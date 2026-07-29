/**
 * Runs the shared Db contract (contractSuite.ts) against the two adapters that
 * need no external services, so it's part of the default `npm test`. The same
 * spec runs against a real Postgres in `postgres.integration.test.ts`.
 */
import { newDb } from 'pg-mem';
import { describeDbContract } from './contractSuite';
import { PostgresDb, type PgPool } from './postgres';
import { SqliteDb } from './sqlite';

describeDbContract('sqlite', async () => new SqliteDb(':memory:'));

describeDbContract('postgres (pg-mem)', async () => {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const db = new PostgresDb(new pg.Pool() as PgPool);
  await db.migrate();
  return db;
});
