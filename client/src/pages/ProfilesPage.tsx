import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Profile } from '@shared';
import { api, qk } from '../api';
import { useAuth } from '../auth';
import { Modal } from '../components/Modal';
import { AccountModal } from './profiles/AccountModal';
import { AddProfileModal } from './profiles/AddProfileModal';
import { FactSetsModal } from './profiles/FactSetsModal';
import { RewardsModal } from './profiles/RewardsModal';
import { SettingsModal } from './profiles/SettingsModal';
import { UpgradeModal } from './profiles/UpgradeModal';
import './ProfilesPage.css';

export function ProfilesPage() {
  const { logout, guest } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Profile | null>(null);
  const [settingsFor, setSettingsFor] = useState<Profile | null>(null);
  const [rewardsFor, setRewardsFor] = useState<Profile | null>(null);
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {!guest && (
            <button className="btn ghost" onClick={() => setAccountOpen(true)}>
              Account
            </button>
          )}
          {/* A guest's session cookie is the only key to their account — exiting
              strands it for the prune job. Confirm (with a save path) first. */}
          <button className="btn ghost" onClick={() => (guest ? setExiting(true) : logout())}>
            {guest ? 'Exit' : 'Sign out'}
          </button>
        </div>
      </header>

      <div className="stack" style={{ maxWidth: 720 }}>
        <h1 className="rise" style={{ fontSize: 'clamp(1.6rem, 5vw, 2.2rem)' }}>
          Who’s practicing?
        </h1>

        {guest && (
          <div className="card guest-banner rise">
            <div>
              <strong>Playing as a guest.</strong>{' '}
              <span className="muted">
                Progress is saved on this device only — create an account to keep it.
              </span>
            </div>
            <button className="btn sun" onClick={() => setUpgrading(true)}>
              Save my progress
            </button>
          </div>
        )}

        {isError && (
          <div className="card" role="alert" style={{ textAlign: 'center' }}>
            <p className="muted">Couldn’t load profiles.</p>
            <button className="btn ghost" onClick={() => refetch()}>
              Try again
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
                <div className="streak-badge" role="img" aria-label={`${p.streak}-day streak`}>
                  <span aria-hidden="true">🔥</span> {p.streak}
                </div>
              )}
              <div className="coin-badge" role="img" aria-label={`${p.coins} coins`}>
                <span aria-hidden="true">⭐</span> {p.coins}
              </div>
              {/* Positive framing only: an invitation, never a homework backlog. */}
              {(p.dueToday ?? 0) > 0 ? (
                <div className="due-chip">{p.dueToday} to review!</div>
              ) : p.streak > 0 ? (
                <div className="due-chip caught-up">All caught up ✓</div>
              ) : null}
              <button className="btn sun full" onClick={() => navigate(`/play/${p.id}`)}>
                Play ▶
              </button>
              <div className="tile-actions">
                <button className="btn ghost" onClick={() => setRewardsFor(p)}>
                  Rewards
                </button>
                <button className="btn ghost" onClick={() => navigate(`/progress/${p.id}`)}>
                  Progress
                </button>
                <button className="btn ghost" onClick={() => setManaging(p)}>
                  Facts
                </button>
                <button className="btn ghost" onClick={() => setSettingsFor(p)}>
                  Settings
                </button>
              </div>
            </div>
          ))}

          {profiles && (
            <button className="profile-tile add-tile rise" onClick={() => setAdding(true)}>
              <div className="avatar plus" aria-hidden="true">
                ＋
              </div>
              <div className="profile-name">Add a kid</div>
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
      {upgrading && (
        <UpgradeModal onClose={() => setUpgrading(false)} onDone={() => setUpgrading(false)} />
      )}
      {accountOpen && <AccountModal onClose={() => setAccountOpen(false)} />}
      {exiting && (
        <Modal title="Leaving already?" onClose={() => setExiting(false)}>
          <p className="muted" style={{ marginTop: '-0.3rem' }}>
            You’re playing as a guest, so exiting deletes your coins and progress for good. Want to
            save them with an account first?
          </p>
          <button
            className="btn sun full"
            onClick={() => {
              setExiting(false);
              setUpgrading(true);
            }}
          >
            Save my progress
          </button>
          <button className="btn danger" onClick={logout}>
            Exit and delete my progress
          </button>
        </Modal>
      )}
    </div>
  );
}
