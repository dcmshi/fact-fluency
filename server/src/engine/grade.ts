/**
 * Answer grading — pure. Ties together threshold (§4.5) and scheduling (§4.3)
 * to turn one answer into updated persistent state. The orchestration layer
 * does the IO; this decides correctness, fluency, the new box, and re-show.
 */
import type { Fact, FactProgress, OperationStat } from '@shared';
import {
  dueAtForBox,
  stateForBox,
  stepLearning,
  transitionReview,
} from './scheduling';
import { ewma, fluencyThreshold, isFast, updateOperationStat } from './threshold';

export interface GradeInput {
  fact: Fact;
  /** Whether the round was answered correctly (the interaction decides this —
   *  a clean munch clear, a right typed answer, etc.). */
  correct: boolean;
  responseMs: number;
  now: number;
  /** Current persistent state, or null for a brand-new fact's first recall. */
  progress: FactProgress | null;
  /** Current per-operation stat (zeros if the kid has never done this op). */
  stat: OperationStat;
  /** In-session correct counter for this fact (box-0 graduation, §4.3). */
  inSessionCorrect: number;
  tzOffsetMin: number;
}

export interface GradeResult {
  correct: boolean;
  fast: boolean;
  progress: FactProgress;
  stat: OperationStat;
  inSessionCorrect: number;
  /** Re-show this fact within the session (incremental rehearsal). */
  requeue: boolean;
}

function baseProgress(profileId: string, factId: string): FactProgress {
  return {
    profileId,
    factId,
    box: 0,
    state: 'learning',
    dueAt: 0,
    lastSeenAt: 0,
    reps: 0,
    fastCorrect: 0,
    correctStreak: 0,
    accuracyEwma: 0,
    medianMsEwma: 0,
  };
}

export function gradeAnswer(input: GradeInput): GradeResult {
  const { fact, correct, responseMs, now, stat, tzOffsetMin } = input;
  const prev = input.progress ?? baseProgress(stat.profileId, fact.id);

  const threshold = fluencyThreshold(fact.operation, stat);
  const fast = correct && isFast(responseMs, threshold);

  // Decide the next box. Box 0 (or a brand-new fact) is in the learning phase
  // and graduates on in-session correct count; boxes ≥ 1 use review transitions.
  let box = prev.box;
  let requeue: boolean;
  let inSessionCorrect = input.inSessionCorrect;

  if (prev.box === 0) {
    const step = stepLearning(inSessionCorrect, correct);
    box = step.box;
    requeue = step.requeue;
    inSessionCorrect = step.inSessionCorrect;
  } else {
    const t = transitionReview(prev.box, correct, fast);
    box = t.box;
    requeue = t.requeue;
    // A demotion back to box 0 restarts learning; reset the in-session counter.
    if (box === 0) inSessionCorrect = 0;
  }

  // dueAt: box 0 is in-session ("next session"); boxes ≥ 1 use their interval,
  // halved on a correct-but-slow answer to bring it forward.
  const fraction = prev.box >= 1 && correct && !fast ? 0.5 : 1;
  const dueAt = box === 0 ? now : dueAtForBox(box, now, tzOffsetMin, fraction);

  const nextStat = correct ? updateOperationStat(stat, responseMs) : stat;

  const progress: FactProgress = {
    profileId: prev.profileId,
    factId: prev.factId || fact.id,
    box,
    state: stateForBox(box),
    dueAt,
    lastSeenAt: now,
    reps: prev.reps + 1,
    fastCorrect: prev.fastCorrect + (fast ? 1 : 0),
    correctStreak: fast ? prev.correctStreak + 1 : 0,
    accuracyEwma: prev.reps === 0 ? (correct ? 1 : 0) : ewma(prev.accuracyEwma, correct ? 1 : 0),
    medianMsEwma: correct
      ? prev.medianMsEwma === 0
        ? responseMs
        : ewma(prev.medianMsEwma, responseMs)
      : prev.medianMsEwma,
  };

  return { correct, fast, progress, stat: nextStat, inSessionCorrect, requeue };
}
