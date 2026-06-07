import { useEffect, useState } from 'react';
import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AuthPage } from './pages/AuthPage';
import { PlayPage } from './pages/PlayPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { ProgressPage } from './pages/ProgressPage';
import { flushAll } from './syncQueue';

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

  if (loading) {
    return (
      <div className="screen center-y">
        <p className="muted">Loading…</p>
      </div>
    );
  }

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
    <Routes>
      <Route path="/" element={<ProfilesPage />} />
      <Route path="/play/:profileId" element={<PlayPage />} />
      <Route path="/progress/:profileId" element={<ProgressPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
