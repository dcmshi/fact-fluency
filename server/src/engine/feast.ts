/**
 * Number Feast — the pure game engine for the real-time math arena (FEAST.md).
 * A belt of numbered plates scrolls past; players grab the plates matching the
 * current fact's answer for points, wrong grabs stun them, and a running timer
 * ends the round. Server-authoritative and framework-free: no IO, no globals,
 * and time + randomness are injected, so it's fully deterministic and unit
 * testable. The WS layer (feast/live.ts) owns the mutable state and the tick.
 *
 * State is mutated in place (game-loop style) rather than rebuilt each tick —
 * cheap and still deterministic given the injected `now`/`rng`.
 */
import type { Fact, FeastSnapshot, FeastStanding } from '@shared';

export type Rng = () => number;

// --- Tunables (ms unless noted) -------------------------------------------
export const ROUND_MS = 90_000;
/** A plate crosses the belt (pos 0→1) in this long. A relaxed pace so young
 *  kids get enough time to read a plate and tap it. */
const PLATE_TRAVEL_MS = 7000;
/** Spawn cadence and belt capacity. */
const SPAWN_INTERVAL_MS = 700;
const MAX_PLATES = 14;
/** Share of spawns that match the current answer (rest are distractors). Kept
 *  around half so there's always a scoring opportunity on the belt. */
const CORRECT_SPAWN_CHANCE = 0.5;
/** The displayed fact rotates this often. */
const FACT_ROTATE_MS = 6500;
/** Stun after a wrong grab, and after being bumped. */
const WRONG_STUN_MS = 1500;
const BUMP_STUN_MS = 900;
/** A player can bump again only after this cooldown. */
const BUMP_COOLDOWN_MS = 2500;
/** Bots: reaction window between grab attempts, and how often they're right.
 *  Deliberately forgiving — this is a kids' game (DESIGN.md §4). */
const BOT_MIN_REACT_MS = 700;
const BOT_MAX_REACT_MS = 1600;
const BOT_ACCURACY = 0.7;
/** Bots only consider plates in this on-belt window (mimics "reachable"). */
const BOT_WINDOW: readonly [number, number] = [0.15, 0.85];
/** Bots steer their muncher toward a target at this speed (belt units per ms). */
const BOT_MOVE_SPEED = 0.0006;

// --- State ----------------------------------------------------------------
export interface FeastPlate {
  id: number;
  value: number;
  pos: number; // 0 (just spawned) → 1 (leaving the belt)
  correct: boolean; // value === current answer (recomputed when the fact rotates)
}

export interface FeastPlayer {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  isBot: boolean;
  score: number;
  stunnedUntil: number;
  bumpReadyAt: number;
  botReactAt: number; // bots only: next allowed grab attempt
  rimPos: number; // 0→1 position along the belt (client-owned for humans)
  aim: number; // 0→1 belt direction the tongue points at
  firing: boolean; // tongue currently extended (render-only)
}

export interface FeastState {
  factId: string;
  factA: number;
  factOp: Fact['operation'];
  factB: number;
  answer: number;
  plates: FeastPlate[];
  players: FeastPlayer[];
  pool: Fact[];
  endsAt: number;
  nextPlateId: number;
  lastSpawnAt: number;
  lastRotateAt: number;
}

export interface PlayerInit {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  isBot: boolean;
}

const randInt = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];

/** Move `cur` toward `target` by at most `step`, staying within [0,1]. */
const ease = (cur: number, target: number, step: number): number => {
  const d = target - cur;
  if (Math.abs(d) <= step) return target;
  return cur + Math.sign(d) * step;
};

/** Set the current fact and recompute which plates now count as correct. */
function setFact(state: FeastState, fact: Fact): void {
  state.factId = fact.id;
  state.factA = fact.operandA;
  state.factOp = fact.operation;
  state.factB = fact.operandB;
  state.answer = fact.answer;
  for (const p of state.plates) p.correct = p.value === fact.answer;
}

/** A plausible wrong value near the current answer (other pool answers or small
 *  offsets), never equal to the answer and never negative. */
