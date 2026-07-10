/**
 * Reward catalog (roadmap v1.1) — unlockable avatars and palette themes a kid
 * buys with coins earned per session (DESIGN.md §10, "reward points spend").
 * Server-authoritative: costs and ownership are enforced here, not client-side.
 *
 * Cost 0 = a starter item every profile owns by default (no unlock row needed).
 * Theme `value`s must match a `body[data-theme="…"]` rule in the client CSS.
 */
import type { RewardItem } from '@shared';

/** Free starter avatars — must mirror the client's creation picker (ops.ts). */
const FREE_AVATARS = ['🦊', '🐼', '🐸', '🦉', '🐙', '🦄', '🐝', '🐳', '🦁', '🐢', '🦖', '🐧'];

const FREE_AVATAR_ITEMS: RewardItem[] = FREE_AVATARS.map((emoji, i) => ({
  id: `avatar-free-${i}`,
  kind: 'avatar',
  label: 'Starter buddy',
  cost: 0,
  value: emoji,
}));

// Seasonal avatars (months 1-12): a fresh goal every few weeks so a dedicated
// kid doesn't own everything forever. Availability is a pure function of the
// date (activeRewardCatalog); owned items stay owned out of season.
const SEASONAL_AVATARS: RewardItem[] = [
  {
    id: 'avatar-snowman',
    kind: 'avatar',
    label: 'Snowman',
    cost: 100,
    value: '⛄',
    months: [12, 1, 2],
  },
  {
    id: 'avatar-blossom',
    kind: 'avatar',
    label: 'Blossom',
    cost: 100,
    value: '🌸',
    months: [3, 4, 5],
  },
  {
    id: 'avatar-beach',
    kind: 'avatar',
    label: 'Beach day',
    cost: 100,
    value: '🏖️',
    months: [6, 7, 8],
  },
  {
    id: 'avatar-maple',
    kind: 'avatar',
    label: 'Maple leaf',
    cost: 100,
    value: '🍁',
    months: [9, 10, 11],
  },
];

// Perks — consumables with a game effect rather than a look. The streak
// shield is spent automatically when it saves a streak (DESIGN.md §4.8's
// anti-punitive principle applied to the one hard reset left), after which it
// can be bought again — the coin economy's first real sink.
const PERKS: RewardItem[] = [
  {
    id: 'perk-streak-shield',
    kind: 'perk',
    label: 'Streak shield',
    cost: 60,
    value: 'streak-shield',
  },
];

const PREMIUM_AVATARS: RewardItem[] = [
  { id: 'avatar-butterfly', kind: 'avatar', label: 'Butterfly', cost: 40, value: '🦋' },
  { id: 'avatar-dragon', kind: 'avatar', label: 'Dragon', cost: 60, value: '🐉' },
  { id: 'avatar-flamingo', kind: 'avatar', label: 'Flamingo', cost: 60, value: '🦩' },
  { id: 'avatar-wolf', kind: 'avatar', label: 'Wolf', cost: 80, value: '🐺' },
  { id: 'avatar-peacock', kind: 'avatar', label: 'Peacock', cost: 100, value: '🦚' },
  { id: 'avatar-robot', kind: 'avatar', label: 'Robot', cost: 120, value: '🤖' },
  { id: 'avatar-alien', kind: 'avatar', label: 'Alien', cost: 150, value: '👽' },
  { id: 'avatar-unicorn-star', kind: 'avatar', label: 'Star pony', cost: 200, value: '🌟' },
];

