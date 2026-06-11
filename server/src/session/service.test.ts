/**
 * Service-level session tests that need control over `now` (which the HTTP
 * layer fixes to Date.now()): the cross-day reconciliation paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from '../db/sqlite';
import { answer, complete, previousDay, startSession } from './service';

describe('previousDay (DST-proof calendar arithmetic)', () => {
  it('steps back across normal, month, year, and leap boundaries', () => {
    expect(previousDay('2026-03-09')).toBe('2026-03-08'); // day after US spring-forward
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
    expect(previousDay('2024-03-01')).toBe('2024-02-29'); // leap year
    expect(previousDay('2026-01-01')).toBe('2025-12-31');
  });
});

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

describe('caught-up is scoped to the enabled sets', () => {
  it('a disabled set\'s due rows no longer block "all caught up"', async () => {
    const accountId = await db.createAccount('a@b.co', 'hash', 'UTC');
    const profile = await db.createProfile({
      accountId,
      displayName: 'Kid',
      avatar: '🦊',
      settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
    });
    const profileId = profile.id;
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);

    // A leftover review row from a set that is NOT enabled — due now.
    await db.upsertProgress({
      profileId,
      factId: 'mul:6x7',
      box: 2,
      state: 'review',
      dueAt: now - 1000,
      lastSeenAt: now - DAY_MS,
      reps: 4,
      fastCorrect: 2,
      correctStreak: 2,
      accuracyEwma: 0.9,
      medianMsEwma: 1400,
    });

    // Only add-0-10 is enabled; the mul fact above can never be served.
    await db.setEnabledSetIds(profileId, ['add-0-10']);
    const session = await startSession(db, accountId, profileId, now);

    // Graduate every box-0 deck fact out of the learning phase (two in-session
    // corrects, §4.3). The last answer should report caughtUp even though the
    // orphan mul row is still "due".
    let lastCaughtUp = false;
    for (const card of session.deck) {
      for (let rep = 0; rep < 2; rep++) {
        const r = await answer(
          db,
          accountId,
          session.sessionId,
          { factId: card.fact.id, correct: true, responseMs: 600 },
          now,
        );
        lastCaughtUp = !!r.caughtUp;
      }
    }
    // The orphan row is still counted unscoped, proving the scoping is what
    // unblocks the celebration.
    expect(await db.countDueReview(profileId, now)).toBeGreaterThan(0);
    expect(
      await db.countDueReview(
        profileId,
        now,
        session.deck.map((c) => c.fact.id),
      ),
    ).toBe(0);
    expect(lastCaughtUp).toBe(true);
  });
});
