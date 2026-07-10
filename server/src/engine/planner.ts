/**
 * Session planner — pure. Implements DESIGN.md §4.4. Assembles the *starter
 * deck* for a session: mostly due review facts, salted with a few easiest-first
 * new facts, interleaved so new/weak facts never cluster. In-session re-shows
 * (incremental rehearsal) are reactive and handled by the orchestration layer
 * at answer time, not here.
 */
import type { Card, Fact, FactProgress } from '@shared';

/**
 * Hard cap on how many *new* facts a single session may introduce, even when
 * the due/review queue is empty and the deck would otherwise be padded entirely
 * with new cards (DESIGN.md §4.4 — "new facts trickle in, never flood"). Keeps
 * a brand-new profile's first session short and gentle instead of ~20 cold
 * intros at once. Never lowers the adult's configured `newPerSession`.
 */
export const DEFAULT_MAX_NEW_PER_SESSION = 6;

/** Recent-accuracy bands for the adaptive new-fact throttle (DESIGN.md §4.4 —
 *  the ~80% success target). Below the low bar the kid is struggling: pause
 *  new material and let review recover; between the bars, halve the intake;
 *  at/above the high bar (or with no recent data) the full allotment flows. */
export const THROTTLE_LOW_ACCURACY = 0.75;
export const THROTTLE_HIGH_ACCURACY = 0.85;

/**
 * The session's new-fact allotment given the configured `newPerSession` and
 * the kid's recent accuracy (0..1, or null when there's no recent data).
 */
export function newFactAllotment(newPerSession: number, recentAccuracy: number | null): number {
  if (recentAccuracy == null || recentAccuracy >= THROTTLE_HIGH_ACCURACY) return newPerSession;
  if (recentAccuracy < THROTTLE_LOW_ACCURACY) return 0;
  return Math.ceil(newPerSession / 2);
}

export interface PlannerInput {
  /** Candidate universe from the kid's enabled sets, easiest-first. */
  facts: Fact[];
  progressByFactId: Map<string, FactProgress>;
  now: number;
  sessionCards: number;
  newPerSession: number;
  /** Optional override for the per-session new-fact cap (see the constant). */
  maxNewPerSession?: number;
  /** Recent accuracy (0..1) for the new-fact throttle; null/omitted = no data. */
  recentAccuracy?: number | null;
}

interface Buckets {
  /** Due now: review facts past dueAt, plus box-0 facts still being learned. */
  due: Fact[];
  /** Review facts not yet due — pulled forward only if the deck is short. */
  upcoming: Fact[];
  /** Mastered facts (box 5) not yet due — last-resort light review. */
  mastered: Fact[];
  /** Never-seen facts, easiest-first — the source of new introductions. */
  unseen: Fact[];
}

function bucket(input: PlannerInput): Buckets {
  const { facts, progressByFactId, now } = input;
  const due: Fact[] = [];
  const upcoming: Fact[] = [];
  const mastered: Fact[] = [];
  const unseen: Fact[] = [];

  for (const fact of facts) {
    const p = progressByFactId.get(fact.id);
    if (!p) unseen.push(fact);
    else if (p.box === 0 || p.dueAt <= now)
      due.push(fact); // box 0 = still learning, always due
    else if (p.box === 5) mastered.push(fact);
    else upcoming.push(fact);
  }

  const byDue = (a: Fact, b: Fact) =>
    (progressByFactId.get(a.id)?.dueAt ?? 0) - (progressByFactId.get(b.id)?.dueAt ?? 0);
  due.sort(byDue); // most overdue first
  upcoming.sort(byDue); // soonest-upcoming first
  mastered.sort(byDue);
  // `unseen` keeps the incoming easiest-first order.

  return { due, upcoming, mastered, unseen };
}

/**
 * Spread `fresh` cards evenly through `review` cards so they never cluster and
 * never lead (the deck opens with an easy win). Deterministic.
 */
function interleave(review: Card[], fresh: Card[]): Card[] {
  if (fresh.length === 0) return [...review];
  if (review.length === 0) return [...fresh];

  const total = review.length + fresh.length;
  const gap = Math.max(1, Math.floor(total / fresh.length));
  const out: Card[] = [];
  let ri = 0;
  let fi = 0;
  let sinceFresh = 0;

  while (ri < review.length || fi < fresh.length) {
    const placeReview = ri < review.length && (sinceFresh < gap || fi >= fresh.length);
    if (placeReview) {
      out.push(review[ri++]);
      sinceFresh++;
    } else {
      out.push(fresh[fi++]);
      sinceFresh = 0;
    }
  }
  return out;
}

const toCard = (fact: Fact, isNew: boolean): Card => ({ fact, answer: fact.answer, isNew });

/**
 * Build the starter deck. Length is `min(sessionCards, candidates available)`.
 * Fill order when due review is short (DESIGN.md §4.4): due review → soonest
 * upcoming (pulled forward) → extra new beyond the cap → mastered light review.
 */
export function planSession(input: PlannerInput): Card[] {
  const { due, upcoming, mastered, unseen } = bucket(input);
  const target = Math.max(0, input.sessionCards);
  // Struggling kids get fewer (or zero) cold intros until accuracy recovers
  // (§4.4's ~80% success target) — review does the repair work.
  const recentAccuracy = input.recentAccuracy ?? null;
  const allotment = newFactAllotment(input.newPerSession, recentAccuracy);
  // Total new facts this session is capped so a quiet queue can't flood a
  // beginner with cold intros (§4.4). The throttle applies to the padding cap
  // too — otherwise a short review queue would refill with the very cold
  // intros the throttle is holding back.
  const maxNew = newFactAllotment(
    Math.max(input.newPerSession, input.maxNewPerSession ?? DEFAULT_MAX_NEW_PER_SESSION),
    recentAccuracy,
  );

  // New facts: the normal small allotment, easiest-first.
  const newCount = Math.min(allotment, unseen.length, target);
  const freshFacts = unseen.slice(0, newCount);

  // Review facts fill the rest, in fill-priority order.
  const reviewFacts: Fact[] = [];
  let remaining = target - freshFacts.length;

  const take = (pool: Fact[]) => {
    if (remaining <= 0) return;
    const picked = pool.slice(0, remaining);
    reviewFacts.push(...picked);
    remaining -= picked.length;
  };
  take(due);
  take(upcoming); // (2) pull soonest-upcoming forward

  // (3) extra new beyond the normal allotment when still short — but only up to
  // the per-session new cap, so a brand-new profile gets a short first session.
  if (remaining > 0) {
    const allowance = Math.max(0, maxNew - freshFacts.length);
    const extra = unseen.slice(newCount, newCount + Math.min(remaining, allowance));
    freshFacts.push(...extra);
    remaining -= extra.length;
  }
  take(mastered); // (4) last-resort light review of mastered facts

  return interleave(
    reviewFacts.map((f) => toCard(f, false)),
    freshFacts.map((f) => toCard(f, true)),
  );
}
