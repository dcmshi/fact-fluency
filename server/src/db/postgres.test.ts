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
    await db.setCoins(profile.id, 25);
    await db.setProfileTheme(profile.id, 'candy');
    const reward = await db.getProfileReward(profile.id);
    expect(reward).toEqual({ coins: 25, theme: 'candy' });
    expect((await db.getProfile(profile.id))?.theme).toBe('candy');

    await db.addUnlock(profile.id, 'theme-candy');
    await db.addUnlock(profile.id, 'theme-candy');
    expect(await db.listUnlocks(profile.id)).toEqual(['theme-candy']);
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
