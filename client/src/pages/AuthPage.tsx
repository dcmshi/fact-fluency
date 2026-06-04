import { useState } from 'react';
import { ApiError } from '../api';
import { useAuth } from '../auth';

const MESSAGES: Record<string, string> = {
  invalid_email: 'That email doesn’t look right.',
  weak_password: 'Password needs at least 8 characters.',
  email_taken: 'That email already has an account — try logging in.',
  invalid_credentials: 'Email or password is incorrect.',
};

export function AuthPage() {
  const { signup, login } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') await signup(email, password);
      else await login(email, password);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'unknown';
      setError(MESSAGES[code] ?? 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen center-y">
      <div className="stack rise">
        <div className="brand" style={{ justifyContent: 'center', fontSize: '1.7rem' }}>
          <span className="glyph">✦</span> Fact Fluency
        </div>
        <p className="muted" style={{ textAlign: 'center', marginTop: '-0.4rem' }}>
          Grown-up sign in — kids play from your account.
        </p>

        <form className="card stack" onSubmit={submit} style={{ gap: '1rem' }}>
          <h2>{mode === 'signup' ? 'Create your account' : 'Welcome back'}</h2>

          {error && <div className="error-banner">{error}</div>}

          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          <button className="btn sun full" type="submit" disabled={busy}>
            {busy ? 'One sec…' : mode === 'signup' ? 'Create account' : 'Log in'}
          </button>

          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setMode(mode === 'signup' ? 'login' : 'signup');
              setError(null);
            }}
          >
            {mode === 'signup' ? 'I already have an account' : 'New here? Create an account'}
          </button>
        </form>
      </div>
    </div>
  );
}
