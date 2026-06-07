/**
 * Server bootstrap — DESIGN.md §5.2. Opens the DB, applies the schema, builds
 * the app, and listens.
 */
import { createApp } from './app';
import { createDb } from './db';

const PORT = Number(process.env.PORT ?? 3001);
const DATABASE_URL = process.env.DATABASE_URL ?? 'sqlite:./data/fact-fluency.sqlite';
const isProd = process.env.NODE_ENV === 'production';

/** Drop expired auth_session rows so they don't accumulate (best-effort). */
const PRUNE_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function main() {
  // Fail fast on a missing/placeholder cookie secret in production — otherwise
  // session cookies would be signed with a publicly-known default key. Render
  // injects a generated COOKIE_SECRET (render.yaml); a bare deploy without one
  // should refuse to boot rather than run insecurely.
  const cookieSecret = process.env.COOKIE_SECRET;
  if (isProd && (!cookieSecret || cookieSecret === 'dev-only-change-me')) {
    throw new Error('COOKIE_SECRET must be set to a strong value in production');
  }

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
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Fact Fluency API listening on http://localhost:${PORT} (${isProd ? 'prod' : 'dev'})`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
