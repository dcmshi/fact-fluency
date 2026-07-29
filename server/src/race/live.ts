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
import { startHeartbeat } from '../ws/heartbeat';
import { claimUpgradePath, isSameOrigin } from '../ws/upgrade';

const RACE_WS_PATH = '/api/race-ws';
const MAX_RACE_MS = 10 * 60 * 1000;

/** 3s on the wire; an env override keeps headless tests fast (a 3s countdown
 *  per case would dominate the suite) — same trick as FF_FEAST_ROUND_MS. */
function countdownMs(): number {
  const env = Number(process.env.FF_RACE_COUNTDOWN_MS);
  return Number.isFinite(env) && env > 0 ? env : 3000;
}
/** Protocol messages are tens of bytes; anything larger is junk. Without a cap
 *  ws would buffer up to its 100 MiB default per frame. */
const MAX_PAYLOAD_BYTES = 16 * 1024;

/**
 * `ws` emits 'error' on the *socket* for protocol violations (bad RSV bits,
 * oversized frames, bad close codes) and TCP resets. An unhandled 'error' on an
 * EventEmitter throws, which would take down the whole process — API and both
 * games — for every user. Swallow it: ws closes the offending socket itself,
 * and the 'close' handler runs the room cleanup.
 */
const ignoreSocketError = () => {};

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
  /** When `go` went out — the server's own clock is the floor for finish times. */
  startedAt: number;
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const rooms = new Map<string, Room>();
  const heartbeat = startHeartbeat(wss);
  claimUpgradePath(RACE_WS_PATH);

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    // Only claim our own path — another upgrade handler (e.g. Feast) may own the
    // socket. Don't destroy non-matches, or we'd kill their upgrades; the
    // upgrade guard (attached last) cleans up anything nobody claimed.
    if (url.pathname !== RACE_WS_PATH) return;
    // Cookie auth alone would let any site open a socket into a family's game.
    if (!isSameOrigin(req)) {
      socket.destroy();
      return;
    }
    const raceId = url.searchParams.get('raceId') ?? '';
    const profileId = url.searchParams.get('profileId') ?? '';
    // The raw socket is unowned until handleUpgrade adopts it, so a reset during
    // the auth awaits below would throw an unhandled 'error'. try/catch can't
    // catch an emitter throw — only a listener can.
    socket.on('error', ignoreSocketError);
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
          heartbeat.track(ws);
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
    room = {
      raceId,
      totalRounds,
      phase: 'lobby',
      players: new Map(),
      awarded: false,
      startedAt: 0,
    };
    rooms.set(raceId, room);
  }
  const r = room;

  const existing = r.players.get(profile.id);
  if (!existing) {
    // Only *newcomers* are gated — an existing racer must always be able to
    // reconnect mid-race and pick their run back up.
    if (r.phase === 'countdown' || r.phase === 'racing') {
      // Admitting them would add an unfinished racer who never gets `go`, so
      // allConnectedFinished could never pass and the race could never end.
      send(ws, { type: 'error', code: 'race_in_progress' });
      ws.close();
      return;
    }
    if (r.phase === 'finished') {
      // Someone fresh at a results screen: recycle the room instead of leaving
      // it stuck in 'finished', where `ready` is ignored and nothing can start.
      r.phase = 'lobby';
      r.awarded = false;
      for (const p of r.players.values()) {
        p.ready = false;
        p.rounds = 0;
        p.finishMs = null;
      }
    }
  }
  const previousWs = existing?.ws;
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
  // Drop the socket this one replaced (the guard in 'close' below keeps its
  // late close event from disconnecting the player who just reconnected).
  if (previousWs && previousWs !== ws) previousWs.close();

  ws.on('error', ignoreSocketError);

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
    // A reconnect swaps player.ws; the old socket's close still fires later.
    // Acting on it would mark a live player disconnected — and, once every
    // player looks disconnected, delete the room out from under them.
    if (player.ws !== ws) return;
    player.connected = false;
    if (asPlayers(r).every((p) => !p.connected)) {
      if (r.countdown) clearTimeout(r.countdown);
      rooms.delete(raceId);
      return;
    }
    broadcastState(r);
    // A drop can leave everyone else already finished → wrap up.
    if (r.phase === 'racing' && allConnectedFinished(asPlayers(r))) void finishRace(db, r);
    // ...or leave everyone still here already readied. The start condition was
    // only re-checked on a `ready` message, so whoever remained sat in a lobby
    // that would never start (their own button already disabled).
    if (r.phase === 'lobby' && shouldStart(asPlayers(r))) startCountdown(r);
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
    // One finish per racer: re-sending used to let a finisher keep improving
    // their time (and their placement) while the race was still running.
    if (player.finishMs != null) return;
    const t = Number(msg.totalMs);
    const reported = Number.isFinite(t) ? Math.max(0, t) : MAX_RACE_MS;
    // The clock the server watched is the floor — a client claiming it swept
    // the deck in 0ms the instant `go` landed can't outrank a real racer.
    const elapsed = room.startedAt > 0 ? Date.now() - room.startedAt : 0;
    player.finishMs = Math.round(Math.min(Math.max(reported, elapsed), MAX_RACE_MS));
    player.rounds = room.totalRounds;
    broadcastState(room);
    if (allConnectedFinished(asPlayers(room))) void finishRace(db, room);
  }
}

function startCountdown(room: Room): void {
  room.phase = 'countdown';
  const ms = countdownMs();
  broadcast(room, { type: 'countdown', ms });
  room.countdown = setTimeout(() => {
    room.phase = 'racing';
    room.startedAt = Date.now();
    for (const p of room.players.values()) {
      p.rounds = 0;
      p.finishMs = null;
    }
    broadcast(room, { type: 'go' });
    broadcastState(room);
  }, ms);
}

async function finishRace(db: Db, room: Room): Promise<void> {
  room.phase = 'finished';
  const standings = roomStandings(asPlayers(room));
  const withCoins = standings.map((s) => ({
    ...s,
    // Mirror the award condition below: the client renders `coinsEarned`
    // verbatim, so advertising coins to someone who never finished promised a
    // dropped kid "+N ⭐" that their balance never received.
    coinsEarned:
      room.players.get(s.profileId)?.finishMs != null
        ? placementCoins(s.placement, standings.length)
        : 0,
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
