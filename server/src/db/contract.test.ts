/**
 * Shared Db contract suite — the same behavioral spec run against BOTH
 * adapters, so SQLite and Postgres can't drift apart (previously the pg-mem
 * suite never exercised guest upgrade, the conditional session award,
 * cascades, equipped-reward reads, the slide throttle, or the guest prune).
 * Adapter-specific quirks (SQLite self-heal, pg-mem's ROLLBACK limitation)
 * stay in the per-adapter test files.
 */
import { newDb } from 'pg-mem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index';
import { PostgresDb, type PgPool } from './postgres';
import { SqliteDb } from './sqlite';

function describeDbContract(name: string, makeDb: () => Promise<Db>) {
  describe(`Db contract: ${name}`, () => {
    let db: Db;
    beforeEach(async () => {
      db = await makeDb();
    });
    afterEach(async () => {
      await db.close();
    });

    async function seedProfile() {
      const accountId = await db.createAccount('a@b.co', 'hash', 'UTC');
      const profile = await db.createProfile({
        accountId,
        displayName: 'Kid',
        avatar: '🦊',
        settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
      });
      return { accountId, profile };
    }

    it('round-trips an account and enforces unique emails', async () => {
      const id = await db.createAccount('p@x.co', 'h', 'America/Toronto');
      expect(await db.findAccountByEmail('p@x.co')).toEqual({ id, passwordHash: 'h' });
      expect(await db.getAccountTimezone(id)).toBe('America/Toronto');
      await expect(db.createAccount('p@x.co', 'h2', 'UTC')).rejects.toThrow();
    });

    it('upgrades a guest exactly once, flipping the flag', async () => {
      const id = await db.createGuestAccount('UTC');
      expect(await db.isGuestAccount(id)).toBe(true);
      expect(await db.upgradeGuestAccount(id, 'real@x.co', 'h')).toBe(true);
      expect(await db.isGuestAccount(id)).toBe(false);
      expect(await db.upgradeGuestAccount(id, 'other@x.co', 'h2')).toBe(false);
      expect(await db.findAccountByEmail('real@x.co')).toEqual({ id, passwordHash: 'h' });
    });

    it('prunes only stranded guests', async () => {
      const stranded = await db.createGuestAccount('UTC');
      const active = await db.createGuestAccount('UTC');
      await db.createAuthSession(active, 'live', Date.now() + 60_000);
      await db.createAccount('real@x.co', 'h', 'UTC'); // never pruned

      expect(await db.deleteExpiredGuests(Date.now())).toBe(1);
      expect(await db.findAccountByEmail(`guest-${stranded}`)).toBeNull();
      expect(await db.findAccountByEmail(`guest-${active}`)).not.toBeNull();
      expect(await db.findAccountByEmail('real@x.co')).not.toBeNull();
    });

    it('slides a session expiry only when below the throttle threshold', async () => {
      const id = await db.createAccount('s@x.co', 'h', 'UTC');
      const now = 1_000_000_000_000;
      const TTL = 30 * 24 * 60 * 60 * 1000;
      const DAY = 24 * 60 * 60 * 1000;
      await db.createAuthSession(id, 'old', now - 2 * DAY + TTL);
      expect(await db.slideAuthSession('old', now, now + TTL, now + TTL - DAY)).toBe(true);
      await db.createAuthSession(id, 'fresh', now + TTL - 1000);
      expect(await db.slideAuthSession('fresh', now, now + TTL, now + TTL - DAY)).toBe(false);
      await db.createAuthSession(id, 'dead', now - 1);
      expect(await db.slideAuthSession('dead', now, now + TTL, now + TTL - DAY)).toBe(false);
    });

    it('serves equipped muncher/effect defaults and updates', async () => {
      const { profile } = await seedProfile();
      expect(await db.getEquippedMuncher(profile.id)).toBe('cat');
      expect(await db.getEquippedEffect(profile.id)).toBe('confetti');
      await db.setEquippedMuncher(profile.id, 'dragon');
      await db.setEquippedEffect(profile.id, 'fireworks');
      expect(await db.getEquippedMuncher(profile.id)).toBe('dragon');
      expect(await db.getEquippedEffect(profile.id)).toBe('fireworks');
    });

    it('completeSessionAndAward wins once and credits once', async () => {
      const { profile } = await seedProfile();
      await db.createSession({
        id: 's1',
        profileId: profile.id,
        startedAt: 1,
        completedAt: null,
        plannedCount: 3,
        workingState: '{}',
      });
      expect(await db.completeSessionAndAward('s1', 9, profile.id, 7)).toBe(true);
      expect(await db.completeSessionAndAward('s1', 11, profile.id, 7)).toBe(false);
      expect((await db.getSession('s1'))?.completedAt).toBe(9);
      expect((await db.getProfileReward(profile.id)).coins).toBe(7);
    });

    it('scopes the caught-up counts to a fact-id filter', async () => {
      const { profile } = await seedProfile();
      const row = (factId: string, box: 0 | 2, dueAt: number) => ({
        profileId: profile.id,
        factId,
        box: box as 0 | 2,
        state: (box === 0 ? 'learning' : 'review') as 'learning' | 'review',
        dueAt,
        lastSeenAt: 0,
        reps: 1,
        fastCorrect: 0,
        correctStreak: 0,
        accuracyEwma: 1,
        medianMsEwma: 1000,
      });
      await db.upsertProgress(row('add:1+1', 2, 10));
      await db.upsertProgress(row('mul:6x7', 2, 10)); // outside the filter
      await db.upsertProgress(row('add:2+2', 0, 0));

      expect(await db.countDueReview(profile.id, 100)).toBe(2);
      expect(await db.countDueReview(profile.id, 100, ['add:1+1', 'add:2+2'])).toBe(1);
      expect(await db.countLearning(profile.id, ['add:2+2'])).toBe(1);
      expect(await db.countDueReview(profile.id, 100, [])).toBe(0);
      expect(await db.countLearning(profile.id, [])).toBe(0);
    });

    it('removes an unlock exactly once (perk consumption)', async () => {
      const { profile } = await seedProfile();
      await db.addCoins(profile.id, 60);
      await db.spendAndUnlock(profile.id, 'perk-streak-shield', 60);
      expect(await db.removeUnlock(profile.id, 'perk-streak-shield')).toBe(true);
      expect(await db.removeUnlock(profile.id, 'perk-streak-shield')).toBe(false);
      expect(await db.listUnlocks(profile.id)).toEqual([]);
    });

    it('cascades a profile delete to its data', async () => {
      const { accountId, profile } = await seedProfile();
      await db.setEnabledSetIds(profile.id, ['add-0-10']);
      await db.createSession({
        id: 's1',
        profileId: profile.id,
        startedAt: 1,
        completedAt: null,
        plannedCount: 1,
        workingState: '{}',
      });
      await db.appendAttempt({
        id: 'a1',
        sessionId: 's1',
        profileId: profile.id,
        factId: 'add:1+1',
        given: 0,
        correct: true,
        fast: false,
        responseMs: 900,
        answeredAt: 2,
      });
      await db.addCoins(profile.id, 5);

      await db.deleteProfile(profile.id);
      expect(await db.getProfile(profile.id)).toBeNull();
      expect(await db.listProfiles(accountId)).toEqual([]);
      expect(await db.getSession('s1')).toBeNull();
      expect(await db.listSessionAttempts('s1')).toEqual([]);
      expect(await db.listEnabledSetIds(profile.id)).toEqual([]);
      expect((await db.getProfileReward(profile.id)).coins).toBe(0);
    });

    it('cascades an account delete to profiles and auth sessions', async () => {
      const { accountId, profile } = await seedProfile();
      await db.createAuthSession(accountId, 'tok', Date.now() + 60_000);

      await db.deleteAccount(accountId);
      expect(await db.getProfile(profile.id)).toBeNull();
      expect(await db.findAccountIdByToken('tok')).toBeNull();
      expect(await db.findAccountByEmail('a@b.co')).toBeNull();
    });

    it('round-trips a race and its runs (fastest-first), and cascades on delete', async () => {
      const { accountId, profile } = await seedProfile();
      await db.createRace({
        id: 'r1',
        accountId,
        createdByProfileId: profile.id,
        deck: '[{"fact":"x"}]',
        factCount: 6,
        createdAt: 1000,
      });
      expect((await db.getRace('r1'))?.factCount).toBe(6);
      expect((await db.listRacesForAccount(accountId, 10)).map((r) => r.id)).toEqual(['r1']);

      await db.addRaceRun({
        id: 'run-slow',
        raceId: 'r1',
        profileId: profile.id,
        totalMs: 45000,
        correctCount: 6,
        perRound: '[8000,7000]',
        finishedAt: 2000,
      });
      await db.addRaceRun({
        id: 'run-fast',
        raceId: 'r1',
        profileId: profile.id,
        totalMs: 30000,
        correctCount: 6,
        perRound: '[5000,5000]',
        finishedAt: 3000,
      });
      const runs = await db.listRaceRuns('r1');
      expect(runs.map((r) => r.id)).toEqual(['run-fast', 'run-slow']); // fastest first
      expect(runs[0].perRound).toBe('[5000,5000]');

      await db.deleteAccount(accountId); // cascades to race + race_run
      expect(await db.getRace('r1')).toBeNull();
      expect(await db.listRaceRuns('r1')).toEqual([]);
    });
  });
}

describeDbContract('sqlite', async () => new SqliteDb(':memory:'));

describeDbContract('postgres (pg-mem)', async () => {
  const mem = newDb();
  const pg = mem.adapters.createPg();
  const db = new PostgresDb(new pg.Pool() as PgPool);
  await db.migrate();
  return db;
});
