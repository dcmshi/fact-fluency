import { useState } from 'react';
import { ApiError } from '../../api';
import { useAuth } from '../../auth';
import { Modal } from '../../components/Modal';
import { AUTH_ERROR_MESSAGES } from '../../messages';

const MESSAGES: Record<string, string> = {
  ...AUTH_ERROR_MESSAGES,
  email_taken: 'That email already has an account — try a different one.',
  not_a_guest: 'This account is already saved.',
};

/** Turn a guest into a real account in place (keeps their progress). */
export function UpgradeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
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
      setError(MESSAGES[code] ?? 'Could not save. Try again.');
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
