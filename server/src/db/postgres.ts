/**
 * Postgres implementation of the Db adapter (DESIGN.md §5.1) — the production
 * store on Render. Structurally identical to the SQLite adapter but with
 * positional ($1) params and an async migrate(). The pool is injectable so
 * tests can run it against pg-mem without a live database.
 */
import { randomUUID } from 'node:crypto';
import type { FactProgress, Operation, OperationStat, Profile, ProfileSettings } from '@shared';
import type { AnswerWrite, AttemptRecord, Db, SessionRecord } from './index';
import { ADDITIVE_COLUMNS_PG, SCHEMA_PG } from './schema.pg';

/** A single checked-out connection — what `pool.connect()` returns. Needed for
 *  multi-statement transactions (a bare pool may route each query to a
 *  different backend connection). */
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
}

/** Minimal pool shape — satisfied by both `pg`'s Pool and pg-mem's adapter. */
export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

type PgQuery = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export class PostgresDb implements Db {
  constructor(private readonly pool: PgPool) {}

  /** Build a PostgresDb from a DATABASE_URL (lazily loads the `pg` driver). */
  static fromUrl(url: string): PostgresDb {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pg = require('pg') as typeof import('pg');
    pg.types.setTypeParser(20, (v: string) => parseInt(v, 10)); // BIGINT -> number
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      ssl: local ? undefined : { rejectUnauthorized: false },
    });
    return new PostgresDb(pool);
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_PG);
    // Self-heal additive columns on a DB created before the column existed —
    // CREATE TABLE IF NOT EXISTS can't add columns to an existing table. Each is
    // idempotent (ADD COLUMN IF NOT EXISTS), so this is safe to run every boot.
    for (const ddl of ADDITIVE_COLUMNS_PG) await this.pool.query(ddl);
  }

  private async rows<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return (await this.pool.query(text, params)).rows as T[];
  }
  private async one<T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    return (await this.rows<T>(text, params))[0] ?? null;
  }

  /** Run `fn` inside a BEGIN/COMMIT on a single checked-out connection, rolling
   *  back on any error. The callback gets a bound `query` for that connection. */
  private async withTransaction<T>(fn: (q: PgQuery) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn((text, params) => client.query(text, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Surface the original error, not a rollback failure.
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // --- accounts & auth ---

  async createAccount(email: string, passwordHash: string, timezone: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO account (id, email, password_hash, timezone, created_at) VALUES ($1,$2,$3,$4,$5)',
      [id, email, passwordHash, timezone, Date.now()],
    );
    return id;
  }

  async createGuestAccount(timezone: string): Promise<string> {
    const id = randomUUID();
    // Synthetic unique email + empty hash: satisfies the schema, never logins.
    await this.pool.query(
      'INSERT INTO account (id, email, password_hash, timezone, created_at, is_guest) VALUES ($1,$2,$3,$4,$5,1)',
      [id, `guest-${id}`, '', timezone, Date.now()],
    );
    return id;
  }

  async isGuestAccount(accountId: string): Promise<boolean> {
    const row = await this.one<{ is_guest: number }>('SELECT is_guest FROM account WHERE id = $1', [
      accountId,
    ]);
    return !!row?.is_guest;
  }

  async upgradeGuestAccount(
    accountId: string,
    email: string,
    passwordHash: string,
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      'UPDATE account SET email = $1, password_hash = $2, is_guest = 0 WHERE id = $3 AND is_guest = 1 RETURNING id',
      [email, passwordHash, accountId],
    );
    return rows.length > 0;
  }

  async findAccountByEmail(email: string): Promise<{ id: string; passwordHash: string } | null> {
    const row = await this.one<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM account WHERE email = $1',
      [email],
    );
    return row ? { id: row.id, passwordHash: row.password_hash } : null;
  }

  async createAuthSession(accountId: string, token: string, expiresAt: number): Promise<void> {
    await this.pool.query(
      'INSERT INTO auth_session (token, account_id, expires_at) VALUES ($1,$2,$3)',
      [token, accountId, expiresAt],
    );
  }

  async findAccountIdByToken(token: string): Promise<string | null> {
    const row = await this.one<{ account_id: string }>(
      'SELECT account_id FROM auth_session WHERE token = $1 AND expires_at > $2',
      [token, Date.now()],
    );
    return row?.account_id ?? null;
  }

  async slideAuthSession(
    token: string,
    now: number,
    newExpiresAt: number,
    onlyIfBelow: number,
  ): Promise<boolean> {
    // RETURNING so the row count comes back via the {rows} pool interface.
    const { rows } = await this.pool.query(
      'UPDATE auth_session SET expires_at = $1 WHERE token = $2 AND expires_at > $3 AND expires_at < $4 RETURNING token',
      [newExpiresAt, token, now, onlyIfBelow],
    );
    return rows.length > 0;
  }

  async deleteAuthSession(token: string): Promise<void> {
    await this.pool.query('DELETE FROM auth_session WHERE token = $1', [token]);
  }

  async deleteExpiredAuthSessions(now: number): Promise<number> {
    // RETURNING so the count comes back via the {rows} pool interface.
    const { rows } = await this.pool.query(
      'DELETE FROM auth_session WHERE expires_at <= $1 RETURNING token',
      [now],
    );
    return rows.length;
  }

  async deleteExpiredGuests(now: number): Promise<number> {
    const { rows } = await this.pool.query(
      `DELETE FROM account
        WHERE is_guest = 1
          AND id NOT IN (SELECT account_id FROM auth_session WHERE expires_at > $1)
       RETURNING id`,
      [now],
    );
    return rows.length;
  }

  async getAccountTimezone(accountId: string): Promise<string | null> {
    const row = await this.one<{ timezone: string }>('SELECT timezone FROM account WHERE id = $1', [
      accountId,
    ]);
    return row?.timezone ?? null;
  }

  async getAccount(accountId: string): Promise<{ email: string; timezone: string } | null> {
    return this.one<{ email: string; timezone: string }>(
      'SELECT email, timezone FROM account WHERE id = $1',
      [accountId],
    );
  }

  async updateAccountEmail(accountId: string, email: string): Promise<void> {
    await this.pool.query('UPDATE account SET email = $1 WHERE id = $2', [email, accountId]);
  }

  async updateAccountPassword(accountId: string, passwordHash: string): Promise<void> {
    await this.pool.query('UPDATE account SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      accountId,
    ]);
  }

  async updateAccountTimezone(accountId: string, timezone: string): Promise<void> {
    await this.pool.query('UPDATE account SET timezone = $1 WHERE id = $2', [timezone, accountId]);
  }

  async deleteAccount(accountId: string): Promise<void> {
    // Profiles + their data and auth sessions cascade via ON DELETE CASCADE.
    await this.pool.query('DELETE FROM account WHERE id = $1', [accountId]);
  }

  // --- profiles ---

  async listProfiles(accountId: string): Promise<Profile[]> {
    return (
      await this.rows<ProfileRow>(
        `${PROFILE_SELECT} WHERE p.account_id = $1 ORDER BY p.created_at`,
        [accountId],
      )
    ).map(toProfile);
  }

  async getProfile(profileId: string): Promise<Profile | null> {
    const row = await this.one<ProfileRow>(`${PROFILE_SELECT} WHERE p.id = $1`, [profileId]);
    return row ? toProfile(row) : null;
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
    await this.pool.query(
      `INSERT INTO profile (id, account_id, display_name, avatar, settings, streak, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        profile.id,
        profile.accountId,
        profile.displayName,
        profile.avatar,
        JSON.stringify(profile.settings),
        profile.streak,
        profile.createdAt,
      ],
    );
    return profile;
  }

  async updateProfileName(profileId: string, displayName: string): Promise<void> {
    await this.pool.query('UPDATE profile SET display_name = $1 WHERE id = $2', [
      displayName,
      profileId,
    ]);
  }

  async updateProfileAvatar(profileId: string, avatar: string): Promise<void> {
    await this.pool.query('UPDATE profile SET avatar = $1 WHERE id = $2', [avatar, profileId]);
  }

  async deleteProfile(profileId: string): Promise<void> {
    // Child rows cascade via ON DELETE CASCADE.
    await this.pool.query('DELETE FROM profile WHERE id = $1', [profileId]);
  }

  // --- rewards ---

  async getProfileReward(profileId: string): Promise<{ coins: number; theme: string }> {
    const row = await this.one<{ coins: number; theme: string }>(
      'SELECT coins, theme FROM profile_reward WHERE profile_id = $1',
      [profileId],
    );
    return { coins: row ? Number(row.coins) : 0, theme: row?.theme ?? 'classic' };
  }

  async addCoins(profileId: string, delta: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO profile_reward (profile_id, coins) VALUES ($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET coins = profile_reward.coins + EXCLUDED.coins`,
      [profileId, delta],
    );
  }

  async setCoins(profileId: string, coins: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO profile_reward (profile_id, coins) VALUES ($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET coins = EXCLUDED.coins`,
      [profileId, coins],
    );
  }

  async setProfileTheme(profileId: string, theme: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO profile_reward (profile_id, theme) VALUES ($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET theme = EXCLUDED.theme`,
      [profileId, theme],
    );
  }

  async getEquippedMuncher(profileId: string): Promise<string> {
    const row = await this.one<{ muncher: string }>(
      'SELECT muncher FROM profile_muncher WHERE profile_id = $1',
      [profileId],
    );
    return row?.muncher ?? 'cat';
  }

  async setEquippedMuncher(profileId: string, muncher: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO profile_muncher (profile_id, muncher) VALUES ($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET muncher = EXCLUDED.muncher`,
      [profileId, muncher],
    );
  }

  async getEquippedEffect(profileId: string): Promise<string> {
    const row = await this.one<{ effect: string }>(
      'SELECT effect FROM profile_effect WHERE profile_id = $1',
      [profileId],
    );
    return row?.effect ?? 'confetti';
  }

  async setEquippedEffect(profileId: string, effect: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO profile_effect (profile_id, effect) VALUES ($1,$2)
       ON CONFLICT (profile_id) DO UPDATE SET effect = EXCLUDED.effect`,
      [profileId, effect],
    );
  }

  async listUnlocks(profileId: string): Promise<string[]> {
    return (
      await this.rows<{ item_id: string }>(
        'SELECT item_id FROM profile_unlock WHERE profile_id = $1',
        [profileId],
      )
    ).map((r) => r.item_id);
  }

  async addUnlock(profileId: string, itemId: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO profile_unlock (profile_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [profileId, itemId],
    );
  }

  async spendAndUnlock(
    profileId: string,
    itemId: string,
    cost: number,
  ): Promise<
    { status: 'ok'; coins: number } | { status: 'insufficient' } | { status: 'already_owned' }
  > {
    // Claim ownership then debit conditionally, one transaction — see the
    // SQLite adapter for the race rationale.
    return this.withTransaction(async (q) => {
      const claim = await q(
        'INSERT INTO profile_unlock (profile_id, item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING item_id',
        [profileId, itemId],
      );
      if (claim.rows.length === 0) return { status: 'already_owned' as const };
      // Add a negative delta rather than subtract: pg-mem evaluates `coins - $n`
      // with its operands swapped (a pg-mem bug), but addition commutes, so this
      // is correct on both real Postgres and pg-mem. $3 guards the balance.
      const debit = await q(
        'UPDATE profile_reward SET coins = coins + $2 WHERE profile_id = $1 AND coins >= $3 RETURNING coins',
        [profileId, -cost, cost],
      );
      if (debit.rows.length === 0) throw new Error('rollback:insufficient'); // undoes the claim
      return { status: 'ok' as const, coins: (debit.rows[0] as { coins: number }).coins };
    }).catch((err: unknown) => {
      if (err instanceof Error && err.message === 'rollback:insufficient') {
        return { status: 'insufficient' as const };
      }
      throw err;
    });
  }

  async updateProfileSettings(profileId: string, settings: ProfileSettings): Promise<Profile> {
    await this.pool.query('UPDATE profile SET settings = $1 WHERE id = $2', [
      JSON.stringify(settings),
      profileId,
    ]);
    const profile = await this.getProfile(profileId);
    if (!profile) throw new Error(`profile not found: ${profileId}`);
    return profile;
  }

  async getProfileStreak(
    profileId: string,
  ): Promise<{ streak: number; lastPlayedDay: string | null }> {
    const row = await this.one<{ streak: number; last_played_day: string | null }>(
      'SELECT streak, last_played_day FROM profile WHERE id = $1',
      [profileId],
    );
    return { streak: row?.streak ?? 0, lastPlayedDay: row?.last_played_day ?? null };
  }

  async setProfileStreak(profileId: string, streak: number, day: string): Promise<void> {
    await this.pool.query('UPDATE profile SET streak = $1, last_played_day = $2 WHERE id = $3', [
      streak,
      day,
      profileId,
    ]);
  }

  // --- fact sets ---

  async listEnabledSetIds(profileId: string): Promise<string[]> {
    return (
      await this.rows<{ fact_set_id: string }>(
        'SELECT fact_set_id FROM profile_fact_set WHERE profile_id = $1 AND enabled = 1',
        [profileId],
      )
    ).map((r) => r.fact_set_id);
  }

  async setEnabledSetIds(profileId: string, setIds: string[]): Promise<void> {
    // Replace the set atomically so a failure can't leave a half-applied list.
    await this.withTransaction(async (q) => {
      await q('DELETE FROM profile_fact_set WHERE profile_id = $1', [profileId]);
      for (const id of setIds) {
        await q(
          'INSERT INTO profile_fact_set (profile_id, fact_set_id, enabled) VALUES ($1,$2,1)',
          [profileId, id],
        );
      }
    });
  }

  // --- progress & stats ---

  async getProgress(profileId: string): Promise<FactProgress[]> {
    return (
      await this.rows<ProgressRow>('SELECT * FROM fact_progress WHERE profile_id = $1', [profileId])
    ).map(toProgress);
  }

  async getProgressForFact(profileId: string, factId: string): Promise<FactProgress | null> {
    const row = await this.one<ProgressRow>(
      'SELECT * FROM fact_progress WHERE profile_id = $1 AND fact_id = $2',
      [profileId, factId],
    );
    return row ? toProgress(row) : null;
  }

  async countDueReview(profileId: string, now: number, factIds?: string[]): Promise<number> {
    if (factIds && factIds.length === 0) return 0;
    const inClause = factIds
      ? ` AND fact_id IN (${factIds.map((_, i) => `$${i + 3}`).join(',')})`
      : '';
    const row = await this.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM fact_progress WHERE profile_id = $1 AND box >= 1 AND due_at <= $2${inClause}`,
      [profileId, now, ...(factIds ?? [])],
    );
    return row?.n ?? 0;
  }

  async countLearning(profileId: string, factIds?: string[]): Promise<number> {
    if (factIds && factIds.length === 0) return 0;
    const inClause = factIds
      ? ` AND fact_id IN (${factIds.map((_, i) => `$${i + 2}`).join(',')})`
      : '';
    const row = await this.one<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM fact_progress WHERE profile_id = $1 AND box = 0${inClause}`,
      [profileId, ...(factIds ?? [])],
    );
    return row?.n ?? 0;
  }

  private async execUpsertProgress(q: PgQuery, p: FactProgress): Promise<void> {
    await q(
      `INSERT INTO fact_progress
         (profile_id, fact_id, box, state, due_at, last_seen_at, reps,
          fast_correct, correct_streak, accuracy_ewma, median_ms_ewma)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (profile_id, fact_id) DO UPDATE SET
         box=$3, state=$4, due_at=$5, last_seen_at=$6, reps=$7,
         fast_correct=$8, correct_streak=$9, accuracy_ewma=$10, median_ms_ewma=$11`,
      [
        p.profileId,
        p.factId,
        p.box,
        p.state,
        p.dueAt,
        p.lastSeenAt,
        p.reps,
        p.fastCorrect,
        p.correctStreak,
        p.accuracyEwma,
        p.medianMsEwma,
      ],
    );
  }

  async upsertProgress(p: FactProgress): Promise<void> {
    await this.execUpsertProgress((t, params) => this.pool.query(t, params), p);
  }

  async getOperationStats(profileId: string): Promise<OperationStat[]> {
    return (
      await this.rows<OperationStatRow>('SELECT * FROM operation_stat WHERE profile_id = $1', [
        profileId,
      ])
    ).map(toOperationStat);
  }

  async getOperationStat(profileId: string, operation: Operation): Promise<OperationStat | null> {
    const row = await this.one<OperationStatRow>(
      'SELECT * FROM operation_stat WHERE profile_id = $1 AND operation = $2',
      [profileId, operation],
    );
    return row ? toOperationStat(row) : null;
  }

  private async execUpsertOperationStat(q: PgQuery, s: OperationStat): Promise<void> {
    await q(
      `INSERT INTO operation_stat (profile_id, operation, median_ms_ewma, correct_samples)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (profile_id, operation) DO UPDATE SET median_ms_ewma=$3, correct_samples=$4`,
      [s.profileId, s.operation, s.medianMsEwma, s.correctSamples],
    );
  }

  async upsertOperationStat(s: OperationStat): Promise<void> {
    await this.execUpsertOperationStat((t, params) => this.pool.query(t, params), s);
  }

  // --- sessions & attempts ---

  async createSession(s: SessionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO session (id, profile_id, started_at, completed_at, planned_count, working_state)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.id, s.profileId, s.startedAt, s.completedAt, s.plannedCount, s.workingState],
    );
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = await this.one<SessionRow>('SELECT * FROM session WHERE id = $1', [id]);
    return row ? toSession(row) : null;
  }

  async getOpenSession(profileId: string): Promise<SessionRecord | null> {
    const row = await this.one<SessionRow>(
      'SELECT * FROM session WHERE profile_id = $1 AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1',
      [profileId],
    );
    return row ? toSession(row) : null;
  }

  async updateSessionWorkingState(id: string, workingState: string): Promise<void> {
    await this.pool.query('UPDATE session SET working_state = $1 WHERE id = $2', [
      workingState,
      id,
    ]);
  }

  async completeSession(id: string, completedAt: number): Promise<void> {
    await this.pool.query('UPDATE session SET completed_at = $1 WHERE id = $2', [completedAt, id]);
  }

  async completeSessionAndAward(
    sessionId: string,
    completedAt: number,
    profileId: string,
    coinDelta: number,
  ): Promise<boolean> {
    return this.withTransaction(async (q) => {
      // Conditional on the session still being open — see the SQLite adapter.
      const upd = await q(
        'UPDATE session SET completed_at = $1 WHERE id = $2 AND completed_at IS NULL RETURNING id',
        [completedAt, sessionId],
      );
      if (upd.rows.length === 0) return false;
      if (coinDelta > 0) {
        await q(
          `INSERT INTO profile_reward (profile_id, coins) VALUES ($1,$2)
           ON CONFLICT (profile_id) DO UPDATE SET coins = profile_reward.coins + EXCLUDED.coins`,
          [profileId, coinDelta],
        );
      }
      return true;
    });
  }

  private async execAppendAttempt(q: PgQuery, a: AttemptRecord): Promise<void> {
    await q(
      `INSERT INTO attempt (id, session_id, profile_id, fact_id, given, correct, fast, response_ms, answered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        a.id,
        a.sessionId,
        a.profileId,
        a.factId,
        a.given,
        a.correct ? 1 : 0,
        a.fast ? 1 : 0,
        a.responseMs,
        a.answeredAt,
      ],
    );
  }

  async appendAttempt(a: AttemptRecord): Promise<void> {
    await this.execAppendAttempt((t, params) => this.pool.query(t, params), a);
  }

  async recordAnswer(w: AnswerWrite): Promise<void> {
    // One transaction (and one connection checkout) for the per-answer write
    // set — fewer round-trips on the hottest path, and progress can never
    // persist without its attempt row.
    await this.withTransaction(async (q) => {
      await this.execUpsertProgress(q, w.progress);
      if (w.stat) await this.execUpsertOperationStat(q, w.stat);
      if (w.siblingProgress) await this.execUpsertProgress(q, w.siblingProgress);
      await this.execAppendAttempt(q, w.attempt);
      if (w.workingState) {
        await q('UPDATE session SET working_state = $1 WHERE id = $2', [
          w.workingState.json,
          w.workingState.sessionId,
        ]);
      }
    });
  }

  async listSessionAttempts(sessionId: string): Promise<AttemptRecord[]> {
    const rows = await this.rows<AttemptRow>(
      'SELECT * FROM attempt WHERE session_id = $1 ORDER BY answered_at',
      [sessionId],
    );
    return rows.map(toAttempt);
  }

  async listProfileAttempts(profileId: string, since: number): Promise<AttemptRecord[]> {
    const rows = await this.rows<AttemptRow>(
      'SELECT * FROM attempt WHERE profile_id = $1 AND answered_at >= $2 ORDER BY answered_at',
      [profileId, since],
    );
    return rows.map(toAttempt);
  }

  async listAllAttempts(since: number): Promise<AttemptRecord[]> {
    const rows = await this.rows<AttemptRow>(
      'SELECT * FROM attempt WHERE answered_at >= $1 ORDER BY answered_at',
      [since],
    );
    return rows.map(toAttempt);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// --- row mappers (snake_case → domain) ---

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
    answeredAt: Number(r.answered_at),
  };
}

function toSession(r: SessionRow): SessionRecord {
  return {
    id: r.id,
    profileId: r.profile_id,
    startedAt: Number(r.started_at),
    completedAt: r.completed_at === null ? null : Number(r.completed_at),
    plannedCount: r.planned_count,
    workingState: r.working_state,
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
    coins: Number(r.coins),
    theme: r.theme,
    createdAt: Number(r.created_at),
  };
}
function toProgress(r: ProgressRow): FactProgress {
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
function toOperationStat(r: OperationStatRow): OperationStat {
  return {
    profileId: r.profile_id,
    operation: r.operation as Operation,
    medianMsEwma: r.median_ms_ewma,
    correctSamples: r.correct_samples,
  };
}
