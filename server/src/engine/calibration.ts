/**
 * Fluency-constant calibration — pure analysis (DESIGN.md §4.5, §11). Turns the
 * attempt log into per-operation response-time statistics and *advisory*
 * recommendations for the tuning knobs in threshold.ts (K, per-op ceilings).
 * It recommends nothing until an operation has enough samples — calibration is
 * only meaningful on real data.
 *
 * Rationale for the suggestions:
 *  - ceiling ≈ p90 of correct response times: all but the slowest genuine
 *    recalls count toward "fast", while clearly-computed answers don't.
 *  - K ≈ p75 / p50: the warm cutoff (K·median) lands around the 75th percentile
 *    of a kid's own recall times.
 */
import type { Operation } from '@shared';
import { CEILING_MS, COLD_START_SAMPLES, FLOOR_MS, K } from './threshold';

const OPERATIONS: Operation[] = ['add', 'sub', 'mul', 'div'];

/** Minimum correct samples before per-op recommendations are offered. */
export const MIN_CALIBRATION_SAMPLES = 30;

export interface AttemptLike {
  factId: string;
  correct: boolean;
  responseMs: number;
}

export interface OperationCalibration {
  operation: Operation;
  attempts: number;
  correctSamples: number;
  accuracy: number;
  /** Percentiles (ms) of *correct* response times; null when no correct samples. */
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  /** Current cold-start ceiling for this op (ms) and the fraction of correct
   *  answers already under it (a too-low fast-rate ⇒ ceiling/threshold too tight). */
  currentCeilingMs: number;
  fastRateUnderCeiling: number | null;
  enoughData: boolean;
  suggestedCeilingMs: number | null;
  suggestedK: number | null;
}

export interface CalibrationReport {
  totalAttempts: number;
  currentConstants: { K: number; floorMs: number; coldStartSamples: number };
  perOperation: OperationCalibration[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/** Linear-interpolated percentile of an ascending-sorted array. */
export function percentile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = clamp(q, 0, 1) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function operationOf(factId: string): Operation | null {
  const op = factId.split(':')[0];
  return (OPERATIONS as string[]).includes(op) ? (op as Operation) : null;
}

export function analyzeCalibration(attempts: AttemptLike[]): CalibrationReport {
  const byOp = new Map<Operation, AttemptLike[]>();
  for (const op of OPERATIONS) byOp.set(op, []);
  for (const a of attempts) {
    const op = operationOf(a.factId);
    if (op) byOp.get(op)!.push(a);
  }

  const perOperation = OPERATIONS.map((operation): OperationCalibration => {
    const list = byOp.get(operation)!;
    const correct = list.filter((a) => a.correct);
    const times = correct.map((a) => a.responseMs).sort((x, y) => x - y);
    const p50 = percentile(times, 0.5);
    const p75 = percentile(times, 0.75);
    const p90 = percentile(times, 0.9);
    const ceiling = CEILING_MS[operation];
    const enoughData = correct.length >= MIN_CALIBRATION_SAMPLES;

    return {
      operation,
      attempts: list.length,
      correctSamples: correct.length,
      accuracy: list.length ? correct.length / list.length : 0,
      p25: percentile(times, 0.25),
      p50,
      p75,
      p90,
      currentCeilingMs: ceiling,
      fastRateUnderCeiling: times.length
        ? times.filter((t) => t <= ceiling).length / times.length
        : null,
      enoughData,
      suggestedCeilingMs: enoughData && p90 != null ? roundTo(p90, 250) : null,
      suggestedK: enoughData && p50 && p50 > 0 && p75 != null ? clamp(p75 / p50, 1.1, 1.6) : null,
    };
  });

  return {
    totalAttempts: attempts.length,
    currentConstants: { K, floorMs: FLOOR_MS, coldStartSamples: COLD_START_SAMPLES },
    perOperation,
  };
}
