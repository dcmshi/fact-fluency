import { describe, expect, it } from 'vitest';
import {
  BOX_INTERVAL_DAYS,
  dueAtForBox,
  stateForBox,
  stepLearning,
  transitionReview,
} from './scheduling';

const DAY = 24 * 60 * 60 * 1000;

describe('stateForBox', () => {
  it('maps boxes to states', () => {
    expect(stateForBox(0)).toBe('learning');
    expect(stateForBox(3)).toBe('review');
    expect(stateForBox(5)).toBe('mastered');
  });
});

describe('dueAtForBox', () => {
  it('snaps to a calendar-day boundary (UTC) N days out', () => {
    const noonDay0 = 12 * 60 * 60 * 1000; // 1970-01-01 12:00 UTC
    const due = dueAtForBox(1, noonDay0, 0);
    expect(due).toBe(1 * DAY); // start of 1970-01-02
  });

  it('uses the box interval for the day count', () => {
    const noonDay0 = 12 * 60 * 60 * 1000;
    expect(dueAtForBox(3, noonDay0, 0)).toBe(BOX_INTERVAL_DAYS[3] * DAY);
    expect(dueAtForBox(5, noonDay0, 0)).toBe(BOX_INTERVAL_DAYS[5] * DAY);
  });

  it('brings the due date forward for the half-interval (slow) case', () => {
    const noonDay0 = 12 * 60 * 60 * 1000;
    const full = dueAtForBox(4, noonDay0, 0, 1); // 8 days
    const half = dueAtForBox(4, noonDay0, 0, 0.5); // ~4 days
    expect(half).toBeLessThan(full);
    expect(half).toBe(4 * DAY);
  });
});

describe('transitionReview', () => {
  it('promotes on correct + fast', () => {
    expect(transitionReview(2, true, true)).toEqual({ box: 3, requeue: false, fraction: 1 });
  });

  it('caps promotion at box 5', () => {
    expect(transitionReview(5, true, true).box).toBe(5);
  });

  it('stays in box with half interval on correct + slow', () => {
    expect(transitionReview(2, true, false)).toEqual({ box: 2, requeue: false, fraction: 0.5 });
  });

  it('demotes mastered to box 4 on correct + slow', () => {
    expect(transitionReview(5, true, false).box).toBe(4);
  });

  it('demotes by two and re-queues on a wrong answer', () => {
    expect(transitionReview(3, false, false)).toEqual({ box: 1, requeue: true, fraction: 1 });
    expect(transitionReview(1, false, false).box).toBe(0);
  });

  it('demotes mastered to box 2 on a wrong answer', () => {
    expect(transitionReview(5, false, false).box).toBe(2);
  });

  it('rejects box 0 (handled by the learning layer)', () => {
    expect(() => transitionReview(0, true, true)).toThrow();
  });
});

describe('stepLearning', () => {
  it('graduates to box 1 after two correct answers', () => {
    const first = stepLearning(0, true);
    expect(first).toEqual({ inSessionCorrect: 1, box: 0, requeue: true });
    const second = stepLearning(first.inSessionCorrect, true);
    expect(second).toEqual({ inSessionCorrect: 2, box: 1, requeue: false });
  });

  it('resets the counter and re-queues on a wrong answer', () => {
    expect(stepLearning(1, false)).toEqual({ inSessionCorrect: 0, box: 0, requeue: true });
  });
});
