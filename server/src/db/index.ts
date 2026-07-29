/**
 * DB adapter seam — DESIGN.md §5.1. App logic talks to this interface only, so
 * SQLite ↔ Postgres is a single swap. The concrete adapter is chosen from
 * DATABASE_URL's scheme (sqlite: vs postgres://). Implementations land with the
 * persistence work; this file pins the contract.
 */
import type { FactProgress, Operation, OperationStat, Profile, ProfileSettings } from '@shared';

/** A play session row (DESIGN.md §4.9). `workingState` is opaque JSON. */
export interface SessionRecord {
  id: string;
  profileId: string;
  startedAt: number;
  completedAt: number | null;
  plannedCount: number;
  workingState: string;
}

/** Everything one graded answer writes — applied atomically by `recordAnswer`. */
export interface AnswerWrite {
  progress: FactProgress;
  /** Updated per-op stat; omitted when the answer was wrong (stats track
   *  correct-answer speed only). */
  stat?: OperationStat;
  /** A family-transfer seed for the inverse sibling (rare; DESIGN.md §9). */
  siblingProgress?: FactProgress;
  attempt: AttemptRecord;
  /** New working-state JSON, only when the learning map changed. */
  workingState?: { sessionId: string; json: string };
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
  /** Client-supplied idempotency key for the round (optional — older clients
   *  and internal writers omit it). See `recordAnswer`. */
  attemptId?: string | null;
}

/** A multiplayer race: a short seeded deck every racer plays (MULTIPLAYER.md).
 *  Isolated from the scheduler + attempt log — race play never writes SR state. */
export interface RaceRecord {
  id: string;
  accountId: string;
  createdByProfileId: string;
  /** JSON: the shared seeded deck (Card[] with boards), served verbatim to all. */
  deck: string;
  factCount: number;
  createdAt: number;
}

/** One racer's finished run — a ghost (per-round splits) + a leaderboard entry. */
export interface RaceRunRecord {
  id: string;
  raceId: string;
  profileId: string;
  totalMs: number;
  correctCount: number;
  /** JSON: number[] per-round ms — the ghost's splits. */
  perRound: string;
  finishedAt: number;
}

export interface Db {
  /** Apply the schema (idempotent). SQLite does this in its constructor too. */
  migrate(): Promise<void>;

  // --- accounts & auth ---
  createAccount(email: string, passwordHash: string, timezone: string): Promise<string>;
  /** Create an anonymous "play for fun" account (no real email/password);
   *  returns its id. The caller creates a default profile + session. */
  createGuestAccount(timezone: string): Promise<string>;
  /** Whether an account is still an anonymous guest. */
  isGuestAccount(accountId: string): Promise<boolean>;
  /** Attach real credentials to a guest account (sets email/password, clears
   *  the guest flag), keeping its id + data. Returns false if the account isn't
   *  a guest (already upgraded / a real account). */
  upgradeGuestAccount(accountId: string, email: string, passwordHash: string): Promise<boolean>;
  findAccountByEmail(email: string): Promise<{ id: string; passwordHash: string } | null>;
  createAuthSession(accountId: string, token: string, expiresAt: number): Promise<void>;
  findAccountIdByToken(token: string): Promise<string | null>;
  /** Slide a still-valid session's expiry forward to `newExpiresAt`, but only if
   *  it currently expires before `onlyIfBelow` (throttles writes to ~once/day).
   *  Returns true if a row was updated, so the caller can re-issue the cookie. */
  slideAuthSession(
    token: string,
    now: number,
    newExpiresAt: number,
    onlyIfBelow: number,
  ): Promise<boolean>;
  deleteAuthSession(token: string): Promise<void>;
  /** Revoke every session on an account except `exceptToken` (pass null to
   *  revoke all). This is what makes a password change able to evict a stolen
   *  or shared session — without it a live cookie slides forward forever.
   *  Returns the number revoked. */
  deleteAuthSessionsForAccount(accountId: string, exceptToken: string | null): Promise<number>;
  /** Delete auth sessions that expired at/before `now`; returns the count. */
  deleteExpiredAuthSessions(now: number): Promise<number>;
  /** Delete guest accounts with no unexpired auth session — their cookie is
   *  gone, so they're unreachable. Cascades to their profiles/progress.
   *  Returns the count. */
  deleteExpiredGuests(now: number): Promise<number>;

