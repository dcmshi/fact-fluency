import { describe, expect, it } from 'vitest';
import type { Box, Fact, FactProgress } from '@shared';
import {
  DEFAULT_MAX_NEW_PER_SESSION,
  newFactAllotment,
  planSession,
  type PlannerInput,
} from './planner';

const NOW = 1_000_000;

/** A throwaway fact; `n` drives both id and difficulty ordering. */
function fact(n: number): Fact {
  return { id: `mul:${n}`, operation: 'mul', operandA: n, operandB: 1, answer: n };
}

function progress(box: Box, dueAt: number): FactProgress {
  return {
    profileId: 'p',
    factId: '',
    box,
    state: box === 0 ? 'learning' : box === 5 ? 'mastered' : 'review',
    dueAt,
    lastSeenAt: 0,
    reps: 1,
    fastCorrect: 0,
    correctStreak: 0,
    accuracyEwma: 1,
    medianMsEwma: 3000,
  };
}

function input(over: Partial<PlannerInput> & { facts: Fact[] }): PlannerInput {
  return {
    progressByFactId: new Map(),
    now: NOW,
    sessionCards: 20,
    newPerSession: 3,
    ...over,
  };
}

const ids = (cards: { fact: Fact }[]) => cards.map((c) => c.fact.id);
const unique = (arr: string[]) => new Set(arr).size === arr.length;

describe('planSession — composition', () => {
  it('caps the deck at sessionCards and keeps facts unique', () => {
    // 50 due-review facts (so the cap under test is sessionCards, not new-fact).
    const facts = Array.from({ length: 50 }, (_, i) => fact(i));
    const progressByFactId = new Map(
      facts.map((f) => [f.id, { ...progress(2, NOW - 1000), factId: f.id }]),
    );
    const deck = planSession(input({ facts, progressByFactId, newPerSession: 0 }));
    expect(deck).toHaveLength(20);
    expect(unique(ids(deck))).toBe(true);
  });

  it('gives a brand-new profile a short, all-new first session (no flood)', () => {
    const facts = Array.from({ length: 30 }, (_, i) => fact(i));
    const deck = planSession(input({ facts })); // nothing due → fill is all new
    expect(deck.every((c) => c.isNew)).toBe(true);
    // Capped well below sessionCards (20) so beginners aren't flooded.
    expect(deck).toHaveLength(DEFAULT_MAX_NEW_PER_SESSION);
    // easiest-first: the new facts are taken from the front of the universe.
    expect(ids(deck).slice(0, 3)).toEqual(['mul:0', 'mul:1', 'mul:2']);
  });

  it('never introduces more than the new-fact cap, even with a huge unseen pool', () => {
    const facts = Array.from({ length: 100 }, (_, i) => fact(i));
    const deck = planSession(input({ facts, newPerSession: 3, sessionCards: 20 }));
    expect(deck.filter((c) => c.isNew)).toHaveLength(DEFAULT_MAX_NEW_PER_SESSION);
  });

  it('respects a higher newPerSession over the default cap', () => {
    const facts = Array.from({ length: 30 }, (_, i) => fact(i));
    const deck = planSession(input({ facts, newPerSession: 10, sessionCards: 20 }));
    // newPerSession (10) exceeds the default cap (6), so it wins.
    expect(deck.filter((c) => c.isNew)).toHaveLength(10);
  });

  it('mixes a few new facts among due review, without clustering or leading', () => {
    const review = Array.from({ length: 30 }, (_, i) => fact(100 + i));
    const unseen = Array.from({ length: 30 }, (_, i) => fact(i));
    const progressByFactId = new Map(
      review.map((f) => [f.id, { ...progress(2, NOW - 1000), factId: f.id }]),
    );
    const deck = planSession(input({ facts: [...unseen, ...review], progressByFactId }));

    expect(deck).toHaveLength(20);
    expect(deck.filter((c) => c.isNew)).toHaveLength(3);
    expect(deck[0].isNew).toBe(false); // opens with an easy win
    for (let i = 0; i < deck.length - 1; i++) {
      expect(deck[i].isNew && deck[i + 1].isNew).toBe(false); // never two new adjacent
    }
  });

  it('still spaces new facts when they are a large share of a short deck', () => {
    // Only 14 facts are due, so short-deck padding tops the deck up with new
    // ones — the case where the spacing arithmetic actually matters. The gap was
    // computed per *total* card but counted only review cards between intros, so
    // the review pool drained early and the leftovers piled up at the end
    // (…rrFF): two cold facts back to back, at the point a kid is most tired.
    const review = Array.from({ length: 14 }, (_, i) => fact(100 + i));
    const unseen = Array.from({ length: 30 }, (_, i) => fact(i));
    const progressByFactId = new Map(
      review.map((f) => [f.id, { ...progress(2, NOW - 1000), factId: f.id }]),
    );
    const deck = planSession(input({ facts: [...unseen, ...review], progressByFactId }));

    expect(deck).toHaveLength(20);
    expect(deck.filter((c) => c.isNew)).toHaveLength(6);
    expect(deck[0].isNew).toBe(false);
    for (let i = 0; i < deck.length - 1; i++) {
      expect(deck[i].isNew && deck[i + 1].isNew).toBe(false);
    }
  });
});

