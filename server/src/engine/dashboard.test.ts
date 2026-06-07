import { describe, expect, it } from 'vitest';
import {
  buildTrends,
  median,
  summarizeAttempts,
  suggestNextSet,
  type SetMastery,
} from './dashboard';

describe('median', () => {
  it('returns null for empty, the middle for odd, the mean for even', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2); // sorted 1,2,3
    expect(median([4, 1, 3, 2])).toBe(2.5); // (2+3)/2
  });
});

describe('summarizeAttempts', () => {
  it('computes accuracy and median speed over correct attempts only', () => {
    const s = summarizeAttempts([
      { correct: true, fast: true, responseMs: 1000 },
      { correct: true, fast: false, responseMs: 3000 },
      { correct: false, fast: false, responseMs: 200 }, // wrong → excluded from speed
    ]);
    expect(s.attempts).toBe(3);
    expect(s.correct).toBe(2);
    expect(s.fastCorrect).toBe(1);
    expect(s.accuracy).toBeCloseTo(2 / 3);
    expect(s.medianMs).toBe(2000); // median of [1000, 3000]
  });

  it('is zeroed for an empty day with a null speed', () => {
    expect(summarizeAttempts([])).toEqual({
      attempts: 0,
      correct: 0,
      fastCorrect: 0,
      accuracy: 0,
      medianMs: null,
    });
  });
});

describe('buildTrends', () => {
  it('buckets by day key and fills gap days with zero activity', () => {
    const attempts = [
      { correct: true, fast: true, responseMs: 1000, answeredAt: 10 },
      { correct: false, fast: false, responseMs: 2000, answeredAt: 11 },
      { correct: true, fast: false, responseMs: 1500, answeredAt: 30 },
    ];
    // answeredAt < 20 → "d1", else "d3"; "d2" has no attempts.
    const dayKeyOf = (ms: number) => (ms < 20 ? 'd1' : 'd3');
    const trends = buildTrends(attempts, ['d1', 'd2', 'd3'], dayKeyOf);

    expect(trends.map((t) => t.day)).toEqual(['d1', 'd2', 'd3']);
    expect(trends[0]).toMatchObject({ attempts: 2, correct: 1, accuracy: 0.5 });
    expect(trends[1]).toMatchObject({ attempts: 0, accuracy: 0, medianMs: null });
    expect(trends[2]).toMatchObject({ attempts: 1, correct: 1, accuracy: 1 });
  });
});

describe('suggestNextSet', () => {
  const set = (
    o: Partial<SetMastery> & Pick<SetMastery, 'setId' | 'aMax' | 'enabled'>,
  ): SetMastery => ({
    operation: 'add',
    label: o.setId,
    total: 10,
    mastered: 0,
    ...o,
  });

  it('suggests the next-larger set once the largest enabled is ≥80% mastered', () => {
    const r = suggestNextSet([
      set({
        setId: 'add-0-10',
        label: 'Addition 0–10',
        aMax: 10,
        enabled: true,
        total: 10,
        mastered: 9,
      }),
      set({ setId: 'add-0-12', label: 'Addition 0–12', aMax: 12, enabled: false }),
      set({ setId: 'add-0-5', label: 'Addition 0–5', aMax: 5, enabled: false }),
    ]);
    expect(r?.setId).toBe('add-0-12'); // smallest not-enabled set larger than 0–10
    expect(r?.reason).toContain('90%');
    expect(r?.reason).toContain('Addition 0–10');
  });

  it('returns null when the kid is not yet ready', () => {
    const r = suggestNextSet([
      set({ setId: 'add-0-10', aMax: 10, enabled: true, total: 10, mastered: 4 }),
      set({ setId: 'add-0-12', aMax: 12, enabled: false }),
    ]);
    expect(r).toBeNull();
  });

  it('returns null when there is no larger set to advance to', () => {
    const r = suggestNextSet([
      set({ setId: 'add-0-12', aMax: 12, enabled: true, total: 10, mastered: 10 }),
    ]);
    expect(r).toBeNull();
  });

  it('picks the most-mastered operation when several are ready', () => {
    const r = suggestNextSet([
      set({ setId: 'add-0-10', operation: 'add', aMax: 10, enabled: true, total: 10, mastered: 8 }),
      set({ setId: 'add-0-12', operation: 'add', aMax: 12, enabled: false }),
      set({ setId: 'mul-0-5', operation: 'mul', aMax: 5, enabled: true, total: 10, mastered: 10 }),
      set({ setId: 'mul-0-10', operation: 'mul', aMax: 10, enabled: false }),
    ]);
    expect(r?.setId).toBe('mul-0-10'); // mul fully mastered beats add at 80%
  });

  it('introduces the next untouched operation once the current ladder is done', () => {
    const r = suggestNextSet([
      set({
        setId: 'add-0-10',
        operation: 'add',
        label: 'Addition 0–10',
        aMax: 10,
        enabled: true,
        total: 10,
        mastered: 10,
      }),
      set({
        setId: 'sub-0-10',
        operation: 'sub',
        label: 'Subtraction 0–10',
        aMax: 10,
        enabled: false,
      }),
      set({
        setId: 'sub-0-20',
        operation: 'sub',
        label: 'Subtraction 0–20',
        aMax: 20,
        enabled: false,
      }),
    ]);
    // add has no larger set to advance to → cross over to the easiest sub set.
    expect(r?.setId).toBe('sub-0-10');
    expect(r?.operation).toBe('sub');
    expect(r?.reason).toContain('subtraction');
  });

  it('prefers finishing the current operation over crossing to a new one', () => {
    const r = suggestNextSet([
      set({ setId: 'add-0-10', operation: 'add', aMax: 10, enabled: true, total: 10, mastered: 9 }),
      set({ setId: 'add-0-12', operation: 'add', aMax: 12, enabled: false }),
      set({ setId: 'sub-0-10', operation: 'sub', aMax: 10, enabled: false }),
    ]);
    expect(r?.setId).toBe('add-0-12'); // within-op wins
  });

  it('does not cross to a new operation until the kid is ready', () => {
    const r = suggestNextSet([
      set({ setId: 'add-0-10', operation: 'add', aMax: 10, enabled: true, total: 10, mastered: 4 }),
      set({ setId: 'sub-0-10', operation: 'sub', aMax: 10, enabled: false }),
    ]);
    expect(r).toBeNull(); // add only 40% mastered — not ready
  });
});