function distractor(state: FeastState, rng: Rng): number {
  const { answer, pool } = state;
  const candidates = new Set<number>();
  for (const off of [1, 2, 3, 10, -1, -2, -10]) {
    const v = answer + off;
    if (v >= 0 && v !== answer) candidates.add(v);
  }
  // A few real answers from the pool make for believable near-misses.
  for (let i = 0; i < 6 && pool.length > 0; i++) {
    const v = pick(rng, pool).answer;
    if (v !== answer) candidates.add(v);
  }
  const arr = [...candidates];
  return arr.length > 0 ? pick(rng, arr) : answer + 1;
}

/** A benign fact so the engine never crashes on an empty pool (shouldn't happen
 *  — the caller requires enabled sets — but keeps the engine total). */
const fallbackFact = (): Fact => ({
  id: 'add:1+1',
  operation: 'add',
  operandA: 1,
  operandB: 1,
  answer: 2,
});

/** Initialize a round: pick the first fact, empty belt, players at zero. */
export function createFeastState(
  players: PlayerInit[],
  pool: Fact[],
  now: number,
  rng: Rng,
  roundMs: number = ROUND_MS,
): FeastState {
  const state: FeastState = {
    factId: '',
    factA: 0,
    factOp: 'add',
    factB: 0,
    answer: 0,
    plates: [],
    players: players.map((p, i) => ({
      ...p,
      score: 0,
      stunnedUntil: 0,
      bumpReadyAt: 0,
      botReactAt: now + randInt(rng, BOT_MIN_REACT_MS, BOT_MAX_REACT_MS),
      rimPos: (i + 0.5) / Math.max(1, players.length),
      aim: (i + 0.5) / Math.max(1, players.length),
      firing: false,
    })),
    pool,
    endsAt: now + roundMs,
    nextPlateId: 1,
    lastSpawnAt: now,
    lastRotateAt: now,
  };
  setFact(state, pool.length > 0 ? pick(rng, pool) : fallbackFact());
  return state;
}

const isStunned = (p: FeastPlayer, now: number): boolean => now < p.stunnedUntil;

/** Advance the world by `dtMs`: move/despawn plates, spawn new ones, rotate the
 *  fact on schedule, and drive bot grabs. Mutates `state`. */
export function stepFeast(state: FeastState, now: number, dtMs: number, rng: Rng): void {
  if (now >= state.endsAt) return;

  // Move plates along the belt; drop the ones that have left it.
  const advance = dtMs / PLATE_TRAVEL_MS;
  for (const plate of state.plates) plate.pos += advance;
  state.plates = state.plates.filter((p) => p.pos < 1);

  // Rotate the displayed fact on schedule.
  if (now - state.lastRotateAt >= FACT_ROTATE_MS && state.pool.length > 1) {
    let next = pick(rng, state.pool);
    if (next.id === state.factId) next = pick(rng, state.pool); // one nudge off a repeat
    setFact(state, next);
    state.lastRotateAt = now;
  }

  // Spawn new plates on cadence, up to the belt cap.
  while (now - state.lastSpawnAt >= SPAWN_INTERVAL_MS && state.plates.length < MAX_PLATES) {
    state.lastSpawnAt += SPAWN_INTERVAL_MS;
    const correct = rng() < CORRECT_SPAWN_CHANCE;
    const value = correct ? state.answer : distractor(state, rng);
    state.plates.push({ id: state.nextPlateId++, value, pos: 0, correct: value === state.answer });
  }

  // Bots: steer toward the nearest reachable correct plate every step (cosmetic
  // movement), and grab on the reaction timer with BOT_ACCURACY.
  for (const bot of state.players) {
    if (!bot.isBot || isStunned(bot, now)) continue;

    // Ease toward the nearest correct plate inside the reachable window.
    let steerTo: number | null = null;
    let bestD = Infinity;
    for (const p of state.plates) {
      if (!p.correct || p.pos < BOT_WINDOW[0] || p.pos > BOT_WINDOW[1]) continue;
      const d = Math.abs(p.pos - bot.rimPos);
      if (d < bestD) {
        bestD = d;
        steerTo = p.pos;
      }
    }
    if (steerTo !== null) {
      bot.rimPos = ease(bot.rimPos, steerTo, BOT_MOVE_SPEED * dtMs);
      bot.aim = bot.rimPos;
    }

    // Grab on the reaction timer (accuracy roll unchanged from before).
    bot.firing = false;
    if (now < bot.botReactAt) continue;
    const target =
      rng() < BOT_ACCURACY
        ? state.plates.find((p) => p.correct && p.pos >= BOT_WINDOW[0] && p.pos <= BOT_WINDOW[1])
        : state.plates.find((p) => !p.correct && p.pos >= BOT_WINDOW[0] && p.pos <= BOT_WINDOW[1]);
    if (target) {
      bot.firing = true;
      applyGrab(state, bot.profileId, target.id, now);
    }
    bot.botReactAt = now + randInt(rng, BOT_MIN_REACT_MS, BOT_MAX_REACT_MS);
  }
}

