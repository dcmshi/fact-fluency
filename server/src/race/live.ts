/**
 * Live race rooms over WebSockets (MULTIPLAYER.md, Phase 2). A raw `ws` server
 * attached to the existing HTTP server — no socket.io, no client bundle cost.
 * Rooms are in-memory and ephemeral: standings live here only; finishing awards
 * placement coins but never writes a race_run (so live results don't mix with
 * the async ghost leaderboard). The pure state helpers live in
 * engine/raceRoom.ts; this file is the IO + protocol.
 *
 * Protocol (JSON):
 *   client → server: {ready}, {progress, rounds}, {finish, totalMs}
 *   server → client: {joined, totalRounds}, {state, phase, standings},
 *                    {countdown, ms}, {go}, {finished, standings}
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Profile } from '@shared';
import { COOKIE_NAME } from '../auth/session';
import type { Db } from '../db';
import { placementCoins } from '../engine/race';
import {
  allConnectedFinished,
  roomStandings,
  shouldStart,
  type RoomPhase,
  type RoomPlayer,
} from '../engine/raceRoom';

const RACE_WS_PATH = '/api/race-ws';
const COUNTDOWN_MS = 3000;
const MAX_RACE_MS = 10 * 60 * 1000;

interface Conn extends RoomPlayer {
  ws: WebSocket;
}
interface Room {
  raceId: string;
  totalRounds: number;
  phase: RoomPhase;
  players: Map<string, Conn>; // keyed by profileId (survives reconnect)
  awarded: boolean;
  countdown?: ReturnType<typeof setTimeout>;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const send = (ws: WebSocket, payload: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

function broadcast(room: Room, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.connected && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

const asPlayers = (room: Room): RoomPlayer[] => [...room.players.values()];

const broadcastState = (room: Room) =>
  broadcast(room, { type: 'state', phase: room.phase, standings: roomStandings(asPlayers(room)) });

/** Attach the live-race WebSocket server to the app's HTTP server. */
export function attachRaceLive(server: Server, db: Db): void {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, Room>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    // Only claim our own path — another upgrade handler (e.g. Feast) may own the
    // socket. Don't destroy non-matches, or we'd kill their upgrades.
    if (url.pathname !== RACE_WS_PATH) return;
    const raceId = url.searchParams.get('raceId') ?? '';
    const profileId = url.searchParams.get('profileId') ?? '';
    void (async () => {
      try {
        // Authenticate the upgrade from the same session cookie the API uses,
        // and confirm the race + profile both belong to that account.
        const token = parseCookie(req.headers.cookie, COOKIE_NAME);
        const accountId = token ? await db.findAccountIdByToken(token) : null;
        const race = raceId ? await db.getRace(raceId) : null;
        const profile = profileId ? await db.getProfile(profileId) : null;
        if (
          !accountId ||
          !race ||
          race.accountId !== accountId ||
          !profile ||
          profile.accountId !== accountId
        ) {
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          joinRoom(rooms, db, ws, race.id, race.factCount, profile);
        });
      } catch {
        socket.destroy();
      }
    })();
  });
}

function joinRoom(
  rooms: Map<string, Room>,
  db: Db,
  ws: WebSocket,
  raceId: string,
  totalRounds: number,
  profile: Profile,
): void {
  let room = rooms.get(raceId);
  if (!room) {
    room = { raceId, totalRounds, phase: 'lobby', players: new Map(), awarded: false };
    rooms.set(raceId, room);
  }
  const r = room;

  const existing = r.players.get(profile.id);
  const player: Conn = existing
    ? Object.assign(existing, { ws, connected: true }) // reconnect: keep progress
    : {
        profileId: profile.id,
        name: profile.displayName,
        avatar: profile.avatar,
        ready: false,
        rounds: 0,
        finishMs: null,
        connected: true,
        ws,
      };
  r.players.set(profile.id, player);

  ws.on('message', (raw) => {
    let msg: { type?: string; ready?: unknown; rounds?: unknown; totalMs?: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    onMessage(db, r, player, msg);
  });

  ws.on('close', () => {
    player.connected = false;
    if (asPlayers(r).every((p) => !p.connected)) {
      if (r.countdown) clearTimeout(r.countdown);
      rooms.delete(raceId);
      return;
    }
    broadcastState(r);
    // A drop can leave everyone else already finished → wrap up.
    if (r.phase === 'racing' && allConnectedFinished(asPlayers(r))) void finishRace(db, r);
  });

  send(ws, { type: 'joined', totalRounds });
  broadcastState(r);
}

function onMessage(
  db: Db,
  room: Room,
  player: Conn,
  msg: { type?: string; ready?: unknown; rounds?: unknown; totalMs?: unknown },
): void {
  if (msg.type === 'ready' && room.phase === 'lobby') {
    player.ready = !!msg.ready;
    broadcastState(room);
    if (shouldStart(asPlayers(room))) startCountdown(room);
    return;
  }
  if (msg.type === 'progress' && room.phase === 'racing') {
    const rounds = Number(msg.rounds);
    if (Number.isFinite(rounds)) {
      player.rounds = Math.max(0, Math.min(room.totalRounds, Math.trunc(rounds)));
      broadcastState(room);
    }
    return;
  }
  if (msg.type === 'finish' && room.phase === 'racing') {
    const t = Number(msg.totalMs);
    player.finishMs = Number.isFinite(t)
      ? Math.round(Math.min(Math.max(0, t), MAX_RACE_MS))
      : MAX_RACE_MS;
    player.rounds = room.totalRounds;
    broadcastState(room);
    if (allConnectedFinished(asPlayers(room))) void finishRace(db, room);
  }
}

function startCountdown(room: Room): void {
  room.phase = 'countdown';
  broadcast(room, { type: 'countdown', ms: COUNTDOWN_MS });
  room.countdown = setTimeout(() => {
    room.phase = 'racing';
    for (const p of room.players.values()) {
      p.rounds = 0;
      p.finishMs = null;
    }
    broadcast(room, { type: 'go' });
    broadcastState(room);
  }, COUNTDOWN_MS);
}

async function finishRace(db: Db, room: Room): Promise<void> {
  room.phase = 'finished';
  const standings = roomStandings(asPlayers(room));
  const withCoins = standings.map((s) => ({
    ...s,
    coinsEarned: placementCoins(s.placement, standings.length),
  }));
  if (!room.awarded) {
    room.awarded = true;
    for (const s of withCoins) {
      // Only actual finishers earn coins (a no-show who never finished doesn't).
      if (room.players.get(s.profileId)?.finishMs != null) {
        try {
          await db.addCoins(s.profileId, s.coinsEarned);
        } catch {
          // best effort — a coin write failure shouldn't crash the room
        }
      }
    }
  }
  broadcast(room, { type: 'finished', standings: withCoins });
}
