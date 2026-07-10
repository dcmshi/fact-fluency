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
  // Ownership (a foreign profile 404s) is enforced by the loadOwnedProfile
  // route middleware and covered at the HTTP level in api.test.ts.

  it('summarizes mastery over the enabled facts and a 14-day window', async () => {
    const { profile } = await setup(['add-0-5']);
    const view = await getDashboardView(db, profile, NOW);
    expect(view.displayName).toBe('Kid');
    expect(view.windowDays).toBe(14);
    expect(view.trends).toHaveLength(14);
    expect(view.summary.totalFacts).toBe(factsOf('add-0-5').length);
    expect(view.summary).toMatchObject({ mastered: 0, attempts: 0, daysActive: 0 });
  });

  it('counts a mastered fact in the summary', async () => {
    const { profile } = await setup(['add-0-5']);
    await db.upsertProgress(masteredRow(profile.id, factsOf('add-0-5')[0].id));
    const view = await getDashboardView(db, profile, NOW);
    expect(view.summary.mastered).toBe(1);
  });

  it('reflects today’s attempts in the trends + accuracy', async () => {
    const { profile } = await setup(['add-0-5']);
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

    const view = await getDashboardView(db, profile, NOW);
    expect(view.summary.attempts).toBe(2);
    expect(view.summary.accuracy).toBeCloseTo(0.5);
    expect(view.summary.daysActive).toBe(1);
    expect(view.trends[view.trends.length - 1].attempts).toBe(2);
  });
});

describe('trickiest facts + weekly recap', () => {
  it('ranks judgeable, unmastered facts worst-first and fills the recap', async () => {
    const { profile } = await setup(['add-0-5']);
    const facts = factsOf('add-0-5');
    const row = (factId: string, accuracy: number, ms: number, reps = 4) => ({
      profileId: profile.id,
      factId,
      box: 2 as const,
      state: 'review' as const,
      dueAt: NOW,
      lastSeenAt: NOW,
      reps,
      fastCorrect: 1,
      correctStreak: 0,
      accuracyEwma: accuracy,
      medianMsEwma: ms,
    });
    await db.upsertProgress(row(facts[0].id, 0.9, 2000)); // fine
    await db.upsertProgress(row(facts[1].id, 0.4, 3000)); // worst accuracy
    await db.upsertProgress(row(facts[2].id, 0.6, 5000)); // middling, slow
    await db.upsertProgress(row(facts[3].id, 0.6, 2000)); // middling, quicker
    await db.upsertProgress(row(facts[4].id, 0.2, 1000, 2)); // too few reps — excluded
    await db.upsertProgress(masteredRow(profile.id, facts[5].id)); // mastered — excluded

    const view = await getDashboardView(db, profile, NOW);
    const ids = view.trickiest.map((t) => `${t.operandA}+${t.operandB}`);
    expect(view.trickiest[0].accuracy).toBeCloseTo(0.4); // worst first
    expect(view.trickiest[1].medianMs).toBe(5000); // slow breaks the tie
    expect(ids).toHaveLength(4); // excluded: low-reps + mastered

    // Weekly recap: one session, two attempts today; no prior week → no delta.
    await db.createSession({
      id: 'w1',
      profileId: profile.id,
      startedAt: NOW,
      completedAt: NOW,
      plannedCount: 2,
      workingState: '{}',
    });
    const attempt = (id: string, correct: boolean) => ({
      id,
      sessionId: 'w1',
      profileId: profile.id,
      factId: facts[0].id,
      given: 0,
      correct,
      fast: false,
      responseMs: 1500,
      answeredAt: NOW,
    });
    await db.appendAttempt(attempt('wa1', true));
    await db.appendAttempt(attempt('wa2', false));

    const view2 = await getDashboardView(db, profile, NOW);
    expect(view2.weekly).toMatchObject({ sessions: 1, attempts: 2, accuracyDelta: null });
    expect(view2.weekly.accuracy).toBeCloseTo(0.5);
    expect(view2.weekly.mastered).toBe(0); // the mastered row's lastSeenAt is 0 (not this week)
  });
});
