import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FactSet, Profile } from '@shared';
import { api } from '../api';
import { useAuth } from '../auth';
import { AVATARS, OP_LABEL, OP_SYMBOL } from '../ops';
import './ProfilesPage.css';

export function ProfilesPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Profile | null>(null);

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

        {!profiles && <p className="muted">Loading…</p>}

        <div className="profile-grid">
          {profiles?.map((p, i) => (
            <div className="profile-tile rise" key={p.id} style={{ animationDelay: `${i * 0.06}s` }}>
              <div className="avatar">{p.avatar}</div>
              <div className="profile-name">{p.displayName}</div>
              <button className="btn sun full" onClick={() => navigate(`/play/${p.id}`)}>
                Play ▶
              </button>
              <div className="tile-actions">
                <button className="btn ghost" onClick={() => navigate(`/progress/${p.id}`)}>
                  Progress
                </button>
                <button className="btn ghost" onClick={() => setManaging(p)}>
                  Facts
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
    </div>
  );
}

function AddProfileModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createProfile(name.trim(), avatar);
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
            {OP_LABEL[op as keyof typeof OP_LABEL]} <span className="op-sym">{OP_SYMBOL[op as keyof typeof OP_SYMBOL]}</span>
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
