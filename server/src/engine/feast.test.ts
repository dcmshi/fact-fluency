import { describe, expect, it } from 'vitest';
import type { Fact } from '@shared';
import {
  applyGrab,
  applyMove,
  createFeastState,
  feastSnapshot,
  feastStandings,
  isFeastOver,
  ROUND_MS,
  stepFeast,
  type FeastPlate,
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

const plate = (
  id: number,
  value: number,
  correct: boolean,
  slot: number = 0,
  pos: number = 0.5,
  spawnedAt: number = 0,
): FeastPlate => ({ id, value, pos, correct, slot, spawnedAt });

const suppressRefills = (state: FeastState) => state.slotReadyAt.fill(1e12);

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
    s.plates = [plate(1, 42, true, 0), plate(2, 99, false, 1)];
    return s;
  };

  it('scores a correct plate and removes it', () => {
    const s = base();
    expect(applyGrab(s, 'a', 1, 100)).toBe('correct');
    expect(s.players[0].score).toBe(1);
    expect(s.plates.find((p) => p.id === 1)).toBeUndefined();
    expect(s.slotReadyAt[0]).toBe(2100);
  });

  it('stuns on a wrong plate (consumed) and then ignores the stunned grabber', () => {
    const s = base();
    expect(applyGrab(s, 'a', 2, 100)).toBe('wrong');
    expect(s.players[0].score).toBe(0);
    expect(s.players[0].stunnedUntil).toBe(2600);
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
    applyMove(s, 'a', 1.4, 0, 0.001, 0.002, 1.4, 0, 0.001, 0.002, 10, 0, true, 100); // vectors are normalized/clamped
    expect(s.players[0].x).toBe(1);
    expect(s.players[0].y).toBe(0);
    expect(s.players[0].aimX).toBe(1);
    expect(s.players[0].aimY).toBe(0);
    expect(s.players[0]).toMatchObject({ vx: 0.001, vy: 0.002 });
    expect(s.players[0].firing).toBe(true);
    // unknown player: no throw, no change elsewhere
    expect(() =>
      applyMove(s, 'ghost', 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1, false, 100),
    ).not.toThrow();
    expect(s.players[0].x).toBe(1);
    applyMove(s, 'a', Number.NaN, 0, 0, 0, 0, 0, 0, 0, 0, 1, false, 100);
    expect(s.players[0].x).toBe(1);
  });

  it('pushes a contacted remote body and deduplicates the same network contact', () => {
    const s = createFeastState(players('a', 'b'), POOL, 0, rng0);
    Object.assign(s.players[0], { x: -0.4, y: 0 });
    Object.assign(s.players[1], { x: 0, y: 0 });

    applyMove(s, 'a', -0.31, 0, 0, 0, -0.25, 0, 0.002, 0, 1, 0, false, 100);
    expect(s.players[1].x).toBeGreaterThan(0);
    expect(s.players[1].pushX).toBeGreaterThan(0);
    expect(s.players[1].pushVx).toBeCloseTo(0.002, 8);

    const pushedOnce = s.players[1].pushX;
    applyMove(s, 'a', -0.31, 0, 0, 0, -0.25, 0, 0.002, 0, 1, 0, false, 150);
    expect(s.players[1].pushX).toBe(pushedOnce);
  });
});

