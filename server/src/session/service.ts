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
import { familyHint, generateFactsForSets } from '../engine/facts';
import { gradeAnswer } from '../engine/grade';
import { buildBoard, makeRng, pickRelation, seedFrom } from '../engine/munch';
import { planSession } from '../engine/planner';
import { fluencyThreshold } from '../engine/threshold';

const OPERATIONS: Operation[] = ['add', 'sub', 'mul', 'div'];

/** How many cards later a missed/learning fact is re-shown (incremental
 *  rehearsal, DESIGN.md §4.4). */
const REHEARSAL_GAP = 3;

/** Upper bound on a single reported response time (ms). Anything slower is
 *  capped before it feeds stats — see `answer()`. */
const MAX_RESPONSE_MS = 60_000;

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
async function bumpStreak(
  db: Db,
  profileId: string,
  timezone: string,
  now: number,
): Promise<number> {
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
  retried = false,
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
        muncher: await db.getEquippedMuncher(profileId),
        effect: await db.getEquippedEffect(profileId),
      };
    }
    // Nothing left to resume (or a different day): close it and plan fresh.
    await db.completeSession(open.id, now);
  }

  const facts = generateFactsForSets(sets);
  const progressByFactId = new Map((await db.getProgress(profileId)).map((p) => [p.factId, p]));
  const sessionId = randomUUID();
  const deck = planSession({
    facts,
    progressByFactId,
    now,
    sessionCards: profile.settings.sessionCards,
    newPerSession: profile.settings.newPerSession,
  }).map((card, i) => {
    // Frame a new sub/div intro with its known inverse sibling (DESIGN.md §9).
    const hint = card.isNew ? familyHint(card.fact) : null;
    // A munch board per round; seeded per (session, fact, index) for variety,
    // and persisted in workingState so resume replays the identical board.
    const rng = makeRng(seedFrom(`${sessionId}:${card.fact.id}:${i}`));
    const relation = pickRelation(card.answer, rng);
    const board = buildBoard({ target: card.answer, relation, rng });
    return { ...card, ...(hint ? { family: hint } : {}), board };
  });

  const workingState: WorkingState = { deck, learning: {} };
  try {
    await db.createSession({
      id: sessionId,
      profileId,
      startedAt: now,
      completedAt: null,
      plannedCount: deck.length,
      workingState: JSON.stringify(workingState),
    });
  } catch (err) {
    // A concurrent start (double-tap / two tabs) won the race and created the
    // one allowed open session (idx_session_one_open). Re-enter once to resume
    // *that* session instead of surfacing a raw 500. The guard prevents loops.
    if (!retried) return startSession(db, accountId, profileId, now, true);
    throw err;
  }

  return {
    sessionId,
    deck,
    thresholds: await computeThresholds(db, profileId),
    sessionSeconds: profile.settings.sessionSeconds,
    theme: profile.theme,
    muncher: await db.getEquippedMuncher(profileId),
    effect: await db.getEquippedEffect(profileId),
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
    typeof body?.correct !== 'boolean' ||
    typeof body?.responseMs !== 'number' ||
    !Number.isFinite(body.responseMs) ||
    body.responseMs < 0
  ) {
    throw new SessionError(400, 'invalid_answer');
  }
  // Clamp the client-reported latency before it feeds the per-op median EWMA
  // (DESIGN.md §4.5). A buggy/hostile client sending a huge value shouldn't be
  // able to skew the fluency threshold; the server is the source of truth.
  const responseMs = Math.min(body.responseMs, MAX_RESPONSE_MS);

  const session = await db.getSession(sessionId);
  if (!session) throw new SessionError(404, 'session_not_found');
  await requireOwnedProfile(db, accountId, session.profileId);
  if (session.completedAt) throw new SessionError(409, 'session_completed');

  const ws: WorkingState = JSON.parse(session.workingState);
  const card = ws.deck.find((c) => c.fact.id === body.factId);
  if (!card) throw new SessionError(400, 'fact_not_in_session');

  const { fact } = card;
  const { profileId } = session;
  // These three reads are independent — fetch them concurrently to cut the
  // per-answer round-trip latency (this is the hot path of a session).
  const [progress, statRow, accountTz] = await Promise.all([
    db.getProgressForFact(profileId, body.factId),
    db.getOperationStat(profileId, fact.operation),
    db.getAccountTimezone(accountId),
  ]);
  const stat = statRow ?? zeroStat(profileId, fact.operation);
  const timezone = accountTz ?? 'UTC';

  const result = gradeAnswer({
    fact,
    correct: body.correct,
    responseMs,
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
    // `given` repurposed for munch: count of wrong munches this round (signal
    // for future tuning; not used in grading or aggregation). Clamp the
    // client-reported value the same way as responseMs.
    given:
      typeof body.wrongMunches === 'number' && Number.isFinite(body.wrongMunches)
        ? Math.min(Math.max(0, Math.trunc(body.wrongMunches)), 999)
        : 0,
    correct: result.correct,
    fast: result.fast,
    responseMs,
    answeredAt: now,
  });

  // Track the box-0 counter only while the fact is still learning.
  if (result.progress.box === 0) ws.learning[body.factId] = result.inSessionCorrect;
  else delete ws.learning[body.factId];
  await db.updateSessionWorkingState(sessionId, JSON.stringify(ws));

  // Caught up = today's work done: nothing due to review AND nothing still
  // being learned (DESIGN.md §4.10). Independent counts → fetch concurrently.
  const [dueReview, learning] = await Promise.all([
    db.countDueReview(profileId, now),
    db.countLearning(profileId),
  ]);

  return {
    correct: result.correct,
    fast: result.fast,
    updatedProgress: result.progress,
    injects: result.requeue ? [{ factId: body.factId, afterOffset: REHEARSAL_GAP }] : undefined,
    caughtUp: dueReview === 0 && learning === 0,
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

  const attempts = await db.listSessionAttempts(sessionId);
  let correct = 0;
  let fastCorrect = 0;
  for (const a of attempts) {
    if (a.correct) correct++;
    if (a.fast) fastCorrect++;
  }
  const pointsEarned = correct + fastCorrect; // +1 correct, +1 fast bonus (§10)

  // Mark complete and credit coins in one transaction, so a crash can't finish
  // the session without awarding its coins. Credited exactly once, on the
  // transition to completed — reopening the summary (or a double POST) can't
  // farm coins (§10).
  if (firstCompletion) {
    await db.completeSessionAndAward(sessionId, now, session.profileId, pointsEarned);
  }

  const timezone = (await db.getAccountTimezone(accountId)) ?? 'UTC';
  const streak = await bumpStreak(db, session.profileId, timezone, now);
  const { coins } = await db.getProfileReward(session.profileId);

  // Facts that reached box 5 (mastered) this session. Load all progress once
  // and look up in-memory rather than querying per fact (avoids an N+1 over the
  // ~20 facts in a session).
  const progressByFact = new Map(
    (await db.getProgress(session.profileId)).map((p) => [p.factId, p]),
  );
  let mastered = 0;
  for (const factId of new Set(attempts.map((a) => a.factId))) {
    if (progressByFact.get(factId)?.box === 5) mastered++;
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
