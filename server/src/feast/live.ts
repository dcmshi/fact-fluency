/**
 * Number Feast — live arena over WebSockets (FEAST.md, slice 2). A server-
 * authoritative real-time room: a tick loop steps the pure engine (engine/
 * feast.ts) and broadcasts snapshots; clients only render and send inputs
 * (grab/bump). Rooms are in-memory and ephemeral (like the live Race); only
 * placement coins are written on finish.
 *
 * A room is keyed by **accountId** — every device on one account joins the same
 * arena (siblings play together; kids have no logins), and bots fill out solo
 * play. There's no discovery/lobby list, so no persisted entity is needed.
 *
 * Protocol (JSON):
 *   client → server: {ready}, {addBot}, {grab, plateId}, {bump, targetId},
 *                    {move, rimPos, aim, firing}, {again}
 *   server → client: {joined}, {lobby, players}, {countdown, ms}, {snapshot,...},
 *                    {finished, standings}, {error, code}
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Profile } from '@shared';
import { COOKIE_NAME } from '../auth/session';
import { SEED_CATALOG } from '../data/catalog';
import type { Db } from '../db';
import { generateFactsForSets } from '../engine/facts';
import {
  applyBump,
  applyGrab,
  applyMove,
  createFeastState,
  feastSnapshot,
  feastStandings,
  isFeastOver,
  stepFeast,
  type FeastState,
  type Rng,
} from '../engine/feast';
import { makeRng, seedFrom } from '../engine/munch';
import { placementCoins } from '../engine/race';

const FEAST_WS_PATH = '/api/feast-ws';
const COUNTDOWN_MS = 3000;
const TICK_MS = 66; // ~15 Hz
const MAX_PLAYERS = 4;
const BOT_NAMES = ['Robo', 'Zappy', 'Nibbles', 'Chomp'];
const BOT_AVATARS = ['🤖', '👾', '🐙', '🦖'];
const BOT_MUNCHERS = ['dog', 'fox', 'frog', 'panda'];

type Phase = 'lobby' | 'countdown' | 'playing' | 'finished';

interface FeastConn {
  profileId: string;
  name: string;
  avatar: string;
  muncher: string;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
  ws?: WebSocket;
}

interface FeastRoom {
  accountId: string;
  poolProfileId: string; // whose enabled sets seed the fact pool at start
  phase: Phase;
  players: Map<string, FeastConn>; // keyed by profileId
  state: FeastState | null;
  rng: Rng;
  tick: ReturnType<typeof setInterval> | null;
  lastTickAt: number;
  countdown: ReturnType<typeof setTimeout> | null;
  awarded: boolean;
  botSeq: number;
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

function broadcast(room: FeastRoom, payload: unknown) {
  const data = JSON.stringify(payload);
  for (const p of room.players.values()) {
    if (p.ws && p.connected && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

const humans = (room: FeastRoom): FeastConn[] => [...room.players.values()].filter((p) => !p.isBot);
const connectedHumans = (room: FeastRoom): FeastConn[] => humans(room).filter((p) => p.connected);

/** Lobby view: who's in the room and whether they're ready. */
function broadcastLobby(room: FeastRoom) {
  broadcast(room, {
    type: 'lobby',
    players: [...room.players.values()].map((p) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      muncher: p.muncher,
      isBot: p.isBot,
      ready: p.ready,
      connected: p.connected,
    })),
  });
}

/** Attach the Feast WebSocket server to the app's HTTP server. */
export function attachFeastLive(server: Server, db: Db): void {
  const wss = new WebSocketServer({ noServer: true });
  const rooms = new Map<string, FeastRoom>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '', 'http://localhost');
    if (url.pathname !== FEAST_WS_PATH) return; // not ours; another handler may own it
    const profileId = url.searchParams.get('profileId') ?? '';
    void (async () => {
      try {
        const token = parseCookie(req.headers.cookie, COOKIE_NAME);
        const accountId = token ? await db.findAccountIdByToken(token) : null;
        const profile = profileId ? await db.getProfile(profileId) : null;
        if (!accountId || !profile || profile.accountId !== accountId) {
          socket.destroy();
          return;
        }
        const muncher = await db.getEquippedMuncher(profile.id).catch(() => 'cat');
        wss.handleUpgrade(req, socket, head, (ws) => {
          joinRoom(rooms, db, ws, accountId, profile, muncher);
        });
      } catch {
        socket.destroy();
      }
    })();
  });
}

