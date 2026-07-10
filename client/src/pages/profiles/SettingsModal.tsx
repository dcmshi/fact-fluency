import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Profile, ProfileSettings } from '@shared';
import { api, ApiError, qk } from '../../api';
import { AvatarPicker } from '../../components/AvatarPicker';
import { Modal } from '../../components/Modal';
import { EDIT_ERROR_MESSAGES, FALLBACK_MESSAGE } from '../../messages';

type NumericKey = Exclude<keyof ProfileSettings, 'comparisons'>;

/** Labels/hints for the numeric session settings. The inclusive bounds come
 *  from /catalog (the server's own validation limits), so the form can't
 *  drift from what the server accepts; these are the offline fallback. */
const SETTING_FIELDS: { key: NumericKey; label: string; hint: string }[] = [
  {
    key: 'sessionCards',
    label: 'Cards per session',
    hint: 'How many questions a session aims for.',
  },
  {
    key: 'sessionSeconds',
    label: 'Session length (seconds)',
    hint: 'Target time budget for a session.',
  },
  {
    key: 'newPerSession',
    label: 'New facts per session',
    hint: 'How many fresh facts trickle in each time.',
  },
];

const FALLBACK_BOUNDS: Record<NumericKey, [number, number]> = {
  sessionCards: [5, 50],
  sessionSeconds: [30, 600],
  newPerSession: [0, 10],
};

export function SettingsModal({
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

  const { data: bounds = FALLBACK_BOUNDS } = useQuery({
    queryKey: qk.catalog,
    queryFn: () => api.catalog(),
    staleTime: Infinity, // the catalog is static
    select: (r) => r.settingBounds,
  });

  const outOfRange = SETTING_FIELDS.some(({ key }) => {
    const [min, max] = bounds[key];
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
      setError(EDIT_ERROR_MESSAGES[e instanceof ApiError ? e.code : ''] ?? FALLBACK_MESSAGE),
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
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </div>
      {SETTING_FIELDS.map(({ key, label, hint }) => {
        const [min, max] = bounds[key];
        return (
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
        );
      })}
      <div className="field">
        <label className="toggle-row" htmlFor="set-comparisons">
          <input
            id="set-comparisons"
            type="checkbox"
            checked={values.comparisons !== false}
            onChange={(e) => setValues((v) => ({ ...v, comparisons: e.target.checked }))}
          />
          Include “smaller / bigger” rounds
        </label>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          Off = every round asks for “the same as” — good for younger kids (K–1 starts this way).
        </span>
      </div>
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
