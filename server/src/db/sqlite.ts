/**
 * SQLite implementation of the Db adapter (DESIGN.md §5.1). better-sqlite3 is
 * synchronous; methods are wrapped as async to satisfy the interface so a
 * future Postgres adapter (genuinely async) is a drop-in replacement.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FactProgress, OperationStat, Profile, ProfileSettings } from '@shared';
import type { Db } from './index';
import { SCHEMA } from './schema';

interface ProfileRow {
  id: string;
  account_id: string;
  display_name: string;
  avatar: string;
  settings: string;
  created_at: number;
}

interface ProgressRow {
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

interface OperationStatRow {
  profile_id: string;
  operation: string;
  median_ms_ewma: number;
  correct_samples: number;
}

export class SqliteDb implements Db {
  private readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  // --- accounts & auth ---

  async createAccount(email: string, passwordHash: string, timezone: string): Promise<string> {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO account (id, email, password_hash, timezone, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, email, passwordHash, timezone, Date.now());
    return id;
  }

  async findAccountByEmail(email: string): Promise<{ id: string; passwordHash: string } | null> {
    const row = this.db
      .prepare('SELECT id, password_hash FROM account WHERE email = ?')
      .get(email) as { id: string; password_hash: string } | undefined;
    return row ? { id: row.id, passwordHash: row.password_hash } : null;
  }

  async createAuthSession(accountId: string, token: string, expiresAt: number): Promise<void> {
    this.db
      .prepare('INSERT INTO auth_session (token, account_id, expires_at) VALUES (?, ?, ?)')
      .run(token, accountId, expiresAt);
  }

  async findAccountIdByToken(token: string): Promise<string | null> {
    const row = this.db
      .prepare('SELECT account_id FROM auth_session WHERE token = ? AND expires_at > ?')
      .get(token, Date.now()) as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  async deleteAuthSession(token: string): Promise<void> {
    this.db.prepare('DELETE FROM auth_session WHERE token = ?').run(token);
  }

  // --- profiles ---

  async listProfiles(accountId: string): Promise<Profile[]> {
    const rows = this.db
      .prepare('SELECT * FROM profile WHERE account_id = ? ORDER BY created_at')
      .all(accountId) as ProfileRow[];
    return rows.map(toProfile);
  }

  async createProfile(p: Omit<Profile, 'id' | 'createdAt'>): Promise<Profile> {
    const profile: Profile = { ...p, id: randomUUID(), createdAt: Date.now() };
    this.db
      .prepare(
        'INSERT INTO profile (id, account_id, display_name, avatar, settings, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        profile.id,
        profile.accountId,
        profile.displayName,
        profile.avatar,
        JSON.stringify(profile.settings),
        profile.createdAt,
      );
    return profile;
  }

  // --- fact sets ---

  async listEnabledSetIds(profileId: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT fact_set_id FROM profile_fact_set WHERE profile_id = ? AND enabled = 1')
      .all(profileId) as { fact_set_id: string }[];
    return rows.map((r) => r.fact_set_id);
  }

  async setEnabledSetIds(profileId: string, setIds: string[]): Promise<void> {
    const replace = this.db.transaction((ids: string[]) => {
      this.db.prepare('DELETE FROM profile_fact_set WHERE profile_id = ?').run(profileId);
      const insert = this.db.prepare(
        'INSERT INTO profile_fact_set (profile_id, fact_set_id, enabled) VALUES (?, ?, 1)',
      );
      for (const id of ids) insert.run(profileId, id);
    });
    replace(setIds);
  }

  // --- progress & stats ---

  async getProgress(profileId: string): Promise<FactProgress[]> {
    const rows = this.db
      .prepare('SELECT * FROM fact_progress WHERE profile_id = ?')
      .all(profileId) as ProgressRow[];
    return rows.map(toProgress);
  }

  async upsertProgress(p: FactProgress): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO fact_progress
           (profile_id, fact_id, box, state, due_at, last_seen_at, reps,
            fast_correct, correct_streak, accuracy_ewma, median_ms_ewma)
         VALUES (@profileId, @factId, @box, @state, @dueAt, @lastSeenAt, @reps,
                 @fastCorrect, @correctStreak, @accuracyEwma, @medianMsEwma)
         ON CONFLICT(profile_id, fact_id) DO UPDATE SET
           box=@box, state=@state, due_at=@dueAt, last_seen_at=@lastSeenAt,
           reps=@reps, fast_correct=@fastCorrect, correct_streak=@correctStreak,
           accuracy_ewma=@accuracyEwma, median_ms_ewma=@medianMsEwma`,
      )
      .run(p);
  }

  async getOperationStats(profileId: string): Promise<OperationStat[]> {
    const rows = this.db
      .prepare('SELECT * FROM operation_stat WHERE profile_id = ?')
      .all(profileId) as OperationStatRow[];
    return rows.map((r) => ({
      profileId: r.profile_id,
      operation: r.operation as OperationStat['operation'],
      medianMsEwma: r.median_ms_ewma,
      correctSamples: r.correct_samples,
    }));
  }

  async upsertOperationStat(s: OperationStat): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO operation_stat (profile_id, operation, median_ms_ewma, correct_samples)
         VALUES (@profileId, @operation, @medianMsEwma, @correctSamples)
         ON CONFLICT(profile_id, operation) DO UPDATE SET
           median_ms_ewma=@medianMsEwma, correct_samples=@correctSamples`,
      )
      .run(s);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    accountId: r.account_id,
    displayName: r.display_name,
    avatar: r.avatar,
    settings: JSON.parse(r.settings) as ProfileSettings,
    createdAt: r.created_at,
  };
}

function toProgress(r: ProgressRow): FactProgress {
  return {
    profileId: r.profile_id,
    factId: r.fact_id,
    box: r.box as FactProgress['box'],
    state: r.state as FactProgress['state'],
    dueAt: r.due_at,
    lastSeenAt: r.last_seen_at,
    reps: r.reps,
    fastCorrect: r.fast_correct,
    correctStreak: r.correct_streak,
    accuracyEwma: r.accuracy_ewma,
    medianMsEwma: r.median_ms_ewma,
  };
}
