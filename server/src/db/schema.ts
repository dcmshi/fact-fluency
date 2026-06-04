/**
 * SQL schema — DESIGN.md §6. Kept as an inlined string (not a .sql file) so it
 * survives esbuild bundling without runtime file-path lookups. DDL is
 * idempotent (IF NOT EXISTS) so applying it doubles as a lightweight migration.
 *
 * The FactSet *catalog* is not stored — it lives in code (data/catalog.ts);
 * only each profile's enabled set ids are persisted.
 */
export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_session (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_session_account ON auth_session(account_id);

CREATE TABLE IF NOT EXISTS profile (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  avatar          TEXT NOT NULL,
  settings        TEXT NOT NULL,        -- JSON: ProfileSettings
  streak          INTEGER NOT NULL DEFAULT 0,
  last_played_day TEXT,                 -- YYYY-MM-DD in the account timezone
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_account ON profile(account_id);

CREATE TABLE IF NOT EXISTS profile_fact_set (
  profile_id  TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  fact_set_id TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, fact_set_id)
);

CREATE TABLE IF NOT EXISTS fact_progress (
  profile_id     TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  fact_id        TEXT NOT NULL,
  box            INTEGER NOT NULL,
  state          TEXT NOT NULL,
  due_at         INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  reps           INTEGER NOT NULL DEFAULT 0,
  fast_correct   INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  accuracy_ewma  REAL NOT NULL DEFAULT 0,
  median_ms_ewma REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, fact_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_due ON fact_progress(profile_id, due_at);

CREATE TABLE IF NOT EXISTS operation_stat (
  profile_id     TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  operation      TEXT NOT NULL,
  median_ms_ewma REAL NOT NULL DEFAULT 0,
  correct_samples INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, operation)
);

-- Play session (DESIGN.md §4.9). Methods land with the session layer; the
-- table is defined now so migrations are complete.
CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER,
  planned_count INTEGER NOT NULL,
  working_state TEXT NOT NULL            -- JSON: in-session queue + box-0 counters
);

-- Append-only attempt log (DESIGN.md §6).
CREATE TABLE IF NOT EXISTS attempt (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  fact_id     TEXT NOT NULL,
  given       INTEGER NOT NULL,
  correct     INTEGER NOT NULL,
  fast        INTEGER NOT NULL,
  response_ms INTEGER NOT NULL,
  answered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_session ON attempt(session_id);
CREATE INDEX IF NOT EXISTS idx_attempt_profile_time ON attempt(profile_id, answered_at);

-- Reward economy (roadmap v1.1). Additive tables so adding the feature needs
-- no ALTER of the existing profile table. coins = spendable balance; theme =
-- equipped palette id (equipped avatar stays on profile.avatar).
CREATE TABLE IF NOT EXISTS profile_reward (
  profile_id TEXT PRIMARY KEY REFERENCES profile(id) ON DELETE CASCADE,
  coins      INTEGER NOT NULL DEFAULT 0,
  theme      TEXT NOT NULL DEFAULT 'classic'
);

CREATE TABLE IF NOT EXISTS profile_unlock (
  profile_id TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  PRIMARY KEY (profile_id, item_id)
);
`;
