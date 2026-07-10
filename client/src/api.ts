/**
 * Typed API client. All calls go to the same-origin /api (Vite proxies to the
 * server in dev) and include cookies for the adult session.
 */
import type {
  AnswerRequest,
  AnswerResponse,
  DashboardView,
  FactSet,
  GradeBand,
  Profile,
  ProfileSettings,
  ProgressView,
  RewardsView,
  SessionResponse,
  SessionSummary,
} from '@shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `http_${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // auth
  me: () => req<{ accountId: string; guest: boolean }>('GET', '/auth/me'),
  signup: (email: string, password: string, timezone: string) =>
    req<{ accountId: string; email: string }>('POST', '/auth/signup', {
      email,
      password,
      timezone,
    }),
  login: (email: string, password: string) =>
    req<{ accountId: string; email: string }>('POST', '/auth/login', { email, password }),
  guest: (timezone: string) =>
    req<{ accountId: string; profileId: string; guest: true }>('POST', '/auth/guest', { timezone }),
  upgrade: (email: string, password: string) =>
    req<{ accountId: string; email: string }>('POST', '/auth/upgrade', { email, password }),
  account: () => req<{ email: string; timezone: string }>('GET', '/auth/account'),
  updateAccount: (fields: { email?: string; password?: string; timezone?: string }) =>
    req<{ email: string; timezone: string }>('PATCH', '/auth/account', fields),
  deleteAccount: () => req<void>('DELETE', '/auth/account'),
  logout: () => req<void>('POST', '/auth/logout'),

  // catalog (public)
  catalog: () =>
    req<{
      sets: FactSet[];
      gradeBands: GradeBand[];
      /** Inclusive [min, max] per editable profile setting — the server's own
       *  validation bounds, so the settings form can't drift from them. */
      settingBounds: Record<keyof ProfileSettings, [number, number]>;
    }>('GET', '/catalog'),

  // profiles
  listProfiles: () => req<{ profiles: Profile[] }>('GET', '/profiles'),
  createProfile: (displayName: string, avatar: string, gradeBand?: string) =>
    req<{ profile: Profile }>('POST', '/profiles', { displayName, avatar, gradeBand }),
  updateProfile: (
    profileId: string,
    fields: { displayName?: string; avatar?: string; settings?: Partial<ProfileSettings> },
  ) => req<{ profile: Profile }>('PATCH', `/profiles/${profileId}`, fields),
  deleteProfile: (profileId: string) => req<void>('DELETE', `/profiles/${profileId}`),
  getFactSets: (profileId: string) =>
    req<{ catalog: FactSet[]; enabledIds: string[] }>('GET', `/profiles/${profileId}/factsets`),
  setFactSets: (profileId: string, enabledIds: string[]) =>
    req<{ enabledIds: string[] }>('PUT', `/profiles/${profileId}/factsets`, { enabledIds }),

  // session loop
  startSession: (profileId: string) =>
    req<SessionResponse>('POST', `/profiles/${profileId}/session`),
  answer: (sessionId: string, body: AnswerRequest) =>
    req<AnswerResponse>('POST', `/sessions/${sessionId}/answer`, body),
  complete: (sessionId: string) => req<SessionSummary>('POST', `/sessions/${sessionId}/complete`),

  // progress
  progress: (profileId: string) => req<ProgressView>('GET', `/profiles/${profileId}/progress`),
  dashboard: (profileId: string) => req<DashboardView>('GET', `/profiles/${profileId}/dashboard`),

  // rewards
  rewards: (profileId: string) => req<RewardsView>('GET', `/profiles/${profileId}/rewards`),
  // (qk below: shared React Query cache keys.)
  unlockReward: (profileId: string, itemId: string) =>
    req<{ coins: number; owned: string[] }>('POST', `/profiles/${profileId}/rewards/unlock`, {
      itemId,
    }),
  equipReward: (profileId: string, itemId: string) =>
    req<{
      equippedAvatar: string;
      equippedTheme: string;
      equippedMuncher: string;
      equippedEffect: string;
    }>('POST', `/profiles/${profileId}/rewards/equip`, { itemId }),
};

/** Shared React Query cache keys, so reads and the mutations that invalidate
 *  them never drift apart. */
export const qk = {
  me: ['me'] as const,
  account: ['account'] as const,
  profiles: ['profiles'] as const,
  catalog: ['catalog'] as const,
  rewards: (profileId: string) => ['rewards', profileId] as const,
  factSets: (profileId: string) => ['factsets', profileId] as const,
  progress: (profileId: string) => ['progress', profileId] as const,
  dashboard: (profileId: string) => ['dashboard', profileId] as const,
};
