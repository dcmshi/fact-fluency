/**
 * Adaptive fluency threshold — pure. Implements DESIGN.md §4.5.
 *
 * "Fast enough to count toward mastery" is per profile, per operation, and
 * anchored to the kid's own rolling response time: a recalled fact lands at or
 * below their typical pace, a computed one runs slower. All constants here are
 * tuning knobs to be calibrated against real Attempt data.
 */
import type { Operation } from '@shared';

/** Lenient absolute ceiling per operation (ms) — used during cold start. */
export const CEILING_MS: Record<Operation, number> = {
  add: 6000,
  sub: 6000,
  mul: 8000,
  div: 8000,
};

/** Hard floor (ms): even a fluent kid needs time to read and type. */
export const FLOOR_MS = 1200;

/** Multiplier applied to the kid's rolling median to get the cutoff. */
export const K = 1.3;

/** Correct answers needed before the adaptive (warm) threshold kicks in. */
export const COLD_START_SAMPLES = 20;

/** EWMA smoothing factor for rolling stats (medianMs, accuracy). */
export const EWMA_ALPHA = 0.2;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Exponentially-weighted moving average update. */
export function ewma(prev: number, sample: number, alpha = EWMA_ALPHA): number {
  return prev + alpha * (sample - prev);
}

export interface OperationStatLike {
  medianMsEwma: number;
  correctSamples: number;
}

/**
 * The "fast" cutoff (ms) for an operation given the kid's current stats.
 * Cold start (< COLD_START_SAMPLES correct) → lenient ceiling.
 * Warm → clamp(K · median, FLOOR, ceiling).
 */
export function fluencyThreshold(operation: Operation, stat: OperationStatLike): number {
  const ceiling = CEILING_MS[operation];
  if (stat.correctSamples < COLD_START_SAMPLES) return ceiling;
  return clamp(K * stat.medianMsEwma, FLOOR_MS, ceiling);
}

export function isFast(responseMs: number, threshold: number): boolean {
  return responseMs <= threshold;
}

/**
 * Fold a correct answer's response time into the rolling stats. Only correct
 * answers update the median (we measure recall speed, not error latency).
 */
export function updateOperationStat<T extends OperationStatLike>(stat: T, responseMs: number): T {
  const seeded = stat.correctSamples === 0 ? responseMs : ewma(stat.medianMsEwma, responseMs);
  return { ...stat, medianMsEwma: seeded, correctSamples: stat.correctSamples + 1 };
}
