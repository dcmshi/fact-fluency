import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activeNow, resetActiveClock } from './timing';

/** Drive document.hidden + the visibilitychange event the way a real
 *  home-button press does. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

let clock = 0;

beforeEach(() => {
  clock = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  setHidden(false);
  resetActiveClock();
});

afterEach(() => {
  setHidden(false);
  vi.restoreAllMocks();
});

describe('activeNow', () => {
  it('measures elapsed time like performance.now while visible', () => {
    const start = activeNow();
    clock += 1500;
    expect(activeNow() - start).toBe(1500);
  });

  it('excludes time the tab spent hidden', () => {
    const start = activeNow(); // kid is shown the fact
    clock += 800; // thinking
    setHidden(true);
    clock += 180_000; // three minutes on the home screen
    setHidden(false);
    clock += 400; // taps the answer

    // Without this the answer reports ~181s: graded slow, fact demoted, and the
    // session-seconds cap trips on the next card.
    expect(activeNow() - start).toBe(1200);
  });

  it('excludes an in-progress hidden stretch, and never runs backwards', () => {
    const start = activeNow();
    clock += 500;
    setHidden(true);
    clock += 60_000;

    // Read *while* still hidden — the pending stretch counts as zero elapsed.
    const midway = activeNow();
    expect(midway - start).toBe(500);
    clock += 5_000;
    expect(activeNow()).toBe(midway); // frozen, not negative, while hidden
  });
});