describe('stepFeast', () => {
  it('fills twelve stable table slots and keeps their dishes through a lap', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    stepFeast(s, 1, 1, rng0);
    expect(s.plates).toHaveLength(12);
    expect(new Set(s.plates.map((p) => p.slot)).size).toBe(12);
    const ids = s.plates.map((p) => p.id);

    stepFeast(s, 6001, 6000, rng0);
    expect(s.plates.map((p) => p.id)).toEqual(ids);
    expect(s.plates[0].pos).toBeCloseTo(0.5, 3);
  });

  it('refills the eaten table after Stadium’s two-second vacancy', () => {
    const s = createFeastState(players('a'), POOL, 0, rng0);
    stepFeast(s, 1, 1, rng0);
    const eaten = s.plates[0];
    applyGrab(s, 'a', eaten.id, 100);
    expect(s.plates).toHaveLength(11);

    stepFeast(s, 2099, 0, rng0);
    expect(s.plates).toHaveLength(11);
    stepFeast(s, 2100, 0, rng0);
    expect(s.plates).toHaveLength(12);
    expect(s.plates.find((p) => p.slot === eaten.slot)?.id).not.toBe(eaten.id);
  });

  it('rotates the fact and recomputes plate correctness', () => {
    const s: FeastState = {
      factId: 'mul:6x7',
      factA: 6,
      factOp: 'mul',
      factB: 7,
      answer: 42,
      plates: [plate(1, 42, true, 0), plate(2, 12, false, 1)],
      players: [],
      pool: POOL,
      endsAt: 1e12,
      nextPlateId: 3,
      beltOffset: 0,
      slotReadyAt: Array(12).fill(1e12),
      collisionReadyAt: {},
      lastRotateAt: 0,
    };
    stepFeast(s, 17_999, 1, () => 0.7);
    expect(s.answer).toBe(42);
    // now (18_500) > FACT_ROTATE_MS (18_000); rng 0.7 → second pool fact.
    stepFeast(s, 18_500, 1, () => 0.7);
    expect(s.answer).toBe(12);
    expect(s.plates.find((p) => p.id === 1)?.correct).toBe(false);
    expect(s.plates.find((p) => p.id === 2)?.correct).toBe(true);
  });

  it('fills a vacant table before replacing a visible plate for a new answer', () => {
    const s = createFeastState([], POOL, 0, rng0);
    s.plates = Array.from({ length: 11 }, (_, slot) => plate(slot + 1, 42, false, slot));
    s.nextPlateId = 12;
    s.answer = 12;
    s.slotReadyAt.fill(0);

    stepFeast(s, 1, 0, rng0);

    expect(s.plates).toHaveLength(12);
    expect(s.plates.filter((p) => p.id <= 11)).toHaveLength(11);
    expect(s.plates.find((p) => p.slot === 11)).toMatchObject({ value: 12, correct: true });
  });

  it('recycles only the oldest wrong plate when every table is full and none matches', () => {
    const s = createFeastState([], POOL, 0, rng0);
    s.answer = 12;
    s.plates = Array.from({ length: 12 }, (_, slot) =>
      plate(slot + 1, 42, false, slot, slot / 12, slot * 100),
    );
    s.nextPlateId = 13;

    stepFeast(s, 1201, 0, rng0);

    expect(s.plates).toHaveLength(12);
    expect(s.plates.some((p) => p.id === 1)).toBe(false);
    expect(s.plates.find((p) => p.slot === 0)).toMatchObject({ value: 12, correct: true });
    expect(s.plates.filter((p) => p.id >= 2 && p.id <= 12)).toHaveLength(11);
  });

  it('moves a bot through the arena toward the nearest correct plate before it grabs', () => {
    const s = createFeastState(
      [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
      POOL,
      0,
      rng0,
    );
    s.players[0].x = 0;
    s.players[0].y = 0;
    s.plates = [plate(1, s.answer, true, 4, 0.3)];
    suppressRefills(s);
    // now (100) < botReactAt → the bot moves but does not grab yet.
    stepFeast(s, 100, 100, rng0);
    expect(Math.hypot(s.players[0].x, s.players[0].y)).toBeCloseTo(0.24, 5);
    expect(Math.hypot(s.players[0].aimX, s.players[0].aimY)).toBeCloseTo(1, 5);
    expect(s.plates).toHaveLength(1); // not grabbed
  });

  it('gives bots the decomp overlap separation and incoming player impulse', () => {
    const s = createFeastState(
      [
        { profileId: 'bot', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true },
        ...players('human'),
      ],
      POOL,
      0,
      rng0,
    );
    const [bot, human] = s.players;
    Object.assign(bot, { x: 0, y: 0, vx: 0, vy: 0 });
    Object.assign(human, { x: 0.2, y: 0, vx: -0.002, vy: 0 });
    suppressRefills(s);

    stepFeast(s, 100, 1000 / 60, rng0);

    expect(bot.vx).toBeCloseTo(-0.002, 8);
    expect(bot.x).toBeLessThan(0);
    expect(human.x - bot.x).toBeGreaterThanOrEqual(40 / 130);
    expect(human.pushX).toBeGreaterThan(0);
  });

  it('lets a bot grab a correct plate once its reaction window passes', () => {
    const s = createFeastState(
      [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
      POOL,
      0,
      rng0,
    );
    s.plates = [plate(1, s.answer, true, 6)];
    suppressRefills(s); // isolate the bot's grab from new spawns
    stepFeast(s, 800, 5, rng0); // now past botReactAt (700)
    expect(s.players[0].score).toBe(1);
    expect(s.plates).toHaveLength(0);
  });

  it('does not let a bot grab before the reaction floor', () => {
    const s = createFeastState(
      [{ profileId: 'bot1', name: 'Bot', avatar: '🤖', muncher: 'cat', isBot: true }],
      POOL,
      0,
      rng0,
    );
    s.plates = [plate(1, s.answer, true, 6)];
    suppressRefills(s);
    stepFeast(s, 500, 5, rng0); // 500 < BOT_MIN_REACT_MS (700)
    expect(s.players[0].score).toBe(0);
    expect(s.plates).toHaveLength(1);
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
        botReactAt: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        pushX: 0,
        pushY: 0,
        pushVx: 0,
        pushVy: 0,
        aimX: 0,
        aimY: -1,
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
        botReactAt: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        pushX: 0,
        pushY: 0,
        pushVx: 0,
        pushVy: 0,
        aimX: 0,
        aimY: -1,
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

  it('spreads munchers inside the arena and exposes position/aim/firing', () => {
    const s = createFeastState(players('a', 'b'), POOL, 0, rng0);
    expect(s.players[0]).toMatchObject({ x: expect.closeTo(0), y: -0.45 });
    expect(s.players[1]).toMatchObject({ x: expect.closeTo(0), y: 0.45 });
    expect(s.players[0]).toMatchObject({ aimX: expect.closeTo(0), aimY: -1 });
    expect(s.players[0].firing).toBe(false);

    const snap = feastSnapshot(s, 0);
    expect(snap.players[0]).toMatchObject({
      x: expect.closeTo(0),
      y: -0.45,
      aimX: expect.closeTo(0),
      aimY: -1,
      firing: false,
    });
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
