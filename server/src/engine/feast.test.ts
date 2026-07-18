import { describe, expect, it } from 'vitest';
import type { Fact } from '@shared';
import {
  applyBump,
  applyGrab,
  applyMove,
  createFeastState,
  feastSnapshot,
  feastStandings,
  isFeastOver,
  ROUND_MS,
  stepFeast,
  type FeastPlayer,
  type FeastState,
} from './feast';

const rng0 = () => 0; // deterministic: always the first choice / lowest int / spawns correct
const f = (
  id: string,
  operation: Fact['operation'],
  operandA: number,
  operandB: number,
  answer: number,
): Fact => ({ id, operation, operandA, operandB, answer });

const POOL: Fact[] = [f('mul:6x7', 'mul', 6, 7, 42), f('mul:3x4', 'mul', 3, 4, 12)];

const players = (...ids: string[]) =>
  ids.map((id) => ({ profileId: id, name: id, avatar: '🦊', muncher: 'cat', isBot: false }));

describe('createFeastState', () => {
  it('starts everyone at zero with a fact and a clock', () => {
    const s = createFeastState(players('a', 'b'), POOL, 1000, rng0);
    expect(s.endsAt).toBe(1000 + ROUND_MS);
    expect(s.plates).toHaveLength(0);
    expect(s.answer).toBe(42); // rng0 → first pool fact
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
  });
});

describe('applyGrab', () => {
  const base = (): FeastState => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    s.plates = [
      { id: 1, value: 42, pos: 0.5, correct: true },
      { id: 2, value: 99, pos: 0.5, correct: false },
    ];
    return s;
  };

  it('scores a correct plate and removes it', () => {
    const s = base();
    expect(applyGrab(s, 'a', 1, 100)).toBe('correct');
    expect(s.players[0].score).toBe(1);
    expect(s.plates.find((p) => p.id === 1)).toBeUndefined();
  });

  it('stuns on a wrong plate (consumed) and then ignores the stunned grabber', () => {
    const s = base();
    expect(applyGrab(s, 'a', 2, 100)).toBe('wrong');
    expect(s.players[0].score).toBe(0);
    expect(s.players[0].stunnedUntil).toBeGreaterThan(100);
    // still stunned → a follow-up grab does nothing
    expect(applyGrab(s, 'a', 1, 100)).toBe('ignored');
    expect(s.players[0].score).toBe(0);
  });

  it('ignores an unknown plate or unknown player', () => {
    const s = base();
    expect(applyGrab(s, 'a', 999, 100)).toBe('ignored');
    expect(applyGrab(s, 'ghost', 1, 100)).toBe('ignored');
  });
});

describe('applyMove', () => {
  it('sets and clamps the mover’s position/aim and ignores unknown players', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    applyMove(s, 'a', 1.4, -0.2, true); // out of range → clamped
    expect(s.players[0].rimPos).toBe(1);
    expect(s.players[0].aim).toBe(0);
    expect(s.players[0].firing).toBe(true);
    // unknown player: no throw, no change elsewhere
    expect(() => applyMove(s, 'ghost', 0.5, 0.5, false)).not.toThrow();
    expect(s.players[0].rimPos).toBe(1);
  });
});

describe('applyBump', () => {
  it('stuns the target, respects the cooldown, and refuses self-bumps', () => {
    const s = createFeastState(players('a', 'b'), POOL, 0, rng0);
    expect(applyBump(s, 'a', 'a', 100)).toBe(false); // no self-bump
    expect(applyBump(s, 'a', 'b', 100)).toBe(true);
    expect(s.players[1].stunnedUntil).toBeGreaterThan(100);
    expect(applyBump(s, 'a', 'b', 200)).toBe(false); // 'a' still on cooldown
  });

  it('a stunned player cannot bump', () => {
    const s = createFeastState(players('a', 'b'), POOL, 0, rng0);
    s.players[0].stunnedUntil = 5000;
    expect(applyBump(s, 'a', 'b', 100)).toBe(false);
  });
});