describe('planSession — scheduling buckets', () => {
  it('orders due review most-overdue first', () => {
    const facts = [fact(1), fact(2), fact(3)];
    const progressByFactId = new Map([
      ['mul:1', { ...progress(2, NOW - 100), factId: 'mul:1' }],
      ['mul:2', { ...progress(2, NOW - 5000), factId: 'mul:2' }],
      ['mul:3', { ...progress(2, NOW - 1000), factId: 'mul:3' }],
    ]);
    const deck = planSession(input({ facts, progressByFactId, newPerSession: 0 }));
    expect(ids(deck)).toEqual(['mul:2', 'mul:3', 'mul:1']); // by ascending dueAt
  });

  it('treats box-0 (still learning) facts as due even if dueAt is in the future', () => {
    const facts = [fact(1)];
    const progressByFactId = new Map([
      ['mul:1', { ...progress(0, NOW + 999_999), factId: 'mul:1' }],
    ]);
    const deck = planSession(input({ facts, progressByFactId, newPerSession: 0 }));
    expect(ids(deck)).toEqual(['mul:1']);
    expect(deck[0].isNew).toBe(false); // it has progress, so not "new"
  });

  it('pulls upcoming review forward only when nothing is due', () => {
    const facts = [fact(1), fact(2)];
    const progressByFactId = new Map([
      ['mul:1', { ...progress(3, NOW + 10_000), factId: 'mul:1' }],
      ['mul:2', { ...progress(3, NOW + 5_000), factId: 'mul:2' }],
    ]);
    const deck = planSession(input({ facts, progressByFactId, newPerSession: 0 }));
    expect(ids(deck)).toEqual(['mul:2', 'mul:1']); // soonest-upcoming first
  });

  it('uses mastered facts only as a last resort', () => {
    const due = fact(1);
    const masteredFact = fact(2);
    const progressByFactId = new Map([
      ['mul:1', { ...progress(2, NOW - 1000), factId: 'mul:1' }],
      ['mul:2', { ...progress(5, NOW + 100_000), factId: 'mul:2' }],
    ]);
    // With a due fact available and sessionCards=1, the mastered one is skipped.
    const deck = planSession(
      input({ facts: [due, masteredFact], progressByFactId, newPerSession: 0, sessionCards: 1 }),
    );
    expect(ids(deck)).toEqual(['mul:1']);
  });
});

describe('accuracy-aware new-fact throttle (§4.4)', () => {
  it('bands the allotment by recent accuracy', () => {
    expect(newFactAllotment(4, null)).toBe(4); // no data — full flow
    expect(newFactAllotment(4, 0.9)).toBe(4); // doing great
    expect(newFactAllotment(4, 0.85)).toBe(4); // at the high bar
    expect(newFactAllotment(4, 0.8)).toBe(2); // middling — halved
    expect(newFactAllotment(3, 0.8)).toBe(2); // ceil of half
    expect(newFactAllotment(4, 0.7)).toBe(0); // struggling — pause intros
  });

  it('pauses cold intros entirely when the kid is struggling', () => {
    const facts = Array.from({ length: 12 }, (_, n) => fact(n));
    const deck = planSession({
      facts,
      progressByFactId: new Map(),
      now: NOW,
      sessionCards: 10,
      newPerSession: 3,
      recentAccuracy: 0.6,
    });
    // Nothing due, nothing upcoming, and new facts are throttled to zero —
    // including the short-deck padding, which must not refill with intros.
    expect(deck).toHaveLength(0);
  });

  it('halves the allotment in the middle accuracy band', () => {
    const facts = Array.from({ length: 12 }, (_, n) => fact(n));
    const deck = planSession({
      facts,
      progressByFactId: new Map(),
      now: NOW,
      sessionCards: 10,
      newPerSession: 4,
      recentAccuracy: 0.8,
    });
    // Allotment 2, and the padding cap is halved too (6 -> 3).
    expect(deck.filter((c) => c.isNew)).toHaveLength(3);
  });
});
