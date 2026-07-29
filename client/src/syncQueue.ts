/**
 * Offline-resilient sync (roadmap: offline play + sync). The session loop is
 * client-held (§4.9) and already tolerates a *dropped* answer report, but a
 * dropped report means that attempt never reaches the server's append-only log.
 * This queue persists failed answer reports (and a finished-but-uncompleted
 * session) in localStorage and replays them when connectivity returns, so a
 * flaky connection never loses practice — coins/streak land on reconnect.
 *
 * The server stays the sole writer of state: replayed answers are graded by the
 * server exactly as live ones, just later.
 */
import type { AnswerRequest } from '@shared';
import { api, ApiError } from './api';

/**
 * A 4xx replay is deterministic — the server will reject it identically every
 * time (e.g. 409 `session_completed` after the session closed, 404 after a
 * guest prune). Retaining one would block everything queued behind it forever,
 * so only transient failures (network, 5xx) are kept for retry.
 */
function isPermanentRejection(err: unknown): boolean {
  return err instanceof ApiError && err.status < 500;
}

const ANS_KEY = 'ff_pending_answers';
const DONE_KEY = 'ff_pending_complete';

interface PendingAnswer {
  sessionId: string;
  body: AnswerRequest;
}

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T[]) : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — degrade to in-memory-less; reports are best-effort */
  }
}

export function enqueueAnswer(sessionId: string, body: AnswerRequest): void {
  write(ANS_KEY, [...read<PendingAnswer>(ANS_KEY), { sessionId, body }]);
}

/**
 * An id for one round, carried on the report and reused verbatim by any replay.
 * A failed POST is indistinguishable from one the server committed before the
 * response was lost, so the queue *must* assume the write may have landed; the
 * server dedupes on this key rather than appending the attempt twice.
 */
export function newAttemptId(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function markPendingComplete(sessionId: string): void {
  const ids = read<string>(DONE_KEY);
  if (!ids.includes(sessionId)) write(DONE_KEY, [...ids, sessionId]);
}

export function pendingCount(): number {
  return read<PendingAnswer>(ANS_KEY).length;
}

/**
 * Replay queued answers in order, stopping at the first *transient* failure
 * (almost always = still offline) so ordering is preserved; a permanently
 * rejected answer (4xx) is dropped rather than retried, so it can't block the
 * queue behind it. Returns true if the queue fully drained.
 *
 * Serialized: a mount flush, an `online` event, and the end-of-session flush can
 * all fire near-simultaneously. Without a lock each would read the same queue
 * snapshot and re-POST the same answers, double-appending to the server's
 * append-only attempt log. Calls chain one after another and each re-reads the
 * queue, so a later call only sends what an earlier one didn't drain.
 *
 * The promise chain only covers *this* tab, though, and the queue is shared
 * localStorage: an installed PWA plus a browser tab both replay it and race the
 * `slice(settled)` rewrite, which can drop an entry that never sent. Web Locks
 * makes the drain exclusive across tabs where it exists (everywhere but older
 * Safari, which falls back to the in-tab chain alone).
 */
const DRAIN_LOCK = 'ff-sync-answers';

let answersChain: Promise<boolean> = Promise.resolve(true);
export function flushAnswers(): Promise<boolean> {
  const run = answersChain.then(withDrainLock, withDrainLock);
  answersChain = run.catch(() => false); // keep the chain alive past a failure
  return run;
}

async function withDrainLock(): Promise<boolean> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return drainAnswers();
  return (await locks.request(DRAIN_LOCK, drainAnswers)) ?? false;
}

async function drainAnswers(): Promise<boolean> {
  const queue = read<PendingAnswer>(ANS_KEY);
  if (queue.length === 0) return true;
  let settled = 0; // delivered, or permanently rejected and dropped
  let blocked = false; // hit a transient failure — stop, keep this one + the rest
  for (const entry of queue) {
    try {
      await api.answer(entry.sessionId, entry.body);
      settled += 1;
    } catch (err) {
      if (isPermanentRejection(err)) {
        settled += 1;
        continue;
      }
      blocked = true;
      break;
    }
  }
  // Re-read before writing: an answer enqueued *while* this drain was in flight
  // sits after our snapshot (drains are serialized and enqueue only appends),
  // so drop exactly the settled prefix instead of overwriting storage with the
  // stale snapshot — which would silently delete it.
  const remaining = read<PendingAnswer>(ANS_KEY).slice(settled);
  write(ANS_KEY, remaining);
  return !blocked && remaining.length === 0;
}

/** Flush queued answers, then complete any sessions that finished offline. */
export async function flushAll(): Promise<void> {
  if (!(await flushAnswers())) {
    scheduleRetry(); // still failing — see below
    return;
  }
  resetRetryBackoff(); // answers are through; next outage starts from the base delay
  const ids = read<string>(DONE_KEY);
  if (ids.length === 0) return;
  const remaining: string[] = [];
  for (const id of ids) {
    try {
      await api.complete(id);
    } catch (err) {
      // Keep only transient failures — a 404/409 will never start succeeding.
      if (!isPermanentRejection(err)) remaining.push(id);
    }
  }
  write(DONE_KEY, remaining);
  if (remaining.length > 0) scheduleRetry();
}

/**
 * Retry a blocked drain with capped exponential backoff.
 *
 * Flushes otherwise only run on mount, an `online` event, and end-of-session. If
 * a drain stops on a transient 5xx *while connectivity stays up*, no `online`
 * event ever fires — so an offline session's coins and streak would sit unsent
 * until the kid happened to play again. Backoff (not a fixed interval) so a
 * server having a bad minute doesn't get hammered by every open tab.
 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_BASE_MS;

function scheduleRetry(): void {
  if (retryTimer != null) return; // one in flight is enough
  if (typeof navigator !== 'undefined' && !navigator.onLine) return; // 'online' covers this
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    void flushAll();
  }, retryDelay);
}

/** Called on a clean drain (and by tests) so the next outage starts fresh. */
export function resetRetryBackoff(): void {
  if (retryTimer != null) clearTimeout(retryTimer);
  retryTimer = null;
  retryDelay = RETRY_BASE_MS;
}
