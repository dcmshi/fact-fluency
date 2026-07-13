import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Profile } from '@shared';
import { api, qk } from '../api';
import { useAuth } from '../auth';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { Modal } from '../components/Modal';
import { AccountModal } from './profiles/AccountModal';
import { AddProfileModal } from './profiles/AddProfileModal';
import { FactSetsModal } from './profiles/FactSetsModal';
import { RewardsModal } from './profiles/RewardsModal';
import { StickerBookModal } from './profiles/StickerBookModal';
import { SettingsModal } from './profiles/SettingsModal';
import { UpgradeModal } from './profiles/UpgradeModal';
import './ProfilesPage.css';

export function ProfilesPage() {
  const { t } = useTranslation();
  const { logout, guest } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Profile | null>(null);
  const [settingsFor, setSettingsFor] = useState<Profile | null>(null);
  const [rewardsFor, setRewardsFor] = useState<Profile | null>(null);
  const [stickersFor, setStickersFor] = useState<Profile | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [exiting, setExiting] = useState(false);

  const {
    data: profiles,
    isError,
    refetch,
  } = useQuery({
    queryKey: qk.profiles,
    queryFn: () => api.listProfiles().then((r) => r.profiles),
  });

  // Deep link from the play summary's "Spend coins" → open the kid's Rewards.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const rid = searchParams.get('rewards');
    if (!rid || !profiles) return;
    const p = profiles.find((x) => x.id === rid);
    if (p) setRewardsFor(p);
    setSearchParams({}, { replace: true }); // consume the param
  }, [searchParams, profiles, setSearchParams]);

  return (
    <div className="screen">
      <header className="hub-header">
        <div className="brand">
          <span className="glyph" aria-hidden="true">
            ✦
          </span>{' '}
          Fact Fluency
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <LanguageSwitcher />
          {!guest && (
            <button className="btn ghost" onClick={() => setAccountOpen(true)}>
              {t('profiles.account')}
            </button>
          )}
          {/* A guest's session cookie is the only key to their account — exiting
              strands it for the prune job. Confirm (with a save path) first. */}
          <button className="btn ghost" onClick={() => (guest ? setExiting(true) : logout())}>
            {guest ? t('profiles.exit') : t('profiles.signOut')}
          </button>
        </div>
      </header>

      <div className="stack" style={{ maxWidth: 720 }}>
        <h1 className="rise" style={{ fontSize: 'clamp(1.6rem, 5vw, 2.2rem)' }}>
          {t('profiles.whosPracticing')}
        </h1>

        {guest && (
          <div className="card guest-banner rise">
            <div>
              <strong>{t('profiles.guestTitle')}</strong>{' '}
              <span className="muted">{t('profiles.guestNote')}</span>
            </div>
            <button className="btn sun" onClick={() => setUpgrading(true)}>
              {t('profiles.saveProgress')}
            </button>
          </div>
        )}

        {isError && (
          <div className="card" role="alert" style={{ textAlign: 'center' }}>
            <p className="muted">{t('profiles.loadError')}</p>
            <button className="btn ghost" onClick={() => refetch()}>
              {t('common.tryAgain')}
            </button>
          </div>
        )}

        <div className="profile-grid">
          {!profiles &&
            !isError &&
            [0, 1, 2].map((i) => (
              <div className="profile-tile" key={`sk-${i}`} aria-hidden="true">
                <div className="skeleton" style={{ width: 64, height: 64, borderRadius: '50%' }} />
                <div className="skeleton" style={{ width: '60%', height: 16, marginTop: 12 }} />
                <div className="skeleton" style={{ width: '100%', height: 40, marginTop: 14 }} />
              </div>
            ))}
          {profiles?.map((p, i) => (
            <div
              className="profile-tile rise"
              key={p.id}
              style={{ animationDelay: `${i * 0.06}s` }}
            >
              <div className="avatar" aria-hidden="true">
                {p.avatar}
              </div>
              <div className="profile-name">{p.displayName}</div>
              {p.streak > 1 && (
                <div
                  className="streak-badge"
                  role="img"
                  aria-label={t('profiles.streakLabel', { count: p.streak })}
                >
                  <span aria-hidden="true">🔥</span> {p.streak}
                </div>
              )}
              <div
                className="coin-badge"
                role="img"
                aria-label={t('profiles.coinsLabel', { count: p.coins })}
              >
                <span aria-hidden="true">⭐</span> {p.coins}
              </div>
              {/* Positive framing only: an invitation, never a homework backlog.
                  Once today's session is done, celebrate rest over a review nag. */}
              {p.doneToday ? (
                <div className="due-chip caught-up">{t('profiles.doneToday')}</div>
              ) : (p.dueToday ?? 0) > 0 ? (
                <div className="due-chip">{t('profiles.toReview', { count: p.dueToday })}</div>
              ) : p.streak > 0 ? (
                <div className="due-chip caught-up">{t('profiles.caughtUp')}</div>
              ) : null}
              <button className="btn sun full" onClick={() => navigate(`/play/${p.id}`)}>
                {t('profiles.play')}
              </button>
              <div className="tile-actions">
                <button className="btn ghost" onClick={() => navigate(`/race/${p.id}`)}>
                  {t('profiles.race')}
                </button>
                <button className="btn ghost" onClick={() => setRewardsFor(p)}>
                  {t('profiles.rewards')}
                </button>
                <button className="btn ghost" onClick={() => setStickersFor(p)}>
                  {t('profiles.stickers')}
                </button>
                <button className="btn ghost" onClick={() => navigate(`/progress/${p.id}`)}>
                  {t('profiles.progress')}
                </button>
                <button className="btn ghost" onClick={() => setManaging(p)}>
                  {t('profiles.facts')}
                </button>
                <button className="btn ghost" onClick={() => setSettingsFor(p)}>
                  {t('profiles.settings')}
                </button>
              </div>
            </div>
          ))}

          {profiles && (
            <button className="profile-tile add-tile rise" onClick={() => setAdding(true)}>
              <div className="avatar plus" aria-hidden="true">
                ＋
              </div>
              <div className="profile-name">{t('profiles.addKid')}</div>
            </button>
          )}
        </div>
      </div>

      {adding && (
        <AddProfileModal onClose={() => setAdding(false)} onCreated={() => setAdding(false)} />
      )}
      {managing && <FactSetsModal profile={managing} onClose={() => setManaging(null)} />}
      {settingsFor && (
        <SettingsModal
          profile={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSaved={() => setSettingsFor(null)}
        />
      )}
      {rewardsFor && <RewardsModal profile={rewardsFor} onClose={() => setRewardsFor(null)} />}
      {stickersFor && (
        <StickerBookModal profile={stickersFor} onClose={() => setStickersFor(null)} />
      )}
      {upgrading && (
        <UpgradeModal onClose={() => setUpgrading(false)} onDone={() => setUpgrading(false)} />
      )}
      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
      {exiting && (
        <Modal title={t('profiles.exitTitle')} onClose={() => setExiting(false)}>
          <p className="muted" style={{ marginTop: '-0.3rem' }}>
            {t('profiles.exitBody')}
          </p>
          <button
            className="btn sun full"
            onClick={() => {
              setExiting(false);
              setUpgrading(true);
            }}
          >
            {t('profiles.saveProgress')}
          </button>
          <button className="btn danger" onClick={logout}>
            {t('profiles.exitConfirm')}
          </button>
        </Modal>
      )}
    </div>
  );
}
