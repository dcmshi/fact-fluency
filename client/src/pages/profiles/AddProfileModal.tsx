import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qk } from '../../api';
import { AvatarPicker } from '../../components/AvatarPicker';
import { Modal } from '../../components/Modal';
import { editErrorText } from '../../errors';
import { AVATARS } from '../../ops';

export function AddProfileModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
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
    onError: (e) => setError(editErrorText(t, e instanceof ApiError ? e.code : '')),
  });
  const busy = createMut.isPending;

  function create() {
    if (!name.trim()) return;
    setError(null);
    createMut.mutate();
  }

  return (
    <Modal onClose={onClose} title={t('modals.addTitle')}>
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label htmlFor="kid-name">{t('modals.name')}</label>
        <input id="kid-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label>{t('modals.pickBuddy')}</label>
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </div>
      <div className="field">
        <label>{t('modals.startingLevel')}</label>
        <div className="band-picker">
          <button
            className={`set-pill ${band === '' ? 'on' : ''}`}
            onClick={() => setBand('')}
            aria-pressed={band === ''}
          >
            {t('modals.starterMix')}
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
          {t('modals.startingHint')}
        </span>
      </div>
      <button className="btn sun full" disabled={busy || !name.trim()} onClick={create}>
        {busy ? t('modals.creating') : t('modals.createProfile')}
      </button>
    </Modal>
  );
}
