import { describe, expect, it } from 'vitest';
import { cellBackground } from './ProgressPage';

/**
 * The fact grid used to convey mastery with shade alone: boxes 0–4 differed only
 * by alpha (0.2 → 0.66) and "unseen" looked much like box 0. The bar layer is
 * the non-color cue (WCAG 1.4.1), so what matters is that it is present, that it
 * is monotonic in the box number, and that "unseen" has none.
 */
const barPct = (css: string): number | null => {
  const m = /transparent (\d+(?:\.\d+)?)%\)/.exec(css);
  return m ? Number(m[1]) : null;
};

describe('cellBackground', () => {
  it('gives an unseen fact a flat fill and no bar', () => {
    const css = cellBackground('mul', null, 'unseen');
    expect(css).toBe('#f1e7d5');
    expect(barPct(css)).toBeNull();
  });

  it('gives a fact with no box yet no bar even if it is not marked unseen', () => {
    expect(barPct(cellBackground('mul', null, 'review'))).toBeNull();
  });

  it('grows the bar monotonically from box 0 to mastered', () => {
    const pcts = ([0, 1, 2, 3, 4, 5] as const).map((b) =>
      barPct(cellBackground('add', b, 'review')),
    );
    expect(pcts).toEqual([16.7, 33.3, 50.0, 66.7, 83.3, 100.0]);
  });

  it('keeps the operation fill underneath the bar', () => {
    expect(cellBackground('sub', 0, 'review')).toContain('rgba(255, 107, 92, 0.2)');
    expect(cellBackground('sub', 5, 'mastered')).toContain('rgba(255, 107, 92, 1)');
  });
});
