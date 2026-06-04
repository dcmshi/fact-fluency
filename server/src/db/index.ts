/**
 * DB adapter seam — DESIGN.md §5.1. App logic talks to this interface only, so
 * SQLite ↔ Postgres is a single swap. The concrete adapter is chosen from
 * DATABASE_URL's scheme (sqlite: vs postgres://). Implementations land with the
 * persistence work; this file pins the contract.
 */
import type { FactProgress, Operation, OperationStat, Profile } from '@shared';
import { PostgresDb } from './postgres';
import { SqliteDb } from './sqlite';

/** A play session row (DESIGN.md §4.9). `workingState` is opaque JSON. */
export interface SessionRecord {
  id: string;
  profileId: string;
  startedAt: number;
  completedAt: number | null;
  plannedCount: number;
  workingState: string;
}

/** An append-only attempt log row (DESIGN.md §6). */
export interface AttemptRecord {
  id: string;
  sessionId: string;
  profileId: string;
  factId: string;
  given: number;
  correct: boolean;
  fast: boolean;
  responseMs: number;
  answeredAt: number;
}

export interface Db {
  /** Apply the schema (idempotent). SQLite does this in its constructor too. */
  migrate(): Promise<void>;

  // --- accounts & auth ---
  createAccount(email: string, passwordHash: string, timezone: string): Promise<string>;
  findAccountByEmail(email: string): Promise<{ id: string; passwordHash: string } | null>;
  createAuthSession(accountId: string, token: string, expiresAt: number): Promise<void>;
  findAccountIdByToken(token: string): Promise<string | null>;
  deleteAuthSession(token: string): Promise<void>;

  getAccountTimezone(accountId: string): Promise<string | null>;

  // --- profiles ---
  listProfiles(accountId: string): Promise<Profile[]>;
  getProfile(profileId: string): Promise<Profile | null>;
  createProfile(p: Omit<Profile, 'id' | 'createdAt' | 'streak'>): Promise<Profile>;
  getProfileStreak(profileId: string): Promise<{ streak: number; lastPlayedDay: string | null }>;
  setProfileStreak(profileId: string, streak: number, day: string): Promise<void>;

  // --- fact sets ---
  listEnabledSetIds(profileId: string): Promise<string[]>;
  setEnabledSetIds(profileId: string, setIds: string[]): Promise<void>;

  // --- progress & stats ---
  getProgress(profileId: string): Promise<FactProgress[]>;
  getProgressForFact(profileId: string, factId: string): Promise<FactProgress | null>;
  upsertProgress(p: FactProgress): Promise<void>;
  /** Count due review facts (box ≥ 1, dueAt ≤ now) — drives "all caught up". */
  countDueReview(profileId: string, now: number): Promise<number>;
  /** Count facts still in the learning phase (box 0). */
  countLearning(profileId: string): Promise<number>;
  getOperationStats(profileId: string): Promise<OperationStat[]>;
  getOperationStat(profileId: string, operation: Operation): Promise<OperationStat | null>;
  upsertOperationStat(s: OperationStat): Promise<void>;

  // --- sessions & attempts ---
  createSession(s: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  updateSessionWorkingState(id: string, workingState: string): Promise<void>;
  completeSession(id: string, completedAt: number): Promise<void>;
  appendAttempt(a: AttemptRecord): Promise<void>;
  listSessionAttempts(sessionId: string): Promise<AttemptRecord[]>;

  close(): Promise<void>;
}

/** Resolve which adapter a DATABASE_URL refers to (by scheme). */
export function adapterKindFor(databaseUrl: string): 'sqlite' | 'postgres' {
  if (databaseUrl.startsWith('sqlite:')) return 'sqlite';
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return 'postgres';
  }
  throw new Error(`Unrecognized DATABASE_URL scheme: ${databaseUrl}`);
}

/** Strip the `sqlite:` scheme to a filename (or `:memory:`). */
export function parseSqliteFilename(databaseUrl: string): string {
  const rest = databaseUrl.slice('sqlite:'.length);
  return rest === ':memory:' ? ':memory:' : rest;
}

/** Open the DB selected by DATABASE_URL. Call `migrate()` before serving. */
export function createDb(databaseUrl: string): Db {
  const kind = adapterKindFor(databaseUrl);
  if (kind === 'sqlite') return new SqliteDb(parseSqliteFilename(databaseUrl));
  return PostgresDb.fromUrl(databaseUrl);
}
