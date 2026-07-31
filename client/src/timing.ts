/**
 * A clock for measuring how long a kid actually took.
 *
 * `performance.now()` keeps running while the tab is hidden, so a kid who
 * presses the home button mid-round and comes back three minutes later reports
 * a ~180000ms answer. The server (rightly) treats response time as a first-class
 * fluency signal, so that lands as "very slow": the fact gets demoted, the
 * per-op median EWMA is dragged upward, and PlayPage's session-seconds cap trips
 * and ends the session on the next card. None of that reflects the kid.
 *
 * `activeNow()` is `performance.now()` minus every interval the document spent
 * hidden. Take a start and an end from it and the difference is time the kid was
 * actually looking at the screen. It stays monotonic, so a delta is never
 * negative.
 */
let hiddenTotalMs = 0;
let hiddenSince: number | null = null;

function onVisibilityChange(): void {
  if (document.hidden) {
    hiddenSince ??= performance.now();
  } else if (hiddenSince != null) {
    hiddenTotalMs += performance.now() - hiddenSince;
    hiddenSince = null;
  }
}

// One listener for the whole app: per-component listeners would each need their
// own bookkeeping, and rounds start and end in different components.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', onVisibilityChange);
  // Mounting while already hidden (restored background tab) still counts.
  if (document.hidden) hiddenSince = performance.now();
}

/** Monotonic ms, excluding time spent with the tab/app in the background. */
export function activeNow(): number {
  const raw = performance.now();
  const currentlyHidden = hiddenSince != null ? raw - hiddenSince : 0;
  return raw - hiddenTotalMs - currentlyHidden;
}

/** Test seam — resets the accumulated hidden time. */
export function resetActiveClock(): void {
  hiddenTotalMs = 0;
  // `typeof`, not `document !== undefined`: an undeclared global is a
  // ReferenceError to read, so the bare comparison threw wherever there is no
  // document — and always evaluated true wherever there is one.
  hiddenSince = typeof document !== 'undefined' && document.hidden ? performance.now() : null;
}
