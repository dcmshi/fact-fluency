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
  FactProgress,
  Operation,
  OperationStat,
  Profile,
  SessionResponse,
  SessionSummary,
  Thresholds,
} from '@shared';
import { SEED_CATALOG } from '../data/catalog';
import type { Db, SessionRecord } from '../db';
import { HttpError } from '../httpError';
import { familyHint, familyTransfer, generateFactsForSets, siblingFactId } from '../engine/facts';
import { gradeAnswer } from '../engine/grade';
import { buildBoard, makeRng, pickRelation, seedFrom } from '../engine/munch';
import { planSession } from '../engine/planner';
import { OPERATIONS } from '../engine/operations';
import { dayInTz, previousDay } from '../engine/scheduling';
import { fluencyThreshold } from '../engine/threshold';

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

const zeroStat = (profileId: string, operation: Operation): OperationStat => ({
  profileId,
  operation,
  medianMsEwma: 0,
  correctSamples: 0,
});

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
  const next = lastPlayedDay === previousDay(today) ? streak + 1 : 1;
  await db.setProfileStreak(profileId, next, today);
  return next;
}

/**
 * Close an open session and credit whatever it earned. Used when startSession
 * discards an open session (a prior-day one, or a same-day one with nothing
 * left to resume): the kid may have finished it offline, queuing a complete()
 * that will now no-op once completedAt is set — so its coins/streak must be
 * reconciled here, or the offline-finish promise ("coins update on reconnect")
 * is broken. A session with no attempts is just closed. completeSessionAndAward
 * sets completedAt transactionally, so the later queued complete() sees
 * firstCompletion=false and can't double-award.
 */
async function closeAndAward(
  db: Db,
  session: SessionRecord,
  timezone: string,
  now: number,
): Promise<void> {
  const attempts = await db.listSessionAttempts(session.id);
  if (attempts.length === 0) {
    await db.completeSession(session.id, now);
    return;
  }
  let correct = 0;
  let fastCorrect = 0;
  for (const a of attempts) {
    if (a.correct) correct++;
    if (a.fast) fastCorrect++;
  }
  const won = await db.completeSessionAndAward(
    session.id,
    now,
    session.profileId,
    correct + fastCorrect,
  );
  if (won) await bumpStreak(db, session.profileId, timezone, now);
}

