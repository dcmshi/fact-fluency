/**
 * Server bootstrap — DESIGN.md §5.2. Opens the DB, applies the schema, builds
 * the app, and listens.
 */
import { createApp } from './app';
import { createDb } from './db';
import { attachRaceLive } from './race/live';

const PORT = Number(process.env.PORT ?? 3001);
// Bind all IPv4 interfaces by default. Without an explicit host, Node binds to
// IPv6 `::`, which on Render (and some hosts without dual-stack) leaves the
// service unreachable on IPv4 — its port scanner then reports "no open ports
// detected" and the deploy times out. 0.0.0.0 is what Render expects.
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL ?? 'sqlite:./data/fact-fluency.sqlite';
const isProd = process.env.NODE_ENV === 'production';

/** Drop expired auth_session rows so they don't accumulate (best-effort). */
const PRUNE_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function main() {
  const db = createDb(DATABASE_URL);
  await db.migrate();

  const prune = () =>
    db
      .deleteExpiredAuthSessions(Date.now())
      .then(() => db.deleteExpiredGuests(Date.now()))
      .catch(() => 0);
  void prune(); // once on boot
  const pruneTimer = setInterval(() => void prune(), PRUNE_INTERVAL_MS);
  pruneTimer.unref?.(); // don't keep the process alive for the timer

  const app = createApp(db, isProd);
  const server = app.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console
    console.log(`Fact Fluency API listening on ${HOST}:${PORT} (${isProd ? 'prod' : 'dev'})`);
  });
  // Live-race WebSocket rooms ride the same HTTP server (MULTIPLAYER.md §2).
  attachRaceLive(server, db);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
