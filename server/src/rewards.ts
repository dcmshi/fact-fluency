/**
 * Reward economy (roadmap v1.1) — spend earned coins to unlock avatars/themes,
 * then equip them. Server-authoritative: the catalog, costs, and ownership all
 * live here so the client can't grant itself items. Kids aren't an adversarial
 * threat model (§4.7), but state stays server-owned for consistency.
 */
import type { Profile, RewardsView } from '@shared';
import type { Db } from './db';
import { activeRewardCatalog, FREE_ITEM_IDS, rewardAvailable, rewardById } from './data/rewards';
import { HttpError } from './httpError';

/** All item ids a profile owns: every free item plus its unlocked ones. */
async function ownedIds(db: Db, profileId: string): Promise<string[]> {
  return [...new Set([...FREE_ITEM_IDS, ...(await db.listUnlocks(profileId))])];
}

export async function getRewards(db: Db, profile: Profile, now: number): Promise<RewardsView> {
  const profileId = profile.id; // ownership checked by the route middleware
  return {
    coins: profile.coins,
    // Seasonal items appear only in their window (a pure function of the
    // date); anything already owned stays owned/equipped out of season.
    catalog: activeRewardCatalog(now),
    owned: await ownedIds(db, profileId),
    equippedAvatar: profile.avatar,
    equippedTheme: profile.theme,
    equippedMuncher: await db.getEquippedMuncher(profileId),
    equippedEffect: await db.getEquippedEffect(profileId),
  };
}

export async function unlockReward(
  db: Db,
  profile: Profile,
  itemId: string,
  now: number,
): Promise<{ coins: number; owned: string[] }> {
  const profileId = profile.id; // ownership checked by the route middleware
  const item = rewardById(itemId);
  if (!item) throw new HttpError(400, 'unknown_item');
  if (item.cost === 0) throw new HttpError(400, 'item_free'); // already owned
  if (!rewardAvailable(item, now)) throw new HttpError(400, 'item_unavailable'); // out of season

  // Claim + debit atomically (no read-modify-write on coins): a session coin
  // award racing this spend can't be lost, and two concurrent unlocks of the
  // same item can't both succeed.
  const result = await db.spendAndUnlock(profileId, itemId, item.cost);
  if (result.status === 'already_owned') throw new HttpError(409, 'already_owned');
  if (result.status === 'insufficient') throw new HttpError(400, 'insufficient_coins');
  return { coins: result.coins, owned: await ownedIds(db, profileId) };
}

export async function equipReward(
  db: Db,
  profile: Profile,
  itemId: string,
): Promise<{
  equippedAvatar: string;
  equippedTheme: string;
  equippedMuncher: string;
  equippedEffect: string;
}> {
  const profileId = profile.id; // ownership checked by the route middleware
  const item = rewardById(itemId);
  if (!item) throw new HttpError(400, 'unknown_item');
  // Perks aren't a look — they act on their own (the streak shield spends
  // itself); there's nothing to equip.
  if (item.kind === 'perk') throw new HttpError(400, 'not_equippable');
  const owned = item.cost === 0 || (await db.listUnlocks(profileId)).includes(itemId);
  if (!owned) throw new HttpError(403, 'not_owned');

  if (item.kind === 'avatar') await db.updateProfileAvatar(profileId, item.value);
  else if (item.kind === 'theme') await db.setProfileTheme(profileId, item.value);
  else if (item.kind === 'muncher') await db.setEquippedMuncher(profileId, item.value);
  else await db.setEquippedEffect(profileId, item.value);

  return {
    equippedAvatar: item.kind === 'avatar' ? item.value : profile.avatar,
    equippedTheme: item.kind === 'theme' ? item.value : profile.theme,
    equippedMuncher: item.kind === 'muncher' ? item.value : await db.getEquippedMuncher(profileId),
    equippedEffect: item.kind === 'effect' ? item.value : await db.getEquippedEffect(profileId),
  };
}
