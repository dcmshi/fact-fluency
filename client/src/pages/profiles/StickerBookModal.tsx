import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Profile, RewardItem } from '@shared';
import { api, qk } from '../../api';
import { Modal } from '../../components/Modal';
import { RewardPreview, itemLabel } from '../../components/RewardPreview';
import './StickerBookModal.css';

// Collection order mirrors the Rewards shop; reuses its section labels.
const SECTIONS = [
  { titleKey: 'rewards.sectionMunchers', kind: 'muncher' },
  { titleKey: 'rewards.sectionCelebrations', kind: 'effect' },
  { titleKey: 'rewards.sectionAvatars', kind: 'avatar' },
  { titleKey: 'rewards.sectionThemes', kind: 'theme' },
  { titleKey: 'rewards.sectionPowerups', kind: 'perk' },
] as const satisfies readonly { titleKey: string; kind: RewardItem['kind'] }[];

/**
 * A calm collection view over the rewards catalog (COMPETITORS.md §5.11): a
 * sticker album showing what's been collected vs. still-to-find. Read-only and
 * celebratory — no coins, no spending (that's the Rewards shop). Reuses the
 * cached rewards query, so it reflects the active (in-season) catalog.
 */
export function StickerBookModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: qk.rewards(profile.id),
    queryFn: () => api.rewards(profile.id),
  });
  const catalog = data?.catalog ?? null;
  const owned = new Set(data?.owned ?? []);
  const total = catalog?.length ?? 0;
  const collected = catalog ? catalog.filter((i) => owned.has(i.id)).length : 0;
  const pct = total > 0 ? Math.round((collected / total) * 100) : 0;

  return (
    <Modal
      onClose={onClose}
      title={t('stickers.title', { avatar: profile.avatar, name: profile.displayName })}
    >
      {!catalog && <p className="muted">{t('common.loading')}</p>}
      {catalog && (
        <>
          <div className="sticker-progress">
            <div className="sticker-progress-count">
              {t('stickers.collected', { collected, total })}
            </div>
            <div
              className="sticker-progress-track"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="sticker-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            {collected === total && (
              <div className="sticker-complete">{t('stickers.complete')}</div>
            )}
          </div>

          {SECTIONS.map(({ titleKey, kind }) => {
            const items = catalog.filter((i) => i.kind === kind);
            if (items.length === 0) return null;
            return (
              <div className="sticker-section" key={kind}>
                <div className="sticker-section-title">{t(titleKey)}</div>
                <div className="sticker-grid">
                  {items.map((item) => {
                    const have = owned.has(item.id);
                    const label = have ? itemLabel(t, item) : t('stickers.locked');
                    return (
                      <div
                        key={item.id}
                        className={`sticker ${have ? 'have' : 'locked'}`}
                        title={label}
                        role="img"
                        aria-label={label}
                      >
                        {have ? (
                          <RewardPreview item={item} />
                        ) : (
                          <span className="sticker-locked" aria-hidden="true">
                            ?
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </Modal>
  );
}
