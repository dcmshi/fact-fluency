import { describe, expect, it } from 'vitest';
import type { Fact } from '@shared';
import {
  applyBump,
  applyGrab,
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
});

describe('isFeastOver', () => {
  it('is true only once the clock runs out', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    expect(isFeastOver(s, ROUND_MS - 1)).toBe(false);
    expect(isFeastOver(s, ROUND_MS)).toBe(true);
  });
});
