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
import { api } from './api';

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

export function markPendingComplete(sessionId: string): void {
  const ids = read<string>(DONE_KEY);
  if (!ids.includes(sessionId)) write(DONE_KEY, [...ids, sessionId]);
}

export function pendingCount(): number {
  return read<PendingAnswer>(ANS_KEY).length;
}

/**
 * Replay queued answers in order, stopping at the first that still fails (almost
 * always = still offline) so ordering is preserved. Returns true if the queue
 * fully drained.
 *
 * Serialized: a mount flush, an `online` event, and the end-of-session flush can
 * all fire near-simultaneously. Without a lock each would read the same queue
 * snapshot and re-POST the same answers, double-appending to the server's
 * append-only attempt log. Calls chain one after another and each re-reads the
 * queue, so a later call only sends what an earlier one didn't drain.
 */
let answersChain: Promise<boolean> = Promise.resolve(true);
export function flushAnswers(): Promise<boolean> {
  const run = answersChain.then(drainAnswers, drainAnswers);
  answersChain = run.catch(() => false); // keep the chain alive past a failure
  return run;
}

async function drainAnswers(): Promise<boolean> {
  const queue = read<PendingAnswer>(ANS_KEY);
  if (queue.length === 0) return true;
  for (let i = 0; i < queue.length; i++) {
    try {
      await api.answer(queue[i].sessionId, queue[i].body);
    } catch {
      write(ANS_KEY, queue.slice(i)); // keep this one and the rest
      return false;
    }
  }
  write(ANS_KEY, []);
  return true;
}

/** Flush queued answers, then complete any sessions that finished offline. */
export async function flushAll(): Promise<void> {
  if (!(await flushAnswers())) return; // still offline — try again next reconnect
  const ids = read<string>(DONE_KEY);
  if (ids.length === 0) return;
  const remaining: string[] = [];
  for (const id of ids) {
    try {
      await api.complete(id);
    } catch {
      remaining.push(id);
    }
  }
  write(DONE_KEY, remaining);
}
