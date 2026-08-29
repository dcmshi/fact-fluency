import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Profile, RewardItem } from '@shared';
import { api, qk } from '../../api';
import { Modal } from '../../components/Modal';
import { RewardPreview, itemLabel } from '../../components/RewardPreview';
import { useTheme } from '../../useTheme';

export function RewardsModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [coins, setCoins] = useState(profile.coins);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<RewardItem[] | null>(null);
  const [equippedAvatar, setEquippedAvatar] = useState(profile.avatar);
  const [equippedTheme, setEquippedTheme] = useState(profile.theme);
  const [equippedMuncher, setEquippedMuncher] = useState('cat');
  const [equippedEffect, setEquippedEffect] = useState('confetti');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState<string | null>(null);

  // Live-preview the equipped theme across the whole picker while open.
  useTheme(equippedTheme);

  // Cached fetch (deduped across reopens); mirror it into local state so equip
  // can optimistically update the preview without refetching.
  const {
    data: rewards,
    isError: loadFailed,
    refetch: reload,
  } = useQuery({
    queryKey: qk.rewards(profile.id),
    queryFn: () => api.rewards(profile.id),
  });
  useEffect(() => {
    if (!rewards) return;
    setCoins(rewards.coins);
    setOwned(new Set(rewards.owned));
    setCatalog(rewards.catalog);
    setEquippedAvatar(rewards.equippedAvatar);
    setEquippedTheme(rewards.equippedTheme);
    setEquippedMuncher(rewards.equippedMuncher);
    setEquippedEffect(rewards.equippedEffect);
  }, [rewards]);

  const isEquipped = (item: RewardItem) =>
    item.kind === 'perk'
      ? false // perks act on their own; nothing is "worn"
      : item.kind === 'avatar'
        ? item.value === equippedAvatar
        : item.kind === 'theme'
          ? item.value === equippedTheme
          : item.kind === 'muncher'
            ? item.value === equippedMuncher
            : item.value === equippedEffect;

  async function equip(item: RewardItem) {
    const r = await api.equipReward(profile.id, item.id);
    setEquippedAvatar(r.equippedAvatar);
    setEquippedTheme(r.equippedTheme);
    setEquippedMuncher(r.equippedMuncher);
    setEquippedEffect(r.equippedEffect);
    // An equipped avatar shows on the picker tile — refresh that list.
    void queryClient.invalidateQueries({ queryKey: qk.profiles });
  }

  async function act(item: RewardItem) {
    const isOwned = owned.has(item.id);
    if (isEquipped(item)) return;
    setBusy(item.id);
    setError(null);
    setGoal(null);
    try {
      if (isOwned) {
        if (item.kind === 'perk') {
          // Nothing to equip — remind what it's for instead of a dead tap.
          setGoal(t('rewards.shieldGoal'));
        } else {
          await equip(item);
        }
      } else if (coins >= item.cost) {
        const r = await api.unlockReward(profile.id, item.id);
        setCoins(r.coins);
        setOwned(new Set(r.owned));
        if (item.kind !== 'perk') await equip(item); // wear it right away
        // Coins were spent — refresh the picker badge and the rewards cache.
        void queryClient.invalidateQueries({ queryKey: qk.profiles });
        void queryClient.invalidateQueries({ queryKey: qk.rewards(profile.id) });
      } else {
        // A locked tile is a goal, not a dead end (the strongest motivation
        // loop): tapping it says how far away it is.
        setGoal(t('rewards.needMore', { label: itemLabel(t, item), n: item.cost - coins }));
      }
    } catch {
      // Refresh from the server so the UI reflects true ownership/coins.
      void queryClient.invalidateQueries({ queryKey: qk.rewards(profile.id) });
      setError(t('errors.rewardFailed'));
    } finally {
      setBusy(null);
    }
  }

  const byKind = (kind: RewardItem['kind']) => (catalog ?? []).filter((i) => i.kind === kind);
  const section = (title: string, kind: RewardItem['kind']) => (
    <RewardSection title={title}>
      {catalog === null
        ? // Loading: tile-shaped shimmer instead of an empty section.
          [0, 1, 2, 3].map((i) => <div key={`sk-${i}`} className="skeleton reward-skel" />)
        : byKind(kind).map((item) => (
            <RewardTile
              key={item.id}
              item={item}
              owned={owned.has(item.id)}
              equipped={isEquipped(item)}
              coins={coins}
              busy={busy === item.id}
              onClick={() => act(item)}
            />
          ))}
    </RewardSection>
  );

  return (
    <Modal
      onClose={onClose}
      title={t('rewards.title', { avatar: equippedAvatar, name: profile.displayName })}
    >
      <div className="coin-balance" role="img" aria-label={t('rewards.coins', { count: coins })}>
        <span aria-hidden="true">⭐</span> {t('rewards.coins', { count: coins })}
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {goal && (
        <div className="notice-banner" role="status">
          {goal}
        </div>
      )}
      {/* Without this a failed fetch left five sections of shimmer tiles up for
          good, with nothing to say so and nothing to retry — the shop looked
          like it was still loading forever. */}
      {loadFailed ? (
        <div role="alert" style={{ textAlign: 'center' }}>
          <p className="muted">{t('errors.rewardsLoadFailed')}</p>
          <button className="btn ghost" onClick={() => void reload()}>
            {t('common.tryAgain')}
          </button>
        </div>
      ) : (
        <>
          {section(t('rewards.sectionMunchers'), 'muncher')}
          {section(t('rewards.sectionCelebrations'), 'effect')}
          {section(t('rewards.sectionAvatars'), 'avatar')}
          {section(t('rewards.sectionThemes'), 'theme')}
          {section(t('rewards.sectionPowerups'), 'perk')}
        </>
      )}
    </Modal>
  );
}

function RewardSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="reward-section">
      <div className="reward-section-title">{title}</div>
      <div className="reward-grid">{children}</div>
    </div>
  );
}

function RewardTile({
  item,
  owned,
  equipped,
  coins,
  busy,
  onClick,
}: {
  item: RewardItem;
  owned: boolean;
  equipped: boolean;
  coins: number;
  busy: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  const locked = !owned && coins < item.cost;
  // Locked tiles stay tappable — the tap shows how many coins to go (a goal,
  // not a dead control).
  return (
    <button
      className={`reward-tile ${equipped ? 'equipped' : ''} ${locked ? 'locked' : ''}`}
      disabled={busy || equipped}
      onClick={onClick}
      title={itemLabel(t, item)}
    >
      <RewardPreview item={item} />
      <div className="reward-label">{itemLabel(t, item)}</div>
      <div className="reward-status">
        {equipped ? (
          t('rewards.statusOn')
        ) : owned ? (
          item.kind === 'perk' ? (
            t('rewards.statusReady')
          ) : (
            t('rewards.statusUse')
          )
        ) : locked ? (
          // Show the goal, not just the price: "⭐ 80 · 45 to go!"
          <>
            <span aria-hidden="true">⭐</span> {item.cost} ·{' '}
            {t('rewards.toGo', { n: item.cost - coins })}
          </>
        ) : (
          <>
            <span aria-hidden="true">⭐</span> {item.cost}
          </>
        )}
      </div>
    </button>
  );
}
