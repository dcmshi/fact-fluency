import { describe, expect, it } from 'vitest';
import type { Fact, FactProgress } from '@shared';
import {
  FAMILY_TRANSFER_BOX,
  factId,
  familyHint,
  familyTransfer,
  generateFacts,
  strategyHint,
} from './facts';

describe('strategyHint', () => {
  const f = (
    operation: 'add' | 'sub' | 'mul' | 'div',
    operandA: number,
    operandB: number,
    answer: number,
  ): Fact => ({ id: factId(operation, operandA, operandB), operation, operandA, operandB, answer });

  it('picks the fitting addition strategy', () => {
    expect(strategyHint(f('add', 3, 3, 6))).toEqual({
      key: 'strategy.addDouble',
      params: { a: 3, answer: 6 },
    });
    expect(strategyHint(f('add', 7, 8, 15))).toEqual({
      key: 'strategy.addMakeTen',
      params: { hi: 8, need: 2, rest: 5, answer: 15 },
    });
    expect(strategyHint(f('add', 0, 5, 5)).key).toBe('strategy.addZero');
    expect(strategyHint(f('add', 2, 3, 5)).key).toBe('strategy.addCountUp');
  });

  it('uses inverse thinking for subtraction and division', () => {
    expect(strategyHint(f('sub', 15, 7, 8))).toEqual({
      key: 'strategy.subThinkAddition',
      params: { a: 15, b: 7, answer: 8 },
    });
    expect(strategyHint(f('div', 12, 3, 4))).toEqual({
      key: 'strategy.divThinkMul',
      params: { a: 12, b: 3, answer: 4 },
    });
  });

  it('picks the fitting multiplication shortcut', () => {
    expect(strategyHint(f('mul', 0, 6, 0)).key).toBe('strategy.mulZero');
    expect(strategyHint(f('mul', 1, 7, 7)).key).toBe('strategy.mulOne');
    expect(strategyHint(f('mul', 2, 6, 12)).key).toBe('strategy.mulDouble');
    expect(strategyHint(f('mul', 5, 6, 30))).toEqual({
      key: 'strategy.mulFive',
      params: { other: 6, tenfold: 60, answer: 30 },
    });
    expect(strategyHint(f('mul', 6, 10, 60)).key).toBe('strategy.mulTen');
    expect(strategyHint(f('mul', 3, 4, 12))).toEqual({
      key: 'strategy.mulBuildUp',
      params: { lo: 3, hiLess: 3, product: 9, answer: 12 },
    });
  });
});

describe('familyHint', () => {
  const fact = (
    operation: 'add' | 'sub' | 'mul' | 'div',
    operandA: number,
    operandB: number,
    answer: number,
  ) => ({
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

describe('familyTransfer', () => {
  const mkFact = (
    operation: Fact['operation'],
    operandA: number,
    operandB: number,
    answer: number,
  ): Fact => ({ id: factId(operation, operandA, operandB), operation, operandA, operandB, answer });

  const sub = mkFact('sub', 15, 7, 8); // 15 − 7 = 8 → sibling add:7+8
  const div = mkFact('div', 56, 7, 8); // 56 ÷ 7 = 8 → sibling mul:7x8
  const base = { profileId: 'p1', prevBox: 4, newBox: 5, siblingProgress: null, now: 1_000_000 };

  it('seeds an unseen add sibling when a sub fact is freshly mastered', () => {
    const seeded = familyTransfer({ ...base, fact: sub });
    expect(seeded).not.toBeNull();
    expect(seeded!.factId).toBe('add:7+8');
    expect(seeded!.box).toBe(FAMILY_TRANSFER_BOX);
    expect(seeded!.state).toBe('review');
    expect(seeded!.dueAt).toBeGreaterThan(base.now); // scheduled forward
  });

  it('seeds an unseen mul sibling when a div fact is freshly mastered', () => {
    expect(familyTransfer({ ...base, fact: div })!.factId).toBe('mul:7x8');
  });

  it('never auto-grants mastery — the head start is below box 5', () => {
    expect(familyTransfer({ ...base, fact: sub })!.box).toBeLessThan(5);
  });

  it('does nothing for base operations (add/mul have no sibling)', () => {
    expect(familyTransfer({ ...base, fact: mkFact('add', 7, 8, 15) })).toBeNull();
    expect(familyTransfer({ ...base, fact: mkFact('mul', 7, 8, 56) })).toBeNull();
  });

  it('only fires on the transition into mastery', () => {
    expect(familyTransfer({ ...base, fact: sub, prevBox: 5, newBox: 5 })).toBeNull(); // already mastered
    expect(familyTransfer({ ...base, fact: sub, prevBox: 3, newBox: 4 })).toBeNull(); // not mastered yet
  });

  it('nudges (not reseeds) a sibling already on its own track', () => {
    // A box-1 sibling keeps its stats and gets a capped one-box raise —
    // never re-seeded at FAMILY_TRANSFER_BOX, never auto-mastered.
    const siblingProgress = {
      profileId: 'p1',
      factId: 'add:7+8',
      box: 1,
      state: 'review',
      dueAt: 0,
      lastSeenAt: 0,
      reps: 2,
      fastCorrect: 0,
      correctStreak: 0,
      accuracyEwma: 0.5,
      medianMsEwma: 3000,
    } satisfies FactProgress;
    const nudged = familyTransfer({ ...base, fact: sub, siblingProgress });
    expect(nudged).toMatchObject({ factId: 'add:7+8', box: 2, reps: 2, accuracyEwma: 0.5 });
  });
});

describe('familyTransfer — in-progress sibling nudge', () => {
  const subFact = generateFacts('sub', { aMin: 0, aMax: 10, bMin: 0, bMax: 10 }).find(
    (f) => f.operandA === 9 && f.operandB === 4,
  )!; // 9 - 4 = 5, sibling add:4+5

  const siblingAt = (box: 1 | 2 | 3): FactProgress => ({
    profileId: 'p1',
    factId: 'add:4+5',
    box,
    state: box === 3 ? 'review' : 'review',
    dueAt: 500,
    lastSeenAt: 100,
    reps: 2,
    fastCorrect: 1,
    correctStreak: 1,
    accuracyEwma: 0.8,
    medianMsEwma: 2000,
  });

  it('raises a box-1/2 sibling one box, keeping its stats', () => {
    const nudged = familyTransfer({
      fact: subFact,
      prevBox: 4,
      newBox: 5,
      profileId: 'p1',
      siblingProgress: siblingAt(2),
      now: 1000,
    });
    expect(nudged).toMatchObject({ factId: 'add:4+5', box: 3, reps: 2, accuracyEwma: 0.8 });
    expect(nudged!.dueAt).toBeGreaterThan(1000); // rescheduled at the new box
  });

  it('leaves a box-3+ sibling and a learning-phase sibling alone', () => {
    expect(
      familyTransfer({
        fact: subFact,
        prevBox: 4,
        newBox: 5,
        profileId: 'p1',
        siblingProgress: siblingAt(3),
        now: 1000,
      }),
    ).toBeNull();
    expect(
      familyTransfer({
        fact: subFact,
        prevBox: 4,
        newBox: 5,
        profileId: 'p1',
        siblingProgress: { ...siblingAt(1), box: 0, state: 'learning' },
        now: 1000,
      }),
    ).toBeNull();
  });
});
