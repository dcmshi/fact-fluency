/**
 * Persistent Leitner scheduling — pure. Implements DESIGN.md §4.2/§4.3.
 *
 * Time is always passed in (never `Date.now()` here) so scheduling is fully
 * deterministic and unit-testable. This module owns the *persistent* schedule
 * (box → dueAt across sessions); the *in-session* re-show queue (§4.4) is the
 * session layer's job, signalled here via `requeue`.
 */
import type { Box, FactState } from '@shared';

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Start of the next calendar day after `days` days, in a timezone given as a
 * fixed UTC offset in minutes (DESIGN.md §4.2 — intervals ≥ 1 day snap to a
 * calendar boundary in the account's timezone). Offset 0 = UTC.
 */
function startOfDayAfter(now: number, days: number, tzOffsetMin: number): number {
  const shifted = now + tzOffsetMin * 60 * 1000;
  const localMidnight = Math.floor(shifted / DAY_MS) * DAY_MS;
  const targetLocalMidnight = localMidnight + days * DAY_MS;
  return targetLocalMidnight - tzOffsetMin * 60 * 1000;
}

/**
 * Compute the next `dueAt` (epoch ms) for a fact that just landed in `box`.
 * `fraction` < 1 (e.g. 0.5 for "correct but slow") brings it forward; the
 * result still snaps to a day boundary so review feels like "tomorrow", not
 * "23 hours from now".
 */
export function dueAtForBox(
  box: Box,
  now: number,
  tzOffsetMin = 0,
  fraction = 1,
): number {
  if (box === 0) return now; // handled by the in-session queue; due "next session"
  const days = Math.max(1, Math.round(BOX_INTERVAL_DAYS[box] * fraction));
  return startOfDayAfter(now, days, tzOffsetMin);
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
