import { describe, expect, it } from 'vitest';
import type { Card } from '@shared';
import { spliceInject } from './injects';

const card = (id: string, isNew = false): Card => ({
  fact: { id, operation: 'add', operandA: 1, operandB: 1, answer: 2 },
  answer: 2,
  isNew,
});

const ids = (q: Card[]) => q.map((c) => c.fact.id);

describe('spliceInject', () => {
  it('lands afterOffset rounds after the answered card when the response is instant', () => {
    // Response arrives during the round right after the answer (advanced = 0):
    // the full gap remains, so the re-show sits after 3 intervening cards.
    const q = [card('c1'), card('c2'), card('c3'), card('c4')];
    expect(ids(spliceInject(q, card('A'), 3, 0))).toEqual(['c1', 'c2', 'c3', 'A', 'c4']);
  });

  it('compensates for rounds already played while the response was in flight', () => {
    // Two more rounds finished before the response landed — only one slot of
    // the gap remains.
    const q = [card('c3'), card('c4')];
    expect(ids(spliceInject(q, card('A'), 3, 2))).toEqual(['c3', 'A', 'c4']);
  });

  it('never lands on the currently-playing slot, however late the response', () => {
    const q = [card('c5'), card('c6')];
    expect(ids(spliceInject(q, card('A'), 3, 7))).toEqual(['c5', 'A', 'c6']);
  });

  it('clamps to the end of a short queue', () => {
    const q = [card('c1')];
    expect(ids(spliceInject(q, card('A'), 3, 0))).toEqual(['c1', 'A']);
  });

  it('skips the re-show entirely when the queue is empty (session wrapping up)', () => {
    expect(spliceInject([], card('A'), 3, 0)).toEqual([]);
  });

  it('strips isNew so the re-show is a plain round, not a study card', () => {
    const q = [card('c1'), card('c2')];
    const out = spliceInject(q, card('A', true), 3, 1);
    expect(out.find((c) => c.fact.id === 'A')?.isNew).toBe(false);
  });
});
