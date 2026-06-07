import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { FactSet, Profile, ProfileSettings, RewardItem } from '@shared';
import { api, ApiError, qk } from '../api';
import { useAuth } from '../auth';
import { Muncher } from '../components/Muncher';
import { AVATARS, OP_LABEL, OP_SYMBOL } from '../ops';
import { useTheme } from '../useTheme';
import './ProfilesPage.css';

/** Shop preview icon per celebration effect. */
const EFFECT_ICON: Record<string, string> = {
  confetti: '🎉',
  sparkles: '✨',
  stars: '🌟',
  fireworks: '🎆',
};

export function ProfilesPage() {
  const { logout, guest } = useAuth();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Profile | null>(null);
  const [settingsFor, setSettingsFor] = useState<Profile | null>(null);
  const [rewardsFor, setRewardsFor] = useState<Profile | null>(null);
  const [upgrading, setUpgrading] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const {
    data: profiles,
    isError,
    refetch,
  } = useQuery({
    queryKey: qk.profiles,
    queryFn: () => api.listProfiles().then((r) => r.profiles),
  });

  return (
    <div className="screen">
      <header className="hub-header">
        <div className="brand">
          <span className="glyph">✦</span> Fact Fluency
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {!guest && (
            <button className="btn ghost" onClick={() => setAccountOpen(true)}>
              Account
            </button>
          )}
          <button className="btn ghost" onClick={logout}>
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
              <div className="avatar">{p.avatar}</div>
              <div className="profile-name">{p.displayName}</div>
              {p.streak > 1 && <div className="streak-badge">🔥 {p.streak}</div>}
              <div className="coin-badge">⭐ {p.coins}</div>
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
              <div className="avatar plus">＋</div>
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
    </div>
  );
}

/** All IANA timezones, when the runtime exposes them (for the picker). */
const TIMEZONES: string[] = (() => {
  const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
})();

const ACCOUNT_MESSAGES: Record<string, string> = {
  invalid_email: 'That email doesn’t look right.',
  weak_password: 'Password needs at least 8 characters.',
  email_taken: 'That email is already in use.',
  invalid_timezone: 'Pick a valid timezone.',
};

