/**
 * Live race room — pure state helpers (MULTIPLAYER.md, Phase 2). The WS layer
 * owns the mutable room (players connecting, ticking progress); these functions
 * answer the questions it needs — standings, whether to start, whether the race
 * is over. Ephemeral by design: nothing here persists (live results never touch
 * race_run; only coins are awarded on finish).
 */
export type RoomPhase = 'lobby' | 'countdown' | 'racing' | 'finished';

export interface RoomPlayer {
  profileId: string;
  name: string;
  avatar: string;
  ready: boolean;
  /** Rounds cleared so far. */
  rounds: number;
  /** Total ms when finished; null while still racing. */
  finishMs: number | null;
  connected: boolean;
}

export interface RoomStanding {
  profileId: string;
  name: string;
  avatar: string;
  rounds: number;
  finishMs: number | null;
  connected: boolean;
  placement: number;
}

/** Minimum racers for a live room to start — below that it's just an async run. */
export const MIN_LIVE_RACERS = 2;

/**
 * Live standings: finishers first (fastest total time), then everyone still
 * racing by rounds cleared (more progress ranks higher). 1-based placements.
 */
export function roomStandings(players: RoomPlayer[]): RoomStanding[] {
  const finished = players
    .filter((p) => p.finishMs != null)
    .sort((a, b) => (a.finishMs as number) - (b.finishMs as number));
  const racing = players.filter((p) => p.finishMs == null).sort((a, b) => b.rounds - a.rounds);
  return [...finished, ...racing].map((p, i) => ({
    profileId: p.profileId,
    name: p.name,
    avatar: p.avatar,
    rounds: p.rounds,
    finishMs: p.finishMs,
    connected: p.connected,
    placement: i + 1,
  }));
}

/** Ready to begin: at least MIN_LIVE_RACERS connected, and every connected
 *  racer has readied up. */
export function shouldStart(players: RoomPlayer[]): boolean {
  const active = players.filter((p) => p.connected);
  return active.length >= MIN_LIVE_RACERS && active.every((p) => p.ready);
}

/** The race is over once every still-connected racer has finished — a dropped
 *  player (frozen at their last position) can't stall the room forever. */
export function allConnectedFinished(players: RoomPlayer[]): boolean {
  const active = players.filter((p) => p.connected);
  return active.length > 0 && active.every((p) => p.finishMs != null);
}