  getAccountTimezone(accountId: string): Promise<string | null>;
  /** Account fields a parent can view/edit (no password hash). */
  getAccount(accountId: string): Promise<{ email: string; timezone: string } | null>;
  /** The stored hash, for re-authenticating a sensitive change (password/email
   *  edit, account deletion). Null for an account with no password (a guest). */
  getAccountPasswordHash(accountId: string): Promise<string | null>;
  updateAccountEmail(accountId: string, email: string): Promise<void>;
  updateAccountPassword(accountId: string, passwordHash: string): Promise<void>;
  updateAccountTimezone(accountId: string, timezone: string): Promise<void>;
  /** Delete an account and (via ON DELETE CASCADE) every profile, session,
   *  attempt, reward, and auth session under it. Right-to-erasure. */
  deleteAccount(accountId: string): Promise<void>;

  // --- profiles ---
  listProfiles(accountId: string): Promise<Profile[]>;
  getProfile(profileId: string): Promise<Profile | null>;
  createProfile(
    p: Omit<Profile, 'id' | 'createdAt' | 'streak' | 'coins' | 'theme'>,
  ): Promise<Profile>;
  updateProfileSettings(profileId: string, settings: ProfileSettings): Promise<Profile>;
  updateProfileName(profileId: string, displayName: string): Promise<void>;
  updateProfileAvatar(profileId: string, avatar: string): Promise<void>;
  /** Delete a profile and (via ON DELETE CASCADE) all its progress, attempts,
   *  sessions, and rewards. */
  deleteProfile(profileId: string): Promise<void>;

  // --- rewards (roadmap v1.1) ---
  getProfileReward(profileId: string): Promise<{ coins: number; theme: string }>;
  /** Add (or subtract) coins; upserts the reward row. */
  addCoins(profileId: string, delta: number): Promise<void>;
  setProfileTheme(profileId: string, theme: string): Promise<void>;
  getEquippedMuncher(profileId: string): Promise<string>;
  setEquippedMuncher(profileId: string, muncher: string): Promise<void>;
  getEquippedEffect(profileId: string): Promise<string>;
  setEquippedEffect(profileId: string, effect: string): Promise<void>;
  listUnlocks(profileId: string): Promise<string[]>;
  /** Remove an unlock row (consumes a perk, e.g. the spent streak shield);
   *  returns whether a row existed. */
  removeUnlock(profileId: string, itemId: string): Promise<boolean>;
  /** Atomically claim an item and debit `cost` coins in one transaction.
   *  Prevents a concurrent coin award being clobbered (vs read-modify-write
   *  setCoins) and a double-spend from two concurrent unlocks of one item. */
  spendAndUnlock(
    profileId: string,
    itemId: string,
    cost: number,
  ): Promise<
    { status: 'ok'; coins: number } | { status: 'insufficient' } | { status: 'already_owned' }
  >;
  getProfileStreak(profileId: string): Promise<{ streak: number; lastPlayedDay: string | null }>;
  setProfileStreak(profileId: string, streak: number, day: string): Promise<void>;

  // --- fact sets ---
  listEnabledSetIds(profileId: string): Promise<string[]>;
  setEnabledSetIds(profileId: string, setIds: string[]): Promise<void>;

  // --- progress & stats ---
  getProgress(profileId: string): Promise<FactProgress[]>;
  getProgressForFact(profileId: string, factId: string): Promise<FactProgress | null>;
  upsertProgress(p: FactProgress): Promise<void>;
  /** Count due review facts (box ≥ 1, dueAt ≤ now) — drives "all caught up".
   *  Pass `factIds` to scope to the currently enabled fact universe, so a
   *  disabled set's lingering rows don't keep the kid from ever catching up. */
  countDueReview(profileId: string, now: number, factIds?: string[]): Promise<number>;
  /** Count facts still in the learning phase (box 0); `factIds` scopes as above. */
  countLearning(profileId: string, factIds?: string[]): Promise<number>;
  getOperationStats(profileId: string): Promise<OperationStat[]>;
  getOperationStat(profileId: string, operation: Operation): Promise<OperationStat | null>;
  upsertOperationStat(s: OperationStat): Promise<void>;

