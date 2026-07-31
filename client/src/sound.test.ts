import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMuted, playCorrect, setMuted } from './sound';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Safari's private mode and Chrome with site data blocked throw on access
 *  rather than returning null. */
function storageDenied() {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  });
}

describe('mute preference', () => {
  it('round-trips through storage', () => {
    expect(isMuted()).toBe(false);
    expect(setMuted(true)).toBe(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  it('degrades to unmuted when storage access throws', () => {
    storageDenied();
    // Every sound in the app is gated on isMuted(), so throwing here doesn't
    // lose a preference — it breaks play.
    expect(() => isMuted()).not.toThrow();
    expect(isMuted()).toBe(false);
    expect(() => setMuted(true)).not.toThrow();
    expect(() => playCorrect()).not.toThrow();
  });
});
