import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactProgress } from '@shared';
import { SEED_CATALOG } from './data/catalog';
import { SqliteDb } from './db/sqlite';
import { generateFactsForSets } from './engine/facts';
import { getProgressView } from './progress';

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

describe('getProgressView', () => {
  it('404s a profile that belongs to another account', async () => {
    const { profile } = await setup();
    await expect(getProgressView(db, 'someone-else', profile.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('returns one grid per enabled operation, all cells unseen initially', async () => {
    const { accountId, profile } = await setup(['add-0-5']);
    const view = await getProgressView(db, accountId, profile.id);
    expect(view.grids).toHaveLength(1);
    expect(view.grids[0].operation).toBe('add');
    expect(view.grids[0].cells.length).toBe(factsOf('add-0-5').length);
    expect(view.grids[0].cells.every((c) => c.state === 'unseen' && c.box === null)).toBe(true);
  });

  it('overlays seeded progress onto the matching cell', async () => {
    const { accountId, profile } = await setup(['add-0-5']);
    const fact = factsOf('add-0-5')[0];
    await db.upsertProgress(masteredRow(profile.id, fact.id));

    const view = await getProgressView(db, accountId, profile.id);
    const cell = view.grids[0].cells.find(
      (c) => c.operandA === fact.operandA && c.operandB === fact.operandB,
    );
    expect(cell).toMatchObject({ state: 'mastered', box: 5 });
  });

  it('returns no grids when no sets are enabled', async () => {
    const { accountId, profile } = await setup([]);
    expect((await getProgressView(db, accountId, profile.id)).grids).toHaveLength(0);
  });
});
