import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ApiError } from './api';
import { AuthProvider } from './auth';
// Self-hosted fonts (no third-party CDN) — Fredoka (display) + Nunito (body).
import '@fontsource/fredoka/400.css';
import '@fontsource/fredoka/500.css';
import '@fontsource/fredoka/600.css';
import '@fontsource/fredoka/700.css';
import '@fontsource/nunito/400.css';
import '@fontsource/nunito/600.css';
import '@fontsource/nunito/700.css';
import '@fontsource/nunito/700-italic.css';
import '@fontsource/nunito/800.css';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Server state changes rarely between views; serve cached data while a
      // background refetch runs.
      staleTime: 30_000,
      // Don't hammer the server on a client error (a 401 just means "logged
      // out", a 404 "not yours") — only retry transient 5xx/network faults.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Register the app-shell service worker in production builds only (the Vite dev
// server handles its own HMR and a SW would interfere).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is best-effort */
    });
  });
}
