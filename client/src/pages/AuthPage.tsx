import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { useAuth } from '../auth';
import { LanguageSwitcher } from '../components/LanguageSwitcher';

export function AuthPage() {
  const { t } = useTranslation();
  const { signup, login, playAsGuest } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guestBusy, setGuestBusy] = useState(false);

  function errorText(code: string): string {
    switch (code) {
      case 'invalid_email':
        return t('errors.invalidEmail');
      case 'weak_password':
        return t('errors.weakPassword');
      case 'email_taken':
        return t('errors.emailTaken');
      case 'invalid_credentials':
        return t('errors.invalidCredentials');
      default:
        return t('errors.generic');
    }
  }

  // Two-way scroll between the play hero and the info panel. Honor
  // prefers-reduced-motion: jump instantly rather than animate the scroll.
  const heroRef = useRef<HTMLElement>(null);
  const infoRef = useRef<HTMLElement>(null);
  const scrollToSection = (el: HTMLElement | null) => {
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };

  // Hide the hero's "Learn more" cue once the info panel scrolls into view, so
  // it doesn't linger beside the "Play Fact Fluency" cue (both fit on screen at
  // once on a short page, which reads as confusing).
  const [infoVisible, setInfoVisible] = useState(false);
  useEffect(() => {
    const el = infoRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInfoVisible(entry.isIntersecting), {
      rootMargin: '0px 0px -20% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signup') await signup(email, password);
      else await login(email, password);
    } catch (err) {
      setError(errorText(err instanceof ApiError ? err.code : 'unknown'));
    } finally {
      setBusy(false);
    }
  }

  async function playGuest() {
    setError(null);
    setGuestBusy(true);
    try {
      const profileId = await playAsGuest();
      navigate(`/calibrate/${profileId}`);
    } catch {
      setError(t('errors.guestGame'));
      setGuestBusy(false);
    }
  }

  return (
    <div className="screen auth">
      <section className="auth-hero" ref={heroRef}>
        <div className="auth-hero-body">
          <div className="stack rise">
            <div style={{ alignSelf: 'flex-end' }}>
              <LanguageSwitcher />
            </div>
            {/* The site's <h1>: the landing page is the only public route, so this
            is what search engines index. Keep it in sync with index.html. */}
            <h1 className="brand" style={{ justifyContent: 'center', fontSize: '1.7rem' }}>
              <span className="glyph" aria-hidden="true">
                ✦
              </span>
              Fact Fluency
            </h1>
            <p className="muted" style={{ textAlign: 'center', marginTop: '-0.4rem' }}>
              {t('landing.tagline')}
            </p>
            <p className="hero-more">
              <Link to="/how-it-works">{t('landing.howItWorks')} →</Link>
            </p>

            <button
              type="button"
              className="btn sun full"
              onClick={playGuest}
              disabled={guestBusy}
              style={{ fontSize: '1.05rem' }}
            >
              {guestBusy ? t('landing.starting') : t('landing.playForFun')}
            </button>
            <p
              className="muted"
              style={{ textAlign: 'center', fontSize: '0.8rem', marginTop: '-0.6rem' }}
            >
              {t('landing.noAccount')}
            </p>

            <div className="muted" style={{ textAlign: 'center', fontSize: '0.85rem' }}>
              {t('landing.orSignIn')}
            </div>

            <form className="card stack" onSubmit={submit} style={{ gap: '1rem' }}>
              <h2>{mode === 'signup' ? t('landing.createAccount') : t('landing.welcomeBack')}</h2>

              {error && <div className="error-banner">{error}</div>}

              <div className="field">
                <label htmlFor="email">{t('landing.email')}</label>
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
                <label htmlFor="password">{t('landing.password')}</label>
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
                {busy
                  ? t('landing.oneSec')
                  : mode === 'signup'
                    ? t('landing.createBtn')
                    : t('landing.logInBtn')}
              </button>

              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setMode(mode === 'signup' ? 'login' : 'signup');
                  setError(null);
                }}
              >
                {mode === 'signup' ? t('landing.haveAccount') : t('landing.newHere')}
              </button>
            </form>
          </div>
        </div>

        <button
          type="button"
          className={`scroll-cue${infoVisible ? ' scroll-cue--hidden' : ''}`}
          data-dir="down"
          onClick={() => scrollToSection(infoRef.current)}
        >
          {t('landing.learnMore')}
          <span className="cue-arrow" aria-hidden="true">
            ↓
          </span>
        </button>
      </section>

      {/* Crawlable landing content — the only public page is this one, so this
          section is what gives search engines something real to rank. Plain
          semantic HTML, below the fold, honest copy (no keyword stuffing). */}
      <section className="landing-info" id="learn-more" ref={infoRef}>
        <button
          type="button"
          className="scroll-cue"
          data-dir="up"
          onClick={() => scrollToSection(heroRef.current)}
        >
          <span className="cue-arrow" aria-hidden="true">
            ↑
          </span>
          {t('landing.playCta')}
        </button>
        <h2>{t('landing.infoTitle')}</h2>
        <p>{t('landing.infoBody')}</p>

        <h2>{t('landing.builtTitle')}</h2>
        <p>{t('landing.builtBody')}</p>

        <h2>{t('landing.familiesTitle')}</h2>
        <ul>
          <li>{t('landing.family1')}</li>
          <li>{t('landing.family2')}</li>
          <li>{t('landing.family3')}</li>
          <li>{t('landing.family4')}</li>
        </ul>

        <div className="landing-more">
          <Link to="/how-it-works" className="btn ghost">
            {t('landing.howItWorks')} →
          </Link>
        </div>
      </section>
    </div>
  );
}
