/**
 * Reward economy (roadmap v1.1) — spend earned coins to unlock avatars/themes,
 * then equip them. Server-authoritative: the catalog, costs, and ownership all
 * live here so the client can't grant itself items. Kids aren't an adversarial
 * threat model (§4.7), but state stays server-owned for consistency.
 */
import type { RewardsView } from '@shared';
import type { Db } from './db';
import { FREE_ITEM_IDS, REWARD_CATALOG, rewardById } from './data/rewards';
import { requireOwnedProfile, SessionError } from './session/service';

/** All item ids a profile owns: every free item plus its unlocked ones. */
async function ownedIds(db: Db, profileId: string): Promise<string[]> {
  return [...new Set([...FREE_ITEM_IDS, ...(await db.listUnlocks(profileId))])];
}

export async function getRewards(db: Db, accountId: string, profileId: string): Promise<RewardsView> {
  const profile = await requireOwnedProfile(db, accountId, profileId);
  return {
    coins: profile.coins,
    catalog: REWARD_CATALOG,
    owned: await ownedIds(db, profileId),
    equippedAvatar: profile.avatar,
    equippedTheme: profile.theme,
    equippedMuncher: await db.getEquippedMuncher(profileId),
    equippedEffect: await db.getEquippedEffect(profileId),
  };
}

export async function unlockReward(
  db: Db,
  accountId: string,
  profileId: string,
  itemId: string,
): Promise<{ coins: number; owned: string[] }> {
  const profile = await requireOwnedProfile(db, accountId, profileId);
  const item = rewardById(itemId);
  if (!item) throw new SessionError(400, 'unknown_item');
  if (item.cost === 0) throw new SessionError(400, 'item_free'); // already owned
  const unlocks = await db.listUnlocks(profileId);
  if (unlocks.includes(itemId)) throw new SessionError(409, 'already_owned');
  if (profile.coins < item.cost) throw new SessionError(400, 'insufficient_coins');

  const coins = profile.coins - item.cost;
  await db.setCoins(profileId, coins);
  await db.addUnlock(profileId, itemId);
  return { coins, owned: [...new Set([...FREE_ITEM_IDS, ...unlocks, itemId])] };
}

export async function equipReward(
  db: Db,
  accountId: string,
  profileId: string,
  itemId: string,
): Promise<{
  equippedAvatar: string;
  equippedTheme: string;
  equippedMuncher: string;
  equippedEffect: string;
}> {
  const profile = await requireOwnedProfile(db, accountId, profileId);
  const item = rewardById(itemId);
  if (!item) throw new SessionError(400, 'unknown_item');
  const owned = item.cost === 0 || (await db.listUnlocks(profileId)).includes(itemId);
  if (!owned) throw new SessionError(403, 'not_owned');

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
