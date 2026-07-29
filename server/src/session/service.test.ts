/**
 * Service-level session tests that need control over `now` (which the HTTP
 * layer fixes to Date.now()): the cross-day reconciliation paths.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Profile } from '@shared';
import { SqliteDb } from '../db/sqlite';
import { answer, complete, startSession } from './service';
import { pendingSessionLocks } from './sessionLock';

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
  return { accountId, profile, profileId: profile.id };
}

describe('stale open session is reconciled on next start', () => {
  it('credits coins for a prior-day session the kid never completed (offline finish)', async () => {
    const { accountId, profile, profileId } = await makeProfile();
    const day1 = Date.UTC(2026, 0, 1, 9, 0, 0);

    const session = await startSession(db, profile, day1);
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
    await startSession(db, profile, day2);
    const coins = (await db.getProfileReward(profileId)).coins;
    expect(coins).toBeGreaterThan(0);

    // The late client complete() for the old session must not double-award.
    const summary = await complete(db, accountId, session.sessionId, day2);
    expect(summary.coins).toBe(coins);
  });

  it('just closes a prior-day session that logged no attempts', async () => {
    const { profile, profileId } = await makeProfile();
    const day1 = Date.UTC(2026, 0, 1, 9, 0, 0);
    await startSession(db, profile, day1);
    await startSession(db, profile, day1 + DAY_MS);
    expect((await db.getProfileReward(profileId)).coins).toBe(0);
  });
});

describe('concurrent completes award exactly once', () => {
  it('two in-flight complete() calls credit coins and bump the streak once', async () => {
    const { accountId, profile, profileId } = await makeProfile();
    const now = Date.UTC(2026, 0, 1, 9, 0, 0);

    const session = await startSession(db, profile, now);
    for (const card of session.deck) {
      await answer(
        db,
        accountId,
        session.sessionId,
        { factId: card.fact.id, correct: true, responseMs: 1200 },
        now,
      );
    }

    // Both calls read the session while it's still open (e.g. the play screen's
    // complete racing a reconnect flushAll replay) — only one may award.
    const [a, b] = await Promise.all([
      complete(db, accountId, session.sessionId, now),
      complete(db, accountId, session.sessionId, now),
    ]);

    expect(a.pointsEarned).toBeGreaterThan(0);
    const { coins } = await db.getProfileReward(profileId);
    expect(coins).toBe(a.pointsEarned); // credited once, not twice
    // The loser may read the streak before or after the winner's bump — but the
    // stored streak must end at 1 (bumped once), never 2.
    expect(Math.max(a.streak, b.streak)).toBe(1);
    expect((await db.getProfileStreak(profileId)).streak).toBe(1);
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
    const session = await startSession(db, profile, now);

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

describe('streak shield (perk)', () => {
  async function playAndComplete(accountId: string, profile: Profile, day: number) {
    const session = await startSession(db, profile, day);
    await answer(
      db,
      accountId,
      session.sessionId,
      { factId: session.deck[0].fact.id, correct: true, responseMs: 900 },
      day,
    );
    return complete(db, accountId, session.sessionId, day);
  }

  it('one owned shield absorbs exactly one missed day, then is consumed', async () => {
    const { accountId, profile, profileId } = await makeProfile();
    await db.addCoins(profileId, 60);
    expect(await db.spendAndUnlock(profileId, 'perk-streak-shield', 60)).toMatchObject({
      status: 'ok',
    });

    const day1 = Date.UTC(2026, 0, 1, 9);
    expect((await playAndComplete(accountId, profile, day1)).streak).toBe(1);
    // Day 2 is skipped; day 3's completion would normally reset to 1.
    const day3 = day1 + 2 * DAY_MS;
    expect((await playAndComplete(accountId, profile, day3)).streak).toBe(2);
    expect(await db.listUnlocks(profileId)).not.toContain('perk-streak-shield'); // spent

    // Without a shield the next gap resets as before.
    const day5 = day3 + 2 * DAY_MS;
    expect((await playAndComplete(accountId, profile, day5)).streak).toBe(1);
  });

  it('a shield does not stretch across two or more missed days', async () => {
    const { accountId, profile, profileId } = await makeProfile();
    await db.addCoins(profileId, 60);
    await db.spendAndUnlock(profileId, 'perk-streak-shield', 60);

    const day1 = Date.UTC(2026, 0, 1, 9);
    await playAndComplete(accountId, profile, day1);
    const day4 = day1 + 3 * DAY_MS; // two missed days
    expect((await playAndComplete(accountId, profile, day4)).streak).toBe(1);
    // The shield only spends on the exactly-one-missed-day path.
    expect(await db.listUnlocks(profileId)).toContain('perk-streak-shield');
  });
});

describe('audit pass 9 — service-level coverage for the P7 wiring', () => {
  it('equality-only boards when comparisons is off', async () => {
    const accountId = await db.createAccount('c@b.co', 'hash', 'UTC');
    const profile = await db.createProfile({
      accountId,
      displayName: 'Kid',
      avatar: '🦊',
      settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 6, comparisons: false },
    });
    await db.setEnabledSetIds(profile.id, ['add-0-10']);
    const session = await startSession(db, profile, Date.UTC(2026, 0, 1, 9));
    expect(session.deck.length).toBeGreaterThan(3);
    for (const card of session.deck) {
      expect(card.board?.relation).toBe('=');
    }
  });

  it('stops emitting in-session re-shows past the presentation ceiling', async () => {
    const { accountId, profile } = await makeProfile();
    const now = Date.UTC(2026, 0, 1, 9);
    const session = await startSession(db, profile, now);
    const factId = session.deck[0].fact.id;

    // Answer the same fact wrong repeatedly: every wrong answer requeues, so
    // injects flow until the session's attempt count crosses the ceiling (30).
    let sawInject = false;
    let stoppedAt: number | null = null;
    for (let i = 1; i <= 35; i++) {
      const r = await answer(
        db,
        accountId,
        session.sessionId,
        { factId, correct: false, responseMs: 900 },
        now,
      );
      if (r.injects?.length) sawInject = true;
      else if (stoppedAt === null) stoppedAt = i;
    }
    expect(sawInject).toBe(true); // early misses do re-show
    expect(stoppedAt).not.toBeNull(); // ...but the ceiling cuts them off
    expect(stoppedAt!).toBeLessThanOrEqual(31);
  });

  it('throttles new-fact intake from recent attempt accuracy (service wiring)', async () => {
    const { accountId, profile } = await makeProfile();
    const day1 = Date.UTC(2026, 0, 1, 9);

    // Session 1: answer >=10 attempts at ~30% accuracy (struggling).
    const s1 = await startSession(db, profile, day1);
    const ids = s1.deck.map((c) => c.fact.id);
    for (let i = 0; i < 12; i++) {
      await answer(
        db,
        accountId,
        s1.sessionId,
        { factId: ids[i % ids.length], correct: i % 3 === 0, responseMs: 900 },
        day1,
      );
    }
    await complete(db, accountId, s1.sessionId, day1);

    // Next day's plan must include NO cold intros while accuracy is that low.
    const s2 = await startSession(db, profile, day1 + DAY_MS);
    expect(s2.deck.some((c) => c.isNew)).toBe(false);
  });
});

describe('concurrent answers on one session', () => {
  it('does not lose a learning counter when two answers overlap', async () => {
    const { accountId, profile } = await makeProfile();
    const now = Date.UTC(2026, 0, 1, 9);
    const session = await startSession(db, profile, now);
    // Two *different* box-0 facts, so their counters are independent — the only
    // way one can vanish is the working-state read-modify-write racing itself.
    const newCards = session.deck.filter((c) => c.isNew).slice(0, 2);
    expect(newCards).toHaveLength(2);

    // The client fires answers without waiting (finishRound advances
    // immediately, the POST is in flight), so two can genuinely overlap.
    await Promise.all(
      newCards.map((c) =>
        answer(
          db,
          accountId,
          session.sessionId,
          { factId: c.fact.id, correct: true, responseMs: 900 },
          now,
        ),
      ),
    );

    const ws = JSON.parse((await db.getSession(session.sessionId))!.workingState);
    for (const c of newCards) {
      expect(ws.learning[c.fact.id]).toBe(1);
    }
    // The queue for a session must drain away, not accumulate an entry per
    // session the process has ever seen. (Released a tick after the caller
    // resumes, so let the microtask queue settle first.)
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingSessionLocks()).toBe(0);
  });

  it('keeps serving a session after one answer throws', async () => {
    const { accountId, profile } = await makeProfile();
    const now = Date.UTC(2026, 0, 1, 9);
    const session = await startSession(db, profile, now);
    const card = session.deck[0];

    await expect(
      answer(
        db,
        accountId,
        session.sessionId,
        { factId: 'nope:1+1', correct: true, responseMs: 900 },
        now,
      ),
    ).rejects.toThrow();
    // A rejected answer must not wedge the chain for every later one.
    const ok = await answer(
      db,
      accountId,
      session.sessionId,
      { factId: card.fact.id, correct: true, responseMs: 900 },
      now,
    );
    expect(ok.correct).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingSessionLocks()).toBe(0);
  });
});
