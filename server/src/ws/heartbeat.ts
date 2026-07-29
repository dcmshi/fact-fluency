/**
 * Liveness probe shared by both live-game WebSocket servers (race/, feast/).
 *
 * TCP won't tell you the peer is gone: a tablet that drops off wifi without a
 * FIN leaves the server socket `readyState === OPEN` for as long as the OS
 * takes to give up — minutes to hours. Both games count *connected* players to
 * decide when a round is over (`allConnectedFinished`, `connectedHumans`), so a
 * zombie stalls the room forever: the kid who actually finished never gets
 * their placement, and the room is never garbage-collected.
 *
 * The fix is the standard ws heartbeat — ping every interval, terminate anyone
 * who didn't answer the previous one. `terminate()` fires 'close', so each
 * game's existing close handler still runs the room cleanup.
 */
import type { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_PING_MS = 30_000;

/** Production cadence, overridable for tests (a 30s probe is untestable —
 *  same trick as FF_FEAST_ROUND_MS). */
export function pingIntervalMs(): number {
  const env = Number(process.env.FF_WS_PING_MS);
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_PING_MS;
}

export interface Heartbeat {
  /** Start watching a socket. Call once per accepted connection. */
  track(ws: WebSocket): void;
  stop(): void;
}

export function startHeartbeat(wss: WebSocketServer): Heartbeat {
  // WeakSet, so a collected socket doesn't pin memory here.
  const alive = new WeakSet<WebSocket>();

  const timer = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate(); // missed the last round trip — assume it's gone
        continue;
      }
      alive.delete(client); // must pong again before the next sweep
      client.ping();
    }
  }, pingIntervalMs());
  timer.unref?.(); // never hold the process open for the probe

  return {
    track(ws) {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
