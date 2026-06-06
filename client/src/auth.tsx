import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';

interface AuthState {
  accountId: string | null;
  loading: boolean;
  signup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Cache key for the current adult session. */
export const ME_KEY = ['me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // The session probe. A 401 is the normal "not logged in" path, so we swallow
  // it to `null` rather than letting it surface as an error (and retry: false
  // keeps it from re-firing — see main.tsx for the global 4xx rule).
  const { data: accountId = null, isLoading } = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return (await api.me()).accountId;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });

  const signupMut = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      return api.signup(email, password, tz);
    },
    onSuccess: (r) => queryClient.setQueryData(ME_KEY, r.accountId),
  });

  const loginMut = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      api.login(email, password),
    onSuccess: (r) => queryClient.setQueryData(ME_KEY, r.accountId),
  });

  const logoutMut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      // Drop every cached query so the next adult can't see the prior one's
      // profiles/progress, then mark logged out.
      queryClient.clear();
      queryClient.setQueryData(ME_KEY, null);
    },
  });

  const value = useMemo<AuthState>(
    () => ({
      accountId,
      loading: isLoading,
      signup: async (email, password) => {
        await signupMut.mutateAsync({ email, password });
      },
      login: async (email, password) => {
        await loginMut.mutateAsync({ email, password });
      },
      logout: async () => {
        await logoutMut.mutateAsync();
      },
    }),
    [accountId, isLoading, signupMut, loginMut, logoutMut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
