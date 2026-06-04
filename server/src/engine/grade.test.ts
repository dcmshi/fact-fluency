import { describe, expect, it } from 'vitest';
import type { Fact, FactProgress, OperationStat } from '@shared';
import { gradeAnswer, type GradeInput } from './grade';
import { COLD_START_SAMPLES } from './threshold';

const FACT: Fact = { id: 'mul:7x8', operation: 'mul', operandA: 7, operandB: 8, answer: 56 };
const NOW = 1_000_000_000;

function stat(over: Partial<OperationStat> = {}): OperationStat {
  return { profileId: 'p', operation: 'mul', medianMsEwma: 0, correctSamples: 0, ...over };
}

function reviewProgress(over: Partial<FactProgress>): FactProgress {
  return {
    profileId: 'p',
    factId: FACT.id,
    box: 2,
    state: 'review',
    dueAt: NOW - 1000,
    lastSeenAt: NOW - 1000,
    reps: 4,
    fastCorrect: 2,
    correctStreak: 1,
    accuracyEwma: 0.9,
    medianMsEwma: 3000,
    ...over,
  };
}

function grade(over: Partial<GradeInput>): ReturnType<typeof gradeAnswer> {
  return gradeAnswer({
    fact: FACT,
    correct: true,
    responseMs: 2000,
    now: NOW,
    progress: null,
    stat: stat(),
    inSessionCorrect: 0,
    tzOffsetMin: 0,
    ...over,
  });
}

describe('correctness & fluency', () => {
  it('marks a wrong answer incorrect and not fast', () => {
    const r = grade({ correct: false, progress: reviewProgress({}) });
    expect(r.correct).toBe(false);
    expect(r.fast).toBe(false);
  });

  it('a correct, slow answer is correct but not fast', () => {
    // Warm stat with a low median so the threshold is tight.
    const r = grade({
      responseMs: 9000,
      progress: reviewProgress({}),
      stat: stat({ medianMsEwma: 2000, correctSamples: COLD_START_SAMPLES }),
    });
    expect(r.correct).toBe(true);
    expect(r.fast).toBe(false);
  });

  it('a correct, fast answer is fast', () => {
    const r = grade({ responseMs: 1500, progress: reviewProgress({}) });
    expect(r.correct).toBe(true);
    expect(r.fast).toBe(true);
  });
});

describe('review transitions', () => {
  it('promotes a box on correct + fast', () => {
    const r = grade({ responseMs: 1500, progress: reviewProgress({ box: 2 }) });
    expect(r.progress.box).toBe(3);
    expect(r.requeue).toBe(false);
    expect(r.progress.dueAt).toBeGreaterThan(NOW);
  });

  it('demotes and re-queues on a wrong answer', () => {
    const r = grade({ correct: false, progress: reviewProgress({ box: 3 }) });
    expect(r.progress.box).toBe(1);
    expect(r.requeue).toBe(true);
    expect(r.progress.correctStreak).toBe(0);
  });
});

describe('learning (box 0) graduation', () => {
  it('keeps a brand-new fact in box 0 after one correct, then graduates on the second', () => {
    const first = grade({ progress: null, inSessionCorrect: 0 });
    expect(first.progress.box).toBe(0);
    expect(first.requeue).toBe(true);
    expect(first.inSessionCorrect).toBe(1);

    const second = grade({ progress: first.progress, inSessionCorrect: first.inSessionCorrect });
    expect(second.progress.box).toBe(1);
    expect(second.requeue).toBe(false);
  });

  it('resets the in-session counter on a wrong learning answer', () => {
    const r = grade({ correct: false, progress: null, inSessionCorrect: 1 });
    expect(r.progress.box).toBe(0);
    expect(r.inSessionCorrect).toBe(0);
    expect(r.requeue).toBe(true);
  });
});

describe('stat & progress bookkeeping', () => {
  it('updates the operation stat only on a correct answer', () => {
    const correct = grade({ responseMs: 2500, progress: reviewProgress({}), stat: stat({ medianMsEwma: 3000, correctSamples: 5 }) });
    expect(correct.stat.correctSamples).toBe(6);

    const wrong = grade({ correct: false, progress: reviewProgress({}), stat: stat({ medianMsEwma: 3000, correctSamples: 5 }) });
    expect(wrong.stat.correctSamples).toBe(5);
    expect(wrong.stat.medianMsEwma).toBe(3000);
  });

  it('increments reps and tracks fast-correct streak', () => {
    const r = grade({ responseMs: 1500, progress: reviewProgress({ reps: 4, fastCorrect: 2, correctStreak: 1 }) });
    expect(r.progress.reps).toBe(5);
    expect(r.progress.fastCorrect).toBe(3);
    expect(r.progress.correctStreak).toBe(2);
  });
});
