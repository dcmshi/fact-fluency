/**
 * Service-level session tests that need control over `now` (which the HTTP
 * layer fixes to Date.now()): the cross-day reconciliation paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from '../db/sqlite';
import { answer, complete, startSession } from './service';

let db: SqliteDb;
beforeEach(() => {
  db = new SqliteDb(':memory:');
});
afterEach(async () => {
  await db.close();
});

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeProfile() {
  const accountId = await db.createAccount('a@b.co', 'hash', 'UTC');
  const profile = await db.createProfile({
    accountId,
    displayName: 'Kid',
    avatar: '🦊',
    settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
  });
  await db.setEnabledSetIds(profile.id, ['add-0-10']);
  return { accountId, profileId: profile.id };
}

describe('stale open session is reconciled on next start', () => {
  it('credits coins for a prior-day session the kid never completed (offline finish)', async () => {
    const { accountId, profileId } = await makeProfile();
    const day1 = Date.UTC(2026, 0, 1, 9, 0, 0);

    const session = await startSession(db, accountId, profileId, day1);
    // Answer the whole deck correctly but never call complete() — the offline
    // finish queued a complete() on the client that hasn't replayed yet.
    for (const card of session.deck) {
      await answer(
        db,
        accountId,
        session.sessionId,
        { factId: card.fact.id, correct: true, responseMs: 1200 },
        day1,
      );
    }
    expect((await db.getProfileReward(profileId)).coins).toBe(0); // not yet credited

    // Next day the kid taps Play: the stale open session is closed *and* its
    // coins/streak are reconciled, instead of being silently dropped.
    const day2 = day1 + DAY_MS;
    await startSession(db, accountId, profileId, day2);
    const coins = (await db.getProfileReward(profileId)).coins;
    expect(coins).toBeGreaterThan(0);

    // The late client complete() for the old session must not double-award.
    const summary = await complete(db, accountId, session.sessionId, day2);
    expect(summary.coins).toBe(coins);
  });

  it('just closes a prior-day session that logged no attempts', async () => {
    const { accountId, profileId } = await makeProfile();
    const day1 = Date.UTC(2026, 0, 1, 9, 0, 0);
    await startSession(db, accountId, profileId, day1);
    await startSession(db, accountId, profileId, day1 + DAY_MS);
    expect((await db.getProfileReward(profileId)).coins).toBe(0);
  });
});
