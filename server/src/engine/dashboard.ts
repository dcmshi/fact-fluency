/**
 * Dashboard aggregation — pure (DESIGN.md §7). Turns the raw attempt log into
 * day-by-day accuracy/speed trends, and turns per-set mastery into a single
 * "enable this next" suggestion. No DB/HTTP/time-of-day reached for here: the
 * caller buckets attempts into account-timezone days and passes them in.
 */
import type { Operation } from '@shared';

/** Stable operation order — also the curriculum order for cross-op intros. */
const OP_ORDER: Operation[] = ['add', 'sub', 'mul', 'div'];

const OP_NOUN: Record<Operation, string> = {
  add: 'addition',
  sub: 'subtraction',
  mul: 'multiplication',
  div: 'division',
};

/** The slice of an attempt the aggregation needs. */
export interface AttemptLike {
  correct: boolean;
  fast: boolean;
  responseMs: number;
}

export interface DayStat {
  attempts: number;
  correct: number;
  fastCorrect: number;
  accuracy: number;
  medianMs: number | null;
}

/** Median of a list, or null if empty. Even-length → mean of the two middles. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Collapse a set of attempts into accuracy + median-speed stats. Speed is the
 *  median responseMs of *correct* attempts only (wrong answers are noise). */
export function summarizeAttempts(attempts: AttemptLike[]): DayStat {
  const correct = attempts.filter((a) => a.correct);
  const fastCorrect = correct.filter((a) => a.fast).length;
  return {
    attempts: attempts.length,
    correct: correct.length,
    fastCorrect,
    accuracy: attempts.length ? correct.length / attempts.length : 0,
    medianMs: median(correct.map((a) => a.responseMs)),
  };
}

/**
 * Build a trend point per day in `dayKeys` (ordered oldest→newest), grouping
 * `attempts` by `dayKeyOf`. Days with no activity are returned with zero stats
 * so the chart has a stable, gap-free x-axis.
 */
export function buildTrends<T extends AttemptLike & { answeredAt: number }>(
  attempts: T[],
  dayKeys: string[],
  dayKeyOf: (answeredAt: number) => string,
): (DayStat & { day: string })[] {
  const byDay = new Map<string, T[]>();
  for (const a of attempts) {
    const key = dayKeyOf(a.answeredAt);
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(a);
  }
  return dayKeys.map((day) => ({ day, ...summarizeAttempts(byDay.get(day) ?? []) }));
}

/** Per-set mastery, for the "what to enable next" heuristic. */
export interface SetMastery {
  setId: string;
  operation: Operation;
  label: string;
  /** Range size key within an operation (rangeSpec.aMax) — orders nested sets. */
  aMax: number;
  total: number;
  mastered: number;
  enabled: boolean;
}

export interface SuggestionResult {
  setId: string;
  operation: Operation;
  label: string;
  reason: string;
}

/**
 * Suggest the next catalog set to enable. Priority:
 *   1. Within an operation the kid has nearly mastered (≥ `threshold` of their
 *      largest enabled set), point to the next-larger not-yet-enabled set —
 *      finish an operation's ladder first.
 *   2. Else, if they've nearly mastered the largest enabled set of *some*
 *      operation (so they're clearly ready) but have nothing left to advance to
 *      there, introduce the next untouched operation in curriculum order
 *      (add → sub → mul → div) at its easiest set.
 * Returns null when nothing is ready — don't nag.
 */
export function suggestNextSet(sets: SetMastery[], threshold = 0.8): SuggestionResult | null {
  const candidates: { op: Operation; frac: number; fromLabel: string; next: SetMastery }[] = [];
  let ready = false; // mastered ≥threshold of some operation's largest enabled set

  for (const op of OP_ORDER) {
    const inOp = sets.filter((s) => s.operation === op);
    const enabled = inOp.filter((s) => s.enabled);
    if (enabled.length === 0) continue;

    const largest = enabled.reduce((a, b) => (b.aMax > a.aMax ? b : a));
    const frac = largest.total > 0 ? largest.mastered / largest.total : 0;
    if (frac < threshold) continue;
    ready = true;

    const next = inOp
      .filter((s) => !s.enabled && s.aMax > largest.aMax)
      .sort((a, b) => a.aMax - b.aMax)[0];
    if (next) candidates.push({ op, frac, fromLabel: largest.label, next });
  }

  // (1) Within-operation advancement wins — finish the current ladder.
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.frac - a.frac || OP_ORDER.indexOf(a.op) - OP_ORDER.indexOf(b.op));
    const { frac, fromLabel, next } = candidates[0];
    return {
      setId: next.setId,
      operation: next.operation,
      label: next.label,
      reason: `Mastered ${Math.round(frac * 100)}% of ${fromLabel} — ready for ${next.label}.`,
    };
  }

  // (2) Cross-operation introduction — only once they've proven ready somewhere.
  if (!ready) return null;
  for (const op of OP_ORDER) {
    const inOp = sets.filter((s) => s.operation === op);
    if (inOp.length === 0 || inOp.some((s) => s.enabled)) continue; // not in catalog / already started
    const easiest = inOp.reduce((a, b) => (b.aMax < a.aMax ? b : a));
    return {
      setId: easiest.setId,
      operation: easiest.operation,
      label: easiest.label,
      reason: `Doing great — ready to try ${OP_NOUN[op]}? Start with ${easiest.label}.`,
    };
  }
  return null;
}
