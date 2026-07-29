import { describe, expect, it } from 'vitest';
import { isChunkLoadError } from './ErrorBoundary';

/**
 * This predicate decides whether a kid's blank screen silently repairs itself.
 * The messages differ per browser, so pin the real ones: these are what Chrome,
 * Firefox, Safari and webpack-era bundlers actually throw when a hashed chunk
 * 404s after a deploy evicted the old build's cache.
 */
describe('isChunkLoadError', () => {
  it('recognises a failed lazy import across browsers', () => {
    const failures = [
      new TypeError('Failed to fetch dynamically imported module: https://app/assets/Play-a1b2.js'),
      new TypeError('error loading dynamically imported module'),
      new Error('Importing a module script failed.'),
      Object.assign(new Error('Loading chunk 42 failed.'), { name: 'ChunkLoadError' }),
    ];
    for (const err of failures) expect(isChunkLoadError(err)).toBe(true);
  });

  it('leaves ordinary app errors alone (a reload would just lose their place)', () => {
    const ordinary = [
      new TypeError("Cannot read properties of undefined (reading 'map')"),
      new Error('Network request failed'),
      'some string throw',
      null,
    ];
    for (const err of ordinary) expect(isChunkLoadError(err)).toBe(false);
  });
});
