/**
 * Munch-board generation — pure (Number Munchers–style play). Given a target
 * (a fact's answer) and a relation, lay out a `size`×`size` grid where some
 * cells satisfy the relation (the ones to munch) and the rest are plausible
 * distractors. Deterministic: all randomness comes from an injected `rng`, so
 * boards are reproducible and unit-testable. No Date/Math.random reached for.
 */
import type { MunchBoard, MunchRelation } from '@shared';

/** Does `value` satisfy `relation` against `target`? (The munch rule.) */
export function satisfies(relation: MunchRelation, target: number, value: number): boolean {
  switch (relation) {
    case '=':
      return value === target;
    case '<':
      return value < target;
    case '>':
      return value > target;
  }
}

/** Small deterministic PRNG (mulberry32) → values in [0, 1). */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a string (FNV-1a), for per-round determinism. */
export function seedFrom(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick a feasible relation. `<` needs a target ≥ 2 (so there's a real pool of
 * smaller numbers); `=` is weighted a little higher since it most directly
 * reinforces the fact.
 */
export function pickRelation(target: number, rng: () => number): MunchRelation {
  const pool: MunchRelation[] = ['=', '=', '>'];
  if (target >= 2) pool.push('<');
  return pool[Math.floor(rng() * pool.length)];
}

const pick = <T>(arr: T[], rng: () => number): T => arr[Math.floor(rng() * arr.length)];

export interface BuildBoardInput {
  target: number;
  relation: MunchRelation;
  rng: () => number;
  size?: number;
  minCorrect?: number;
  maxCorrect?: number;
}

/**
 * Build a board with between `minCorrect` and `maxCorrect` cells satisfying the
 * relation and the rest plausible distractors (values clustered near the
 * target). Guarantees at least one correct cell.
 */
export function buildBoard(input: BuildBoardInput): MunchBoard {
  const { target, relation, rng } = input;
  const size = input.size ?? 5;
  const total = size * size;

  const lo = 0;
  const hi = target + 10;
  const all: number[] = [];
  for (let v = lo; v <= hi; v++) all.push(v);

  const correctPool = all.filter((v) => satisfies(relation, target, v));
  const wrongPool = all.filter((v) => !satisfies(relation, target, v));
  // Feasibility is the caller's job (pickRelation), but never emit a board with
  // no correct cell: fall back to equality, which always has the target itself.
  const effectiveRelation: MunchRelation = correctPool.length === 0 ? '=' : relation;
  const corrects = correctPool.length === 0 ? [target] : correctPool;
  const wrongs = wrongPool.length === 0 ? all.filter((v) => v !== target) : wrongPool;

  const minCorrect = Math.max(1, input.minCorrect ?? 3);
  const maxCorrect = Math.min(total - 1, input.maxCorrect ?? 8);
  const nCorrect = Math.min(
    total - 1,
    minCorrect + Math.floor(rng() * (maxCorrect - minCorrect + 1)),
  );

  const cells: number[] = [];
  for (let i = 0; i < nCorrect; i++) cells.push(pick(corrects, rng));
  while (cells.length < total) cells.push(pick(wrongs, rng));

  // Fisher–Yates shuffle so correct cells aren't clustered at the front.
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }

  return { target, relation: effectiveRelation, size, cells };
}
