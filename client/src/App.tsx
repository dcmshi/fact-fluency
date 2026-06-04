import { Navigate, Route, BrowserRouter, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AuthPage } from './pages/AuthPage';
import { PlayPage } from './pages/PlayPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { ProgressPage } from './pages/ProgressPage';

export function App() {
  const { accountId, loading } = useAuth();

  if (loading) {
    return (
      <div className="screen center-y">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!accountId) return <AuthPage />;

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ProfilesPage />} />
        <Route path="/play/:profileId" element={<PlayPage />} />
        <Route path="/progress/:profileId" element={<ProgressPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
