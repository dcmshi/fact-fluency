/**
 * Serialize answer handling per session.
 *
 * `answer()` is a read-modify-write over the session's working state: it reads
 * `working_state`, grades using `learning[factId]` as the in-session correct
 * count, then writes the whole map back. The client deliberately doesn't wait
 * for one answer's POST before sending the next (rounds advance immediately, so
 * the game never stalls on the network), and the offline queue can replay a
 * burst — so two answers for the same session really do overlap. Interleaved,
 * they both read the same snapshot and the second write erases the first's
 * counter, and worse, the second *grades* against a stale count.
 *
 * A conditional write alone wouldn't fix that second half, so the whole
 * critical section is serialized instead. Waiters chain per session id, and a
 * session's entry is dropped once nothing is queued behind it, so this can't
 * grow without bound.
 *
 * Scope: one process. The deployment is a single web service (render.yaml) and
 * a profile can only have one open session (`idx_session_one_open`), so that
 * covers it. If this ever runs multi-instance, this needs to become a row lock
 * (`SELECT … FOR UPDATE` on the session inside the answer transaction).
 */
const chains = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();
  // Run after whatever is queued, regardless of how that finished — a failed
  // answer must not wedge every later one for this session.
  const run = previous.then(fn, fn);
  const tail = run
    .catch(() => undefined)
    .then(() => {
      // Only the last link clears the entry; an earlier one finishing while
      // others wait would otherwise let the next caller skip the queue.
      if (chains.get(sessionId) === tail) chains.delete(sessionId);
    });
  chains.set(sessionId, tail);
  return run;
}

/** Sessions with work queued — test seam, and a leak check. */
export function pendingSessionLocks(): number {
  return chains.size;
}
