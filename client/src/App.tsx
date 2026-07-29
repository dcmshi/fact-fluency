import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthPage } from './pages/AuthPage';
import { flushAll } from './syncQueue';

// Code-split the post-login pages so the logged-out entry (auth) ships a small
// bundle; the heavier play/progress/profile screens load on demand.
const ProfilesPage = lazy(() =>
  import('./pages/ProfilesPage').then((m) => ({ default: m.ProfilesPage })),
);
const PlayPage = lazy(() => import('./pages/PlayPage').then((m) => ({ default: m.PlayPage })));
const CalibratePage = lazy(() =>
  import('./pages/CalibratePage').then((m) => ({ default: m.CalibratePage })),
);
const RacePage = lazy(() => import('./pages/RacePage').then((m) => ({ default: m.RacePage })));
const FeastPage = lazy(() => import('./pages/FeastPage').then((m) => ({ default: m.FeastPage })));
const ProgressPage = lazy(() =>
  import('./pages/ProgressPage').then((m) => ({ default: m.ProgressPage })),
);
// Public methodology page — available logged-out or in; lazy so it stays out of
// the auth entry bundle.
const HowItWorksPage = lazy(() =>
  import('./pages/HowItWorksPage').then((m) => ({ default: m.HowItWorksPage })),
);

function LoadingScreen() {
  const { t } = useTranslation();
  return (
    <div className="screen center-y">
      <p className="muted">{t('common.loading')}</p>
    </div>
  );
}

/** Offline banner + flush of any queued reports when connectivity returns. */
function NetworkStatus() {
  const { t } = useTranslation();
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const goOnline = () => {
      setOffline(false);
      void flushAll();
    };
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    void flushAll(); // drain anything left from a previous visit
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="offline-banner" role="status">
      {t('common.offline')}
    </div>
  );
}

function AppRoutes() {
  const { accountId, loading } = useAuth();

  if (loading) return <LoadingScreen />;

  // Logged out (incl. before a guest session is minted): the auth page handles
  // every path. It can navigate to /play/:id after "Play for fun" — once the
  // guest account lands, accountId flips and the routes below take over.
  if (!accountId) {
    return (
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route path="/how-it-works" element={<HowItWorksPage />} />
          <Route path="*" element={<AuthPage />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/" element={<ProfilesPage />} />
        <Route path="/how-it-works" element={<HowItWorksPage />} />
        <Route path="/calibrate/:profileId" element={<CalibratePage />} />
        <Route path="/race/:profileId" element={<RacePage />} />
        <Route path="/feast/:profileId" element={<FeastPage />} />
        <Route path="/play/:profileId" element={<PlayPage />} />
        <Route path="/progress/:profileId" element={<ProgressPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <NetworkStatus />
        <AppRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
