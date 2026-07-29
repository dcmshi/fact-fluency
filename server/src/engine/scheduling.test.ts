import { describe, expect, it } from 'vitest';
import {
  BOX_INTERVAL_DAYS,
  dayInTz,
  dueAtForBox,
  previousDay,
  stateForBox,
  stepLearning,
  transitionReview,
} from './scheduling';

const DAY = 24 * 60 * 60 * 1000;

describe('dayInTz', () => {
  it('gives the calendar day in the requested zone', () => {
    const t = Date.parse('2026-01-01T23:30:00Z');
    expect(dayInTz('UTC', t)).toBe('2026-01-01');
    expect(dayInTz('Asia/Tokyo', t)).toBe('2026-01-02'); // UTC+9 already rolled over
    expect(dayInTz('America/New_York', t)).toBe('2026-01-01');
  });

  it('handles the DST-transition day itself', () => {
    // 2026-03-08 06:30Z is 01:30 EST, still 03-08 in New York.
    expect(dayInTz('America/New_York', Date.parse('2026-03-08T06:30:00Z'))).toBe('2026-03-08');
  });

  it('falls back to UTC — not the machine calendar — for an unrecognized zone', () => {
    // Must agree with tzOffsetMinutes' own fallback (0 = UTC): startOfDayAfter
    // combines the two, so a mismatch on a host west of UTC produced a
    // "tomorrow" already in the past, making a just-promoted fact due again
    // immediately. It also kept engine output independent of the host's zone.
    const t = Date.parse('2026-01-02T02:00:00Z'); // still Jan 1 in the Americas
    expect(dayInTz('Not/A_Zone', t)).toBe('2026-01-02');
    expect(dayInTz('Not/A_Zone', t)).toBe(dayInTz('UTC', t));
  });
});

describe('previousDay (DST-proof calendar arithmetic)', () => {
  it('steps back across normal, month, year, and leap boundaries', () => {
    expect(previousDay('2026-03-09')).toBe('2026-03-08'); // day after US spring-forward
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2024-03-01')).toBe('2024-02-29'); // leap year
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});

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
    const due = dueAtForBox(1, noonDay0, 'UTC');
    expect(due).toBe(1 * DAY); // start of 1970-01-02
  });

  it('uses the box interval for the day count', () => {
    const noonDay0 = 12 * 60 * 60 * 1000;
    expect(dueAtForBox(3, noonDay0, 'UTC')).toBe(BOX_INTERVAL_DAYS[3] * DAY);
    expect(dueAtForBox(5, noonDay0, 'UTC')).toBe(BOX_INTERVAL_DAYS[5] * DAY);
  });

  it('brings the due date forward for the half-interval (slow) case', () => {
    const noonDay0 = 12 * 60 * 60 * 1000;
    const full = dueAtForBox(4, noonDay0, 'UTC', 1); // 8 days
    const half = dueAtForBox(4, noonDay0, 'UTC', 0.5); // ~4 days
    expect(half).toBeLessThan(full);
    expect(half).toBe(4 * DAY);
  });

  it('snaps to local midnight across a DST transition (no ±1h drift)', () => {
    const tz = 'America/New_York';
    const localDate = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
    const localTime = (ms: number) =>
      new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });

    // Spring forward: 2025-03-09 02:00 EST → 03:00 EDT. A 1-day due from the day
    // before must land on local midnight 03-09, not 11pm/1am.
    const beforeSpring = Date.parse('2025-03-08T17:00:00Z'); // 12:00 ET
    const springDue = dueAtForBox(1, beforeSpring, tz);
    expect(localDate(springDue)).toBe('2025-03-09');
    expect(localTime(springDue)).toBe('00:00:00');

    // Fall back: 2025-11-02 02:00 EDT → 01:00 EST.
    const beforeFall = Date.parse('2025-11-01T16:00:00Z'); // 12:00 ET
    const fallDue = dueAtForBox(1, beforeFall, tz);
    expect(localDate(fallDue)).toBe('2025-11-02');
    expect(localTime(fallDue)).toBe('00:00:00');
  });

  it('honors a non-UTC zone for the day boundary', () => {
    // 1970-01-01 23:00 UTC is already 1970-01-02 in Tokyo (UTC+9); +1 day → 01-03.
    const due = dueAtForBox(1, Date.parse('1970-01-01T23:00:00Z'), 'Asia/Tokyo');
    expect(new Date(due).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })).toBe(
      '1970-01-03',
    );
    expect(new Date(due).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo' })).toBe('00:00:00');
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
