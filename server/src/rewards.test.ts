import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteDb } from './db/sqlite';
import { equipReward, getRewards, unlockReward } from './rewards';

const NOW = Date.UTC(2026, 6, 10, 12); // July — no seasonal window games

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
    const view = await getRewards(db, profile, NOW);
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
    await expect(unlockReward(db, profile, 'muncher-fox', NOW)).rejects.toMatchObject({
      status: 400,
      code: 'insufficient_coins',
    });
    expect((await db.getProfileReward(profile.id)).coins).toBe(10);
    // The atomic claim was rolled back — the item isn't owned.
    expect(await db.listUnlocks(profile.id)).not.toContain('muncher-fox');
  });

  it('rejects a free item and an unknown item', async () => {
    const { profile } = await setup();
    await expect(unlockReward(db, profile, 'muncher-cat', NOW)).rejects.toMatchObject({
      code: 'item_free',
    });
    await expect(unlockReward(db, profile, 'nope', NOW)).rejects.toMatchObject({
      code: 'unknown_item',
    });
  });

  it('deducts coins, records ownership, and rejects a repeat unlock', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 100);
    const r = await unlockReward(db, profile, 'muncher-fox', NOW); // cost 40
    expect(r.coins).toBe(60);
    expect(r.owned).toContain('muncher-fox');
    expect((await db.getProfileReward(profile.id)).coins).toBe(60);

    await expect(unlockReward(db, profile, 'muncher-fox', NOW)).rejects.toMatchObject({
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
      unlockReward(db, profile, 'muncher-fox', NOW),
      unlockReward(db, profile, 'muncher-fox', NOW),
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
    const unlock = unlockReward(db, profile, 'muncher-fox', NOW); // cost 40
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
    await unlockReward(db, profile, 'avatar-dragon', NOW); // cost 60
    const r = await equipReward(db, profile, 'avatar-dragon');
    expect(r.equippedAvatar).toBe('🐉');
    expect((await db.getProfile(profile.id))?.avatar).toBe('🐉');
  });
});

describe('perks & seasonal availability', () => {
  it('sells the streak shield but refuses to equip it', async () => {
    const { profile } = await setup();
    await db.addCoins(profile.id, 60);
    const fresh = async () => (await db.getProfile(profile.id))!;
    const r = await unlockReward(db, await fresh(), 'perk-streak-shield', NOW);
    expect(r.owned).toContain('perk-streak-shield');
    await expect(equipReward(db, await fresh(), 'perk-streak-shield')).rejects.toMatchObject({
      code: 'not_equippable',
    });
  });

  it('filters seasonal items by month and blocks out-of-season purchase', async () => {
    const { profile } = await setup();
    const july = Date.UTC(2026, 6, 10);
    const january = Date.UTC(2026, 0, 10);

    const summer = await getRewards(db, profile, july);
    const summerIds = summer.catalog.map((i) => i.id);
    expect(summerIds).toContain('avatar-beach');
    expect(summerIds).not.toContain('avatar-snowman');

    const winter = await getRewards(db, profile, january);
    const winterIds = winter.catalog.map((i) => i.id);
    expect(winterIds).toContain('avatar-snowman');
    expect(winterIds).not.toContain('avatar-beach');

    await db.addCoins(profile.id, 200);
    const fresh = (await db.getProfile(profile.id))!;
    await expect(unlockReward(db, fresh, 'avatar-snowman', july)).rejects.toMatchObject({
      code: 'item_unavailable',
    });
    // In season it sells normally.
    const ok = await unlockReward(db, fresh, 'avatar-beach', july);
    expect(ok.owned).toContain('avatar-beach');
  });
});
