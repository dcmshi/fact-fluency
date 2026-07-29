/**
 * Shared WebSocket upgrade concerns for the two live-game servers.
 *
 * Both attach their own `'upgrade'` listener to the one HTTP server and claim a
 * single path each. That leaves two gaps this module closes:
 *
 * 1. **Unclaimed upgrades leak.** Once *any* 'upgrade' listener is registered,
 *    Node stops closing unhandled upgrades for you. A request to any other path
 *    was therefore answered by nobody and destroyed by nobody — the socket sat
 *    half-open until the client gave up, which anything scanning the host can
 *    repeat cheaply. `attachUpgradeGuard` runs last and destroys what no game
 *    claimed.
 *
 * 2. **No Origin check (CSWSH).** The handshake authenticates from the session
 *    cookie alone, so any page on the internet could open a socket into a
 *    family's game. Today only `SameSite=Lax` prevents that — one browser-policy
 *    change away from being the whole defence, and the cookie isn't `secure` in
 *    dev. Same-origin is now required explicitly.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

const claimedPaths = new Set<string>();

/** Register a path a game server owns, so the guard below leaves it alone. */
export function claimUpgradePath(path: string): void {
  claimedPaths.add(path);
}

export function upgradePath(req: IncomingMessage): string {
  return new URL(req.url ?? '', 'http://localhost').pathname;
}

/**
 * Same-origin check for a handshake. A missing `Origin` is allowed: non-browser
 * clients (our own tests, native apps) don't send one, and the attack this
 * blocks is specifically a *browser* on another site — which always does.
 * Loopback origins stay allowed outside production so the Vite dev proxy
 * (:5173 → :3001, different ports = different origins) keeps working.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false; // unparseable Origin — not something a browser sends
  }
  if (host === req.headers.host) return true;
  if (process.env.NODE_ENV !== 'production') {
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  }
  return false;
}

/**
 * Destroy upgrades no game claimed. Must be attached *after* both game servers:
 * 'upgrade' listeners run in registration order, and this one is the fallback.
 */
export function attachUpgradeGuard(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    if (claimedPaths.has(upgradePath(req))) return; // an earlier listener owns it
    socket.on('error', () => {}); // a reset here must not throw on its way out
    socket.destroy();
  });
}