export async function requireOwnedProfile(db: Db, accountId: string, profileId: string) {
  const profile = await db.getProfile(profileId);
  if (!profile || profile.accountId !== accountId) {
    throw new HttpError(404, 'profile_not_found');
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
  profile: Profile,
  now: number,
  retried = false,
): Promise<SessionResponse> {
  const { id: profileId, accountId } = profile;

  // Ownership was checked by the route middleware; these reads are independent — fetch them in
  // one round-trip batch rather than serially (matters most on Render Postgres,
  // where each await is a network hop). The response fields shared by both the
  // resume and fresh-plan branches come from here.
  const [enabledSetIds, accountTz, open, thresholds, muncher, effect] = await Promise.all([
    db.listEnabledSetIds(profileId),
    db.getAccountTimezone(accountId),
    db.getOpenSession(profileId),
    computeThresholds(db, profileId),
    db.getEquippedMuncher(profileId),
    db.getEquippedEffect(profileId),
  ]);
  const timezone = accountTz ?? 'UTC';
  const sets = SEED_CATALOG.filter((s) => enabledSetIds.includes(s.id));
  if (sets.length === 0) throw new HttpError(400, 'no_enabled_sets');

  const common = {
    thresholds,
    sessionSeconds: profile.settings.sessionSeconds,
    theme: profile.theme,
    muncher,
    effect,
  };

  // Resume an interrupted session reopened the same day; otherwise discard a
  // stale open session and plan fresh (DESIGN.md §10, one active session/profile).
  if (open) {
    const sameDay = dayInTz(timezone, open.startedAt) === dayInTz(timezone, now);
    const resumeDeck = sameDay ? await buildResumeDeck(db, open, profileId) : [];
    if (resumeDeck.length > 0) {
      return { sessionId: open.id, deck: resumeDeck, ...common };
    }
    // Nothing left to resume (or a different day): close it — crediting any
    // attempts it logged (e.g. an offline finish) — and plan fresh.
    await closeAndAward(db, open, timezone, now);
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
    if (!retried) return startSession(db, profile, now, true);
    throw err;
  }

  return { sessionId, deck, ...common };
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
    throw new HttpError(400, 'invalid_answer');
  }
  // Clamp the client-reported latency before it feeds the per-op median EWMA
  // (DESIGN.md §4.5). A buggy/hostile client sending a huge value shouldn't be
  // able to skew the fluency threshold; the server is the source of truth.
  // Round to an integer too: the attempt.response_ms column is INTEGER, and
  // Postgres (unlike SQLite) rejects a fractional value — which would 500
  // *after* progress already wrote.
  const responseMs = Math.round(Math.min(body.responseMs, MAX_RESPONSE_MS));

  const session = await db.getSession(sessionId);
  if (!session) throw new HttpError(404, 'session_not_found');
  await requireOwnedProfile(db, accountId, session.profileId);
  if (session.completedAt) throw new HttpError(409, 'session_completed');

  const ws: WorkingState = JSON.parse(session.workingState);
  const card = ws.deck.find((c) => c.fact.id === body.factId);
  if (!card) throw new HttpError(400, 'fact_not_in_session');

  const { fact } = card;
  const { profileId } = session;
  // These reads are independent — fetch them concurrently to cut the per-answer
  // round-trip latency (this is the hot path of a session).
  const [progress, statRow, accountTz, enabledSetIds] = await Promise.all([
    db.getProgressForFact(profileId, body.factId),
    db.getOperationStat(profileId, fact.operation),
    db.getAccountTimezone(accountId),
    db.listEnabledSetIds(profileId),
  ]);
  const stat = statRow ?? zeroStat(profileId, fact.operation);
  const timezone = accountTz ?? 'UTC';
  // The fact ids the planner can actually serve right now. Used to gate family
  // transfer and to scope "caught up" — facts from a disabled set still carry
  // progress (DESIGN.md §10) but can never be reviewed, so they must not seed
  // unreachable rows nor block the caught-up celebration.
  const enabledFactIds = new Set(
    generateFactsForSets(SEED_CATALOG.filter((s) => enabledSetIds.includes(s.id))).map((f) => f.id),
  );

  const result = gradeAnswer({
    fact,
    correct: body.correct,
    responseMs,
    now,
    progress,
    stat,
    inSessionCorrect: ws.learning[body.factId] ?? 0,
    timeZone: timezone,
  });

  // Fact-family scheduling transfer (DESIGN.md §9): when a sub/div fact is
  // freshly mastered, give its unseen inverse sibling a review head start.
  const newlyMastered = result.progress.box === 5 && (progress?.box ?? 0) < 5;
  const sibling = siblingFactId(fact);
  // Only seed a sibling the kid can actually reach — otherwise it becomes a due
  // row no session ever serves, stranding "all caught up" forever.
  let siblingSeed: FactProgress | undefined;
  if (newlyMastered && sibling && enabledFactIds.has(sibling)) {
    const siblingProgress = await db.getProgressForFact(profileId, sibling);
    siblingSeed =
      familyTransfer({
        fact,
        prevBox: progress?.box ?? 0,
        newBox: result.progress.box,
        profileId,
        siblingProgress,
        now,
        timeZone: timezone,
      }) ?? undefined;
  }

  // Track the box-0 counter only while the fact is still learning. Only persist
  // when the learning map actually changed — the deck half of workingState is
  // static, so for a review fact (the majority) this is a no-op, and rewriting
  // the whole 5-15 KB deck JSON on every answer is wasted IO.
  let learningChanged = false;
  if (result.progress.box === 0) {
    if (ws.learning[body.factId] !== result.inSessionCorrect) {
      ws.learning[body.factId] = result.inSessionCorrect;
      learningChanged = true;
    }
  } else if (body.factId in ws.learning) {
    delete ws.learning[body.factId];
    learningChanged = true;
  }

  // Persist the whole answer atomically (progress + stat + sibling seed +
  // attempt + working state): one commit instead of 4-5 on the hot path, and a
  // crash can't record progress without its attempt row.
  await db.recordAnswer({
    progress: result.progress,
    stat: result.correct ? result.stat : undefined,
    siblingProgress: siblingSeed,
    attempt: {
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
    },
    workingState: learningChanged ? { sessionId, json: JSON.stringify(ws) } : undefined,
  });

  // Caught up = today's work done: nothing due to review AND nothing still
  // being learned, among the *enabled* facts (DESIGN.md §4.10). Scoped so a
  // disabled set's leftover rows can't keep this false forever. Independent
  // counts → fetch concurrently.
  const enabledIds = [...enabledFactIds];
  const [dueReview, learning] = await Promise.all([
    db.countDueReview(profileId, now, enabledIds),
    db.countLearning(profileId, enabledIds),
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
  if (!session) throw new HttpError(404, 'session_not_found');
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
  // farm coins (§10). The transition is conditional at the DB, so even two
  // *concurrent* completes (both reading completedAt = null above) resolve to
  // one winner; the loser takes the repeat path below.
  // Bump the streak only on that winning completion. A re-POST (or a retried
  // request straddling midnight) must not advance the day streak without any
  // new play — coins are already gated the same way.
  const won =
    firstCompletion &&
    (await db.completeSessionAndAward(sessionId, now, session.profileId, pointsEarned));
  let streak: number;
  if (won) {
    const timezone = (await db.getAccountTimezone(accountId)) ?? 'UTC';
    streak = await bumpStreak(db, session.profileId, timezone, now);
  } else {
    streak = (await db.getProfileStreak(session.profileId)).streak;
  }
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

  // "Nothing left here" — every fact across the kid's enabled sets is mastered
  // (DESIGN.md §4.4). Drives the "ask a grown-up to add more" end screen.
  const enabledSetIds = new Set(await db.listEnabledSetIds(session.profileId));
  const enabledFacts = generateFactsForSets(SEED_CATALOG.filter((s) => enabledSetIds.has(s.id)));
  const allMastered =
    enabledFacts.length > 0 && enabledFacts.every((f) => progressByFact.get(f.id)?.box === 5);

  return {
    cardsPlayed: attempts.length,
    correct,
    fastCorrect,
    mastered,
    pointsEarned,
    streak,
    coins,
    allMastered,
  };
}
