import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qk } from './api';

interface AuthState {
  accountId: string | null;
  /** True while signed in as an anonymous "play for fun" guest. */
  guest: boolean;
  loading: boolean;
  signup: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  /** Start an anonymous "play for fun" session; resolves to the guest profile id. */
  playAsGuest: () => Promise<string>;
  /** Attach real credentials to the current guest account (keeps its progress). */
  upgradeGuest: (email: string, password: string) => Promise<void>;
  /** Permanently delete the account and all its data (right-to-erasure). */
  deleteAccount: (currentPassword?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/** Cached current session: the account id + whether it's still a guest. */
interface Me {
  accountId: string;
  guest: boolean;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // The session probe. A 401 is the normal "not logged in" path, so we swallow
  // it to `null` rather than letting it surface as an error (and retry: false
  // keeps it from re-firing — see main.tsx for the global 4xx rule).
  const { data: me = null, isLoading } = useQuery<Me | null>({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
  const accountId = me?.accountId ?? null;
  const guest = me?.guest ?? false;

  const signupMut = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      return api.signup(email, password, tz);
    },
    onSuccess: (r) => queryClient.setQueryData<Me>(qk.me, { accountId: r.accountId, guest: false }),
  });

  const loginMut = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      api.login(email, password),
    onSuccess: (r) => queryClient.setQueryData<Me>(qk.me, { accountId: r.accountId, guest: false }),
  });

  const guestMut = useMutation({
    mutationFn: () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      return api.guest(tz);
    },
    onSuccess: (r) => queryClient.setQueryData<Me>(qk.me, { accountId: r.accountId, guest: true }),
  });

  const upgradeMut = useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      api.upgrade(email, password),
    onSuccess: (r) => queryClient.setQueryData<Me>(qk.me, { accountId: r.accountId, guest: false }),
  });

  const logoutMut = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      // Drop every cached query so the next adult can't see the prior one's
      // profiles/progress, then mark logged out.
      queryClient.clear();
      queryClient.setQueryData(qk.me, null);
    },
  });

  const deleteAccountMut = useMutation({
    mutationFn: (currentPassword?: string) => api.deleteAccount(currentPassword),
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(qk.me, null);
    },
  });

  const value = useMemo<AuthState>(
    () => ({
      accountId,
      guest,
      loading: isLoading,
      signup: async (email, password) => {
        await signupMut.mutateAsync({ email, password });
      },
      login: async (email, password) => {
        await loginMut.mutateAsync({ email, password });
      },
      playAsGuest: async () => {
        const r = await guestMut.mutateAsync();
        return r.profileId;
      },
      upgradeGuest: async (email, password) => {
        await upgradeMut.mutateAsync({ email, password });
      },
      deleteAccount: async (currentPassword?: string) => {
        await deleteAccountMut.mutateAsync(currentPassword);
      },
      logout: async () => {
        await logoutMut.mutateAsync();
      },
    }),
    [
      accountId,
      guest,
      isLoading,
      signupMut,
      loginMut,
      guestMut,
      upgradeMut,
      deleteAccountMut,
      logoutMut,
    ],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