  // --- sessions & attempts ---
  createSession(s: SessionRecord): Promise<void>;
  getSession(id: string): Promise<SessionRecord | null>;
  /** Most recent not-yet-completed session for a profile, or null. Backs
   *  same-day resume (DESIGN.md §10); at most one is expected to be open. */
  getOpenSession(profileId: string): Promise<SessionRecord | null>;
  updateSessionWorkingState(id: string, workingState: string): Promise<void>;
  completeSession(id: string, completedAt: number): Promise<void>;
  /** Mark a session completed and credit `coinDelta` coins in one transaction,
   *  so a crash can't finish the session without awarding its coins (DESIGN.md
   *  §10, coins credited exactly once on completion). `coinDelta` ≤ 0 just
   *  completes. The transition is conditional on the session still being open,
   *  and returns whether *this* call won it — so two concurrent completes (a
   *  double POST, or the play screen racing a reconnect replay) can't both
   *  award; the loser must take the repeat-completion path. */
  completeSessionAndAward(
    sessionId: string,
    completedAt: number,
    profileId: string,
    coinDelta: number,
  ): Promise<boolean>;
  appendAttempt(a: AttemptRecord): Promise<void>;
  /** Persist one graded answer atomically: the fact's progress row, the
   *  (optional) per-op stat, the (optional) family-transfer sibling seed, the
   *  attempt-log row, and the (optional) working-state rewrite — one
   *  transaction instead of 4-5 separate commits/round-trips on the hottest
   *  path, and a crash can't persist progress without its attempt row. */
  /** Apply one graded answer atomically. If the attempt carries an `attemptId`
   *  already present for that session, nothing is written and this returns
   *  false — a replayed report (its response was lost, not its effect) must not
   *  advance the schedule a second time. */
  recordAnswer(w: AnswerWrite): Promise<boolean>;
  listSessionAttempts(sessionId: string): Promise<AttemptRecord[]>;
  /** All of a profile's attempts at/after `since` (epoch ms), oldest first —
   *  backs the dashboard trends (DESIGN.md §7). */
  listProfileAttempts(profileId: string, since: number): Promise<AttemptRecord[]>;
  /** Every attempt at/after `since` across all profiles — backs the offline
   *  calibration analysis (DESIGN.md §4.5). Read-only/ops use. */
  listAllAttempts(since: number): Promise<AttemptRecord[]>;

  // --- races (MULTIPLAYER.md) ---
  createRace(r: RaceRecord): Promise<void>;
  getRace(id: string): Promise<RaceRecord | null>;
  /** Recent races under an account, newest first — for the race lobby. */
  listRacesForAccount(accountId: string, limit: number): Promise<RaceRecord[]>;
  addRaceRun(run: RaceRunRecord): Promise<void>;
  /** All runs for a race, fastest-first — the leaderboard + ghosts. */
  listRaceRuns(raceId: string): Promise<RaceRunRecord[]>;

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

/**
 * Open the DB selected by DATABASE_URL. Call `migrate()` before serving.
 *
 * The adapter module is required lazily so each environment only loads its own
 * driver: a Postgres deploy (Render) never pulls in the native `better-sqlite3`
 * binary, and a local SQLite run never loads `pg`. Mirrors the lazy `pg` load
 * inside `PostgresDb.fromUrl`.
 */
export function createDb(databaseUrl: string): Db {
  const kind = adapterKindFor(databaseUrl);
  if (kind === 'sqlite') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load: keep the native driver out of a Postgres deploy
    const { SqliteDb } = require('./sqlite') as typeof import('./sqlite');
    return new SqliteDb(parseSqliteFilename(databaseUrl));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy load: keep `pg` out of a SQLite-only run
  const { PostgresDb } = require('./postgres') as typeof import('./postgres');
  return PostgresDb.fromUrl(databaseUrl);
}
