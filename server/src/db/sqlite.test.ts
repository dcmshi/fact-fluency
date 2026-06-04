import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactProgress } from '@shared';
import { SqliteDb } from './sqlite';

let db: SqliteDb;

beforeEach(() => {
  db = new SqliteDb(':memory:');
});
afterEach(async () => {
  await db.close();
});

async function makeAccountAndProfile() {
  const accountId = await db.createAccount('a@b.co', 'hash', 'UTC');
  const profile = await db.createProfile({
    accountId,
    displayName: 'Kid',
    avatar: '🦊',
    settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
  });
  return { accountId, profile };
}

describe('accounts & auth', () => {
  it('creates and finds an account by email', async () => {
    const id = await db.createAccount('parent@home.test', 'argon-hash', 'America/Toronto');
    const found = await db.findAccountByEmail('parent@home.test');
    expect(found).toEqual({ id, passwordHash: 'argon-hash' });
    expect(await db.findAccountByEmail('missing@home.test')).toBeNull();
  });

  it('enforces unique emails', async () => {
    await db.createAccount('dupe@home.test', 'h', 'UTC');
    await expect(db.createAccount('dupe@home.test', 'h2', 'UTC')).rejects.toThrow();
  });

  it('resolves a valid auth token and rejects an expired one', async () => {
    const accountId = await db.createAccount('p@home.test', 'h', 'UTC');
    await db.createAuthSession(accountId, 'live-token', Date.now() + 60_000);
    await db.createAuthSession(accountId, 'dead-token', Date.now() - 1);
    expect(await db.findAccountIdByToken('live-token')).toBe(accountId);
    expect(await db.findAccountIdByToken('dead-token')).toBeNull();
  });

  it('deletes an auth session on logout', async () => {
    const accountId = await db.createAccount('p2@home.test', 'h', 'UTC');
    await db.createAuthSession(accountId, 'tok', Date.now() + 60_000);
    await db.deleteAuthSession('tok');
    expect(await db.findAccountIdByToken('tok')).toBeNull();
  });
});

describe('profiles', () => {
  it('round-trips a profile with parsed settings, scoped to its account', async () => {
    const { accountId, profile } = await makeAccountAndProfile();
    const list = await db.listProfiles(accountId);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(profile);
    expect(list[0].settings.sessionCards).toBe(20);
    expect(await db.listProfiles('other-account')).toEqual([]);
  });

  it('updates settings and returns the refreshed profile', async () => {
    const { profile } = await makeAccountAndProfile();
    const updated = await db.updateProfileSettings(profile.id, {
      sessionCards: 15,
      sessionSeconds: 120,
      newPerSession: 2,
    });
    expect(updated.settings).toEqual({ sessionCards: 15, sessionSeconds: 120, newPerSession: 2 });
    expect((await db.getProfile(profile.id))?.settings.sessionCards).toBe(15);
  });
});

describe('enabled fact sets', () => {
  it('replaces the enabled set on each call', async () => {
    const { profile } = await makeAccountAndProfile();
    await db.setEnabledSetIds(profile.id, ['add-0-10', 'mul-0-5']);
    expect((await db.listEnabledSetIds(profile.id)).sort()).toEqual(['add-0-10', 'mul-0-5']);

    await db.setEnabledSetIds(profile.id, ['mul-0-12']);
    expect(await db.listEnabledSetIds(profile.id)).toEqual(['mul-0-12']);
  });
});

describe('fact progress', () => {
  const progress = (overrides: Partial<FactProgress>): FactProgress => ({
    profileId: 'p',
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
    ...overrides,
  });

  it('inserts then updates on conflict (upsert)', async () => {
    const { profile } = await makeAccountAndProfile();
    await db.upsertProgress(progress({ profileId: profile.id }));
    await db.upsertProgress(progress({ profileId: profile.id, box: 2, dueAt: 2000, reps: 2 }));

    const rows = await db.getProgress(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].box).toBe(2);
    expect(rows[0].dueAt).toBe(2000);
    expect(rows[0].reps).toBe(2);
  });
});

describe('sessions', () => {
  const make = (id: string, profileId: string, startedAt: number) => ({
    id,
    profileId,
    startedAt,
    completedAt: null,
    plannedCount: 3,
    workingState: '{}',
  });

  it('getOpenSession returns the most recent incomplete session, null once closed', async () => {
    const { profile } = await makeAccountAndProfile();
    await db.createSession(make('s1', profile.id, 1));
    await db.createSession(make('s2', profile.id, 5));
    expect((await db.getOpenSession(profile.id))?.id).toBe('s2'); // latest open

    await db.completeSession('s2', 9);
    expect((await db.getOpenSession(profile.id))?.id).toBe('s1'); // falls back to the older open one

    await db.completeSession('s1', 9);
    expect(await db.getOpenSession(profile.id)).toBeNull();
  });

  it('listProfileAttempts filters by since and orders oldest-first', async () => {
    const { profile } = await makeAccountAndProfile();
    await db.createSession(make('s1', profile.id, 0));
    const attempt = (id: string, answeredAt: number) => ({
      id,
      sessionId: 's1',
      profileId: profile.id,
      factId: 'add:2+3',
      given: 5,
      correct: true,
      fast: true,
      responseMs: 1200,
      answeredAt,
    });
    await db.appendAttempt(attempt('a3', 300));
    await db.appendAttempt(attempt('a1', 100));
    await db.appendAttempt(attempt('a2', 200));

    const since200 = await db.listProfileAttempts(profile.id, 200);
    expect(since200.map((a) => a.id)).toEqual(['a2', 'a3']); // >= 200, oldest first
    expect(await db.listProfileAttempts('nobody', 0)).toEqual([]);
  });
});

describe('operation stats', () => {
  it('upserts per (profile, operation)', async () => {
    const { profile } = await makeAccountAndProfile();
    await db.upsertOperationStat({
      profileId: profile.id,
      operation: 'mul',
      medianMsEwma: 3000,
      correctSamples: 5,
    });
    await db.upsertOperationStat({
      profileId: profile.id,
      operation: 'mul',
      medianMsEwma: 2800,
      correctSamples: 6,
    });
    const stats = await db.getOperationStats(profile.id);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ operation: 'mul', medianMsEwma: 2800, correctSamples: 6 });
  });
});
