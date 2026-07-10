import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, qk } from '../../api';
import { useAuth } from '../../auth';
import { Modal } from '../../components/Modal';
import { AUTH_ERROR_MESSAGES, FALLBACK_MESSAGE } from '../../messages';

/** All IANA timezones, when the runtime exposes them (for the picker). */
const TIMEZONES: string[] = (() => {
  const fn = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    return fn ? fn('timeZone') : [];
  } catch {
    return [];
  }
})();

const MESSAGES: Record<string, string> = {
  ...AUTH_ERROR_MESSAGES,
  invalid_timezone: 'Pick a valid timezone.',
};

/** Parent account management: edit email / password / timezone, or delete. */
export function AccountModal({ onClose }: { onClose: () => void }) {
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
      setError(MESSAGES[e instanceof ApiError ? e.code : ''] ?? FALLBACK_MESSAGE);
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
