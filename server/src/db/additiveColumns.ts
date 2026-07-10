/**
 * Additive-column migrations, declared once for both adapters. `CREATE TABLE
 * IF NOT EXISTS` can't add a column to a table that already exists, so any
 * column introduced after a deploy needs an explicit backfill: Postgres runs
 * an idempotent `ADD COLUMN IF NOT EXISTS`; SQLite (which lacks IF NOT EXISTS
 * on ADD COLUMN) checks `PRAGMA table_info` first. Append here when adding a
 * column to an existing table.
 */
export const ADDITIVE_COLUMNS: {
  table: string;
  column: string;
  sqliteDecl: string;
  pgDecl: string;
}[] = [
  {
    table: 'account',
    column: 'is_guest',
    sqliteDecl: 'INTEGER NOT NULL DEFAULT 0',
    pgDecl: 'SMALLINT NOT NULL DEFAULT 0',
  },
];
