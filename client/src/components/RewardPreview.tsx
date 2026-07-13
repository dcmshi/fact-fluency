import type { TFunction } from 'i18next';
import type { RewardItem } from '@shared';
import { tLabel } from '../i18n';
import { Muncher } from './Muncher';

/** Preview icon per celebration effect. */
const EFFECT_ICON: Record<string, string> = {
  confetti: '🎉',
  sparkles: '✨',
  stars: '🌟',
  fireworks: '🎆',
};

/** Localized reward name by id; the 12 free avatars share one label. */
export function itemLabel(t: TFunction, item: RewardItem): string {
  const key = item.id.startsWith('avatar-free-')
    ? 'rewards.items.starterBuddy'
    : `rewards.items.${item.id}`;
  return tLabel(t, key, item.label);
}

/**
 * The visual for a reward — shared by the Rewards shop and the sticker book so
 * they render identically. `still` (no animation) AND a clipped, self-compositing
 * wrapper (.reward-muncher): the muncher SVG paints past its box
 * (overflow: visible), and a plain overflow:hidden ancestor doesn't reliably clip
 * a composited SVG while a modal is mid-scroll — it slides off its tile. The
 * wrapper's own layer clips it on the scroll thread. Emoji/swatch previews don't
 * need this.
 */
export function RewardPreview({ item }: { item: RewardItem }) {
  return (
    <div className="reward-preview">
      {item.kind === 'avatar' && <span className="reward-emoji">{item.value}</span>}
      {item.kind === 'muncher' && (
        <span className="reward-muncher">
          <Muncher animal={item.value} state="still" size={36} />
        </span>
      )}
      {item.kind === 'effect' && (
        <span className="reward-emoji">{EFFECT_ICON[item.value] ?? '🎉'}</span>
      )}
      {item.kind === 'perk' && <span className="reward-emoji">🛡️</span>}
      {item.kind === 'theme' && (
        <span className="reward-swatches">
          {(item.swatches ?? []).map((c, i) => (
            <span key={i} className="reward-swatch" style={{ background: c }} />
          ))}
        </span>
      )}
    </div>
  );
}
