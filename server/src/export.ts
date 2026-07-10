/**
 * Profile data export (DESIGN.md §9 "data portability"). Lets an adult download
 * a kid's full attempt log + current progress — for a tutor, a records archive,
 * or peace of mind. Read-only; the IO is here, CSV shaping is a pure helper.
 */
import type { Profile } from '@shared';
import type { AttemptRecord, Db } from './db';

export interface ProfileExport {
  profile: { id: string; displayName: string };
  exportedAt: number;
  progress: Awaited<ReturnType<Db['getProgress']>>;
  attempts: AttemptRecord[];
}

/** Gather everything stored for a profile (ownership checked by middleware). */
export async function buildExport(db: Db, profile: Profile, now: number): Promise<ProfileExport> {
  const [progress, attempts] = await Promise.all([
    db.getProgress(profile.id),
    db.listProfileAttempts(profile.id, 0), // since epoch 0 = all time
  ]);
  return {
    profile: { id: profile.id, displayName: profile.displayName },
    exportedAt: now,
    progress,
    attempts,
  };
}

/** Escape one CSV cell (RFC 4180): quote if it contains a comma, quote, or newline. */
function csvCell(value: string | number | boolean): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The attempt log as CSV — the most analysis-friendly slice for a tutor. */
export function attemptsToCsv(attempts: AttemptRecord[]): string {
  const header = ['answeredAt', 'factId', 'correct', 'fast', 'responseMs', 'wrongMunches'];
  const rows = attempts.map((a) => [
    new Date(a.answeredAt).toISOString(),
    a.factId,
    a.correct,
    a.fast,
    a.responseMs,
    a.given, // `given` carries wrong-munch count for the munch interaction
  ]);
  return [header, ...rows].map((cols) => cols.map(csvCell).join(',')).join('\r\n');
}
