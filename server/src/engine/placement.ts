/**
 * Calibration placement — pure. Given a short "warm-up" probe over a kid's
 * enabled fact universe and how they did (correct + response time), decide
 * where in the Leitner schedule each fact should start so practice begins at
 * the kid's fluency edge instead of the very easiest fact (DESIGN.md §4.4).
 *
 * Two pure steps:
 *  1. buildCalibrationProbe — pick a small difficulty-spread sample to ask.
 *  2. placeFromCalibration — turn the answers into seed FactProgress rows.
 *
 * Deterministic: all randomness comes from an injected rng. No Date/DB/HTTP.
 */
import type { Box, Fact, FactProgress, Operation } from '@shared';
import { dueAtForBox, stateForBox } from './scheduling';

/** A fact answered fast+correct (and everything easier) is treated as already
 *  mastered (box 5), so the planner skips it — mastered facts are last-resort
 *  padding only. This is what jump-starts the kid past the trivial facts:
 *  seeding at box 4 left them in "upcoming" review, which the planner still
 *  pulls forward (easiest-first) when the due queue is empty, so the first game
 *  replayed 0×0. Calibration is direct per-kid evidence, so treating a clean
 *  fast recall as mastery here is warranted. */
export const CALIBRATION_KNOWN_BOX: Box = 5;
/** Answered correctly but slowly: the kid knows it, just isn't fluent — start
 *  it in early review so speed work surfaces it soon. */
export const CALIBRATION_EDGE_BOX: Box = 2;

/** Difficulty proxy shared with facts.ts ordering: the operand sum. */
const difficulty = (f: Fact): number => f.operandA + f.operandB;

/**
 * Pick `count` facts spread easy→hard across the (already difficulty-ordered)
 * universe: split it into `count` contiguous buckets and take one from each, so
 * the probe eases in and samples the whole range. Fewer facts than `count` ⇒
 * return them all. Deterministic via `rng`.
 */
export function buildCalibrationProbe(facts: Fact[], rng: () => number, count = 10): Fact[] {
  if (facts.length <= count) return [...facts];
  const picked: Fact[] = [];
  const bucket = facts.length / count;
  for (let i = 0; i < count; i++) {
    const lo = Math.floor(i * bucket);
    const hi = Math.min(facts.length - 1, Math.floor((i + 1) * bucket) - 1);
    const idx = Math.min(lo + Math.floor(rng() * (hi - lo + 1)), facts.length - 1);
    picked.push(facts[idx]);
  }
  return picked;
}

export interface CalibrationResult {
  factId: string;
  correct: boolean;
  responseMs: number;
}

export interface PlacementInput {
  profileId: string;
  /** The kid's full enabled fact universe (from their grade band's sets). */
  facts: Fact[];
  /** Probe outcomes; entries for facts outside `facts` are ignored. */
  results: CalibrationResult[];
  /** Per-operation "fast enough" cutoffs (ms) — the fluency gate for placement. */
  thresholds: Record<Operation, number>;
  now: number;
  /** Account IANA timezone; day-interval dueAts snap to its calendar (§4.2). */
  timeZone: string;
}

function seed(
  profileId: string,
  factId: string,
  box: Box,
  now: number,
  timeZone: string,
): FactProgress {
  return {
    profileId,
    factId,
    box,
    state: stateForBox(box),
    dueAt: dueAtForBox(box, now, timeZone, 1),
    lastSeenAt: now,
    reps: 0,
    fastCorrect: 0,
    correctStreak: 0,
    accuracyEwma: 0,
    medianMsEwma: 0,
  };
}

/**
 * Seed FactProgress from a calibration probe. Places the kid at their fluency
 * edge per operation:
 *  - fast+correct facts, and every *easier* same-op fact, seed as mastered
 *    (CALIBRATION_KNOWN_BOX = box 5) — one fluent hard fact implies the easy
 *    ones, and box 5 keeps them out of active review so they aren't replayed;
 *  - correct-but-slow facts seed at the edge (CALIBRATION_EDGE_BOX);
 *  - missed facts and anything harder than the fluent frontier are left
 *    unseeded, so the normal "new fact" study-card flow introduces them gently.
 *
 * Net effect: the first game starts at the kid's edge (their slow facts + new
 * facts just above the frontier), not at 0 + 0.
 */
export function placeFromCalibration(input: PlacementInput): FactProgress[] {
  const { facts, results, thresholds, profileId, now, timeZone } = input;
  const byId = new Map(facts.map((f) => [f.id, f]));

  const missed = new Set<string>();
  const fast = new Set<string>();
  const slow = new Set<string>();
  // Hardest fast+correct difficulty per op — the "known" frontier.
  const frontier = new Map<Operation, number>();

  for (const r of results) {
    const f = byId.get(r.factId);
    if (!f) continue;
    if (!r.correct) {
      missed.add(f.id);
      continue;
    }
    if (r.responseMs <= (thresholds[f.operation] ?? Infinity)) {
      fast.add(f.id);
      frontier.set(f.operation, Math.max(frontier.get(f.operation) ?? -1, difficulty(f)));
    } else {
      slow.add(f.id);
    }
  }

  const seeds: FactProgress[] = [];
  for (const f of facts) {
    if (missed.has(f.id)) continue; // reintroduce as a new fact, with the study card
    let box: Box | null = null;
    if (slow.has(f.id)) {
      box = CALIBRATION_EDGE_BOX; // an explicit slow answer wins over the frontier
    } else if (fast.has(f.id) || difficulty(f) <= (frontier.get(f.operation) ?? -1)) {
      box = CALIBRATION_KNOWN_BOX;
    }
    if (box == null) continue; // above the frontier and unprobed → introduce later
    seeds.push(seed(profileId, f.id, box, now, timeZone));
  }
  return seeds;
}

/** Fisher–Yates shuffle using the injected rng (deterministic). */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Multiple-choice options for a calibration question: the correct answer plus
 * plausible near-miss distractors (offsets around the answer / an operand),
 * clamped to ≥ 0 and distinct, then shuffled. Deterministic via `rng`.
 */
export function buildChoices(fact: Fact, rng: () => number, count = 4): number[] {
  const { answer } = fact;
  const candidates = new Set<number>();
  for (const d of [1, -1, 2, -2, 3, -3, fact.operandB || 1, -(fact.operandA || 1)]) {
    const v = answer + d;
    if (v >= 0 && v !== answer) candidates.add(v);
  }
  // Pad from small numbers if a tiny answer didn't yield enough distractors.
  for (let v = 0; candidates.size < count - 1 && v <= answer + count + 3; v++) {
    if (v !== answer) candidates.add(v);
  }
  const distractors = shuffle([...candidates], rng).slice(0, count - 1);
  return shuffle([answer, ...distractors], rng);
}
