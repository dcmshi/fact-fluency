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
    const { profile } = await setup();
    const view = await getRewards(db, profile);
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

  // Ownership (a foreign profile 404s) is enforced by the loadOwnedProfile
  // route middleware and covered at the HTTP level in api.test.ts.
});

describe('unlockReward', () => {
  it('rejects an unaffordable item without spending', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 10); // muncher-fox costs 40
    await expect(unlockReward(db, profile, 'muncher-fox')).rejects.toMatchObject({
      status: 400,
      code: 'insufficient_coins',
    });
    expect((await db.getProfileReward(profile.id)).coins).toBe(10);
    // The atomic claim was rolled back — the item isn't owned.
    expect(await db.listUnlocks(profile.id)).not.toContain('muncher-fox');
  });

  it('rejects a free item and an unknown item', async () => {
    const { profile } = await setup();
    await expect(unlockReward(db, profile, 'muncher-cat')).rejects.toMatchObject({
      code: 'item_free',
    });
    await expect(unlockReward(db, profile, 'nope')).rejects.toMatchObject({
      code: 'unknown_item',
    });
  });

  it('deducts coins, records ownership, and rejects a repeat unlock', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 100);
    const r = await unlockReward(db, profile, 'muncher-fox'); // cost 40
    expect(r.coins).toBe(60);
    expect(r.owned).toContain('muncher-fox');
    expect((await db.getProfileReward(profile.id)).coins).toBe(60);

    await expect(unlockReward(db, profile, 'muncher-fox')).rejects.toMatchObject({
      status: 409,
      code: 'already_owned',
    });
  });

  it('does not double-spend when the same item is unlocked concurrently', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 100);
    // Two near-simultaneous unlocks of muncher-fox (cost 40): exactly one wins;
    // the loser is rejected, and only one debit lands.
    const results = await Promise.allSettled([
      unlockReward(db, profile, 'muncher-fox'),
      unlockReward(db, profile, 'muncher-fox'),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    expect((await db.getProfileReward(profile.id)).coins).toBe(60); // debited once, not twice
  });

  it('does not clobber a coin award that lands mid-spend (relative debit)', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 100);
    // A session award is credited between an unlock's start and finish; because
    // the debit is relative (coins = coins - cost), the award survives.
    const unlock = unlockReward(db, profile, 'muncher-fox'); // cost 40
    await db.addCoins(profile.id, 25);
    await unlock;
    expect((await db.getProfileReward(profile.id)).coins).toBe(85); // 100 - 40 + 25
  });
});

describe('equipReward', () => {
  it('equips an owned free item', async () => {
    const { profile } = await setup();
    const r = await equipReward(db, profile, 'muncher-dog'); // free
    expect(r.equippedMuncher).toBe('dog');
    expect(await db.getEquippedMuncher(profile.id)).toBe('dog');
  });

  it('refuses to equip an unowned premium item', async () => {
    const { profile } = await setup();
    await expect(equipReward(db, profile, 'muncher-fox')).rejects.toMatchObject({
      status: 403,
      code: 'not_owned',
    });
  });

  it('equips a premium item once unlocked, updating the right slot', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 100);
    await unlockReward(db, profile, 'avatar-dragon'); // cost 60
    const r = await equipReward(db, profile, 'avatar-dragon');
    expect(r.equippedAvatar).toBe('🐉');
    expect((await db.getProfile(profile.id))?.avatar).toBe('🐉');
  });
});