export type GrabResult = 'correct' | 'wrong' | 'ignored';

/** A player grabs a plate: correct → +1 point, wrong → consumed + a stun. The
 *  plate is removed either way (first tap wins). Mutates `state`. */
export function applyGrab(
  state: FeastState,
  playerId: string,
  plateId: number,
  now: number,
): GrabResult {
  const player = state.players.find((p) => p.profileId === playerId);
  if (!player || isStunned(player, now)) return 'ignored';
  const idx = state.plates.findIndex((p) => p.id === plateId);
  if (idx === -1) return 'ignored';
  const [plate] = state.plates.splice(idx, 1);
  if (plate.correct) {
    player.score += 1;
    return 'correct';
  }
  player.stunnedUntil = now + WRONG_STUN_MS;
  return 'wrong';
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A player reports its muncher position + tongue aim (render-only relay). The
 *  server keeps this only to broadcast to other clients; it is NOT trusted for
 *  scoring (correctness is decided in applyGrab). Mutates `state`. */
export function applyMove(
  state: FeastState,
  playerId: string,
  rimPos: number,
  aim: number,
  firing: boolean,
): void {
  const player = state.players.find((p) => p.profileId === playerId);
  if (!player) return;
  player.rimPos = clamp01(rimPos);
  player.aim = clamp01(aim);
  player.firing = firing;
}

/** A player bumps a rival, stunning them briefly (on a cooldown). Mutates
 *  `state`. Returns whether the bump landed. */
export function applyBump(state: FeastState, byId: string, targetId: string, now: number): boolean {
  if (byId === targetId) return false;
  const by = state.players.find((p) => p.profileId === byId);
  const target = state.players.find((p) => p.profileId === targetId);
  if (!by || !target || isStunned(by, now) || now < by.bumpReadyAt) return false;
  by.bumpReadyAt = now + BUMP_COOLDOWN_MS;
  target.stunnedUntil = Math.max(target.stunnedUntil, now + BUMP_STUN_MS);
  return true;
}

export const isFeastOver = (state: FeastState, now: number): boolean => now >= state.endsAt;

/** Final ranking: highest score first, ties broken by profileId for stability. */
export function feastStandings(players: FeastPlayer[]): FeastStanding[] {
  return [...players]
    .sort((a, b) => b.score - a.score || a.profileId.localeCompare(b.profileId))
    .map((p, i) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      placement: i + 1,
      isBot: p.isBot,
    }));
}

/** The client-facing view of the current tick (no answer / correctness leaked). */
export function feastSnapshot(state: FeastState, now: number): FeastSnapshot {
  return {
    factA: state.factA,
    factOp: state.factOp,
    factB: state.factB,
    timeLeftMs: Math.max(0, state.endsAt - now),
    plates: state.plates.map((p) => ({ id: p.id, value: p.value, pos: p.pos })),
    players: state.players.map((p) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      muncher: p.muncher,
      score: p.score,
      stunned: isStunned(p, now),
      isBot: p.isBot,
      rimPos: p.rimPos,
      aim: p.aim,
      firing: p.firing,
    })),
  };
}
