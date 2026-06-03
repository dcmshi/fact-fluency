/**
 * Fact generation — pure, no side effects. Implements DESIGN.md §3.1/§3.2.
 *
 * The fact universe is small and deterministic, so facts are generated rather
 * than stored. Commutative operations (add, mul) are canonicalized so a ≤ b,
 * making `3 + 7` and `7 + 3` the same fact. Subtraction is the inverse of
 * addition (never negative); division the inverse of multiplication (whole
 * quotients, never ÷0).
 */
import type { Fact, Operation, RangeSpec } from '@shared';

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

  return [...byId.values()].sort(
    (x, y) => x.operandA + x.operandB - (y.operandA + y.operandB) || x.answer - y.answer,
  );
}
