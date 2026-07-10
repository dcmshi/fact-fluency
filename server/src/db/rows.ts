/**
 * Row shapes (snake_case, as both drivers return them) and row→domain mappers,
 * shared by the SQLite and Postgres adapters — they were duplicated verbatim
 * and had already drifted. Numeric columns pass through `Number()` where a
 * driver may hand back strings (pg BIGINT) — harmless for SQLite's numbers.
 */
import type { FactProgress, Operation, OperationStat, Profile, ProfileSettings } from '@shared';
import type { AttemptRecord, SessionRecord } from './index';

export interface ProfileRow {
  id: string;
  account_id: string;
  display_name: string;
  avatar: string;
  settings: string;
  streak: number;
  coins: number;
  theme: string;
  created_at: number;
}

export interface ProgressRow {
  profile_id: string;
  fact_id: string;
  box: number;
  state: string;
  due_at: number;
  last_seen_at: number;
  reps: number;
  fast_correct: number;
  correct_streak: number;
  accuracy_ewma: number;
  median_ms_ewma: number;
}

export interface OperationStatRow {
  profile_id: string;
  operation: string;
  median_ms_ewma: number;
  correct_samples: number;
}

export interface SessionRow {
  id: string;
  profile_id: string;
  started_at: number;
  completed_at: number | null;
  planned_count: number;
  working_state: string;
}

export interface AttemptRow {
  id: string;
  session_id: string;
  profile_id: string;
  fact_id: string;
  given: number;
  correct: number;
  fast: number;
  response_ms: number;
  answered_at: number;
}

/** Profile columns joined with the (optional) reward row, defaulted. */
export const PROFILE_SELECT = `
  SELECT p.id, p.account_id, p.display_name, p.avatar, p.settings, p.streak,
         p.created_at, COALESCE(r.coins, 0) AS coins,
         COALESCE(r.theme, 'classic') AS theme
  FROM profile p LEFT JOIN profile_reward r ON r.profile_id = p.id`;

export function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    accountId: r.account_id,
    displayName: r.display_name,
    avatar: r.avatar,
    settings: JSON.parse(r.settings) as ProfileSettings,
    streak: r.streak,
    coins: Number(r.coins),
    theme: r.theme,
    createdAt: Number(r.created_at),
  };
}

export function toProgress(r: ProgressRow): FactProgress {
  return {
    profileId: r.profile_id,
    factId: r.fact_id,
    box: r.box as FactProgress['box'],
    state: r.state as FactProgress['state'],
    dueAt: Number(r.due_at),
    lastSeenAt: Number(r.last_seen_at),
    reps: r.reps,
    fastCorrect: r.fast_correct,
    correctStreak: r.correct_streak,
    accuracyEwma: r.accuracy_ewma,
    medianMsEwma: r.median_ms_ewma,
  };
}

export function toOperationStat(r: OperationStatRow): OperationStat {
  return {
    profileId: r.profile_id,
    operation: r.operation as Operation,
    medianMsEwma: r.median_ms_ewma,
    correctSamples: r.correct_samples,
  };
}

export function toSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    profileId: r.profile_id,
    startedAt: Number(r.started_at),
    completedAt: r.completed_at === null ? null : Number(r.completed_at),
    plannedCount: r.planned_count,
    workingState: r.working_state,
  };
}

export function toAttempt(r: AttemptRow): AttemptRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    profileId: r.profile_id,
    factId: r.fact_id,
    given: r.given,
    correct: !!r.correct,
    fast: !!r.fast,
    responseMs: r.response_ms,
    answeredAt: Number(r.answered_at),
  };
}
