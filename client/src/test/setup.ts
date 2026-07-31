import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Vitest runs without globals, so @testing-library's own auto-cleanup (which
 * hooks a global afterEach) never registers. Unmount here instead, or every
 * render leaks its container and its effects — one test's timers and rAF loops
 * keep running through the next.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
