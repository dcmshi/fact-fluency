/**
 * Live-race WebSocket layer — protocol + robustness.
 *
 * These run against a real HTTP server and a real `ws` client, because the bugs
 * worth catching here (unhandled socket 'error' events, oversized frames) live
 * in the IO layer, not the pure room engine (engine/raceRoom.test.ts covers
 * that). An unhandled 'error' on a ws socket takes down the whole process, so
 * "the server is still answering afterwards" is the assertion that matters.
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SqliteDb } from '../db/sqlite';
import { attachRaceLive } from './live';

let db: SqliteDb;
let server: Server;
let port: number;
let cookie: string;
let raceId: string;
let profileId: string; // the first racer; kids[] holds all three
let kids: string[];

/** Production cadences (30s probe, 3s countdown) would be untestable; both
 *  servers read these at attach time (same trick as FF_FEAST_ROUND_MS). */
const PING_MS = 40;
const COUNTDOWN_MS = 30;
process.env.FF_WS_PING_MS = String(PING_MS);
process.env.FF_RACE_COUNTDOWN_MS = String(COUNTDOWN_MS);

beforeEach(async () => {
  db = new SqliteDb(':memory:');
  const accountId = await db.createAccount('p@home.test', 'hash', 'UTC');
  const token = 'tok-' + Math.random().toString(36).slice(2);
  await db.createAuthSession(accountId, token, Date.now() + 60_000);
  cookie = `ff_session=${token}`;
  kids = [];
  for (const name of ['Ada', 'Ben', 'Cal']) {
    const p = await db.createProfile({
      accountId,
      displayName: name,
      avatar: '🦊',
      settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
    });
    kids.push(p.id);
  }
  profileId = kids[0];
  raceId = 'race-1';
  await db.createRace({
    id: raceId,
    accountId,
    createdByProfileId: kids[0],
    deck: '[]',
    factCount: 10,
    createdAt: Date.now(),
  });

  server = createServer();
  attachRaceLive(server, db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
});

type Frame = Record<string, unknown> & { type: string };

/**
 * A test client that *buffers* every frame from the moment it connects. The
 * server sends frames back to back (`joined` then `state`, `countdown` then
 * `go` 30ms later), so a listener attached after an `await` reliably misses
 * them — `next()` checks the buffer before waiting.
 */
interface Client {
  ws: WebSocket;
  next(type: string, ms?: number): Promise<Frame>;
  send(msg: unknown): void;
  close(): void;
}

function track(ws: WebSocket): Client {
  const seen: Frame[] = [];
  let consumed = 0;
  ws.on('message', (raw) => seen.push(JSON.parse(raw.toString())));
  return {
    ws,
    async next(type, ms = 1000) {
      const deadline = Date.now() + ms;
      for (;;) {
        while (consumed < seen.length) {
          const frame = seen[consumed++];
          if (frame.type === type) return frame;
        }
        if (Date.now() > deadline) throw new Error(`no '${type}' frame within ${ms}ms`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

/** Resolve when the socket is closed — including if it already is (the close
 *  often lands while we're polling the frame buffer). */
function closed(ws: WebSocket, ms = 1000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    ws.once('close', () => resolve());
    setTimeout(() => reject(new Error(`socket still open after ${ms}ms`)), ms);
  });
}

/** Raw socket — for cases where the server is expected to refuse us. */
function open(who: string = profileId): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/api/race-ws?raceId=${raceId}&profileId=${who}`, {
    headers: { cookie },
  });
}

/** Open a race socket and resolve once the server's `joined` frame lands. */
async function connect(who: string = profileId): Promise<Client> {
  const client = track(open(who));
  await client.next('joined');
  return client;
}

/** Both racers ready up, which starts the countdown, then the race. */
async function startRace(): Promise<{ a: Client; b: Client }> {
  const a = await connect(kids[0]);
  const b = await connect(kids[1]);
  a.send({ type: 'ready', ready: true });
  b.send({ type: 'ready', ready: true });
  await b.next('countdown');
  return { a, b };
}

describe('live race WebSocket', () => {
  it('authenticates the upgrade and admits an owned profile', async () => {
    const client = await connect();
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it('rejects an upgrade with no session cookie', async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/race-ws?raceId=${raceId}&profileId=${profileId}`,
    );
    await expect(
      new Promise((_resolve, reject) => {
        ws.once('open', () => reject(new Error('unauthenticated upgrade was accepted')));
        ws.once('error', (err) => reject(err));
        ws.once('close', () => reject(new Error('closed')));
      }),
    ).rejects.toThrow();
  });

  it('pings clients and leaves a responsive one connected', async () => {
    const client = await connect();
    // A half-open socket (lid closed, wifi drop) stays readyState OPEN for as
    // long as the OS takes to notice, so the room needs its own liveness probe.
    await new Promise<void>((resolve) => client.ws.once('ping', () => resolve()));
    // ...and a client that answers (ws auto-pongs) must survive several cycles.
    await new Promise((resolve) => setTimeout(resolve, PING_MS * 4));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    client.close();
  });

  it("a reconnect's old socket closing does not disconnect the live player", async () => {
    const first = await connect();
    const second = await connect(); // same profile → reconnect, swaps player.ws

    // The dead socket's close arrives late. If it blindly flips connected=false
    // (or tears the room down), the live socket is orphaned: broadcasts skip it.
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    second.send({ type: 'ready', ready: true });
    // Reaches us only if the server still considers this player connected.
    expect((await second.next('state', 500)).phase).toBe('lobby');
    second.close();
  });

  it('refuses a newcomer once the race is under way', async () => {
    const { a, b } = await startRace();

    // A late joiner used to be admitted unfinished and never sent `go`, so
    // allConnectedFinished could never pass — the race in progress could never
    // end for anyone.
    const late = track(open(kids[2]));
    expect(await late.next('error')).toMatchObject({ code: 'race_in_progress' });
    await closed(late.ws);

    a.close();
    b.close();
  });

  it('lets an already-joined racer reconnect mid-race', async () => {
    const { a, b } = await startRace();
    a.close();
    // The phase guard must not lock out someone who was already racing.
    const back = await connect(kids[0]);
    expect(back.ws.readyState).toBe(WebSocket.OPEN);
    back.close();
    b.close();
  });

  it('resets a finished room to the lobby when a new racer joins', async () => {
    const { a, b } = await startRace();
    await b.next('go');
    a.send({ type: 'finish', totalMs: 5000 });
    b.send({ type: 'finish', totalMs: 6000 });
    await b.next('finished');
    a.close();
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Without a reset the room stays 'finished' forever — `ready` is only
    // honored in the lobby, so the next racer could never start.
    const next = await connect(kids[2]);
    expect((await next.next('state')).phase).toBe('lobby');
    next.close();
  });

  it('floors a finish at the time actually elapsed, and ignores a second one', async () => {
    const { a, b } = await startRace();
    await b.next('go');
    await new Promise((resolve) => setTimeout(resolve, 120));

    // A modified client can claim it swept 10 rounds the instant `go` landed.
    a.send({ type: 'finish', totalMs: 0 });
    // ...and re-submitting an even better time used to reshuffle the standings.
    a.send({ type: 'finish', totalMs: 0 });
    b.send({ type: 'finish', totalMs: 4000 });

    const standings = (await b.next('finished')).standings as {
      profileId: string;
      finishMs: number;
    }[];
    const forged = standings.find((s) => s.profileId === kids[0])!;
    expect(forged.finishMs).toBeGreaterThanOrEqual(100); // not 0
    // Honest B ran 4s; the forger's floored time is ~120ms, so B still places
    // second here — what matters is that 0 didn't become the recorded time.
    expect(standings.filter((s) => s.profileId === kids[0])).toHaveLength(1);
    a.close();
    b.close();
  });

  it('survives an oversized frame instead of crashing the process', async () => {
    const client = await connect();
    // Far beyond any real game message (they're tens of bytes). Without a
    // maxPayload cap plus an 'error' handler on the socket, ws emits an
    // unhandled 'error' here and the whole server process dies.
    client.send({ type: 'progress', rounds: 1, pad: 'x'.repeat(2_000_000) });
    await closed(client.ws);

    // The offending socket is gone, but the server must still be serving:
    // a fresh client still completes the handshake.
    const again = await connect();
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    again.close();
  });
});
