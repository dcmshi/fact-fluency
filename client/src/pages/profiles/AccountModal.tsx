import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, qk } from '../../api';
import { useAuth } from '../../auth';
import { Modal } from '../../components/Modal';
import { accountErrorText } from '../../errors';

/** All IANA timezones, when the runtime exposes them (for the picker). */
const TIMEZONES: string[] = (() => {
  const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
})();

/** Parent account management: edit email / password / timezone, or delete. */
export function AccountModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { deleteAccount } = useAuth();
  const [email, setEmail] = useState('');
  const [timezone, setTimezone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const { data: account } = useQuery({ queryKey: qk.account, queryFn: () => api.account() });
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
      setError(accountErrorText(t, e instanceof ApiError ? e.code : ''));
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
    <Modal onClose={onClose} title={t('modals.accountTitle')}>
      <form className="stack" onSubmit={save} style={{ gap: '0.9rem' }}>
        {error && <div className="error-banner">{error}</div>}
        {saved && (
          <div className="muted" style={{ color: 'var(--add)' }}>
            {t('modals.saved')}
          </div>
        )}
        <div className="field">
          <label htmlFor="acct-email">{t('landing.email')}</label>
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
          <label htmlFor="acct-password">{t('modals.newPassword')}</label>
          <input
            id="acct-password"
            type="password"
            autoComplete="new-password"
            placeholder={t('modals.passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="acct-tz">{t('modals.timezone')}</label>
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
            {t('modals.timezoneHint')}
          </span>
        </div>
        <button className="btn sun full" type="submit" disabled={saveMut.isPending}>
          {saveMut.isPending ? t('common.saving') : t('modals.saveChanges')}
        </button>
      </form>

      <div className="danger-zone">
        {deleteMut.isError && <div className="error-banner">{t('errors.deleteFailed')}</div>}
        {!confirming ? (
          <button className="btn danger-link" onClick={() => setConfirming(true)}>
            {t('modals.deleteAccount')}
          </button>
        ) : (
          <div className="confirm-delete">
            <p className="muted">{t('modals.deleteAccountConfirm')}</p>
            <div className="confirm-actions">
              <button
                className="btn ghost"
                disabled={deleteMut.isPending}
                onClick={() => setConfirming(false)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn danger"
                disabled={deleteMut.isPending}
                onClick={() => deleteMut.mutate()}
              >
                {deleteMut.isPending ? t('modals.deleting') : t('modals.deleteEverything')}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
