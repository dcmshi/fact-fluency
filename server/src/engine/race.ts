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

/** Rounds in a race — short, because each munch round is ~10s (~60-90s total). */
export const RACE_ROUNDS = 6;

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
 * Bot opponent splits (ms per round) — a friendly, beatable ~3.5–5.5s/round
 * pace, so a solo racer (or a first race with no human ghost yet) always has
 * someone to chase. Deterministic via rng (seed it from the race id so the same
 * race always faces the same bot).
 */
export function buildBotGhost(rounds: number, rng: () => number): number[] {
  return Array.from({ length: rounds }, () => 3500 + Math.floor(rng() * 2000));
}

export interface RaceRunLike {
  profileId: string;
  /** Total time to clear the deck (ms); lower is better. */
  totalMs: number;
}

/**
 * Rank runs fastest-first and assign 1-based placements. Everyone finishes the
 * deck, so time is the only metric (wrong munches already cost time). Ties keep
 * input order — sub-ms ties are effectively impossible.
 */
export function rankRuns<T extends RaceRunLike>(runs: T[]): (T & { placement: number })[] {
  return [...runs]
    .sort((a, b) => a.totalMs - b.totalMs)
    .map((run, i) => ({ ...run, placement: i + 1 }));
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
