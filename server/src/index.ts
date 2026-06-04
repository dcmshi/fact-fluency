/**
 * Server bootstrap — DESIGN.md §5.2. Opens the DB, applies the schema, builds
 * the app, and listens.
 */
import { createApp } from './app';
import { createDb } from './db';

const PORT = Number(process.env.PORT ?? 3001);
const DATABASE_URL = process.env.DATABASE_URL ?? 'sqlite:./data/fact-fluency.sqlite';
const isProd = process.env.NODE_ENV === 'production';

async function main() {
  const db = createDb(DATABASE_URL);
  await db.migrate();
  const app = createApp(db, isProd);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Fact Fluency API listening on http://localhost:${PORT} (${isProd ? 'prod' : 'dev'})`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start server:', err);
  process.exit(1);
});
