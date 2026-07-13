import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Profile, ProfileSettings } from '@shared';
import { api, ApiError, qk } from '../../api';
import { AvatarPicker } from '../../components/AvatarPicker';
import { Modal } from '../../components/Modal';
import { editErrorText } from '../../errors';

type NumericKey = 'sessionCards' | 'sessionSeconds' | 'newPerSession';

/** The numeric session settings and their i18n label/hint keys. The inclusive
 *  bounds come from /catalog (the server's own validation limits), so the form
 *  can't drift from what the server accepts; these are the offline fallback. */
const SETTING_FIELDS = [
  {
    key: 'sessionCards',
    labelKey: 'modals.cardsPerSession',
    hintKey: 'modals.cardsPerSessionHint',
  },
  { key: 'sessionSeconds', labelKey: 'modals.sessionLength', hintKey: 'modals.sessionLengthHint' },
  { key: 'newPerSession', labelKey: 'modals.newPerSession', hintKey: 'modals.newPerSessionHint' },
] as const satisfies readonly { key: NumericKey; labelKey: string; hintKey: string }[];

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
  const { t } = useTranslation();
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
    onError: (e) => setError(editErrorText(t, e instanceof ApiError ? e.code : '')),
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
    <Modal
      onClose={onClose}
      title={t('modals.settingsTitle', { avatar: profile.avatar, name: profile.displayName })}
    >
      {error && <div className="error-banner">{error}</div>}
      <div className="field">
        <label htmlFor="edit-name">{t('modals.name')}</label>
        <input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>{t('modals.buddy')}</label>
        <AvatarPicker value={avatar} onChange={setAvatar} />
      </div>
      {SETTING_FIELDS.map(({ key, labelKey, hintKey }) => {
        const [min, max] = bounds[key];
        return (
          <div className="field" key={key}>
            <label htmlFor={`set-${key}`}>{t(labelKey)}</label>
            <input
              id={`set-${key}`}
              type="number"
              min={min}
              max={max}
              value={values[key]}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.valueAsNumber }))}
            />
            <span className="muted" style={{ fontSize: '0.85rem' }}>
              {t(hintKey)} ({min}–{max})
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
          {t('modals.comparisons')}
        </label>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {t('modals.comparisonsHint')}
        </span>
      </div>

      <div className="settings-heading">{t('modals.accessibility')}</div>
      <div className="field">
        <label className="toggle-row" htmlFor="set-easyread">
          <input
            id="set-easyread"
            type="checkbox"
            checked={values.easyReadFont === true}
            onChange={(e) => setValues((v) => ({ ...v, easyReadFont: e.target.checked }))}
          />
          {t('modals.easyRead')}
        </label>
      </div>
      <div className="field">
        <label className="toggle-row" htmlFor="set-contrast">
          <input
            id="set-contrast"
            type="checkbox"
            checked={values.highContrast === true}
            onChange={(e) => setValues((v) => ({ ...v, highContrast: e.target.checked }))}
          />
          {t('modals.highContrast')}
        </label>
      </div>
      <div className="field">
        <label className="toggle-row" htmlFor="set-calm">
          <input
            id="set-calm"
            type="checkbox"
            checked={values.calmMode === true}
            onChange={(e) => setValues((v) => ({ ...v, calmMode: e.target.checked }))}
          />
          {t('modals.calmMode')}
        </label>
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          {t('modals.calmModeHint')}
        </span>
      </div>

      <button className="btn sun full" disabled={busy || outOfRange || nameEmpty} onClick={save}>
        {saveMut.isPending ? t('common.saving') : t('common.save')}
      </button>

      <div className="danger-zone">
        {deleteMut.isError && <div className="error-banner">{t('errors.deleteFailed')}</div>}
        {!confirmingDelete ? (
          <button className="btn danger-link" onClick={() => setConfirmingDelete(true)}>
            {t('modals.deleteProfile', { name: profile.displayName })}
          </button>
        ) : (
          <div className="confirm-delete">
            <p className="muted">
              {t('modals.deleteProfileConfirm', { name: profile.displayName })}
            </p>
            <div className="confirm-actions">
              <button
                className="btn ghost"
                disabled={busy}
                onClick={() => setConfirmingDelete(false)}
              >
                {t('common.cancel')}
              </button>
              <button className="btn danger" disabled={busy} onClick={() => deleteMut.mutate()}>
                {deleteMut.isPending ? t('modals.deleting') : t('modals.deleteForever')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
