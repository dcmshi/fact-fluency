import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { useAuth } from './auth';
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
const ProgressPage = lazy(() =>
  import('./pages/ProgressPage').then((m) => ({ default: m.ProgressPage })),
);

function LoadingScreen() {
  return (
    <div className="screen center-y">
      <p className="muted">Loading…</p>
    </div>
  );
}

/** Offline banner + flush of any queued reports when connectivity returns. */
function NetworkStatus() {
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
      📡 Offline — your progress is saved and syncs when you reconnect.
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
      <Routes>
        <Route path="*" element={<AuthPage />} />
      </Routes>
    );
  }

  return (
    <Suspense fallback={<LoadingScreen />}>
      <Routes>
        <Route path="/" element={<ProfilesPage />} />
        <Route path="/calibrate/:profileId" element={<CalibratePage />} />
        <Route path="/race/:profileId" element={<RacePage />} />
        <Route path="/play/:profileId" element={<PlayPage />} />
        <Route path="/progress/:profileId" element={<ProgressPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <NetworkStatus />
      <AppRoutes />
    </BrowserRouter>
  );
}
