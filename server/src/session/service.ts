/**
 * Session orchestration (DESIGN.md §4.9). The pure engine decides *what*
 * happens (planSession, gradeAnswer); this layer does the IO: loads state,
 * persists results, and shapes the client DTOs. The client holds the deck and
 * reports answers; the server replies with injects + caught-up status.
 */
import { randomUUID } from 'node:crypto';
import type {
  AnswerRequest,
  AnswerResponse,
  Card,
  Operation,
  OperationStat,
  SessionResponse,
  SessionSummary,
  Thresholds,
} from '@shared';
import { SEED_CATALOG } from '../data/catalog';
import type { Db, SessionRecord } from '../db';
import { generateFactsForSets } from '../engine/facts';
import { gradeAnswer } from '../engine/grade';
import { planSession } from '../engine/planner';
import { fluencyThreshold } from '../engine/threshold';

const OPERATIONS: Operation[] = ['add', 'sub', 'mul', 'div'];

/** How many cards later a missed/learning fact is re-shown (incremental
 *  rehearsal, DESIGN.md §4.4). */
const REHEARSAL_GAP = 3;

/** Opaque per-session working state persisted as JSON (DESIGN.md §4.9). */
interface WorkingState {
  deck: Card[];
  /** In-session correct counters for box-0 facts (graduation, §4.3). */
  learning: Record<string, number>;
}

/** A service-level error carrying the HTTP status the handler should return. */
export class SessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const zeroStat = (profileId: string, operation: Operation): OperationStat => ({
  profileId,
  operation,
  medianMsEwma: 0,
  correctSamples: 0,
});

