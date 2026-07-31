import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Source-level accessibility invariants — the ones that are a single attribute
 * in a single tag, easy to reintroduce, and impossible to notice without a
 * screen reader running.
 */
const resolve = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const sources = readdirSync(resolve('.'), { recursive: true })
  .map(String)
  .map((f) => f.replaceAll('\\', '/'))
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));

/** Every JSX opening tag in a file, as raw text. */
const tags = (file: string): string[] => {
  const src = readFileSync(resolve(`./${file}`), 'utf8');
  return [...src.matchAll(/<[A-Za-z][^<>]*?(?:\/?)>/gs)].map((m) => m[0]);
};

describe('live regions', () => {
  it('found the components', () => {
    expect(sources).toContain('pages/PlayPage.tsx');
    expect(sources.length).toBeGreaterThan(10);
  });

  it('announces politely', () => {
    // Every live region in this app updates once per round, seconds apart.
    // `assertive` interrupts the current utterance mid-word — including the
    // previous round's own announcement — so it makes play *less* readable.
    const assertive = sources.flatMap((file) =>
      tags(file)
        .filter((tag) => /aria-live=("|')assertive\1/.test(tag))
        .map(() => file),
    );
    expect(assertive).toEqual([]);
  });
});