function joinRoom(
  rooms: Map<string, FeastRoom>,
  db: Db,
  ws: WebSocket,
  accountId: string,
  profile: Profile,
  muncher: string,
): void {
  let room = rooms.get(accountId);
  if (!room) {
    room = {
      accountId,
      poolProfileId: profile.id,
      phase: 'lobby',
      players: new Map(),
      state: null,
      rng: makeRng(seedFrom(`feast:${accountId}`)),
      tick: null,
      lastTickAt: 0,
      countdown: null,
      awarded: false,
      botSeq: 0,
    };
    rooms.set(accountId, room);
  }
  const r = room;

  const existing = r.players.get(profile.id);
  const player: FeastConn = existing
    ? Object.assign(existing, {
        ws,
        connected: true,
        name: profile.displayName,
        avatar: profile.avatar,
        muncher,
      })
    : {
        profileId: profile.id,
        name: profile.displayName,
        avatar: profile.avatar,
        muncher,
        isBot: false,
        ready: false,
        connected: true,
        ws,
      };
  r.players.set(profile.id, player);

  ws.on('message', (raw) => {
    let msg: {
      type?: string;
      plateId?: unknown;
      targetId?: unknown;
      rimPos?: unknown;
      aim?: unknown;
      firing?: unknown;
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    onMessage(db, r, player, msg);
  });

  ws.on('close', () => {
    player.connected = false;
    if (connectedHumans(r).length === 0) {
      teardown(r);
      rooms.delete(accountId);
      return;
    }
    if (r.phase === 'lobby' || r.phase === 'finished') broadcastLobby(r);
  });

  send(ws, { type: 'joined', profileId: profile.id });
  broadcastLobby(r);
}

function teardown(room: FeastRoom) {
  if (room.tick) clearInterval(room.tick);
  if (room.countdown) clearTimeout(room.countdown);
  room.tick = null;
  room.countdown = null;
}

function onMessage(
  db: Db,
  room: FeastRoom,
  player: FeastConn,
  msg: {
    type?: string;
    plateId?: unknown;
    targetId?: unknown;
    rimPos?: unknown;
    aim?: unknown;
    firing?: unknown;
  },
): void {
  switch (msg.type) {
    case 'ready':
      if (room.phase !== 'lobby') return;
      player.ready = true;
      broadcastLobby(room);
      maybeStart(db, room);
      return;
    case 'addBot':
      if (room.phase !== 'lobby' || room.players.size >= MAX_PLAYERS) return;
      addBot(room);
      broadcastLobby(room);
      return;
    case 'grab':
      if (room.phase === 'playing' && room.state && typeof msg.plateId === 'number') {
        applyGrab(room.state, player.profileId, msg.plateId, Date.now());
      }
      return;
    case 'bump':
      if (room.phase === 'playing' && room.state && typeof msg.targetId === 'string') {
        applyBump(room.state, player.profileId, msg.targetId, Date.now());
      }
      return;
    case 'move':
      if (
        room.phase === 'playing' &&
        room.state &&
        typeof msg.rimPos === 'number' &&
        typeof msg.aim === 'number' &&
        typeof msg.firing === 'boolean'
      ) {
        applyMove(room.state, player.profileId, msg.rimPos, msg.aim, msg.firing);
      }
      return;
    case 'again':
      // Back to the lobby for another round (keep bots; clear ready flags).
      if (room.phase !== 'finished') return;
      room.phase = 'lobby';
      room.state = null;
      room.awarded = false;
      for (const p of room.players.values()) if (!p.isBot) p.ready = false;
      broadcastLobby(room);
      return;
  }
}

function addBot(room: FeastRoom): void {
  const i = room.botSeq++ % BOT_NAMES.length;
  const id = `bot-${room.botSeq}`;
  room.players.set(id, {
    profileId: id,
    name: BOT_NAMES[i],
    avatar: BOT_AVATARS[i],
    muncher: BOT_MUNCHERS[i],
    isBot: true,
    ready: true,
    connected: true,
    ws: undefined,
  });
}

/** Start once every connected human is ready. Auto-adds one bot so a lone
 *  player always has a rival (score-attack alone is dull). */
function maybeStart(db: Db, room: FeastRoom): void {
  const ch = connectedHumans(room);
  if (ch.length === 0 || !ch.every((p) => p.ready)) return;
  if (room.players.size < 2) addBot(room);
  startCountdown(db, room);
}

function startCountdown(db: Db, room: FeastRoom): void {
  room.phase = 'countdown';
  broadcast(room, { type: 'countdown', ms: COUNTDOWN_MS });
  room.countdown = setTimeout(() => void go(db, room), COUNTDOWN_MS);
}

async function go(db: Db, room: FeastRoom): Promise<void> {
  // Build the fact pool from the pool profile's currently-enabled sets.
  let enabled: string[] = [];
  try {
    enabled = await db.listEnabledSetIds(room.poolProfileId);
  } catch {
    enabled = [];
  }
  const sets = SEED_CATALOG.filter((s) => enabled.includes(s.id));
  const pool = generateFactsForSets(sets);
  if (pool.length === 0) {
    room.phase = 'lobby';
    for (const p of room.players.values()) if (!p.isBot) p.ready = false;
    broadcast(room, { type: 'error', code: 'no_enabled_sets' });
    broadcastLobby(room);
    return;
  }

  const now = Date.now();
  // Round length is fixed in the engine; an env override keeps headless smoke
  // tests fast (a 90s round would be untestable).
  const envRound = Number(process.env.FF_FEAST_ROUND_MS);
  const roundMs = Number.isFinite(envRound) && envRound > 0 ? envRound : undefined;
  room.state = createFeastState(
    [...room.players.values()].map((p) => ({
      profileId: p.profileId,
      name: p.name,
      avatar: p.avatar,
      muncher: p.muncher,
      isBot: p.isBot,
    })),
    pool,
    now,
    room.rng,
    roundMs,
  );
  room.phase = 'playing';
  room.lastTickAt = now;
  room.tick = setInterval(() => tickRoom(db, room), TICK_MS);
}

function tickRoom(db: Db, room: FeastRoom): void {
  if (!room.state) return;
  const now = Date.now();
  const dt = now - room.lastTickAt;
  room.lastTickAt = now;
  stepFeast(room.state, now, dt, room.rng);
  if (isFeastOver(room.state, now)) {
    void finish(db, room);
    return;
  }
  broadcast(room, { type: 'snapshot', ...feastSnapshot(room.state, now) });
}

async function finish(db: Db, room: FeastRoom): Promise<void> {
  if (room.tick) clearInterval(room.tick);
  room.tick = null;
  room.phase = 'finished';
  const standings = feastStandings(room.state!.players);
  const withCoins = standings.map((s) => ({
    ...s,
    coinsEarned: placementCoins(s.placement, standings.length),
  }));
  if (!room.awarded) {
    room.awarded = true;
    for (const s of withCoins) {
      if (!s.isBot) {
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
