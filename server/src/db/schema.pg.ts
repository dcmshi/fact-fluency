/**
 * Postgres schema — the same model as schema.ts (DESIGN.md §6) with PG types:
 * BIGINT for epoch-ms columns (INTEGER is 32-bit and would overflow), SMALLINT
 * for the boolean attempt flags (kept numeric to match the adapter's row
 * mapping), and DOUBLE PRECISION for the rolling EWMA stats.
 */
export const SCHEMA_PG = /* sql */ `
CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  timezone      TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_session (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_session_account ON auth_session(account_id);

CREATE TABLE IF NOT EXISTS profile (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  avatar          TEXT NOT NULL,
  settings        TEXT NOT NULL,
  streak          INTEGER NOT NULL DEFAULT 0,
  last_played_day TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_account ON profile(account_id);

CREATE TABLE IF NOT EXISTS profile_fact_set (
  profile_id  TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  fact_set_id TEXT NOT NULL,
  enabled     SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (profile_id, fact_set_id)
);

CREATE TABLE IF NOT EXISTS fact_progress (
  profile_id     TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  fact_id        TEXT NOT NULL,
  box            SMALLINT NOT NULL,
  state          TEXT NOT NULL,
  due_at         BIGINT NOT NULL,
  last_seen_at   BIGINT NOT NULL,
  reps           INTEGER NOT NULL DEFAULT 0,
  fast_correct   INTEGER NOT NULL DEFAULT 0,
  correct_streak INTEGER NOT NULL DEFAULT 0,
  accuracy_ewma  DOUBLE PRECISION NOT NULL DEFAULT 0,
  median_ms_ewma DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, fact_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_due ON fact_progress(profile_id, due_at);

CREATE TABLE IF NOT EXISTS operation_stat (
  profile_id      TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  operation       TEXT NOT NULL,
  median_ms_ewma  DOUBLE PRECISION NOT NULL DEFAULT 0,
  correct_samples INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, operation)
);

CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  started_at    BIGINT NOT NULL,
  completed_at  BIGINT,
  planned_count INTEGER NOT NULL,
  working_state TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempt (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
  fact_id     TEXT NOT NULL,
  given       INTEGER NOT NULL,
  correct     SMALLINT NOT NULL,
  fast        SMALLINT NOT NULL,
  response_ms INTEGER NOT NULL,
  answered_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_session ON attempt(session_id);
CREATE INDEX IF NOT EXISTS idx_attempt_profile_time ON attempt(profile_id, answered_at);

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

CREATE TABLE IF NOT EXISTS profile_muncher (
  profile_id TEXT PRIMARY KEY REFERENCES profile(id) ON DELETE CASCADE,
  muncher    TEXT NOT NULL DEFAULT 'cat'
);

CREATE TABLE IF NOT EXISTS profile_effect (
  profile_id TEXT PRIMARY KEY REFERENCES profile(id) ON DELETE CASCADE,
  effect     TEXT NOT NULL DEFAULT 'confetti'
);
`;
