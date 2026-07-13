import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { AUTH_ERROR_MESSAGES } from '../messages';

const MESSAGES: Record<string, string> = {
  ...AUTH_ERROR_MESSAGES,
  email_taken: 'That email already has an account — try logging in.',
  invalid_credentials: 'Email or password is incorrect.',
};

export function AuthPage() {
  const { signup, login, playAsGuest } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guestBusy, setGuestBusy] = useState(false);

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

  async function playGuest() {
    setError(null);
    setGuestBusy(true);
    try {
      const profileId = await playAsGuest();
      navigate(`/play/${profileId}`);
    } catch {
      setError('Could not start a guest game. Try again.');
      setGuestBusy(false);
    }
  }

  return (
    <div className="screen center-y">
      <div className="stack rise">
        {/* The site's <h1>: the landing page is the only public route, so this
            is what search engines index. Keep it in sync with index.html. */}
        <h1 className="brand" style={{ justifyContent: 'center', fontSize: '1.7rem' }}>
          <span className="glyph" aria-hidden="true">
            ✦
          </span>
          Fact Fluency
        </h1>
        <p className="muted" style={{ textAlign: 'center', marginTop: '-0.4rem' }}>
          A free math facts practice game for kids — the fun way to master addition, subtraction,
          multiplication, and division.
        </p>

        <button
          type="button"
          className="btn sun full"
          onClick={playGuest}
          disabled={guestBusy}
          style={{ fontSize: '1.05rem' }}
        >
          {guestBusy ? 'Starting…' : '▶ Play for fun'}
        </button>
        <p
          className="muted"
          style={{ textAlign: 'center', fontSize: '0.8rem', marginTop: '-0.6rem' }}
        >
          No account needed — progress stays on this device.
        </p>

        <div className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>
          or sign in to save progress
        </div>

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

        {/* Crawlable landing content — the only public page is this one, so
            this section is what gives search engines something real to rank.
            Plain semantic HTML, below the fold, honest copy (no keyword
            stuffing). */}
        <section className="landing-info">
          <div className="landing-info__label">Learn more ↓</div>
          <h2>What is Fact Fluency?</h2>
          <p>
            Fact Fluency helps kids build real automaticity with their math facts — addition,
            subtraction, multiplication, and division (including times tables up to 12) — through
            short, game-like practice sessions. Each round plays like the classic Number Munchers:
            steer a cute muncher around a grid and eat every number that matches the fact.
          </p>

          <h2>Built on spaced repetition</h2>
          <p>
            Behind the game is a spaced-repetition engine: facts a child knows come back less often,
            tricky ones come back sooner, and a fact only counts as mastered when it&rsquo;s
            answered both correctly <em>and</em> quickly — true fluency, not just accuracy. New
            facts trickle in a few at a time, and sessions stay around three minutes so practice
            never turns into a grind.
          </p>

          <h2>Made for families</h2>
          <ul>
            <li>One grown-up account, a profile for each kid — kids just tap and play.</li>
            <li>A parent dashboard with accuracy trends, trickiest facts, and weekly recaps.</li>
            <li>Coins, unlockable characters, themes, and streaks keep motivation up.</li>
            <li>Free to use, no ads — and you can try it instantly without an account.</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
