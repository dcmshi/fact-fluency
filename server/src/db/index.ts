/**
 * DB adapter seam — DESIGN.md §5.1. App logic talks to this interface only, so
 * SQLite ↔ Postgres is a single swap. The concrete adapter is chosen from
 * DATABASE_URL's scheme (sqlite: vs postgres://). Implementations land with the
 * persistence work; this file pins the contract.
 */
import type { FactProgress, OperationStat, Profile } from '@shared';

export interface Db {
  // --- accounts & auth ---
  createAccount(email: string, passwordHash: string, timezone: string): Promise<string>;
  findAccountByEmail(email: string): Promise<{ id: string; passwordHash: string } | null>;
  createAuthSession(accountId: string, token: string, expiresAt: number): Promise<void>;
  findAccountIdByToken(token: string): Promise<string | null>;
  deleteAuthSession(token: string): Promise<void>;

  // --- profiles ---
  listProfiles(accountId: string): Promise<Profile[]>;
  createProfile(p: Omit<Profile, 'id' | 'createdAt'>): Promise<Profile>;

  // --- fact sets ---
  listEnabledSetIds(profileId: string): Promise<string[]>;
  setEnabledSetIds(profileId: string, setIds: string[]): Promise<void>;

  // --- progress & stats ---
  getProgress(profileId: string): Promise<FactProgress[]>;
  upsertProgress(p: FactProgress): Promise<void>;
  getOperationStats(profileId: string): Promise<OperationStat[]>;
  upsertOperationStat(s: OperationStat): Promise<void>;

  close(): Promise<void>;
}

/**
 * Resolve which adapter a DATABASE_URL refers to. The adapters themselves are
 * implemented alongside the persistence layer.
 */
export function adapterKindFor(databaseUrl: string): 'sqlite' | 'postgres' {
  if (databaseUrl.startsWith('sqlite:')) return 'sqlite';
  if (databaseUrl.startsWith('postgres://') || databaseUrl.startsWith('postgresql://')) {
    return 'postgres';
  }
  throw new Error(`Unrecognized DATABASE_URL scheme: ${databaseUrl}`);
}
