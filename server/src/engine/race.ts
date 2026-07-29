/**
 * Race logic — pure (MULTIPLAYER.md). A race is a short, fixed deck of facts all
 * racers play; ranking is by total time to clear the deck (everyone finishes —
 * non-punitive), and coins scale with placement over a guaranteed floor.
 *
 * Deterministic: all randomness comes from an injected rng. No Date/DB/HTTP.
 * Board generation and persistence live in the service layer (like the session
 * loop) — this module only picks the facts and scores the outcome.
 */
import type { Fact } from '@shared';

/** Rounds in a race — each round is a quick tap-the-answer question (~2-4s), so
 *  10 rounds keeps a race ~30-45s. */
export const RACE_ROUNDS = 10;

/** Number of answer buttons per race round (one correct + distractors). */
export const RACE_CHOICES = 5;

/** Coins for finishing last / a participation floor — everyone leaves with some. */
export const RACE_COIN_FLOOR = 3;
/** Coins for first place (linear down to the floor for last). */
export const RACE_COIN_TOP = 12;

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
 * Pick the race deck: a shuffled sample of `count` facts from the universe (the
 * creator's enabled facts), so a race is varied rather than a difficulty ladder.
 * Fewer facts than `count` ⇒ use them all (still shuffled). The same deck is
 * then served verbatim to every racer, so it's a true head-to-head.
 */
export function buildRaceDeck(facts: Fact[], rng: () => number, count = RACE_ROUNDS): Fact[] {
  const shuffled = shuffle(facts, rng);
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Bot opponent splits (ms per round) — a friendly, beatable ~2-4s/round pace for
 * tap-the-answer rounds, so a solo racer (or a first race with no human ghost
 * yet) always has someone to chase. Deterministic via rng (seed it from the race
 * id so the same race always faces the same bot).
 */
export function buildBotGhost(rounds: number, rng: () => number): number[] {
  return Array.from({ length: rounds }, () => 2000 + Math.floor(rng() * 2000));
}

export interface RaceRunLike {
  profileId: string;
  /** Total time to clear the deck (ms); lower is better. */
  totalMs: number;
}

/**
 * Rank runs fastest-first and assign 1-based placements. Everyone finishes the
 * deck, so time is the only metric (wrong munches already cost time).
 *
 * Equal times share a placement (competition ranking: 1, 2, 2, 4). Exact ties
 * aren't as impossible as they look — times are rounded to whole ms and clamped
 * at MAX_RACE_MS, and a live race that can't read a racer's time *defaults* it
 * to that cap, so two capped racers tie exactly. Splitting them by sort order
 * would hand out 1st vs 2nd, and different coin payouts, on DB row order.
 */
export function rankRuns<T extends RaceRunLike>(runs: T[]): (T & { placement: number })[] {
  const sorted = [...runs].sort((a, b) => a.totalMs - b.totalMs);
  let placement = 0;
  let previousMs: number | null = null;
  return sorted.map((run, i) => {
    if (previousMs == null || run.totalMs !== previousMs) placement = i + 1;
    previousMs = run.totalMs;
    return { ...run, placement };
  });
}

/**
 * Coins for a placement among `racers` (a ghost counts as a racer). First place
 * earns RACE_COIN_TOP, last earns RACE_COIN_FLOOR, linear in between; a solo
 * time-trial (no opponent) earns the full amount. Never below the floor.
 */
export function placementCoins(placement: number, racers: number): number {
  if (racers <= 1) return RACE_COIN_TOP;
  const frac = (racers - placement) / (racers - 1); // 1 at 1st … 0 at last
  return Math.round(RACE_COIN_FLOOR + (RACE_COIN_TOP - RACE_COIN_FLOOR) * frac);
}
