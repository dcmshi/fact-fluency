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
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && !f.startsWith('test/'));

/**
 * Every JSX opening tag in a file, as raw text.
 *
 * Scanned rather than matched with a regex: attribute values hold arrow
 * functions and template literals, so the first `>` after `<div` is usually part
 * of an `=>` rather than the end of the tag. Getting this wrong makes the tests
 * below quietly vacuous — they'd only ever see a truncated prefix of each tag.
 */
function tags(file: string): string[] {
  const src = readFileSync(resolve(`./${file}`), 'utf8');
  const out: string[] = [];
  for (const open of src.matchAll(/<[A-Za-z][\w.]*/g)) {
    const from = open.index;
    let depth = 0;
    let quote = '';
    let i = from + open[0].length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    out.push(src.slice(from, i + 1));
  }
  return out;
}

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

  it('never puts a React key on a live region', () => {
    // A `key` on the live region itself remounts the node whenever it changes,
    // and a remounted live region usually announces nothing — which silently
    // removes the announcement the region exists for. Key an inner element.
    const keyed = sources.flatMap((file) =>
      tags(file)
        .filter((tag) => /aria-live=/.test(tag) && /\bkey=\{/.test(tag))
        .map(() => file),
    );
    expect(keyed).toEqual([]);
  });
});

describe('labels', () => {
  it('has no <label> that labels nothing', () => {
    // These render as ordinary small bold text, so they look right and do
    // nothing: no htmlFor, and nothing wrapped. Groups of controls (the buddy
    // picker, the grade bands) use role="group" + aria-labelledby and a
    // .field-label span instead.
    const orphans = sources.flatMap((file) =>
      tags(file)
        .filter((tag) => tag.startsWith('<label') && !/\bhtmlFor=/.test(tag))
        .map(() => file),
    );
    expect(orphans).toEqual([]);
  });
});

describe('custom interactive elements', () => {
  it('gives every focusable div with a keyboard handler a role', () => {
    // A tabbable div with its own key bindings and no role is announced as
    // nothing, so a screen reader user lands on it with no idea what it is or
    // which keys do something (WCAG 4.1.2).
    const roleless = sources.flatMap((file) =>
      tags(file)
        .filter(
          (tag) =>
            tag.startsWith('<div') &&
            /tabIndex=\{0\}/.test(tag) &&
            /onKeyDown=/.test(tag) &&
            !/\brole=/.test(tag),
        )
        .map(() => file),
    );
    expect(roleless).toEqual([]);
  });
});
