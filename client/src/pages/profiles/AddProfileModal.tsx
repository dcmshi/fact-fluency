import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qk } from '../../api';
import { AvatarPicker } from '../../components/AvatarPicker';
import { Modal } from '../../components/Modal';
import { EDIT_ERROR_MESSAGES, FALLBACK_MESSAGE } from '../../messages';
import { AVATARS } from '../../ops';

export function AddProfileModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(AVATARS[0]);
  const [band, setBand] = useState(''); // '' = starter mix (default sets)

  const { data: bands = [] } = useQuery({
    queryKey: qk.catalog,
    queryFn: () => api.catalog(),
    staleTime: Infinity, // the catalog is static
    select: (r) => r.gradeBands,
  });

  const [error, setError] = useState<string | null>(null);
  const createMut = useMutation({
    mutationFn: () => api.createProfile(name.trim(), avatar, band || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.profiles });
      onCreated();
    },
    onError: (e) =>
      setError(EDIT_ERROR_MESSAGES[e instanceof ApiError ? e.code : ''] ?? FALLBACK_MESSAGE),
  });
  const busy = createMut.isPending;

  function create() {
    if (!name.trim()) return;
    setError(null);
    createMut.mutate();
  }

  return (
    <Modal onClose={onClose} title="Add a kid">
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label htmlFor="kid-name">Name</label>
        <input id="kid-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>Pick a buddy</label>
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </div>
      <div className="field">
        <label>Starting level</label>
        <div className="band-picker">
          <button
            className={`set-pill ${band === '' ? 'on' : ''}`}
            onClick={() => setBand('')}
            aria-pressed={band === ''}
          >
            Starter mix
          </button>
          {bands.map((b) => (
            <button
              key={b.id}
              className={`set-pill ${band === b.id ? 'on' : ''}`}
              onClick={() => setBand(b.id)}
              aria-pressed={band === b.id}
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
