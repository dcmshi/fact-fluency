import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FactProgress } from '@shared';
import { getDashboardView } from './dashboard';
import { SEED_CATALOG } from './data/catalog';
import { SqliteDb } from './db/sqlite';
import { generateFactsForSets } from './engine/facts';

// Fixed clock so day-bucketing is deterministic (engine time is passed in).
const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);

let db: SqliteDb;
beforeEach(() => {
  db = new SqliteDb(':memory:');
});
afterEach(async () => {
  await db.close();
});

async function setup(setIds: string[] = ['add-0-5']) {
  const accountId = await db.createAccount('a@b.co', 'h', 'UTC');
  const profile = await db.createProfile({
    accountId,
    displayName: 'Kid',
    avatar: '🦊',
    settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
  });
  await db.setEnabledSetIds(profile.id, setIds);
  return { accountId, profile };
}

const factsOf = (setId: string) => generateFactsForSets(SEED_CATALOG.filter((s) => s.id === setId));

function masteredRow(profileId: string, factId: string): FactProgress {
  return {
    profileId,
    factId,
    box: 5,
    state: 'mastered',
    dueAt: 0,
    lastSeenAt: 0,
    reps: 6,
    fastCorrect: 5,
    correctStreak: 5,
    accuracyEwma: 1,
    medianMsEwma: 1000,
  };
}

describe('getDashboardView', () => {
  it('404s for another account', async () => {
    const { profile } = await setup();
    await expect(getDashboardView(db, 'nope', profile.id, NOW)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('summarizes mastery over the enabled facts and a 14-day window', async () => {
    const { accountId, profile } = await setup(['add-0-5']);
    const view = await getDashboardView(db, accountId, profile.id, NOW);
    expect(view.displayName).toBe('Kid');
    expect(view.windowDays).toBe(14);
    expect(view.trends).toHaveLength(14);
    expect(view.summary.totalFacts).toBe(factsOf('add-0-5').length);
    expect(view.summary).toMatchObject({ mastered: 0, attempts: 0, daysActive: 0 });
  });

  it('counts a mastered fact in the summary', async () => {
    const { accountId, profile } = await setup(['add-0-5']);
    await db.upsertProgress(masteredRow(profile.id, factsOf('add-0-5')[0].id));
    const view = await getDashboardView(db, accountId, profile.id, NOW);
    expect(view.summary.mastered).toBe(1);
  });

  it('reflects today’s attempts in the trends + accuracy', async () => {
    const { accountId, profile } = await setup(['add-0-5']);
    const fact = factsOf('add-0-5')[0];
    await db.createSession({
      id: 's1',
      profileId: profile.id,
      startedAt: NOW,
      completedAt: NOW,
      plannedCount: 2,
      workingState: '{}',
    });
    const attempt = (correct: boolean, fast: boolean) => ({
      id: randomUUID(),
      sessionId: 's1',
      profileId: profile.id,
      factId: fact.id,
      given: 0,
      correct,
      fast,
      responseMs: 1500,
      answeredAt: NOW,
    });
    await db.appendAttempt(attempt(true, true));
    await db.appendAttempt(attempt(false, false));

    const view = await getDashboardView(db, accountId, profile.id, NOW);
    expect(view.summary.attempts).toBe(2);
    expect(view.summary.accuracy).toBeCloseTo(0.5);
    expect(view.summary.daysActive).toBe(1);
    expect(view.trends[view.trends.length - 1].attempts).toBe(2);
  });
});
