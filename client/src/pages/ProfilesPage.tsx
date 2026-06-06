import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FactSet, GradeBand, Profile, ProfileSettings, RewardItem } from '@shared';
import { api } from '../api';
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
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Profile | null>(null);
  const [settingsFor, setSettingsFor] = useState<Profile | null>(null);
  const [rewardsFor, setRewardsFor] = useState<Profile | null>(null);

  const refresh = () => api.listProfiles().then((r) => setProfiles(r.profiles));
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="screen">
      <header className="hub-header">
        <div className="brand">
          <span className="glyph">✦</span> Fact Fluency
        </div>
        <button className="btn ghost" onClick={logout}>
          Sign out
        </button>
      </header>

      <div className="stack" style={{ maxWidth: 720 }}>
        <h1 className="rise" style={{ fontSize: 'clamp(1.6rem, 5vw, 2.2rem)' }}>
          Who’s practicing?
        </h1>

        <div className="profile-grid">
          {!profiles &&
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
        <AddProfileModal
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      {managing && <FactSetsModal profile={managing} onClose={() => setManaging(null)} />}
      {settingsFor && (
        <SettingsModal
          profile={settingsFor}
          onClose={() => setSettingsFor(null)}
          onSaved={() => {
            setSettingsFor(null);
            refresh();
          }}
        />
      )}
      {rewardsFor && (
        <RewardsModal
          profile={rewardsFor}
          onClose={() => {
            setRewardsFor(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function RewardsModal({ profile, onClose }: { profile: Profile; onClose: () => void }) {
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

  useEffect(() => {
    api.rewards(profile.id).then((r) => {
      setCoins(r.coins);
      setOwned(new Set(r.owned));
      setCatalog(r.catalog);
      setEquippedAvatar(r.equippedAvatar);
      setEquippedTheme(r.equippedTheme);
      setEquippedMuncher(r.equippedMuncher);
      setEquippedEffect(r.equippedEffect);
    });
  }, [profile.id]);

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

function SettingsModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<ProfileSettings>(profile.settings);
  const [busy, setBusy] = useState(false);

  const outOfRange = SETTING_FIELDS.some(({ key, min, max }) => {
    const v = values[key];
    return !Number.isInteger(v) || v < min || v > max;
  });

  async function save() {
    if (outOfRange) return;
    setBusy(true);
    try {
      await api.updateSettings(profile.id, values);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} title={`${profile.avatar} ${profile.displayName}'s settings`}>
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
      <button className="btn sun full" disabled={busy || outOfRange} onClick={save}>
        {busy ? 'Saving…' : 'Save'}
      </button>
    </Modal>
  );
}

function AddProfileModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [bands, setBands] = useState<GradeBand[]>([]);
  const [band, setBand] = useState(''); // '' = starter mix (default sets)
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.catalog().then((r) => setBands(r.gradeBands));
  }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createProfile(name.trim(), avatar, band || undefined);
      onCreated();
    } finally {
      setBusy(false);
    }
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
  const [catalog, setCatalog] = useState<FactSet[] | null>(null);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getFactSets(profile.id).then((r) => {
      setCatalog(r.catalog);
      setEnabled(new Set(r.enabledIds));
    });
  }, [profile.id]);

  function toggle(id: string) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      await api.setFactSets(profile.id, [...enabled]);
      onClose();
    } finally {
      setBusy(false);
    }
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