describe('stepFeast', () => {
  it('spawns plates on cadence and despawns ones that leave the belt', () => {
    const s = createFeastState([], POOL, 0, rng0);
    stepFeast(s, 700, 700, rng0);
    expect(s.plates).toHaveLength(1);
    stepFeast(s, 1400, 700, rng0);
    expect(s.plates).toHaveLength(2);

    // A plate near the end of the belt falls off after moving.
    const s2 = createFeastState([], POOL, 0, rng0);
    s2.plates = [{ id: 9, value: 1, pos: 0.99, correct: false }];
    s2.lastSpawnAt = 1e12; // suppress new spawns for the assertion
    stepFeast(s2, 100, 700, rng0);
    expect(s2.plates).toHaveLength(0);
  });

  it('rotates the fact and recomputes plate correctness', () => {
    const s: FeastState = {
      factId: 'mul:6x7',
      factA: 6,
      factOp: 'mul',
      factB: 7,
      answer: 42,
      plates: [
        { id: 1, value: 42, pos: 0.5, correct: true },
        { id: 2, value: 12, pos: 0.5, correct: false },
      ],
      players: [],
      pool: POOL,
      endsAt: 1e12,
      nextPlateId: 3,
      lastSpawnAt: 1e12,
      lastRotateAt: 0,
    };
    // now (7000) > FACT_ROTATE_MS (6500); rng 0.7 → picks the second pool fact.
    stepFeast(s, 7000, 1, () => 0.7);
    expect(s.answer).toBe(12);
    expect(s.plates.find((p) => p.id === 1)?.correct).toBe(false);
    expect(s.plates.find((p) => p.id === 2)?.correct).toBe(true);
  });

  it('eases a bot’s rimPos toward the nearest correct plate before it grabs', () => {
    const s = createFeastState(
      [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
      POOL,
      0,
      rng0,
    );
    s.players[0].rimPos = 0.5;
    s.plates = [{ id: 1, value: s.answer, pos: 0.3, correct: true }];
    s.lastSpawnAt = 1e12; // no new spawns
    // now (100) < botReactAt → the bot moves but does not grab yet.
    stepFeast(s, 100, 100, rng0);
    expect(s.players[0].rimPos).toBeLessThan(0.5);
    expect(s.players[0].rimPos).toBeGreaterThan(0.3);
    expect(s.plates).toHaveLength(1); // not grabbed
  });

  it('lets a bot grab a correct plate once its reaction window passes', () => {
    const s = createFeastState(
      [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
      POOL,
      0,
      rng0,
    );
    s.plates = [{ id: 1, value: s.answer, pos: 0.5, correct: true }];
    s.lastSpawnAt = 1e12; // isolate the bot's grab from new spawns
    stepFeast(s, 500, 5, rng0); // now past botReactAt (450)
    expect(s.players[0].score).toBe(1);
    expect(s.plates).toHaveLength(0);
  });
});

describe('feastStandings + snapshot', () => {
  it('ranks by score, highest first', () => {
    const roster: FeastPlayer[] = [
      {
        profileId: 'a',
        name: 'A',
        avatar: '🦊',
        muncher: 'cat',
        isBot: false,
        score: 2,
        stunnedUntil: 0,
        bumpReadyAt: 0,
        botReactAt: 0,
        rimPos: 0,
        aim: 0,
        firing: false,
      },
      {
        profileId: 'b',
        name: 'B',
        avatar: '🐼',
        muncher: 'dog',
        isBot: false,
        score: 5,
        stunnedUntil: 0,
        bumpReadyAt: 0,
        botReactAt: 0,
        rimPos: 0,
        aim: 0,
        firing: false,
      },
    ];
    const ranked = feastStandings(roster);
    expect(ranked[0].profileId).toBe('b');
    expect(ranked[0].placement).toBe(1);
    expect(ranked[1].placement).toBe(2);
  });

  it('snapshot exposes the fact + stun state but never the answer', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    s.players[0].stunnedUntil = 5000;
    const snap = feastSnapshot(s, 100);
    expect(snap.factA).toBe(6);
    expect(snap.factB).toBe(7);
    expect(snap.players[0].stunned).toBe(true);
    expect(snap).not.toHaveProperty('answer');
    expect(snap.plates.every((p) => !('correct' in p))).toBe(true);
  });

  it('spreads munchers along the belt and exposes rimPos/aim/firing (no answer leak)', () => {
    const s = createFeastState(players('a', 'b'), POOL, 0, rng0);
    // Two players → seeded at 0.25 and 0.75 so they do not stack.
    expect(s.players[0].rimPos).toBeCloseTo(0.25, 5);
    expect(s.players[1].rimPos).toBeCloseTo(0.75, 5);
    expect(s.players[0].aim).toBeCloseTo(0.25, 5);
    expect(s.players[0].firing).toBe(false);

    const snap = feastSnapshot(s, 0);
    expect(snap.players[0]).toMatchObject({ rimPos: 0.25, aim: 0.25, firing: false });
    expect(snap).not.toHaveProperty('answer');
  });
});

describe('isFeastOver', () => {
  it('is true only once the clock runs out', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    expect(isFeastOver(s, ROUND_MS - 1)).toBe(false);
    expect(isFeastOver(s, ROUND_MS)).toBe(true);
  });
});
