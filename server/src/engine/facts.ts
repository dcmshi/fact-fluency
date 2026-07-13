/**
 * Fact generation — pure, no side effects. Implements DESIGN.md §3.1/§3.2.
 *
 * The fact universe is small and deterministic, so facts are generated rather
 * than stored. Commutative operations (add, mul) are canonicalized so a ≤ b,
 * making `3 + 7` and `7 + 3` the same fact. Subtraction is the inverse of
 * addition (never negative); division the inverse of multiplication (whole
 * quotients, never ÷0).
 */
import type {
  Box,
  Fact,
  FactHint,
  FactProgress,
  FactSet,
  LocalizedText,
  Operation,
  RangeSpec,
} from '@shared';
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

/**
 * A warm, kid-friendly *strategy* for deriving a fact — Reflex-style
 * "just-in-time coaching" (COMPETITORS.md), shown on the study card so a missed
 * fact teaches a way to get it, not just the answer. Pure; picks the most
 * useful strategy for the fact (doubles, make-ten, ×10/×5 shortcuts, build-up,
 * or the inverse relationship). Operands are canonical (a ≤ b for add/mul; sub/
 * div carry dividend/divisor).
 */
export function strategyHint(fact: Fact): LocalizedText {
  const { operandA: a, operandB: b, answer } = fact;
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  switch (fact.operation) {
    case 'add':
      if (a === 0 || b === 0) return { key: 'strategy.addZero', params: { answer } };
      if (a === b) return { key: 'strategy.addDouble', params: { a, answer } };
      if (a + b > 10 && hi < 10) {
        const need = 10 - hi;
        return { key: 'strategy.addMakeTen', params: { hi, need, rest: lo - need, answer } };
      }
      return { key: 'strategy.addCountUp', params: { lo, hi, answer } };
    case 'sub':
      // a = minuend, b = subtrahend, answer = difference.
      return { key: 'strategy.subThinkAddition', params: { a, b, answer } };
    case 'mul':
      if (a === 0 || b === 0) return { key: 'strategy.mulZero' };
      if (lo === 1) return { key: 'strategy.mulOne', params: { answer } };
      if (lo === 2) return { key: 'strategy.mulDouble', params: { hi, answer } };
      if (a === 10 || b === 10) {
        const other = a === 10 ? b : a;
        return { key: 'strategy.mulTen', params: { other, answer } };
      }
      if (a === 5 || b === 5) {
        const other = a === 5 ? b : a;
        return { key: 'strategy.mulFive', params: { other, tenfold: other * 10, answer } };
      }
      return {
        key: 'strategy.mulBuildUp',
        params: { lo, hiLess: hi - 1, product: lo * (hi - 1), answer },
      };
    case 'div':
      // a = dividend, b = divisor, answer = quotient.
      return { key: 'strategy.divThinkMul', params: { a, b, answer } };
  }
}

/** Box a freshly-mastered fact lends its unseen inverse sibling — a review head
 *  start, never auto-mastery (box 5 must still be earned directly, §4.3). */
export const FAMILY_TRANSFER_BOX: Box = 3;

/** Highest box an in-progress sibling can be *nudged* into (one-box raise). */
export const FAMILY_NUDGE_MAX_BOX: Box = 3;

/**
 * Fact-family scheduling transfer (DESIGN.md §9). A sub/div fact is the inverse
 * of an add/mul one (§3.1), so mastering it is strong evidence the kid knows the
 * sibling too. When such a fact is *freshly* mastered:
 *   - an unseen sibling is seeded into review at `FAMILY_TRANSFER_BOX`, so the
 *     kid meets it as review rather than cold;
 *   - a sibling already early in review (boxes 1–2) gets a capped one-box
 *     nudge, keeping its own track/stats — never auto-mastery, and a sibling
 *     at box 3+ (or still in the learning phase) is left alone.
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
  timeZone?: string;
}): FactProgress | null {
  const siblingId = siblingFactId(args.fact);
  if (!siblingId) return null; // base op — nothing to seed
  if (!(args.newBox === 5 && args.prevBox < 5)) return null; // only on entering mastery

  const sibling = args.siblingProgress;
  if (sibling) {
    // Nudge an early-review sibling one box (capped); leave the learning phase
    // (box 0, graduation is in-session evidence) and boxes ≥ 3 undisturbed.
    if (sibling.box < 1 || sibling.box >= FAMILY_NUDGE_MAX_BOX) return null;
    const box = (sibling.box + 1) as Box;
    return {
      ...sibling,
      box,
      state: stateForBox(box),
      dueAt: dueAtForBox(box, args.now, args.timeZone ?? 'UTC', 1),
    };
  }

  const box = FAMILY_TRANSFER_BOX;
  return {
    profileId: args.profileId,
    factId: siblingId,
    box,
    state: stateForBox(box),
    dueAt: dueAtForBox(box, args.now, args.timeZone ?? 'UTC', 1),
    lastSeenAt: args.now,
    reps: 0,
    fastCorrect: 0,
    correctStreak: 0,
    accuracyEwma: 0,
    medianMsEwma: 0,
  };
}