/** Minutes east of UTC for an IANA timezone at a given instant (DST-aware). */
function tzOffsetMinutes(timeZone: string, atMs: number): number {
  try {
    const d = new Date(atMs);
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    const local = new Date(d.toLocaleString('en-US', { timeZone }));
    return Math.round((local.getTime() - utc.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** Calendar day (YYYY-MM-DD) for an instant in a timezone. en-CA yields ISO. */
export function dayInTz(timeZone: string, atMs: number): string {
  try {
    return new Date(atMs).toLocaleDateString('en-CA', { timeZone });
  } catch {
    return new Date(atMs).toLocaleDateString('en-CA');
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Update the day streak on session completion (DESIGN.md §4.10): same day → no
 * change; yesterday → +1; otherwise → reset to 1. Idempotent for the same day.
 */
async function bumpStreak(db: Db, profileId: string, timezone: string, now: number): Promise<number> {
  const today = dayInTz(timezone, now);
  const { streak, lastPlayedDay } = await db.getProfileStreak(profileId);
  if (lastPlayedDay === today) return streak;
  const yesterday = dayInTz(timezone, now - DAY_MS);
  const next = lastPlayedDay === yesterday ? streak + 1 : 1;
  await db.setProfileStreak(profileId, next, today);
  return next;
}

export async function requireOwnedProfile(db: Db, accountId: string, profileId: string) {
  const profile = await db.getProfile(profileId);
  if (!profile || profile.accountId !== accountId) {
    throw new SessionError(404, 'profile_not_found');
  }
  return profile;
}

/** Current per-operation fast cutoffs for a profile (DESIGN.md §4.5). */
async function computeThresholds(db: Db, profileId: string): Promise<Thresholds> {
  const stats = await db.getOperationStats(profileId);
  const statByOp = new Map(stats.map((s) => [s.operation, s]));
  const thresholds = {} as Thresholds;
  for (const op of OPERATIONS) {
    thresholds[op] = fluencyThreshold(op, statByOp.get(op) ?? zeroStat(profileId, op));
  }
  return thresholds;
}

/**
 * Reconstruct the cards still worth playing in an interrupted session
 * (DESIGN.md §10). A planned card is dropped once its fact has been answered
 * *and* has left the learning phase (box ≥ 1); facts never answered keep their
 * place (and their study-first `isNew`), and facts still learning are kept but
 * no longer flagged new — they were already studied today.
 */
async function buildResumeDeck(db: Db, session: SessionRecord, profileId: string): Promise<Card[]> {
  const ws: WorkingState = JSON.parse(session.workingState);
  const attempts = await db.listSessionAttempts(session.id);
  const answered = new Set(attempts.map((a) => a.factId));
  const progressByFactId = new Map((await db.getProgress(profileId)).map((p) => [p.factId, p]));

  const remaining: Card[] = [];
  for (const card of ws.deck) {
    if (!answered.has(card.fact.id)) {
      remaining.push(card);
      continue;
    }
    if (progressByFactId.get(card.fact.id)?.box === 0) {
      remaining.push({ ...card, isNew: false });
    }
  }
  return remaining;
}

export async function startSession(
  db: Db,
  accountId: string,
  profileId: string,
  now: number,
): Promise<SessionResponse> {
  const profile = await requireOwnedProfile(db, accountId, profileId);

  const enabled = new Set(await db.listEnabledSetIds(profileId));
  const sets = SEED_CATALOG.filter((s) => enabled.has(s.id));
  if (sets.length === 0) throw new SessionError(400, 'no_enabled_sets');

  // Resume an interrupted session reopened the same day; otherwise discard a
  // stale open session and plan fresh (DESIGN.md §10, one active session/profile).
  const timezone = (await db.getAccountTimezone(accountId)) ?? 'UTC';
  const open = await db.getOpenSession(profileId);
  if (open) {
    const sameDay = dayInTz(timezone, open.startedAt) === dayInTz(timezone, now);
    const resumeDeck = sameDay ? await buildResumeDeck(db, open, profileId) : [];
    if (resumeDeck.length > 0) {
      return {
        sessionId: open.id,
        deck: resumeDeck,
        thresholds: await computeThresholds(db, profileId),
        sessionSeconds: profile.settings.sessionSeconds,
        theme: profile.theme,
      };
    }
    // Nothing left to resume (or a different day): close it and plan fresh.
    await db.completeSession(open.id, now);
  }

  const facts = generateFactsForSets(sets);
  const progressByFactId = new Map((await db.getProgress(profileId)).map((p) => [p.factId, p]));
  const deck = planSession({
    facts,
    progressByFactId,
    now,
    sessionCards: profile.settings.sessionCards,
    newPerSession: profile.settings.newPerSession,
  });

  const sessionId = randomUUID();
  const workingState: WorkingState = { deck, learning: {} };
  await db.createSession({
    id: sessionId,
    profileId,
    startedAt: now,
    completedAt: null,
    plannedCount: deck.length,
    workingState: JSON.stringify(workingState),
  });

  return {
    sessionId,
    deck,
    thresholds: await computeThresholds(db, profileId),
    sessionSeconds: profile.settings.sessionSeconds,
    theme: profile.theme,
  };
}

export async function answer(
  db: Db,
  accountId: string,
  sessionId: string,
  body: AnswerRequest,
  now: number,
): Promise<AnswerResponse> {
  if (
    typeof body?.factId !== 'string' ||
    typeof body?.given !== 'number' ||
    typeof body?.responseMs !== 'number'
  ) {
    throw new SessionError(400, 'invalid_answer');
  }

  const session = await db.getSession(sessionId);
  if (!session) throw new SessionError(404, 'session_not_found');
  await requireOwnedProfile(db, accountId, session.profileId);
  if (session.completedAt) throw new SessionError(409, 'session_completed');

  const ws: WorkingState = JSON.parse(session.workingState);
  const card = ws.deck.find((c) => c.fact.id === body.factId);
  if (!card) throw new SessionError(400, 'fact_not_in_session');

  const { fact } = card;
  const { profileId } = session;
  const progress = await db.getProgressForFact(profileId, body.factId);
  const stat =
    (await db.getOperationStat(profileId, fact.operation)) ?? zeroStat(profileId, fact.operation);
  const timezone = (await db.getAccountTimezone(accountId)) ?? 'UTC';

  const result = gradeAnswer({
    fact,
    given: body.given,
    responseMs: body.responseMs,
    now,
    progress,
    stat,
    inSessionCorrect: ws.learning[body.factId] ?? 0,
    tzOffsetMin: tzOffsetMinutes(timezone, now),
  });

  await db.upsertProgress(result.progress);
  if (result.correct) await db.upsertOperationStat(result.stat);
  await db.appendAttempt({
    id: randomUUID(),
    sessionId,
    profileId,
    factId: body.factId,
    given: body.given,
    correct: result.correct,
    fast: result.fast,
    responseMs: body.responseMs,
    answeredAt: now,
  });

  // Track the box-0 counter only while the fact is still learning.
  if (result.progress.box === 0) ws.learning[body.factId] = result.inSessionCorrect;
  else delete ws.learning[body.factId];
  await db.updateSessionWorkingState(sessionId, JSON.stringify(ws));

  return {
    correct: result.correct,
    fast: result.fast,
    updatedProgress: result.progress,
    injects: result.requeue ? [{ factId: body.factId, afterOffset: REHEARSAL_GAP }] : undefined,
    // Caught up = today's work done: nothing due to review AND nothing still
    // being learned (DESIGN.md §4.10).
    caughtUp:
      (await db.countDueReview(profileId, now)) === 0 && (await db.countLearning(profileId)) === 0,
  };
}

export async function complete(
  db: Db,
  accountId: string,
  sessionId: string,
  now: number,
): Promise<SessionSummary> {
  const session = await db.getSession(sessionId);
  if (!session) throw new SessionError(404, 'session_not_found');
  await requireOwnedProfile(db, accountId, session.profileId);
  const firstCompletion = !session.completedAt;
  if (firstCompletion) await db.completeSession(sessionId, now);

  const timezone = (await db.getAccountTimezone(accountId)) ?? 'UTC';
  const streak = await bumpStreak(db, session.profileId, timezone, now);

  const attempts = await db.listSessionAttempts(sessionId);
  const correct = attempts.filter((a) => a.correct).length;
  const fastCorrect = attempts.filter((a) => a.fast).length;
  const pointsEarned = correct + fastCorrect; // +1 correct, +1 fast bonus (§10)

  // Credit coins exactly once, on the transition to completed — so reopening
  // the summary (or a double POST) can't farm coins.
  if (firstCompletion && pointsEarned > 0) await db.addCoins(session.profileId, pointsEarned);
  const { coins } = await db.getProfileReward(session.profileId);

  // Facts that reached box 5 (mastered) this session.
  let mastered = 0;
  for (const factId of new Set(attempts.map((a) => a.factId))) {
    const p = await db.getProgressForFact(session.profileId, factId);
    if (p?.box === 5) mastered++;
  }

  return {
    cardsPlayed: attempts.length,
    correct,
    fastCorrect,
    mastered,
    pointsEarned,
    streak,
    coins,
  };
}
