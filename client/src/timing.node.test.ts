// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { activeNow, resetActiveClock } from './timing';

/**
 * The rest of timing's tests run in jsdom, where `document` exists and every
 * guard in the module is satisfied for the wrong reason — `document !==
 * undefined` is true for any real document, so a missing `typeof` reads as
 * working code. Only a DOM-less environment tells them apart: reading an
 * undeclared global is a ReferenceError, not undefined.
 */
describe('timing without a document', () => {
  it('resets the clock instead of throwing', () => {
    expect(typeof document).toBe('undefined');
    expect(() => resetActiveClock()).not.toThrow();
  });

  it('still measures elapsed time', () => {
    resetActiveClock();
    const before = activeNow();
    expect(activeNow()).toBeGreaterThanOrEqual(before);
  });
});
