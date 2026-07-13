import { describe, expect, it } from 'vitest';
import { allConnectedFinished, roomStandings, shouldStart, type RoomPlayer } from './raceRoom';

const player = (over: Partial<RoomPlayer> & { profileId: string }): RoomPlayer => ({
  name: over.profileId,
  avatar: '🦊',
  ready: false,
  rounds: 0,
  finishMs: null,
  connected: true,
  ...over,
});

describe('roomStandings', () => {
  it('ranks finishers by time, then racers by rounds cleared', () => {
    const standings = roomStandings([
      player({ profileId: 'still-2', rounds: 2 }),
      player({ profileId: 'done-slow', rounds: 6, finishMs: 40000 }),
      player({ profileId: 'still-4', rounds: 4 }),
      player({ profileId: 'done-fast', rounds: 6, finishMs: 25000 }),
    ]);
    expect(standings.map((s) => s.profileId)).toEqual([
      'done-fast', // finishers first, fastest
      'done-slow',
      'still-4', // then racers, most progress first
      'still-2',
    ]);
    expect(standings.map((s) => s.placement)).toEqual([1, 2, 3, 4]);
  });
});

describe('shouldStart', () => {
  it('needs at least two connected and all connected ready', () => {
    expect(shouldStart([player({ profileId: 'a', ready: true })])).toBe(false); // only one
    expect(
      shouldStart([
        player({ profileId: 'a', ready: true }),
        player({ profileId: 'b', ready: false }),
      ]),
    ).toBe(false); // b not ready
    expect(
      shouldStart([
        player({ profileId: 'a', ready: true }),
        player({ profileId: 'b', ready: true }),
      ]),
    ).toBe(true);
  });

  it('ignores a disconnected player when checking readiness', () => {
    expect(
      shouldStart([
        player({ profileId: 'a', ready: true }),
        player({ profileId: 'b', ready: true }),
        player({ profileId: 'c', ready: false, connected: false }), // dropped — doesn't block
      ]),
    ).toBe(true);
  });
});

describe('allConnectedFinished', () => {
  it('is true only when every connected racer has finished', () => {
    expect(allConnectedFinished([])).toBe(false);
    expect(
      allConnectedFinished([player({ profileId: 'a', finishMs: 100 }), player({ profileId: 'b' })]),
    ).toBe(false);
    expect(
      allConnectedFinished([
        player({ profileId: 'a', finishMs: 100 }),
        player({ profileId: 'b', finishMs: 200 }),
        player({ profileId: 'c', connected: false }), // dropped, unfinished — ignored
      ]),
    ).toBe(true);
  });
});
