import { describe, expect, it } from 'vitest';
import { factId, familyHint, generateFacts } from './facts';

describe('familyHint', () => {
  const fact = (operation: 'add' | 'sub' | 'mul' | 'div', operandA: number, operandB: number, answer: number) => ({
    id: factId(operation, operandA, operandB),
    operation,
    operandA,
    operandB,
    answer,
  });

  it('frames a division fact with its multiplication sibling', () => {
    // 56 ÷ 7 = 8  ←  8 × 7 = 56
    expect(familyHint(fact('div', 56, 7, 8))).toEqual({
      operandA: 8,
      operandB: 7,
      operation: 'mul',
      answer: 56,
    });
  });

  it('frames a subtraction fact with its addition sibling', () => {
    // 15 − 7 = 8  ←  8 + 7 = 15
    expect(familyHint(fact('sub', 15, 7, 8))).toEqual({
      operandA: 8,
      operandB: 7,
      operation: 'add',
      answer: 15,
    });
  });

  it('returns null for the base operations (add/mul)', () => {
    expect(familyHint(fact('add', 3, 7, 10))).toBeNull();
    expect(familyHint(fact('mul', 3, 7, 21))).toBeNull();
  });
});

describe('factId', () => {
  it('canonicalizes commutative operations to a ≤ b', () => {
    expect(factId('add', 7, 3)).toBe('add:3+7');
    expect(factId('add', 3, 7)).toBe('add:3+7');
    expect(factId('mul', 8, 2)).toBe('mul:2x8');
    expect(factId('mul', 2, 8)).toBe('mul:2x8');
  });

  it('keeps order for non-commutative operations', () => {
    expect(factId('sub', 15, 7)).toBe('sub:15-7');
    expect(factId('div', 56, 7)).toBe('div:56/7');
  });
});

describe('generateFacts: add', () => {
  it('dedupes commutative pairs', () => {
    const facts = generateFacts('add', { aMin: 0, aMax: 2, bMin: 0, bMax: 2 });
    // 0..2 x 0..2 canonicalized = {0+0,0+1,0+2,1+1,1+2,2+2} = 6 facts
    expect(facts).toHaveLength(6);
    expect(facts.every((f) => f.operandA <= f.operandB)).toBe(true);
    expect(facts.find((f) => f.id === 'add:1+2')?.answer).toBe(3);
  });

  it('orders easiest-first by operand sum then answer', () => {
    const facts = generateFacts('add', { aMin: 0, aMax: 3, bMin: 0, bMax: 3 });
    const sums = facts.map((f) => f.operandA + f.operandB);
    expect(sums).toEqual([...sums].sort((a, b) => a - b));
  });
});

describe('generateFacts: mul', () => {
  it('produces correct products and dedupes', () => {
    const facts = generateFacts('mul', { aMin: 0, aMax: 12, bMin: 0, bMax: 12 });
    // 13x13 grid, canonicalized: 13*14/2 = 91 facts
    expect(facts).toHaveLength(91);
    expect(facts.find((f) => f.id === 'mul:7x8')?.answer).toBe(56);
  });
});

describe('generateFacts: sub', () => {
  it('never produces a negative answer', () => {
    const facts = generateFacts('sub', { aMin: 0, aMax: 20, bMin: 0, bMax: 20 });
    expect(facts.every((f) => f.answer >= 0)).toBe(true);
    expect(facts.every((f) => f.operandA >= f.operandB)).toBe(true);
    expect(facts.find((f) => f.id === 'sub:15-7')?.answer).toBe(8);
  });
});

describe('generateFacts: div', () => {
  it('never divides by zero and yields whole quotients', () => {
    const facts = generateFacts('div', { aMin: 0, aMax: 12, bMin: 0, bMax: 12 });
    expect(facts.every((f) => f.operandB >= 1)).toBe(true);
    expect(facts.every((f) => Number.isInteger(f.answer))).toBe(true);
    expect(facts.every((f) => f.operandA === f.answer * f.operandB)).toBe(true);
    expect(facts.find((f) => f.id === 'div:56/7')?.answer).toBe(8);
  });
});
