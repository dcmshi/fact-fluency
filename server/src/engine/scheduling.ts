/**
 * Persistent Leitner scheduling — pure. Implements DESIGN.md §4.2/§4.3.
 *
 * Time is always passed in (never `Date.now()` here) so scheduling is fully
 * deterministic and unit-testable. This module owns the *persistent* schedule
 * (box → dueAt across sessions); the *in-session* re-show queue (§4.4) is the
 * session layer's job, signalled here via `requeue`.
 */
import type { Box, FactState } from '@shared';

/** Days until a fact in a given box is due again. Box 0 is in-session only. */
export const BOX_INTERVAL_DAYS: Record<Box, number> = {
  0: 0,
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 21,
};

export function stateForBox(box: Box): FactState {
  if (box === 0) return 'learning';
  if (box === 5) return 'mastered';
  return 'review';
}

/**
 * Minutes east of UTC for an IANA `timeZone` at a given instant — DST-aware
 * (the offset is sampled at `atMs`, not assumed constant). Pure: the instant is
 * passed in. Falls back to UTC for an unrecognized zone.
 */
export function tzOffsetMinutes(timeZone: string, atMs: number): number {
  try {
    // Read the zone's wall-clock at `atMs` via Intl parts (machine-tz
    // independent), treat those fields as UTC, and diff against the real instant.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(atMs));
    const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    const hour = get('hour') % 24; // some engines render midnight as "24"
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      hour,
      get('minute'),
      get('second'),
    );
    return Math.round((asUtc - atMs) / 60_000); // minutes east of UTC
  } catch {
    return 0;
  }
}

/** The local calendar date (y, m, d) of an instant in a zone. */
function localYMD(timeZone: string, atMs: number): { y: number; m: number; d: number } {
  let iso: string;
  try {
    iso = new Date(atMs).toLocaleDateString('en-CA', { timeZone }); // YYYY-MM-DD
  } catch {
    iso = new Date(atMs).toISOString().slice(0, 10);
  }
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/**
 * Start of the calendar day `days` days after `now`, in an IANA `timeZone`
 * (DESIGN.md §4.2 — intervals ≥ 1 day snap to a calendar boundary in the
 * account's timezone). DST-correct: the target day's own offset is used, so a
 * due date that crosses a transition still lands on local midnight rather than
 * drifting ±1h. Returns the UTC epoch-ms of that local midnight.
 */
function startOfDayAfter(now: number, days: number, timeZone: string): number {
  const { y, m, d } = localYMD(timeZone, now);
  // The target wall-clock midnight treated as if it were UTC (Date.UTC rolls
  // month/year overflow); local 00:00 in UTC = wall − offset(at that instant).
  const wall = Date.UTC(y, m - 1, d + days);
  // Solve t = wall − offset(t) with one fixed-point step — offsets shift by ≤1h
  // and sampling at the first estimate lands in the correct DST period even on a
  // spring-forward/fall-back day (where noon would be the wrong side).
  const t0 = wall - tzOffsetMinutes(timeZone, wall) * 60_000;
  return wall - tzOffsetMinutes(timeZone, t0) * 60_000;
}

/**
 * Compute the next `dueAt` (epoch ms) for a fact that just landed in `box`.
 * `fraction` < 1 (e.g. 0.5 for "correct but slow") brings it forward; the
 * result still snaps to a day boundary so review feels like "tomorrow", not
 * "23 hours from now".
 */
export function dueAtForBox(box: Box, now: number, timeZone = 'UTC', fraction = 1): number {
  if (box === 0) return now; // handled by the in-session queue; due "next session"
  const days = Math.max(1, Math.round(BOX_INTERVAL_DAYS[box] * fraction));
  return startOfDayAfter(now, days, timeZone);
}

export interface Transition {
  box: Box;
  /** Re-show this fact within the current session (incremental rehearsal). */
  requeue: boolean;
  /** Interval fraction to apply when computing dueAt (1 = full, 0.5 = sooner). */
  fraction: number;
}

function clampBox(n: number): Box {
  return Math.max(0, Math.min(5, n)) as Box;
}

/**
 * Apply one answer to a fact in a *review* box (1–5) and return the new box +
 * scheduling signals. Box 0 graduation is the session layer's responsibility
 * (needs the in-session correct count), so this asserts box ≥ 1.
 *
 * Rules (DESIGN.md §4.3):
 *   correct & fast  → promote +1 (box 5 stays), full interval
 *   correct & slow  → stay,  half interval (sees it sooner)
 *   wrong           → demote (−2, or to 2 from mastered), re-show in session
 */
export function transitionReview(box: Box, correct: boolean, fast: boolean): Transition {
  if (box < 1) throw new Error(`transitionReview expects box ≥ 1, got ${box}`);

  if (!correct) {
    const demoted = box === 5 ? 2 : clampBox(box - 2);
    return { box: demoted, requeue: true, fraction: 1 };
  }
  if (fast) {
    return { box: clampBox(box + 1), requeue: false, fraction: 1 };
  }
  // correct but slow
  const stayed = box === 5 ? clampBox(4) : box;
  return { box: stayed, requeue: false, fraction: 0.5 };
}

/**
 * Box-0 (learning) graduation. A new fact needs `GRADUATE_AT` correct answers
 * within the session to reach box 1; a wrong answer resets the counter and
 * re-queues it. Speed is NOT required at box 0 — it was just taught (§4.3).
 */
export const GRADUATE_AT = 2;

export interface LearningStep {
  /** Updated in-session correct counter for this fact. */
  inSessionCorrect: number;
  /** Box after this answer: 0 (still learning) or 1 (graduated). */
  box: Box;
  requeue: boolean;
}

export function stepLearning(inSessionCorrect: number, correct: boolean): LearningStep {
  if (!correct) return { inSessionCorrect: 0, box: 0, requeue: true };
  const next = inSessionCorrect + 1;
  if (next >= GRADUATE_AT) return { inSessionCorrect: next, box: 1, requeue: false };
  return { inSessionCorrect: next, box: 0, requeue: true };
}
