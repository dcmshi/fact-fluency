/**
 * Fact generation — pure, no side effects. Implements DESIGN.md §3.1/§3.2.
 *
 * The fact universe is small and deterministic, so facts are generated rather
 * than stored. Commutative operations (add, mul) are canonicalized so a ≤ b,
 * making `3 + 7` and `7 + 3` the same fact. Subtraction is the inverse of
 * addition (never negative); division the inverse of multiplication (whole
 * quotients, never ÷0).
 */
import type { Box, Fact, FactHint, FactProgress, FactSet, Operation, RangeSpec } from '@shared';
import { dueAtForBox, stateForBox } from './scheduling';

/** Canonical, stable id for a fact. Commutative ops are written with a ≤ b. */
export function factId(operation: Operation, a: number, b: number): string {
  switch (operation) {
    case 'add': {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return `add:${lo}+${hi}`;
    }
    case 'mul': {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return `mul:${lo}x${hi}`;
    }
    case 'sub':
      return `sub:${a}-${b}`;
    case 'div':
      return `div:${a}/${b}`;
  }
}

function makeFact(operation: Operation, operandA: number, operandB: number, answer: number): Fact {
  return { id: factId(operation, operandA, operandB), operation, operandA, operandB, answer };
}

/**
 * Generate every fact in a set's range. Output is de-duplicated (commutative
 * canonicalization) and stable-ordered by ascending difficulty (§3.2):
 * (operandA + operandB), then answer.
 */
export function generateFacts(operation: Operation, range: RangeSpec): Fact[] {
  const byId = new Map<string, Fact>();

  switch (operation) {
    case 'add':
      for (let a = range.aMin; a <= range.aMax; a++) {
        for (let b = range.bMin; b <= range.bMax; b++) {
          const fact = makeFact('add', Math.min(a, b), Math.max(a, b), a + b);
          byId.set(fact.id, fact);
        }
      }
      break;

    case 'mul':
      for (let a = range.aMin; a <= range.aMax; a++) {
        for (let b = range.bMin; b <= range.bMax; b++) {
          const fact = makeFact('mul', Math.min(a, b), Math.max(a, b), a * b);
          byId.set(fact.id, fact);
        }
      }
      break;

    case 'sub':
      // Inverse of addition: minuend m, subtrahend b ≤ m, so answer ≥ 0.
      for (let m = range.aMin; m <= range.aMax; m++) {
        const bHi = Math.min(m, range.bMax);
        for (let b = range.bMin; b <= bHi; b++) {
          const fact = makeFact('sub', m, b, m - b);
          byId.set(fact.id, fact);
        }
      }
      break;

    case 'div': {
      // Inverse of multiplication: quotient q, divisor d ≥ 1, dividend = q·d.
      const dLo = Math.max(1, range.bMin);
      for (let q = range.aMin; q <= range.aMax; q++) {
        for (let d = dLo; d <= range.bMax; d++) {
          const fact = makeFact('div', q * d, d, q);
          byId.set(fact.id, fact);
        }
      }
      break;
    }
  }

  return [...byId.values()].sort(byDifficulty);
}

/** Ascending difficulty: operand sum, then answer (DESIGN.md §3.2). */
function byDifficulty(x: Fact, y: Fact): number {
  return x.operandA + x.operandB - (y.operandA + y.operandB) || x.answer - y.answer;
}

/**
 * Per-set generation cache. The catalog is static, so the same (operation,
 * range) is generated over and over across requests (every dashboard load
 * regenerates all ~24 sets — DESIGN.md §7). Keyed by the generating inputs, not
 * set id, so it stays correct even for ad-hoc sets. Cached arrays are treated as
 * immutable — `generateFactsForSets` only ever reads them.
 */
