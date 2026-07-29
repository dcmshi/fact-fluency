/**
 * The Db contract against a **real** Postgres (Docker), plus the guarantees
 * pg-mem cannot express.
 *
 * Why this exists: pg-mem is a reimplementation, not Postgres. It silently
 * ignored `COUNT(*) FILTER` and counted every row (caught in review, but only
 * because SQLite disagreed), and it cannot honor ROLLBACK — so every
 * transactional claim in the adapter was previously asserted against SQLite
 * alone, while Postgres is what production actually runs.
 *
 * Skipped unless FF_TEST_PG_URL is set, so `npm test` stays Docker-free.
 * Run it with `npm run test:pg`, which starts the container and tears it down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeDbContract } from './contractSuite';
import { PostgresDb, type PgClient, type PgPool } from './postgres';

const url = process.env.FF_TEST_PG_URL;

/** One long-lived connection used only to reset state between tests. */
let admin: PgPool | undefined;

async function adminPool(): Promise<PgPool> {
  if (!admin) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pg = require('pg') as typeof import('pg');
    admin = new pg.Pool({ connectionString: url }) as unknown as PgPool;
  }
  return admin;
}

/**
 * A pristine database per test. Dropping the schema is blunt but unambiguous —
 * no leftover row can make a test pass or fail for the wrong reason, and it
 * exercises `migrate()` from nothing on every single case.
 */
async function freshDb(): Promise<PostgresDb> {
  const pool = await adminPool();
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  // fromUrl, not `new PostgresDb(pool)`: it's the production construction path,
  // including the BIGINT type parser that epoch-ms columns depend on.
  const db = PostgresDb.fromUrl(url!);
  await db.migrate();
  return db;
}

if (!url) {
  describe.skip('Postgres integration (set FF_TEST_PG_URL — see npm run test:pg)', () => {
    it('skipped', () => {});
  });
} else {
  afterAll(async () => {
    await admin?.end();
    admin = undefined;
  });

  // The whole shared contract, against the real engine.
  describeDbContract('postgres (docker)', freshDb);

  describe('Postgres behaviour pg-mem cannot verify', () => {
    let db: PostgresDb;
    beforeAll(async () => {
      db = await freshDb();
    });

    it('rolls back a failed transaction (pg-mem ignores ROLLBACK)', async () => {
      const accountId = await db.createAccount('rollback@x.co', 'hash', 'UTC');
      const profile = await db.createProfile({
        accountId,
        displayName: 'Kid',
        avatar: '🦊',
        settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
      });
      await db.addCoins(profile.id, 50);

      // recordAnswer writes progress + attempt + working state in one
      // transaction. Point it at a session that doesn't exist so the attempt's
      // foreign key blows up *after* the progress upsert has run: nothing at
      // all may survive. This is the assertion SQLite has been carrying alone.
      await expect(
        db.recordAnswer({
          progress: {
            profileId: profile.id,
            factId: 'add:1+1',
            box: 1,
            state: 'review',
            dueAt: 100,
            lastSeenAt: 10,
            reps: 1,
            fastCorrect: 1,
            correctStreak: 1,
            accuracyEwma: 1,
            medianMsEwma: 900,
          },
          attempt: {
            id: 'attempt-1',
            sessionId: 'no-such-session',
            profileId: profile.id,
            factId: 'add:1+1',
            given: 0,
            correct: true,
            fast: true,
            responseMs: 900,
            answeredAt: 20,
          },
        }),
      ).rejects.toThrow();

      expect(await db.getProgressForFact(profile.id, 'add:1+1')).toBeNull();
      expect((await db.getProfileReward(profile.id)).coins).toBe(50);
    });

    it('keeps epoch-ms values exact through BIGINT columns', async () => {
      const accountId = await db.createAccount('bigint@x.co', 'hash', 'UTC');
      const profile = await db.createProfile({
        accountId,
        displayName: 'Kid',
        avatar: '🦊',
        settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
      });
      // Beyond INT4 — the reason these columns are BIGINT — and past 2^53 would
      // be a different bug, so use a real far-future timestamp.
      const farFuture = Date.UTC(2099, 11, 31, 23, 59, 59);
      await db.createSession({
        id: 's-bigint',
        profileId: profile.id,
        startedAt: farFuture,
        completedAt: null,
        plannedCount: 3,
        workingState: '{}',
      });
      const session = await db.getSession('s-bigint');
      expect(session?.startedAt).toBe(farFuture);
      expect(typeof session?.startedAt).toBe('number'); // parsed, not a string
    });

    it('enforces the one-open-session partial unique index', async () => {
      const accountId = await db.createAccount('oneopen@x.co', 'hash', 'UTC');
      const profile = await db.createProfile({
        accountId,
        displayName: 'Kid',
        avatar: '🦊',
        settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
      });
      const open = (id: string) => ({
        id,
        profileId: profile.id,
        startedAt: 1,
        completedAt: null,
        plannedCount: 3,
        workingState: '{}',
      });
      await db.createSession(open('s1'));
      // startSession relies on this constraint to resolve a double-tap race.
      await expect(db.createSession(open('s2'))).rejects.toThrow();
      // ...but a *completed* session doesn't block the next one.
      await db.completeSession('s1', 2);
      await expect(db.createSession(open('s3'))).resolves.toBeUndefined();
    });

    it('re-runs migrate() cleanly on an existing database (deploy path)', async () => {
      // Every boot calls migrate(); a second run must be a no-op rather than an
      // error. (pg-mem can't check this — it rejects the repeat CREATE TABLE.)
      await expect(db.migrate()).resolves.toBeUndefined();
      await expect(db.migrate()).resolves.toBeUndefined();
    });

    it('self-heals an additive column dropped from an existing table', async () => {
      const pool = await adminPool();
      // Simulate a database created before `attempt.attempt_id` existed.
      await pool.query('ALTER TABLE attempt DROP COLUMN attempt_id');
      await db.migrate();
      const client: PgClient = await pool.connect();
      try {
        const { rows } = await client.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'attempt' AND column_name = 'attempt_id'`,
        );
        expect(rows).toHaveLength(1);
      } finally {
        client.release();
      }
    });
  });
}
