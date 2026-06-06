import { describe, expect, it } from 'vitest';
import { buildBoard, makeRng, pickRelation, satisfies, seedFrom } from './munch';

describe('satisfies', () => {
  it('applies the relation against the target', () => {
    expect(satisfies('=', 12, 12)).toBe(true);
    expect(satisfies('=', 12, 11)).toBe(false);
    expect(satisfies('<', 12, 5)).toBe(true);
    expect(satisfies('<', 12, 12)).toBe(false);
    expect(satisfies('>', 12, 20)).toBe(true);
    expect(satisfies('>', 12, 12)).toBe(false);
  });
});

describe('makeRng', () => {
  it('is deterministic for a given seed and varies across seeds', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    expect(a()).toBe(b());
    expect(a()).toBe(b());
    expect(makeRng(1)()).not.toBe(makeRng(2)());
  });
});

describe('pickRelation', () => {
  it('never picks < when the target is too small to have a pool', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(pickRelation(1, makeRng(seed))).not.toBe('<');
      expect(pickRelation(0, makeRng(seed))).not.toBe('<');
    }
  });
  it('can pick < for larger targets', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 50; seed++) seen.add(pickRelation(10, makeRng(seed)));
    expect(seen.has('<')).toBe(true);
  });
});

describe('buildBoard', () => {
  const countCorrect = (b: ReturnType<typeof buildBoard>) =>
    b.cells.filter((v) => satisfies(b.relation, b.target, v)).length;

  it('fills a size*size grid with a bounded number of correct cells', () => {
    const b = buildBoard({
      target: 12,
      relation: '=',
      rng: makeRng(7),
      size: 5,
      minCorrect: 3,
      maxCorrect: 8,
    });
    expect(b.cells).toHaveLength(25);
    const correct = countCorrect(b);
    expect(correct).toBeGreaterThanOrEqual(3);
    expect(correct).toBeLessThanOrEqual(8);
    // and there are distractors too
    expect(correct).toBeLessThan(25);
  });

  it('equality boards put the target value in every correct cell', () => {
    const b = buildBoard({ target: 12, relation: '=', rng: makeRng(3) });
    for (const v of b.cells) if (v !== 12) expect(satisfies('=', 12, v)).toBe(false);
    expect(b.cells.filter((v) => v === 12).length).toBeGreaterThanOrEqual(1);
  });

  it('less-than / greater-than correct cells all satisfy the relation', () => {
    const lt = buildBoard({ target: 9, relation: '<', rng: makeRng(11) });
    for (const v of lt.cells.filter((v) => satisfies('<', 9, v))) expect(v).toBeLessThan(9);
    const gt = buildBoard({ target: 9, relation: '>', rng: makeRng(13) });
    for (const v of gt.cells.filter((v) => satisfies('>', 9, v))) expect(v).toBeGreaterThan(9);
    expect(lt.cells.every((v) => v >= 0)).toBe(true); // never negative
  });

  it('falls back to equality when the relation has no valid cells', () => {
    // target 0 with '<' has no non-negative value below it.
    const b = buildBoard({ target: 0, relation: '<', rng: makeRng(5) });
    expect(b.relation).toBe('=');
    expect(b.cells.some((v) => v === 0)).toBe(true);
  });

  it('is reproducible for the same seed', () => {
    const a = buildBoard({ target: 8, relation: '>', rng: makeRng(99) });
    const b = buildBoard({ target: 8, relation: '>', rng: makeRng(99) });
    expect(a.cells).toEqual(b.cells);
  });
});

describe('seedFrom', () => {
  it('is stable and differs by input', () => {
    expect(seedFrom('s1:mul:3x4:0')).toBe(seedFrom('s1:mul:3x4:0'));
    expect(seedFrom('s1:mul:3x4:0')).not.toBe(seedFrom('s1:mul:3x4:1'));
  });
});
