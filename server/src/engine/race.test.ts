import { describe, expect, it } from 'vitest';
import { generateFacts } from './facts';
import { makeRng } from './munch';
import {
  buildBotGhost,
  buildRaceDeck,
  placementCoins,
  RACE_COIN_FLOOR,
  RACE_COIN_TOP,
  rankRuns,
} from './race';

const MUL = generateFacts('mul', { aMin: 0, aMax: 9, bMin: 0, bMax: 9 });

describe('buildRaceDeck', () => {
  it('returns `count` unique facts, deterministically for a seed', () => {
    const a = buildRaceDeck(MUL, makeRng(5), 6);
    const b = buildRaceDeck(MUL, makeRng(5), 6);
    expect(a).toHaveLength(6);
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id)); // deterministic
    expect(new Set(a.map((f) => f.id)).size).toBe(6); // unique
  });

  it('uses the whole (shuffled) universe when it is smaller than count', () => {
    const small = MUL.slice(0, 4);
    expect(buildRaceDeck(small, makeRng(1), 6)).toHaveLength(4);
  });

  it('samples — not just the easiest-first head of the universe', () => {
    const deck = buildRaceDeck(MUL, makeRng(9), 6);
    expect(deck.map((f) => f.id)).not.toEqual(MUL.slice(0, 6).map((f) => f.id));
  });
});

describe('buildBotGhost', () => {
  it('produces one beatable split per round, deterministically', () => {
    const a = buildBotGhost(6, makeRng(3));
    const b = buildBotGhost(6, makeRng(3));
    expect(a).toHaveLength(6);
    expect(a).toEqual(b);
    for (const ms of a) {
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThan(4000);
    }
  });
});

describe('rankRuns', () => {
  it('orders fastest-first with 1-based placements', () => {
    const ranked = rankRuns([
      { profileId: 'a', totalMs: 30000 },
      { profileId: 'b', totalMs: 21000 },
      { profileId: 'c', totalMs: 45000 },
    ]);
    expect(ranked.map((r) => r.profileId)).toEqual(['b', 'a', 'c']);
    expect(ranked.map((r) => r.placement)).toEqual([1, 2, 3]);
  });

  it('gives equal times equal placements (competition ranking)', () => {
    // Times are whole ms and clamped at MAX_RACE_MS, and a live race defaults an
    // unreadable time to that cap — so two racers really can tie exactly.
    // Splitting them would decide 1st vs 2nd, and the coins, on row order.
    const ranked = rankRuns([
      { profileId: 'a', totalMs: 600000 },
      { profileId: 'b', totalMs: 21000 },
      { profileId: 'c', totalMs: 600000 },
      { profileId: 'd', totalMs: 900000 },
    ]);
    expect(ranked.map((r) => r.profileId)).toEqual(['b', 'a', 'c', 'd']);
    expect(ranked.map((r) => r.placement)).toEqual([1, 2, 2, 4]);
  });

  it('does not mutate the input', () => {
    const runs = [
      { profileId: 'a', totalMs: 2 },
      { profileId: 'b', totalMs: 1 },
    ];
    rankRuns(runs);
    expect(runs[0].profileId).toBe('a'); // original order intact
  });
});

describe('placementCoins', () => {
  it('gives first the top, last the floor, and interpolates between', () => {
    expect(placementCoins(1, 4)).toBe(RACE_COIN_TOP);
    expect(placementCoins(4, 4)).toBe(RACE_COIN_FLOOR);
    const second = placementCoins(2, 4);
    expect(second).toBeLessThan(RACE_COIN_TOP);
    expect(second).toBeGreaterThan(RACE_COIN_FLOOR);
  });

  it('never pays below the floor, and a solo time-trial gets the full amount', () => {
    expect(placementCoins(2, 2)).toBe(RACE_COIN_FLOOR); // last of two
    expect(placementCoins(1, 1)).toBe(RACE_COIN_TOP); // no opponent
    for (let n = 2; n <= 8; n++) {
      for (let p = 1; p <= n; p++) {
        expect(placementCoins(p, n)).toBeGreaterThanOrEqual(RACE_COIN_FLOOR);
      }
    }
  });
});
