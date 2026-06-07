import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from './db/sqlite';
import { equipReward, getRewards, unlockReward } from './rewards';

let db: SqliteDb;
beforeEach(() => {
  db = new SqliteDb(':memory:');
});
afterEach(async () => {
  await db.close();
});

async function setup() {
  const accountId = await db.createAccount('a@b.co', 'h', 'UTC');
  const profile = await db.createProfile({
    accountId,
    displayName: 'Kid',
    avatar: '🦊',
    settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
  });
  return { accountId, profile };
}

describe('getRewards', () => {
  it('exposes the catalog, free items, and equipped defaults', async () => {
    const { accountId, profile } = await setup();
    const view = await getRewards(db, accountId, profile.id);
    expect(view.coins).toBe(0);
    expect(view.catalog.length).toBeGreaterThan(0);
    // Every cost-0 item is owned without an unlock row.
    expect(view.owned).toContain('muncher-cat');
    expect(view.owned).toContain('effect-confetti');
    expect(view.owned).not.toContain('muncher-fox');
    expect(view.equippedMuncher).toBe('cat');
    expect(view.equippedEffect).toBe('confetti');
    expect(view.equippedTheme).toBe('classic');
  });

  it('404s for another account', async () => {
    const { profile } = await setup();
    await expect(getRewards(db, 'nope', profile.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('unlockReward', () => {
  it('rejects an unaffordable item without spending', async () => {
    const { accountId, profile } = await setup();
    await db.addCoins(profile.id, 10); // muncher-fox costs 40
    await expect(unlockReward(db, accountId, profile.id, 'muncher-fox')).rejects.toMatchObject({
      status: 400,
      code: 'insufficient_coins',
    });
    expect((await db.getProfileReward(profile.id)).coins).toBe(10);
  });

  it('rejects a free item and an unknown item', async () => {
    const { accountId, profile } = await setup();
    await expect(unlockReward(db, accountId, profile.id, 'muncher-cat')).rejects.toMatchObject({
      code: 'item_free',
    });
    await expect(unlockReward(db, accountId, profile.id, 'nope')).rejects.toMatchObject({
      code: 'unknown_item',
    });
  });

  it('deducts coins, records ownership, and rejects a repeat unlock', async () => {
    const { accountId, profile } = await setup();
    await db.addCoins(profile.id, 100);
    const r = await unlockReward(db, accountId, profile.id, 'muncher-fox'); // cost 40
    expect(r.coins).toBe(60);
    expect(r.owned).toContain('muncher-fox');
    expect((await db.getProfileReward(profile.id)).coins).toBe(60);

    await expect(unlockReward(db, accountId, profile.id, 'muncher-fox')).rejects.toMatchObject({
      status: 409,
      code: 'already_owned',
    });
  });
});

describe('equipReward', () => {
  it('equips an owned free item', async () => {
    const { accountId, profile } = await setup();
    const r = await equipReward(db, accountId, profile.id, 'muncher-dog'); // free
    expect(r.equippedMuncher).toBe('dog');
    expect(await db.getEquippedMuncher(profile.id)).toBe('dog');
  });

  it('refuses to equip an unowned premium item', async () => {
    const { accountId, profile } = await setup();
    await expect(equipReward(db, accountId, profile.id, 'muncher-fox')).rejects.toMatchObject({
      status: 403,
      code: 'not_owned',
    });
  });

  it('equips a premium item once unlocked, updating the right slot', async () => {
    const { accountId, profile } = await setup();
    await db.addCoins(profile.id, 100);
    await unlockReward(db, accountId, profile.id, 'avatar-dragon'); // cost 60
    const r = await equipReward(db, accountId, profile.id, 'avatar-dragon');
    expect(r.equippedAvatar).toBe('🐉');
    expect((await db.getProfile(profile.id))?.avatar).toBe('🐉');
  });
});
