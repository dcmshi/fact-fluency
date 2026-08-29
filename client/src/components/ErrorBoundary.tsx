import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Last line of defence for the whole tree.
 *
 * The real-world case this exists for: every post-login page is a `lazy()`
 * chunk, and the service worker's activate handler deletes the previous build's
 * cache. A kid sitting on the profiles screen across a deploy taps "Play", the
 * old hashed chunk 404s, the lazy promise rejects, and React unmounts the root
 * — a blank white screen, with a manual reload the only way out (and no kid
 * knows to do that). A chunk failure is exactly the error a reload fixes, so we
 * reload once automatically and only show the card if that didn't help.
 */
const RELOAD_AT_KEY = 'ff_chunk_reload_at';
/** Long enough that a reload loop can't form; short enough that the *next*
 *  deploy can auto-recover too. */
const RELOAD_COOLDOWN_MS = 10_000;

export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ChunkLoadError|dynamically imported module|module script failed|Loading chunk/i.test(
    text,
  );
}

/** sessionStorage throws in some privacy modes — never let that mask the error
 *  we're already handling. */
function lastReloadAt(): number {
  try {
    return Number(sessionStorage.getItem(RELOAD_AT_KEY) ?? 0);
  } catch {
    return Date.now(); // treat as "just reloaded": skip the auto-reload
  }
}
function markReloaded(): void {
  try {
    sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  } catch {
    // no storage, no loop protection — the cooldown check above already bailed
  }
}

function CrashScreen() {
  const { t } = useTranslation();
  return (
    <main className="screen center-y">
      <div className="stack rise" style={{ textAlign: 'center' }}>
        <div className="big-emoji" aria-hidden="true">
          🧩
        </div>
        <h1>{t('errors.crashTitle')}</h1>
        <p className="muted" style={{ marginTop: '-0.4rem' }}>
          {t('errors.crashHint')}
        </p>
        <button className="btn sun full" onClick={() => location.reload()}>
          {t('errors.reload')}
        </button>
      </div>
    </main>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error) && Date.now() - lastReloadAt() > RELOAD_COOLDOWN_MS) {
      markReloaded();
      location.reload();
    }
  }

  render() {
    return this.state.failed ? <CrashScreen /> : this.props.children;
  }
}