const THEMES: RewardItem[] = [
  {
    id: 'theme-classic',
    kind: 'theme',
    label: 'Classic',
    cost: 0,
    value: 'classic',
    swatches: ['#fff7ec', '#ffc83d', '#3b82f6'],
  },
  {
    id: 'theme-ocean',
    kind: 'theme',
    label: 'Ocean',
    cost: 60,
    value: 'ocean',
    swatches: ['#eaf6fb', '#16b5c9', '#0e7490'],
  },
  {
    id: 'theme-candy',
    kind: 'theme',
    label: 'Candy',
    cost: 80,
    value: 'candy',
    swatches: ['#fdeef7', '#ff5fa2', '#a855f7'],
  },
  {
    id: 'theme-forest',
    kind: 'theme',
    label: 'Forest',
    cost: 80,
    value: 'forest',
    swatches: ['#edf6ea', '#3a9d54', '#7c5e3b'],
  },
  {
    id: 'theme-sunset',
    kind: 'theme',
    label: 'Sunset',
    cost: 120,
    value: 'sunset',
    swatches: ['#fff0e8', '#ff7a3d', '#ff4d6d'],
  },
  {
    id: 'theme-midnight',
    kind: 'theme',
    label: 'Midnight',
    cost: 150,
    value: 'midnight',
    swatches: ['#20233a', '#7c9cff', '#ffc83d'],
  },
];

// Muncher characters (the animal on the play board). `value` is the animal key
// the client renders as an animated SVG. 'cat' is the free default.
const MUNCHERS: RewardItem[] = [
  { id: 'muncher-cat', kind: 'muncher', label: 'Cat', cost: 0, value: 'cat' },
  { id: 'muncher-dog', kind: 'muncher', label: 'Dog', cost: 0, value: 'dog' },
  { id: 'muncher-fox', kind: 'muncher', label: 'Fox', cost: 40, value: 'fox' },
  { id: 'muncher-frog', kind: 'muncher', label: 'Frog', cost: 60, value: 'frog' },
  { id: 'muncher-bunny', kind: 'muncher', label: 'Bunny', cost: 90, value: 'bunny' },
  { id: 'muncher-panda', kind: 'muncher', label: 'Panda', cost: 130, value: 'panda' },
  { id: 'muncher-dragon', kind: 'muncher', label: 'Dragon', cost: 220, value: 'dragon' },
];

/** The free default muncher every profile starts with. */
export const DEFAULT_MUNCHER = 'cat';

// Celebration effects (the burst on a correct munch). `value` is the effect key
// the client renders. 'confetti' is the free default.
const EFFECTS: RewardItem[] = [
  { id: 'effect-confetti', kind: 'effect', label: 'Confetti', cost: 0, value: 'confetti' },
  { id: 'effect-sparkles', kind: 'effect', label: 'Sparkles', cost: 50, value: 'sparkles' },
  { id: 'effect-stars', kind: 'effect', label: 'Shooting stars', cost: 90, value: 'stars' },
  { id: 'effect-fireworks', kind: 'effect', label: 'Fireworks', cost: 160, value: 'fireworks' },
];

/** The free default celebration effect. */
export const DEFAULT_EFFECT = 'confetti';

export const REWARD_CATALOG: RewardItem[] = [
  ...FREE_AVATAR_ITEMS,
  ...PREMIUM_AVATARS,
  ...SEASONAL_AVATARS,
  ...MUNCHERS,
  ...EFFECTS,
  ...THEMES,
  ...PERKS,
];

const BY_ID = new Map(REWARD_CATALOG.map((r) => [r.id, r]));

/** Lookup over the FULL catalog — owned out-of-season items must still resolve. */
export function rewardById(id: string): RewardItem | undefined {
  return BY_ID.get(id);
}

/** Whether an item is purchasable at `now` (seasonal windows). */
export function rewardAvailable(item: RewardItem, now: number): boolean {
  return !item.months || item.months.includes(new Date(now).getUTCMonth() + 1);
}

/** The catalog as shown/sold right now — seasonal items filtered by month. */
export function activeRewardCatalog(now: number): RewardItem[] {
  return REWARD_CATALOG.filter((r) => rewardAvailable(r, now));
}

/** The consumable that saves a streak across exactly one missed day. */
export const STREAK_SHIELD_ID = 'perk-streak-shield';

/** Item ids owned by default (every cost-0 item). */
export const FREE_ITEM_IDS: string[] = REWARD_CATALOG.filter((r) => r.cost === 0).map((r) => r.id);
