import type { EventEmitter } from 'node:events';
import { newDb } from 'pg-mem';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FactProgress } from '@shared';
import { PgPool, PostgresDb } from './postgres';

let db: PostgresDb;

beforeEach(async () => {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  db = new PostgresDb(new pg.Pool() as PgPool);
  await db.migrate();
});

async function accountAndProfile() {
  const accountId = await db.createAccount('a@b.co', 'hash', 'UTC');
  const profile = await db.createProfile({
    accountId,
    displayName: 'Kid',
    avatar: '🦊',
    settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
  });
  return { accountId, profile };
}

describe('PostgresDb.fromUrl', () => {
  it('handles pool errors instead of crashing the process', async () => {
    // node-postgres emits 'error' on the Pool when an *idle* client's backend
    // connection dies — Render restarts/failovers/idle timeouts all do this.
    // With no listener that's an unhandled 'error' and the process exits, so
    // routine DB maintenance would take the whole service down.
    const built = PostgresDb.fromUrl('postgres://u:p@db.invalid:5432/x');
    const pool = (built as unknown as { pool: EventEmitter & PgPool }).pool;
    expect(() => pool.emit('error', new Error('idle client died'))).not.toThrow();
    await pool.end();
  });
});

describe('PostgresDb (pg-mem)', () => {
  // Note: the additive-column self-heal (ADD COLUMN IF NOT EXISTS) can't be
  // exercised here — pg-mem rejects a CREATE TABLE IF NOT EXISTS that becomes a
  // no-op (it flags the "unread" constraints), so a second migrate() throws on
  // pg-mem though real Postgres is fine. The heal logic is covered against the
  // SQLite adapter (sqlite.test.ts) instead.

  it('migrates and round-trips an account + auth session', async () => {
    const accountId = await db.createAccount('p@home.test', 'argon', 'America/Toronto');
    expect(await db.findAccountByEmail('p@home.test')).toEqual({
      id: accountId,
      passwordHash: 'argon',
    });
    expect(await db.getAccountTimezone(accountId)).toBe('America/Toronto');

    await db.createAuthSession(accountId, 'live', Date.now() + 60_000);
    await db.createAuthSession(accountId, 'dead', Date.now() - 1);
    expect(await db.findAccountIdByToken('live')).toBe(accountId);
    expect(await db.findAccountIdByToken('dead')).toBeNull();

    expect(await db.deleteExpiredAuthSessions(Date.now())).toBe(1); // prunes 'dead' only
    expect(await db.findAccountIdByToken('live')).toBe(accountId);
  });

  it('creates profiles (streak 0) and updates the streak', async () => {
    const { accountId, profile } = await accountAndProfile();
    expect(profile.streak).toBe(0);
    expect((await db.listProfiles(accountId))[0].settings.sessionCards).toBe(20);

    await db.setProfileStreak(profile.id, 3, '2026-06-03');
    expect(await db.getProfileStreak(profile.id)).toEqual({
      streak: 3,
      lastPlayedDay: '2026-06-03',
    });
  });

  it('updates profile settings', async () => {
    const { profile } = await accountAndProfile();
    const updated = await db.updateProfileSettings(profile.id, {
      sessionCards: 15,
      sessionSeconds: 120,
      newPerSession: 2,
    });
    expect(updated.settings).toEqual({ sessionCards: 15, sessionSeconds: 120, newPerSession: 2 });
    expect((await db.getProfile(profile.id))?.settings.sessionSeconds).toBe(120);
  });

  it('replaces enabled fact sets', async () => {
    const { profile } = await accountAndProfile();
    await db.setEnabledSetIds(profile.id, ['add-0-10', 'mul-0-5']);
    expect((await db.listEnabledSetIds(profile.id)).sort()).toEqual(['add-0-10', 'mul-0-5']);
    await db.setEnabledSetIds(profile.id, ['mul-0-12']);
    expect(await db.listEnabledSetIds(profile.id)).toEqual(['mul-0-12']);
  });

  it('upserts progress and counts due / learning', async () => {
    const { profile } = await accountAndProfile();
    const base: FactProgress = {
      profileId: profile.id,
      factId: 'mul:7x8',
      box: 1,
      state: 'review',
      dueAt: 1000,
      lastSeenAt: 500,
      reps: 1,
      fastCorrect: 0,
      correctStreak: 0,
      accuracyEwma: 1,
      medianMsEwma: 3000,
    };
    await db.upsertProgress(base);
    await db.upsertProgress({ ...base, box: 2, dueAt: 2000, reps: 2 });
    const rows = await db.getProgress(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ box: 2, dueAt: 2000, reps: 2 });

    await db.upsertProgress({ ...base, factId: 'mul:1x1', box: 0, dueAt: 0 });
    expect(await db.countDueReview(profile.id, 5000)).toBe(1); // the box-2 fact
    expect(await db.countLearning(profile.id)).toBe(1); // the box-0 fact
  });

  it('persists sessions and the attempt log', async () => {
    const { profile } = await accountAndProfile();
    await db.createSession({
      id: 's1',
      profileId: profile.id,
      startedAt: 1,
      completedAt: null,
      plannedCount: 3,
      workingState: '{}',
    });
    expect((await db.getSession('s1'))?.plannedCount).toBe(3);

    await db.appendAttempt({
      id: 'a1',
      sessionId: 's1',
      profileId: profile.id,
      factId: 'mul:7x8',
      given: 56,
      correct: true,
      fast: true,
      responseMs: 1500,
      answeredAt: 2,
    });
    await db.completeSession('s1', 9);
    expect((await db.getSession('s1'))?.completedAt).toBe(9);

    const attempts = await db.listSessionAttempts('s1');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].correct).toBe(true);
    expect(attempts[0].fast).toBe(true);
  });

  it('tracks reward coins, theme, and unlocks', async () => {
    const { profile } = await accountAndProfile();
    expect(await db.getProfileReward(profile.id)).toEqual({ coins: 0, theme: 'classic' });
    await db.addCoins(profile.id, 40);
    await db.addCoins(profile.id, 10);
    expect((await db.getProfileReward(profile.id)).coins).toBe(50);
    await db.setProfileTheme(profile.id, 'candy');
    const reward = await db.getProfileReward(profile.id);
    expect(reward).toEqual({ coins: 50, theme: 'candy' });
    expect((await db.getProfile(profile.id))?.theme).toBe('candy');

    // Unlocks are recorded through the atomic spend (theme-candy costs 80).
    await db.addCoins(profile.id, 30);
    expect(await db.spendAndUnlock(profile.id, 'theme-candy', 80)).toEqual({
      status: 'ok',
      coins: 0,
    });
    expect(await db.spendAndUnlock(profile.id, 'theme-candy', 80)).toEqual({
      status: 'already_owned',
    });
    expect(await db.listUnlocks(profile.id)).toEqual(['theme-candy']);
  });

  it('spendAndUnlock debits relatively and reports ok / already-owned / insufficient', async () => {
    const { profile } = await accountAndProfile();
    await db.addCoins(profile.id, 50);

    expect(await db.spendAndUnlock(profile.id, 'muncher-fox', 40)).toEqual({
      status: 'ok',
      coins: 10,
    });
    expect(await db.listUnlocks(profile.id)).toContain('muncher-fox');

    // Same item again — already owned, no further debit.
    expect(await db.spendAndUnlock(profile.id, 'muncher-fox', 40)).toEqual({
      status: 'already_owned',
    });
    expect((await db.getProfileReward(profile.id)).coins).toBe(10);

    // Can't afford a second item.
    expect(await db.spendAndUnlock(profile.id, 'avatar-dragon', 60)).toEqual({
      status: 'insufficient',
    });
    // NB: the claim-rollback on the insufficient path can't be asserted here —
    // pg-mem's pooled client doesn't honor ROLLBACK — so its side effects (the
    // unlock claim undone) are verified against the real-transaction SQLite
    // adapter in rewards.test.ts instead. Real Postgres rolls back correctly.
  });

  it('recordAnswer persists the whole per-answer write set', async () => {
    const { profile } = await accountAndProfile();
    await db.createSession({
      id: 's1',
      profileId: profile.id,
      startedAt: 1,
      completedAt: null,
      plannedCount: 3,
      workingState: '{}',
    });
    await db.recordAnswer({
      progress: {
        profileId: profile.id,
        factId: 'add:2+3',
        box: 1,
        state: 'review',
        dueAt: 100,
        lastSeenAt: 50,
        reps: 1,
        fastCorrect: 1,
        correctStreak: 1,
        accuracyEwma: 1,
        medianMsEwma: 1500,
      },
      stat: { profileId: profile.id, operation: 'add', medianMsEwma: 1500, correctSamples: 1 },
      attempt: {
        id: 'a1',
        sessionId: 's1',
        profileId: profile.id,
        factId: 'add:2+3',
        given: 0,
        correct: true,
        fast: true,
        responseMs: 1500,
        answeredAt: 60,
      },
      workingState: { sessionId: 's1', json: '{"learning":{}}' },
    });
    expect((await db.getProgressForFact(profile.id, 'add:2+3'))?.box).toBe(1);
    expect((await db.getOperationStat(profile.id, 'add'))?.correctSamples).toBe(1);
    expect(await db.listSessionAttempts('s1')).toHaveLength(1);
    expect((await db.getSession('s1'))?.workingState).toBe('{"learning":{}}');
    // (Rollback-on-failure is asserted on the SQLite adapter — pg-mem's pooled
    // client doesn't honor ROLLBACK; real Postgres does.)
  });

  it('completeSessionAndAward transitions once and credits once', async () => {
    const { profile } = await accountAndProfile();
    await db.createSession({
      id: 's1',
      profileId: profile.id,
      startedAt: 1,
      completedAt: null,
      plannedCount: 3,
      workingState: '{}',
    });
    expect(await db.completeSessionAndAward('s1', 9, profile.id, 7)).toBe(true);
    // A repeat/concurrent complete loses the conditional transition.
    expect(await db.completeSessionAndAward('s1', 11, profile.id, 7)).toBe(false);
    expect((await db.getSession('s1'))?.completedAt).toBe(9);
    expect((await db.getProfileReward(profile.id)).coins).toBe(7);
  });

  it('getOpenSession tracks the latest incomplete session', async () => {
    const { profile } = await accountAndProfile();
    const row = (id: string, startedAt: number) => ({
      id,
      profileId: profile.id,
      startedAt,
      completedAt: null,
      plannedCount: 3,
      workingState: '{}',
    });
    await db.createSession(row('s1', 1));
    expect((await db.getOpenSession(profile.id))?.id).toBe('s1');
    // At most one open session per profile (partial unique index).
    await expect(db.createSession(row('s2', 5))).rejects.toThrow();
    await db.completeSession('s1', 9);
    expect(await db.getOpenSession(profile.id)).toBeNull();
    await db.createSession(row('s2', 5));
    expect((await db.getOpenSession(profile.id))?.id).toBe('s2');
  });
});
