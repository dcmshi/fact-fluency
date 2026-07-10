import type { Card } from '@shared';

/**
 * Splice a server-directed re-show into the live queue (DESIGN.md §4.4, §4.9).
 *
 * `afterOffset` counts intervening rounds from the *answered* card, but the
 * answer round trip no longer blocks play — by the time the response lands the
 * kid may already be `advanced` rounds past that card. The splice position
 * compensates (`afterOffset - advanced`), clamped so the re-show:
 *   - never lands on index 0 (the currently-playing slot) — a fact is never
 *     shown twice back-to-back;
 *   - stays inside the queue.
 * An empty queue means the session is wrapping up: skip the in-session
 * re-show — the fact's demoted box schedule resurfaces it instead.
 */
export function spliceInject(
  queue: Card[],
  card: Card,
  afterOffset: number,
  advanced: number,
): Card[] {
  if (queue.length === 0) return queue;
  const at = Math.min(Math.max(1, afterOffset - advanced), queue.length);
  return [...queue.slice(0, at), { ...card, isNew: false }, ...queue.slice(at)];
}