const setFactsCache = new Map<string, Fact[]>();
function factsForSet(set: FactSet): Fact[] {
  const r = set.rangeSpec;
  const key = `${set.operation}:${r.aMin}-${r.aMax}:${r.bMin}-${r.bMax}`;
  let facts = setFactsCache.get(key);
  if (!facts) {
    facts = generateFacts(set.operation, r);
    setFactsCache.set(key, facts);
  }
  return facts;
}

/**
 * The de-duplicated candidate fact universe across several enabled sets,
 * globally ordered easiest-first. Overlapping sets (e.g. add 0–5 ⊂ add 0–10)
 * contribute each fact once. Returns a fresh array each call (callers may
 * reorder/slice it); the Fact objects within are shared, immutable value types.
 */
export function generateFactsForSets(sets: FactSet[]): Fact[] {
  const byId = new Map<string, Fact>();
  for (const set of sets) {
    for (const fact of factsForSet(set)) byId.set(fact.id, fact);
  }
  return [...byId.values()].sort(byDifficulty);
}

/**
 * The inverse "sibling" that frames a subtraction/division fact for transfer
 * (DESIGN.md §9): since `sub`/`div` are generated as inverses (§3.1), a sub fact
 * `m − b = a` is explained by `a + b = m`, and a div fact `n ÷ d = q` by
 * `q × d = n`. Returns null for add/mul (the base operations have no framing).
 */
export function familyHint(fact: Fact): FactHint | null {
  switch (fact.operation) {
    case 'sub':
      return {
        operandA: fact.answer,
        operandB: fact.operandB,
        operation: 'add',
        answer: fact.operandA,
      };
    case 'div':
      return {
        operandA: fact.answer,
        operandB: fact.operandB,
        operation: 'mul',
        answer: fact.operandA,
      };
    default:
      return null;
  }
}

/** The canonical id of a fact's inverse sibling, or null for the base ops. */
export function siblingFactId(fact: Fact): string | null {
  const hint = familyHint(fact);
  return hint ? factId(hint.operation, hint.operandA, hint.operandB) : null;
}

/** Box a freshly-mastered fact lends its unseen inverse sibling — a review head
 *  start, never auto-mastery (box 5 must still be earned directly, §4.3). */
export const FAMILY_TRANSFER_BOX: Box = 3;

/**
 * Fact-family scheduling transfer (DESIGN.md §9). A sub/div fact is the inverse
 * of an add/mul one (§3.1), so mastering it is strong evidence the kid knows the
 * sibling too. When such a fact is *freshly* mastered, seed its sibling into
 * review at `FAMILY_TRANSFER_BOX` so it's met as review rather than cold — but
 * only if the sibling is still unseen (never demote/disturb a sibling already on
 * its own track, and never grant mastery the kid hasn't earned directly).
 *
 * Pure: the caller supplies the sibling's current progress and gets back the row
 * to upsert, or null when no transfer applies. One direction only (sub→add,
 * div→mul) — `familyHint` returns null for the base ops.
 */
export function familyTransfer(args: {
  fact: Fact;
  prevBox: number;
  newBox: number;
  profileId: string;
  /** The sibling's current progress, or null if unseen. */
  siblingProgress: FactProgress | null;
  now: number;
  tzOffsetMin?: number;
}): FactProgress | null {
  const siblingId = siblingFactId(args.fact);
  if (!siblingId) return null; // base op — nothing to seed
  if (!(args.newBox === 5 && args.prevBox < 5)) return null; // only on entering mastery
  if (args.siblingProgress) return null; // only seed an unseen sibling

  const box = FAMILY_TRANSFER_BOX;
  return {
    profileId: args.profileId,
    factId: siblingId,
    box,
    state: stateForBox(box),
    dueAt: dueAtForBox(box, args.now, args.tzOffsetMin ?? 0, 1),
    lastSeenAt: args.now,
    reps: 0,
    fastCorrect: 0,
    correctStreak: 0,
    accuracyEwma: 0,
    medianMsEwma: 0,
  };
}
