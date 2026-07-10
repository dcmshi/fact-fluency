/**
 * Adult dashboard view (DESIGN.md §7) — accuracy/speed trends from the attempt
 * log plus a "what to enable next" suggestion. The IO lives here; the actual
 * aggregation/heuristic is pure and unit-tested in engine/dashboard.ts.
 */
import type { DashboardView, DayTrend, Operation, Profile } from '@shared';
import { SEED_CATALOG } from './data/catalog';
import type { Db } from './db';
import { buildTrends, suggestNextSet, type SetMastery } from './engine/dashboard';
import { generateFactsForSets } from './engine/facts';
import { dayInTz } from './engine/scheduling';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 14;

/** The last `days` account-timezone calendar days, oldest first (DST-deduped). */
function recentDayKeys(timezone: string, now: number, days: number): string[] {
  const keys: string[] = [];
  for (let k = days - 1; k >= 0; k--) {
    const key = dayInTz(timezone, now - k * DAY_MS);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }
  return keys;
}

export async function getDashboardView(
  db: Db,
  profile: Profile,
  now: number,
): Promise<DashboardView> {
  const profileId = profile.id; // ownership checked by the route middleware
  const timezone = (await db.getAccountTimezone(profile.accountId)) ?? 'UTC';

  const enabledIds = new Set(await db.listEnabledSetIds(profileId));
  const progress = await db.getProgress(profileId);
  const progressByFactId = new Map(progress.map((p) => [p.factId, p]));

  // Mastery snapshot over the kid's currently-enabled facts.
  const enabledSets = SEED_CATALOG.filter((s) => enabledIds.has(s.id));
  const enabledFacts = generateFactsForSets(enabledSets);
  let mastered = 0;
  let review = 0;
  let learning = 0;
  let unseen = 0;
  for (const fact of enabledFacts) {
    const state = progressByFactId.get(fact.id)?.state;
    if (!state) unseen++;
    else if (state === 'mastered') mastered++;
    else if (state === 'review') review++;
    else learning++;
  }

  // Per-set mastery across the whole catalog → next-set suggestion.
  const setMastery: SetMastery[] = SEED_CATALOG.map((set) => {
    const facts = generateFactsForSets([set]);
    const masteredInSet = facts.filter(
      (f) => progressByFactId.get(f.id)?.state === 'mastered',
    ).length;
    return {
      setId: set.id,
      operation: set.operation as Operation,
      label: set.label,
      aMax: set.rangeSpec.aMax,
      total: facts.length,
      mastered: masteredInSet,
      enabled: enabledIds.has(set.id),
    };
  });
  const suggestion = suggestNextSet(setMastery);

  // Daily trends over the window.
  const dayKeys = recentDayKeys(timezone, now, WINDOW_DAYS);
  const attempts = await db.listProfileAttempts(profileId, now - WINDOW_DAYS * DAY_MS);
  const trends: DayTrend[] = buildTrends(attempts, dayKeys, (ms) => dayInTz(timezone, ms));

  const windowAttempts = trends.reduce((n, t) => n + t.attempts, 0);
  const windowCorrect = trends.reduce((n, t) => n + t.correct, 0);

  return {
    displayName: profile.displayName,
    streak: profile.streak,
    windowDays: WINDOW_DAYS,
    trends,
    summary: {
      totalFacts: enabledFacts.length,
      mastered,
      review,
      learning,
      unseen,
      attempts: windowAttempts,
      accuracy: windowAttempts ? windowCorrect / windowAttempts : 0,
      daysActive: trends.filter((t) => t.attempts > 0).length,
    },
    suggestion,
  };
}