/** Parent account management: edit email / password / timezone, or delete. */
function AccountModal({ onClose }: { onClose: () => void }) {
  const { deleteAccount } = useAuth();
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const { data: account } = useQuery({ queryKey: ['account'], queryFn: () => api.account() });
  useEffect(() => {
    if (account) {
      setEmail(account.email);
      setTimezone(account.timezone);
    }
  }, [account]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.updateAccount({ email: email.trim(), timezone, ...(password ? { password } : {}) }),
    onSuccess: (r) => {
      setSaved(true);
      setError(null);
      setPassword('');
      setEmail(r.email);
      setTimezone(r.timezone);
    },
    onError: (e) => {
      setSaved(false);
      setError(
        ACCOUNT_MESSAGES[e instanceof ApiError ? e.code : ''] ?? 'Couldn’t save — try again.',
      );
    },
  });
  const deleteMut = useMutation({ mutationFn: () => deleteAccount() });
  // On delete success the auth state flips to logged-out and this page unmounts.

  function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (!email.trim()) return;
    saveMut.mutate();
  }

  return (
    <Modal onClose={onClose} title="Your account">
      <form className="stack" onSubmit={save} style={{ gap: '0.9rem' }}>
        {error && <div className="error-banner">{error}</div>}
        {saved && (
          <div className="muted" style={{ color: 'var(--add)' }}>
            Saved ✓
          </div>
        )}
        <div className="field">
          <label htmlFor="acct-email">Email</label>
          <input
            id="acct-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="acct-password">New password</label>
          <input
            id="acct-password"
            type="password"
            autoComplete="new-password"
            placeholder="Leave blank to keep current"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="acct-tz">Timezone</label>
          {TIMEZONES.length ? (
            <select id="acct-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {timezone && !TIMEZONES.includes(timezone) && (
                <option value={timezone}>{timezone}</option>
              )}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          ) : (
            <input id="acct-tz" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          )}
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            Review scheduling uses this zone.
          </span>
        </div>
        <button className="btn sun full" type="submit" disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <div className="danger-zone">
        {deleteMut.isError && <div className="error-banner">Couldn’t delete — try again.</div>}
        {!confirming ? (
          <button className="btn danger-link" onClick={() => setConfirming(true)}>
            Delete my account
          </button>
        ) : (
          <div className="confirm-delete">
            <p className="muted">Really delete everything?</p>
            <div className="confirm-actions">
              <button
                className="btn ghost"
                disabled={deleteMut.isPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
              >
                {deleteMut.isPending ? 'Deleting…' : 'Delete everything'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RewardsModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [coins, setCoins] = useState(profile.coins);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<RewardItem[] | null>(null);
  const [equippedAvatar, setEquippedAvatar] = useState(profile.avatar);
  const [equippedTheme, setEquippedTheme] = useState(profile.theme);
  const [equippedMuncher, setEquippedMuncher] = useState('cat');
  const [equippedEffect, setEquippedEffect] = useState('confetti');
  const [busy, setBusy] = useState<string | null>(null);

  // Live-preview the equipped theme across the whole picker while open.
  useTheme(equippedTheme);

  // Cached fetch (deduped across reopens); mirror it into local state so equip
  // can optimistically update the preview without refetching.
  const { data: rewards } = useQuery({
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
    item.kind === 'avatar'
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
    try {
      if (isOwned) {
        await equip(item);
      } else if (coins >= item.cost) {
        const r = await api.unlockReward(profile.id, item.id);
        setCoins(r.coins);
        setOwned(new Set(r.owned));
        await equip(item); // wear it right away
        // Coins were spent — refresh the picker badge and the rewards cache.
        void queryClient.invalidateQueries({ queryKey: qk.profiles });
        void queryClient.invalidateQueries({ queryKey: qk.rewards(profile.id) });
      }
    } finally {
      setBusy(null);
    }
  }

  const byKind = (kind: RewardItem['kind']) => (catalog ?? []).filter((i) => i.kind === kind);
  const section = (title: string, kind: RewardItem['kind']) => (
    <RewardSection title={title}>
      {byKind(kind).map((item) => (
        <RewardTile
          key={item.id}
          item={item}
          owned={owned.has(item.id)}
          equipped={isEquipped(item)}
          affordable={coins >= item.cost}
          busy={busy === item.id}
          onClick={() => act(item)}
        />
      ))}
    </RewardSection>
  );

  return (
    <Modal onClose={onClose} title={`${equippedAvatar} ${profile.displayName}'s rewards`}>
      <div className="coin-balance">⭐ {coins} coins</div>
      {section('Munchers', 'muncher')}
      {section('Celebrations', 'effect')}
      {section('Avatars', 'avatar')}
      {section('Themes', 'theme')}
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
  affordable,
  busy,
  onClick,
}: {
  item: RewardItem;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  const locked = !owned && !affordable;
  return (
    <button
      className={`reward-tile ${equipped ? 'equipped' : ''} ${locked ? 'locked' : ''}`}
      disabled={busy || equipped || locked}
      onClick={onClick}
      title={item.label}
    >
      <div className="reward-preview">
        {item.kind === 'avatar' && <span className="reward-emoji">{item.value}</span>}
        {item.kind === 'muncher' && <Muncher animal={item.value} state="idle" size={44} />}
        {item.kind === 'effect' && (
          <span className="reward-emoji">{EFFECT_ICON[item.value] ?? '🎉'}</span>
        )}
        {item.kind === 'theme' && (
          <span className="reward-swatches">
            {(item.swatches ?? []).map((c, i) => (
              <span key={i} className="reward-swatch" style={{ background: c }} />
            ))}
          </span>
        )}
      </div>
      <div className="reward-label">{item.label}</div>
      <div className="reward-status">{equipped ? '✓ On' : owned ? 'Use' : `⭐ ${item.cost}`}</div>
    </button>
  );
}

/** Editable session settings with their inclusive bounds — mirrors the server's
 *  SETTING_BOUNDS so the UI rejects out-of-range input before the round-trip. */
const SETTING_FIELDS: {
  key: keyof ProfileSettings;
  label: string;
  hint: string;
  min: number;
  max: number;
}[] = [
  {
    key: 'sessionCards',
    label: 'Cards per session',
    hint: 'How many questions a session aims for.',
    min: 5,
    max: 50,
  },
  {
    key: 'sessionSeconds',
    label: 'Session length (seconds)',
    hint: 'Target time budget for a session.',
    min: 30,
    max: 600,
  },
  {
    key: 'newPerSession',
    label: 'New facts per session',
    hint: 'How many fresh facts trickle in each time.',
    min: 0,
    max: 10,
  },
];

const EDIT_MESSAGES: Record<string, string> = {
  invalid_display_name: 'Please enter a name.',
  invalid_avatar: 'Pick a buddy.',
  invalid_settings: 'Those settings are out of range.',
};

function SettingsModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState(profile.avatar);
  const [values, setValues] = useState<ProfileSettings>(profile.settings);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const outOfRange = SETTING_FIELDS.some(({ key, min, max }) => {
    const v = values[key];
    return !Number.isInteger(v) || v < min || v > max;
  });
  const nameEmpty = !name.trim();

  const [error, setError] = useState<string | null>(null);
  const saveMut = useMutation({
    mutationFn: () =>
      api.updateProfile(profile.id, { displayName: name.trim(), avatar, settings: values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profiles });
      onSaved();
    },
    onError: (e) =>
      setError(EDIT_MESSAGES[e instanceof ApiError ? e.code : ''] ?? 'Couldn’t save — try again.'),
  });
  const deleteMut = useMutation({
    mutationFn: () => api.deleteProfile(profile.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profiles });
      onClose();
    },
  });
  const busy = saveMut.isPending || deleteMut.isPending;

  function save() {
    setError(null);
    if (outOfRange || nameEmpty) return;
    saveMut.mutate();
  }

  return (
    <Modal onClose={onClose} title={`${profile.avatar} ${profile.displayName}'s settings`}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label htmlFor="edit-name">Name</label>
        <input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Buddy</label>
        <div className="avatar-picker">
          {AVATARS.map((a) => (
            <button
              key={a}
              className={`avatar-option ${a === avatar ? 'selected' : ''}`}
              onClick={() => setAvatar(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      {SETTING_FIELDS.map(({ key, label, hint, min, max }) => (
        <div className="field" key={key}>
          <label htmlFor={`set-${key}`}>{label}</label>
          <input
            id={`set-${key}`}
            type="number"
            min={min}
            max={max}
            value={values[key]}
            onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.valueAsNumber }))}
          />
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            {hint} ({min}–{max})
          </span>
        </div>
      ))}
      <button className="btn sun full" disabled={busy || outOfRange || nameEmpty} onClick={save}>
        {saveMut.isPending ? 'Saving…' : 'Save'}
      </button>

      <div className="danger-zone">
        {deleteMut.isError && <div className="error-banner">Couldn’t delete — try again.</div>}
        {!confirmingDelete ? (
          <button className="btn danger-link" onClick={() => setConfirmingDelete(true)}>
            Delete {profile.displayName}’s profile
          </button>
        ) : (
          <div className="confirm-delete">
            <p className="muted">
              Delete <strong>{profile.displayName}</strong> and all their progress? This can’t be
              undone.
            </p>
            <div className="confirm-actions">
              <button
                className="btn ghost"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button className="btn danger" disabled={busy} onClick={() => deleteMut.mutate()}>
                {deleteMut.isPending ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function AddProfileModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [band, setBand] = useState(''); // '' = starter mix (default sets)

  const { data: bands = [] } = useQuery({
    queryKey: qk.catalog,
    queryFn: () => api.catalog().then((r) => r.gradeBands),
    staleTime: Infinity, // the catalog is static
  });

  const createMut = useMutation({
    mutationFn: () => api.createProfile(name.trim(), avatar, band || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profiles });
      onCreated();
    },
  });
  const busy = createMut.isPending;

  function create() {
    if (!name.trim()) return;
    createMut.mutate();
  }

  return (
    <Modal onClose={onClose} title="Add a kid">
      <div className="field">
        <label htmlFor="kid-name">Name</label>
        <input id="kid-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Pick a buddy</label>
        <div className="avatar-picker">
          {AVATARS.map((a) => (
            <button
              key={a}
              className={`avatar-option ${a === avatar ? 'selected' : ''}`}
              onClick={() => setAvatar(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Starting level</label>
        <div className="band-picker">
          <button className={`set-pill ${band === '' ? 'on' : ''}`} onClick={() => setBand('')}>
            Starter mix
          </button>
          {bands.map((b) => (
            <button
              key={b.id}
              className={`set-pill ${band === b.id ? 'on' : ''}`}
              onClick={() => setBand(b.id)}
            >
              {b.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: '0.8rem' }}>
          Sets a few fact sets to start — you can fine-tune them anytime from “Facts”.
        </span>
      </div>
      <button className="btn sun full" disabled={busy || !name.trim()} onClick={create}>
        {busy ? 'Creating…' : 'Create profile'}
      </button>
    </Modal>
  );
}

function FactSetsModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState<Set<string>>(new Set());

  const { data } = useQuery({
    queryKey: qk.factSets(profile.id),
    queryFn: () => api.getFactSets(profile.id),
  });
  const catalog = data?.catalog ?? null;
  useEffect(() => {
    if (data) setEnabled(new Set(data.enabledIds));
  }, [data]);

  function toggle(id: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const saveMut = useMutation({
    mutationFn: () => api.setFactSets(profile.id, [...enabled]),
    onSuccess: () => {
      // Enabled sets change the progress grid + dashboard mastery — refresh both.
      void queryClient.invalidateQueries({ queryKey: qk.factSets(profile.id) });
      void queryClient.invalidateQueries({ queryKey: qk.progress(profile.id) });
      void queryClient.invalidateQueries({ queryKey: qk.dashboard(profile.id) });
      onClose();
    },
  });
  const busy = saveMut.isPending;

  function save() {
    saveMut.mutate();
  }

  const grouped = (catalog ?? []).reduce<Record<string, FactSet[]>>((acc, s) => {
    (acc[s.operation] ??= []).push(s);
    return acc;
  }, {});

  return (
    <Modal onClose={onClose} title={`${profile.avatar} ${profile.displayName}'s facts`}>
      {!catalog && <p className="muted">Loading…</p>}
      {Object.entries(grouped).map(([op, sets]) => (
        <div key={op} className="set-group">
          <div className="set-group-title">
            {OP_LABEL[op as keyof typeof OP_LABEL]}{' '}
            <span className="op-sym">{OP_SYMBOL[op as keyof typeof OP_SYMBOL]}</span>
          </div>
          <div className="set-options">
            {sets.map((s) => (
              <button
                key={s.id}
                className={`set-pill ${op} ${enabled.has(s.id) ? 'on' : ''}`}
                onClick={() => toggle(s.id)}
              >
                {s.label.replace(/^[A-Za-z]+ /, '')}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button className="btn sun full" disabled={busy} onClick={save}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </Modal>
  );
}

const UPGRADE_MESSAGES: Record<string, string> = {
  invalid_email: 'That email doesn’t look right.',
  weak_password: 'Password needs at least 8 characters.',
  email_taken: 'That email already has an account — try a different one.',
  not_a_guest: 'This account is already saved.',
};

/** Turn a guest into a real account in place (keeps their progress). */
function UpgradeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { upgradeGuest } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await upgradeGuest(email, password);
      onDone();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      setError(UPGRADE_MESSAGES[code] ?? 'Could not save. Try again.');
      setBusy(false);
    }
  }

  return (
    <Modal title="Save your progress" onClose={onClose}>
      <p className="muted" style={{ marginTop: '-0.3rem' }}>
        Create an account to keep your coins and progress — and play on other devices.
      </p>
      <form className="stack" onSubmit={save} style={{ gap: '0.9rem' }}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="up-email">Email</label>
          <input
            id="up-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor="up-password">Password</label>
          <input
            id="up-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn sun full" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Create account'}
        </button>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card stack" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
