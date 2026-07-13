import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api';
import { useAuth } from '../../auth';
import { Modal } from '../../components/Modal';
import { upgradeErrorText } from '../../errors';

/** Turn a guest into a real account in place (keeps their progress). */
export function UpgradeModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
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
      setError(upgradeErrorText(t, err instanceof ApiError ? err.code : 'unknown'));
      setBusy(false);
    }
  }

  return (
    <Modal title={t('modals.upgradeTitle')} onClose={onClose}>
      <p className="muted" style={{ marginTop: '-0.3rem' }}>
        {t('modals.upgradeSub')}
      </p>
      <form className="stack" onSubmit={save} style={{ gap: '0.9rem' }}>
        {error && <div className="error-banner">{error}</div>}
        <div className="field">
          <label htmlFor="up-email">{t('landing.email')}</label>
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
          <label htmlFor="up-password">{t('landing.password')}</label>
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
          {busy ? t('common.saving') : t('landing.createBtn')}
        </button>
      </form>
    </Modal>
  );
}
