/**
 * Typed API client. All calls go to the same-origin /api (Vite proxies to the
 * server in dev) and include cookies for the adult session.
 */
import type {
  AnswerRequest,
  AnswerResponse,
  DashboardView,
  FactSet,
  Profile,
  ProfileSettings,
  ProgressView,
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
  me: () => req<{ accountId: string }>('GET', '/auth/me'),
  signup: (email: string, password: string, timezone: string) =>
    req<{ accountId: string; email: string }>('POST', '/auth/signup', { email, password, timezone }),
  login: (email: string, password: string) =>
    req<{ accountId: string; email: string }>('POST', '/auth/login', { email, password }),
  logout: () => req<void>('POST', '/auth/logout'),

  // profiles
  listProfiles: () => req<{ profiles: Profile[] }>('GET', '/profiles'),
  createProfile: (displayName: string, avatar: string) =>
    req<{ profile: Profile }>('POST', '/profiles', { displayName, avatar }),
  updateSettings: (profileId: string, settings: Partial<ProfileSettings>) =>
    req<{ profile: Profile }>('PATCH', `/profiles/${profileId}`, { settings }),
  getFactSets: (profileId: string) =>
    req<{ catalog: FactSet[]; enabledIds: string[] }>('GET', `/profiles/${profileId}/factsets`),
  setFactSets: (profileId: string, enabledIds: string[]) =>
    req<{ enabledIds: string[] }>('PUT', `/profiles/${profileId}/factsets`, { enabledIds }),

  // session loop
  startSession: (profileId: string) =>
    req<SessionResponse>('POST', `/profiles/${profileId}/session`),
  answer: (sessionId: string, body: AnswerRequest) =>
    req<AnswerResponse>('POST', `/sessions/${sessionId}/answer`, body),
  complete: (sessionId: string) =>
    req<SessionSummary>('POST', `/sessions/${sessionId}/complete`),

  // progress
  progress: (profileId: string) => req<ProgressView>('GET', `/profiles/${profileId}/progress`),
  dashboard: (profileId: string) => req<DashboardView>('GET', `/profiles/${profileId}/dashboard`),
};
