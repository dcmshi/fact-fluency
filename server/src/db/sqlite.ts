/**
 * SQLite implementation of the Db adapter (DESIGN.md §5.1). better-sqlite3 is
 * synchronous; methods are wrapped as async to satisfy the interface so a
 * future Postgres adapter (genuinely async) is a drop-in replacement.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FactProgress, Operation, OperationStat, Profile, ProfileSettings } from '@shared';
import type { AttemptRecord, Db, SessionRecord } from './index';
import { SCHEMA } from './schema';

interface ProfileRow {
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

/** Profile columns joined with the (optional) reward row, defaulted. */
const PROFILE_SELECT = `
  SELECT p.id, p.account_id, p.display_name, p.avatar, p.settings, p.streak,
         p.created_at, COALESCE(r.coins, 0) AS coins,
         COALESCE(r.theme, 'classic') AS theme
  FROM profile p LEFT JOIN profile_reward r ON r.profile_id = p.id`;

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

interface SessionRow {
  id: string;
  profile_id: string;
  started_at: number;
  completed_at: number | null;
  planned_count: number;
  working_state: string;
}

interface AttemptRow {
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

function toAttempt(r: AttemptRow): AttemptRecord {
  return {
    id: r.id,
    sessionId: r.session_id,
    profileId: r.profile_id,
    factId: r.fact_id,
    given: r.given,
    correct: !!r.correct,
    fast: !!r.fast,
    responseMs: r.response_ms,
    answeredAt: r.answered_at,
  };
}

function toSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    profileId: r.profile_id,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    plannedCount: r.planned_count,
    workingState: r.working_state,
  };
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

  // Schema is applied in the constructor; migrate() satisfies the interface.
  async migrate(): Promise<void> {
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

  async createGuestAccount(timezone: string): Promise<string> {
    const id = randomUUID();
    // Synthetic unique email + empty hash: the row satisfies the schema but can
    // never be logged into. is_guest=1 marks it for pruning.
    this.db
      .prepare(
        'INSERT INTO account (id, email, password_hash, timezone, created_at, is_guest) VALUES (?, ?, ?, ?, ?, 1)',
      )
      .run(id, `guest-${id}`, '', timezone, Date.now());
    return id;
  }

  async isGuestAccount(accountId: string): Promise<boolean> {
    const row = this.db.prepare('SELECT is_guest FROM account WHERE id = ?').get(accountId) as
      | { is_guest: number }
      | undefined;
    return !!row?.is_guest;
  }

  async upgradeGuestAccount(
    accountId: string,
    email: string,
    passwordHash: string,
  ): Promise<boolean> {
    const info = this.db
      .prepare(
        'UPDATE account SET email = ?, password_hash = ?, is_guest = 0 WHERE id = ? AND is_guest = 1',
      )
      .run(email, passwordHash, accountId);
    return info.changes > 0;
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

  async deleteExpiredAuthSessions(now: number): Promise<number> {
    return this.db.prepare('DELETE FROM auth_session WHERE expires_at <= ?').run(now).changes;
  }

  async deleteExpiredGuests(now: number): Promise<number> {
    return this.db
      .prepare(
        `DELETE FROM account
          WHERE is_guest = 1
            AND id NOT IN (SELECT account_id FROM auth_session WHERE expires_at > ?)`,
      )
      .run(now).changes;
  }

  async getAccountTimezone(accountId: string): Promise<string | null> {
    const row = this.db.prepare('SELECT timezone FROM account WHERE id = ?').get(accountId) as
      | { timezone: string }
      | undefined;
    return row?.timezone ?? null;
  }

  // --- profiles ---

  async listProfiles(accountId: string): Promise<Profile[]> {
    const rows = this.db
      .prepare(`${PROFILE_SELECT} WHERE p.account_id = ? ORDER BY p.created_at`)
      .all(accountId) as ProfileRow[];
    return rows.map(toProfile);
  }

  async getProfile(profileId: string): Promise<Profile | null> {
    const row = this.db.prepare(`${PROFILE_SELECT} WHERE p.id = ?`).get(profileId) as
      | ProfileRow
      | undefined;
    return row ? toProfile(row) : null;
  }

  async getProfileStreak(
    profileId: string,
  ): Promise<{ streak: number; lastPlayedDay: string | null }> {
    const row = this.db
      .prepare('SELECT streak, last_played_day FROM profile WHERE id = ?')
      .get(profileId) as { streak: number; last_played_day: string | null } | undefined;
    return { streak: row?.streak ?? 0, lastPlayedDay: row?.last_played_day ?? null };
  }

  async setProfileStreak(profileId: string, streak: number, day: string): Promise<void> {
    this.db
      .prepare('UPDATE profile SET streak = ?, last_played_day = ? WHERE id = ?')
      .run(streak, day, profileId);
  }

  async createProfile(
    p: Omit<Profile, 'id' | 'createdAt' | 'streak' | 'coins' | 'theme'>,
  ): Promise<Profile> {
    const profile: Profile = {
      ...p,
      id: randomUUID(),
      streak: 0,
      coins: 0,
      theme: 'classic',
      createdAt: Date.now(),
    };
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

  async updateProfileAvatar(profileId: string, avatar: string): Promise<void> {
    this.db.prepare('UPDATE profile SET avatar = ? WHERE id = ?').run(avatar, profileId);
  }

  // --- rewards ---

  async getProfileReward(profileId: string): Promise<{ coins: number; theme: string }> {
    const row = this.db
      .prepare('SELECT coins, theme FROM profile_reward WHERE profile_id = ?')
      .get(profileId) as { coins: number; theme: string } | undefined;
    return { coins: row?.coins ?? 0, theme: row?.theme ?? 'classic' };
  }

  async addCoins(profileId: string, delta: number): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO profile_reward (profile_id, coins) VALUES (?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET coins = coins + excluded.coins`,
      )
      .run(profileId, delta);
  }

  async setCoins(profileId: string, coins: number): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO profile_reward (profile_id, coins) VALUES (?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET coins = excluded.coins`,
      )
      .run(profileId, coins);
  }

  async setProfileTheme(profileId: string, theme: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO profile_reward (profile_id, theme) VALUES (?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET theme = excluded.theme`,
      )
      .run(profileId, theme);
  }

  async getEquippedMuncher(profileId: string): Promise<string> {
    const row = this.db
      .prepare('SELECT muncher FROM profile_muncher WHERE profile_id = ?')
      .get(profileId) as { muncher: string } | undefined;
    return row?.muncher ?? 'cat';
  }

  async setEquippedMuncher(profileId: string, muncher: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO profile_muncher (profile_id, muncher) VALUES (?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET muncher = excluded.muncher`,
      )
      .run(profileId, muncher);
  }

  async getEquippedEffect(profileId: string): Promise<string> {
    const row = this.db
      .prepare('SELECT effect FROM profile_effect WHERE profile_id = ?')
      .get(profileId) as { effect: string } | undefined;
    return row?.effect ?? 'confetti';
  }

  async setEquippedEffect(profileId: string, effect: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO profile_effect (profile_id, effect) VALUES (?, ?)
         ON CONFLICT(profile_id) DO UPDATE SET effect = excluded.effect`,
      )
      .run(profileId, effect);
  }

  async listUnlocks(profileId: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT item_id FROM profile_unlock WHERE profile_id = ?')
      .all(profileId) as { item_id: string }[];
    return rows.map((r) => r.item_id);
  }

  async addUnlock(profileId: string, itemId: string): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO profile_unlock (profile_id, item_id) VALUES (?, ?)')
      .run(profileId, itemId);
  }

  async updateProfileSettings(profileId: string, settings: ProfileSettings): Promise<Profile> {
    this.db
      .prepare('UPDATE profile SET settings = ? WHERE id = ?')
      .run(JSON.stringify(settings), profileId);
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error(`profile not found: ${profileId}`);
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

  async getProgressForFact(profileId: string, factId: string): Promise<FactProgress | null> {
    const row = this.db
      .prepare('SELECT * FROM fact_progress WHERE profile_id = ? AND fact_id = ?')
      .get(profileId, factId) as ProgressRow | undefined;
    return row ? toProgress(row) : null;
  }

  async countDueReview(profileId: string, now: number): Promise<number> {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM fact_progress WHERE profile_id = ? AND box >= 1 AND due_at <= ?',
      )
      .get(profileId, now) as { n: number };
    return row.n;
  }

  async countLearning(profileId: string): Promise<number> {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM fact_progress WHERE profile_id = ? AND box = 0')
      .get(profileId) as { n: number };
    return row.n;
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
    return rows.map(toOperationStat);
  }

  async getOperationStat(profileId: string, operation: Operation): Promise<OperationStat | null> {
    const row = this.db
      .prepare('SELECT * FROM operation_stat WHERE profile_id = ? AND operation = ?')
      .get(profileId, operation) as OperationStatRow | undefined;
    return row ? toOperationStat(row) : null;
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

  // --- sessions & attempts ---

  async createSession(s: SessionRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO session (id, profile_id, started_at, completed_at, planned_count, working_state)
         VALUES (@id, @profileId, @startedAt, @completedAt, @plannedCount, @workingState)`,
      )
      .run(s);
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = this.db.prepare('SELECT * FROM session WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? toSession(row) : null;
  }

  async getOpenSession(profileId: string): Promise<SessionRecord | null> {
    const row = this.db
      .prepare(
        'SELECT * FROM session WHERE profile_id = ? AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1',
      )
      .get(profileId) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async updateSessionWorkingState(id: string, workingState: string): Promise<void> {
    this.db.prepare('UPDATE session SET working_state = ? WHERE id = ?').run(workingState, id);
  }

  async completeSession(id: string, completedAt: number): Promise<void> {
    this.db.prepare('UPDATE session SET completed_at = ? WHERE id = ?').run(completedAt, id);
  }

  async completeSessionAndAward(
    sessionId: string,
    completedAt: number,
    profileId: string,
    coinDelta: number,
  ): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('UPDATE session SET completed_at = ? WHERE id = ?')
        .run(completedAt, sessionId);
      if (coinDelta > 0) {
        this.db
          .prepare(
            `INSERT INTO profile_reward (profile_id, coins) VALUES (?, ?)
             ON CONFLICT(profile_id) DO UPDATE SET coins = coins + excluded.coins`,
          )
          .run(profileId, coinDelta);
      }
    });
    tx();
  }

  async appendAttempt(a: AttemptRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO attempt (id, session_id, profile_id, fact_id, given, correct, fast, response_ms, answered_at)
         VALUES (@id, @sessionId, @profileId, @factId, @given, @correct, @fast, @responseMs, @answeredAt)`,
      )
      .run({ ...a, correct: a.correct ? 1 : 0, fast: a.fast ? 1 : 0 });
  }

  async listSessionAttempts(sessionId: string): Promise<AttemptRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM attempt WHERE session_id = ? ORDER BY answered_at')
      .all(sessionId) as AttemptRow[];
    return rows.map(toAttempt);
  }

  async listProfileAttempts(profileId: string, since: number): Promise<AttemptRecord[]> {
    const rows = this.db
      .prepare(
        'SELECT * FROM attempt WHERE profile_id = ? AND answered_at >= ? ORDER BY answered_at',
      )
      .all(profileId, since) as AttemptRow[];
    return rows.map(toAttempt);
  }

  async listAllAttempts(since: number): Promise<AttemptRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM attempt WHERE answered_at >= ? ORDER BY answered_at')
      .all(since) as AttemptRow[];
    return rows.map(toAttempt);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

function toOperationStat(r: OperationStatRow): OperationStat {
  return {
    profileId: r.profile_id,
    operation: r.operation as Operation,
    medianMsEwma: r.median_ms_ewma,
    correctSamples: r.correct_samples,
  };
}

function toProfile(r: ProfileRow): Profile {
  return {
    id: r.id,
    accountId: r.account_id,
    displayName: r.display_name,
    avatar: r.avatar,
    settings: JSON.parse(r.settings) as ProfileSettings,
    streak: r.streak,
    coins: r.coins,
    theme: r.theme,
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
