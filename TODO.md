# TODO

Where things stand and what's left. v1 (DESIGN.md §9) is complete: auth, all four
operations, the scheduling/fluency engine, the session player, the fact grid,
daily streaks, and Render deploy (SQLite + Postgres). 208 tests passing.

This is a backlog, not a commitment — pick from it as needed.

## Audit follow-ups (2026-06-06)

A repo-wide audit landed a first batch of high-value fixes (see below) and
surfaced these tracked items. Confidence flags: most are confirmed in source;
the client-closure items are plausible and want a close read before changes.

**Done in the audit pass:**

- [x] **N+1 in session `complete()`** — the mastered-count loop queried progress
      per fact (~20 queries/session). Now loads all progress once and looks up
      in-memory (`session/service.ts`).
- [x] **`responseMs` validation + clamp** — `answer()` now rejects negative /
      non-finite latencies (400) and clamps to a 60s ceiling before it feeds the
      per-op median EWMA, so a buggy/hostile client can't skew the fast threshold
      (DESIGN.md §4.5). HTTP-tested.
- [x] **ESLint + Prettier** — flat `eslint.config.mjs` (typescript-eslint +
      react-hooks, formatting delegated to Prettier via `eslint-config-prettier`),
      `.prettierrc.json`. New root scripts `lint` / `format` / `format:write`,
      wired into CI and the pre-commit hook. Repo formatted to baseline.
- [x] **`COOKIE_SECRET` prod guard** — `index.ts` now refuses to boot in
      production if the secret is unset or the dev placeholder, instead of
      silently signing cookies with a public key.

**Done in the second pass:**

- [x] **DB adapter atomicity.** Added a `withTransaction` helper to the Postgres
      adapter (checks out one connection, BEGIN/COMMIT/ROLLBACK). `setEnabledSetIds`
      now replaces the set in a transaction on both adapters. New atomic
      `completeSessionAndAward` marks a session complete and credits its coins in
      one transaction, so a crash can't finish a session without awarding coins
      (replaces the two-await `completeSession`+`addCoins` in `complete()`).
- [x] **Enforce "one active session" at the DB.** Partial unique index
      `idx_session_one_open ON session(profile_id) WHERE completed_at IS NULL` on
      both schemas. (Deploy note resolved: rather than pre-checking the live DB
      for pre-existing duplicate open sessions, the plan is to reset the Render
      database for the new schema — user count is still negligible — so migrate()
      runs against an empty table.)
- [x] **Memoize the static fact universe.** `generateFactsForSets()` caches
      per-set generation keyed by (operation, range); the dashboard's per-set loop
      and every session/progress build now reuse it.
- [x] **Rate-limit profile creation.** Per-IP fixed window (20/hr) on
      `POST /api/profiles`, mirroring the auth limiters. HTTP-tested.
- [x] **Adopt React Query** (DESIGN.md §5.1). Added `@tanstack/react-query` with a
      `QueryClient` whose retry skips 4xx (a 401/404 isn't worth retrying) and a
      30s `staleTime`. `auth` is now backed by a `['me']` query (401 → logged-out,
      no retry storm); the profiles list, catalog, rewards, fact sets, progress,
      and dashboard are `useQuery` reads; settings/create/fact-sets/unlock/equip
      and session-complete are mutations that invalidate the right keys (shared
      `qk` map in `api.ts`). Failed reads now render a retry affordance instead of
      a stuck skeleton. The imperative session-play loop in `PlayPage` stays as-is
      (stateful game flow, not cached server-state) but invalidates profiles/
      progress/dashboard on completion. Verified in-browser (signup → profiles,
      add-a-kid invalidation refreshes the list, progress/dashboard render).

**Done in the third pass:**

- [x] **Unify the profile-ownership check.** New `loadOwnedProfile(db)` Express
      middleware loads the `:id` profile, 404s on a foreign/missing one, and
      attaches `req.profile`. `profiles.ts` uses it (dropping `owns()`, which
      loaded _all_ profiles then `.some()`d, and the inline PATCH check);
      `dashboard.ts`/`progress.ts` reuse the `requireOwnedProfile` service helper.
- [x] **Server-module unit tests.** Isolated tests for `dashboard.ts` /
      `progress.ts` / `rewards.ts` against an in-memory SqliteDb (ownership 404s,
      grid overlay, mastery summary + trend bucketing, full reward economy).
- [x] **Client test harness + sync-queue tests.** Vitest + jsdom in the client,
      wired into root `npm test`; `syncQueue.test.ts` covers ordering, drain,
      stop-at-first-failure, and `flushAll` completion gating.
- [x] **Guard the `flushAll` double-flush race.** `flushAnswers` now serializes
      through a promise chain, so a mount flush + an `online` event + the
      end-of-session flush can't double-POST the same queued answers (which would
      double-append to the server's attempt log). Regression test added. (The
      `PlayPage` `sessionRef` "stale closure" the audit flagged is a non-issue —
      reading `.current` from a ref is the correct stale-closure-free pattern.)

All first-three-pass audit follow-ups are resolved.

## Audit pass 4 (2026-06-07) — new backlog

A fresh scan after the first three passes. Several headline findings were
investigated and **dropped as non-issues**: the planner "recency guard" (the
starter deck is dup-free by construction and re-shows are gapped by
`REHEARSAL_GAP`), and service-worker "stale shell after deploy" (navigations are
network-first and Vite content-hashes assets). What remains, verified:

### Features

- [x] **Guest / "Play for fun" mode (no signup)** — _done._ A "Play for fun"
      button (`AuthPage`) mints an anonymous account via `POST /api/auth/guest`
      (rate-limited 30/hr), auto-creates one default profile, drops the session
      cookie, and routes straight into a session — reusing the whole existing
      engine/scheduling/rewards stack. Guest accounts carry an `is_guest` flag and
      a synthetic `guest-<id>` email (never loginable); `deleteExpiredGuests`
      reclaims any guest with no unexpired session (cookie cleared → stranded →
      pruned on boot + 12h). Router now always wraps so the auth page can navigate
      post-mint. Verified in-browser (Play for fun → study card → munch grid).
- [x] **Guest → account upgrade path** — _done._ `POST /api/auth/upgrade`
      (auth'd + rate-limited) attaches real credentials to the current guest in
      place (`upgradeGuestAccount` sets email/password, clears `is_guest`) — same
      account id + session, so all progress/coins carry over; rejects a taken
      email (409) or a non-guest (409 `not_a_guest`). `/auth/me` now returns a
      `guest` flag; the profile hub shows a "Save my progress" banner + modal for
      guests that disappears once upgraded. Verified in-browser.
- [x] **Fact-family scheduling transfer** (DESIGN.md §9 "Later") — _done._ Pure
      `familyTransfer` (`engine/facts.ts`): when a sub/div fact is _freshly_
      mastered, its unseen inverse sibling (sub→add, div→mul) is seeded into review
      at box `FAMILY_TRANSFER_BOX` (3) so the kid meets it as review, not cold.
      Conservative guards: only on the transition into mastery, one direction,
      never auto-grants mastery (capped below box 5), and never disturbs a sibling
      already on its own track (unseen-only). Wired into `answer()` (reads the
      sibling + upserts only when newly mastered); 6 engine tests. Future
      refinement: also _raise_ an in-progress sibling, not just seed unseen ones.
- [x] **Cross-operation "next" suggestion** — _done._ `suggestNextSet` now falls
      back to introducing the next untouched operation in curriculum order
      (add→sub→mul→div) at its easiest set once the kid has nearly mastered some
      operation's largest enabled set and has nothing left to advance to there.
      Within-operation advancement still takes priority. Engine-tested.
- [x] **"All caught up" / "mastered it all" end screen** — _done._ Added an
      `allMastered` flag to the session summary (every enabled fact is box 5,
      computed in `complete()`); the done screen now has three tiers — mastered-all
      (🏆 + "ask a grown-up to add more" CTA, bonus round secondary), daily caught-up
      (🎉 + confetti), and normal — instead of just flipping the heading.
- [x] **Data export (CSV/JSON)** — _done._ `GET /profiles/:id/export?format=csv|json`
      (`export.ts`): JSON = profile + full progress + attempt log; CSV = the
      attempt log (RFC-4180 escaped). Download links on the Progress page. HTTP-tested.
- [~] **Classroom mode** (DESIGN.md §9 "Later") — **deferred / out of scope.**
  The userbase is scoped to parents + kids (home) for now; revisit only if a
  school/teacher actually wants it (2026-06-07 decision).
- [~] **Parent email / progress reports** — **deferred.** A weekly per-kid
  summary email is parent-facing and in-scope conceptually, but needs a paid
  email provider + domain we don't want to take on at this stage (2026-06-07).
  Revisit when there's budget/appetite. (Data export already covers manual
  pull.)

### Speed / robustness — done (audit pass 4)

- [x] **Index the due-count hot path.** Added `idx_progress_box_due` on
      `(profile_id, box, due_at)` (both schemas) so the per-answer `countDueReview`
      / `countLearning` no longer scan all of a profile's progress rows.
- [x] **Parallelize independent reads in `answer()`.** `getProgressForFact` +
      `getOperationStat` + `getAccountTimezone` now run in one `Promise.all`, as
      do the two caught-up counts — fewer sequential round-trips on the hot path.
- [x] **Cap request body + array lengths.** `express.json({ limit: '16kb' })`;
      `setFactSets` rejects an `enabledIds` array longer than the catalog;
      `avatar` length capped on create. HTTP-tested.
- [x] **Handle concurrent session-start gracefully.** `startSession` catches a
      lost create race (the `idx_session_one_open` unique violation) and re-enters
      once to resume the winning session instead of 500ing. Tested via two
      concurrent starts converging on one session id.
- [x] **Tighten remaining client-trusted inputs.** `wrongMunches` is now clamped
      (finite, 0–999, truncated) before it's logged, mirroring `responseMs`;
      `avatar` bounded (above).

### Client polish — done (audit pass 4)

- [x] **Lazy-load routes.** `ProfilesPage` / `PlayPage` / `ProgressPage` are now
      `React.lazy` chunks behind a `Suspense` fallback (auth page stays eager for
      an instant logged-out entry). Main bundle 245 → 214 KB; each page ships its
      own JS+CSS chunk. Verified in-browser (Suspense loads play/profile cleanly).
- [x] **Minor render/input hygiene.** `React.memo` on `Confetti`,
      `CelebrationBurst`, `Muncher`; `e.repeat` guards on the munch + study key
      handlers (discrete presses, no auto-repeat); flash/burst/complete timeouts
      tracked and cleared on round unmount.

### Engine (minor) — done (audit pass 4)

- [x] **DST day-boundary.** Day-interval `dueAt` snapping is now timezone-aware
      end to end: the engine takes the IANA zone (not a snapshot offset number)
      and `startOfDayAfter` solves for the target day's _own_ offset (one
      fixed-point step), so a due date crossing a DST transition lands on local
      midnight instead of drifting ±1h. `tzOffsetMinutes` moved into the engine
      and rebuilt on `Intl.formatToParts` (machine-tz independent). Threaded
      through `gradeAnswer`/`familyTransfer` (now take `timeZone`), simplifying
      the service. Tested across spring-forward + fall-back and a non-UTC zone.
- [x] **Engine test gaps.** Added a box-4 "correct but slow" case (stays box 4,
      due sooner via the half interval) and an `accuracyEwma`-trends-to-0 case.

## Audit pass 5 (2026-06-07) — parents + kids lens

Broad multi-angle audit scoped to the home parent+kids userbase (classroom out
of scope). One agent finding was **discarded as a false positive**:
"`deleteExpiredGuests` is never called" — it _is_ wired into the boot prune
(`index.ts`). Verified, actionable findings below, by theme.

### Account & data lifecycle — done (highest value — parent UX **and** privacy)

- [x] **Delete a kid profile** (+ cascade) — `DELETE /profiles/:id`
      (ownership-checked) → `db.deleteProfile`; purges that kid's data via the
      existing FKs. Confirm-gated in the Settings modal. Verified in-browser.
- [x] **Rename a kid profile** — `PATCH /profiles/:id` is now a partial edit of
      displayName / avatar / settings; the Settings modal gained a name field +
      avatar picker.
- [x] **Delete account + all data** (right-to-erasure) — `DELETE /auth/account`
      cascades everything + clears the cookie; an "Account" button → confirm UI.
      Verified in-browser (delete → routed to sign-in; email freed).
- [x] **Edit account: email / password / timezone** — `GET`/`PATCH
/auth/account` (rate-limited; email-taken + weak-password guards). The
      Account modal prefills email + timezone (IANA `<select>`), password
      optional. Fixes the silent wrong-timezone scheduling trap. Verified.

### Child privacy

- [x] **Self-host fonts (drop the Google Fonts CDN)** — _done._ Fredoka + Nunito
      now ship via `@fontsource` (bundled woff2 emitted as same-origin assets,
      imported in `main.tsx`); the Google `<link>`/preconnects are gone and the
      CSP tightened to `style-src 'self' 'unsafe-inline'` + `font-src 'self'` (no
      third-party origins). Verified in-browser: fonts render, zero google links.
- Notes (lower priority / partly by-design): attempt-log granularity has no
  retention policy (fine at this scale); signup distinguishes
  `invalid_email` vs `email_taken` (minor enumeration, accepted); a kid on the
  parent's session can see siblings' profiles — inherent to the family-account
  model (kids don't authenticate, §2), revisit only if it becomes a concern.

### Kid experience / engagement

- [x] **Study-card wait legible** — disabled button now reads "Look at it…" then
      "Got it! ▶" with a brief pop when tappable (was a dead-looking "…").
- [x] **Warmer after-round message** — clearing a board with wrong munches now
      says "All done — nice effort! Keep going." instead of "Some were wrong…".
- [x] **Closed the coins→Rewards loop** — the summary's "⭐ Spend coins" deep-links
      to the kid's Rewards modal via `/?rewards=<id>`.
- [x] **Relation variety** — `pickRelation` is now an even =/</> mix (was ~50%+
      `=`); each relation still reinforces knowing the answer.
- [x] **Comparison-operator comprehension (`<`/`>`)** — _done (friendlier copy)._
      The munch prompt + SR announcement now say "smaller than" / "bigger than" /
      "the same as" instead of "less/greater than/equal to" — easier for young or
      pre-reading kids. (A number-line hint or difficulty-gating `<`/`>` remain
      possible later if real-kid use shows it's still confusing.)

### Code health — done (from the regression sweep)

- [x] **Removed dead `appendCards`** from `AnswerResponse` (never set/read).
- [x] **Settings modal surfaces save errors** (added `onError` + message map).
- [x] **RewardsModal error handling** — `act()` now catches, re-fetches the
      rewards cache, and shows a banner instead of silently resetting the tile.
- [x] **Export via fetch→blob** — failures show an inline message rather than
      downloading the error JSON as a file (was a naked `<a download>`).
- [x] **Modal focus management** — focus enters the dialog (respecting child
      autoFocus), Tab-trap, Esc to close, focus restored to the trigger; plus
      `role="dialog"`/`aria-modal`/`aria-labelledby`.
- [x] **Additive-columns sync documented** — the `ADDITIVE_COLUMNS` /
      `ADDITIVE_COLUMNS_PG` lists already carry "mirror in the other adapter"
      comments (added with the self-heal migration).

## Audit pass 6 (2026-06-10) — full-repo audit backlog

Five parallel review passes (UI/UX, bugs, performance, refactoring, features)
over the whole repo. Baseline: 208 tests passing, typecheck clean. Items are
verified in source and grouped by priority tier — address top-down. Verified
sound, don't re-flag: engine math matches DESIGN §4.2–4.5; coins credit exactly
once; CSRF/cookie/argon2 auth solid; DB indexes match query predicates; fact
generation memoized; N+1s already engineered out.

### P1 — Security & data-loss bugs

- [x] **`trust proxy: true` lets clients spoof their IP past every rate limit.**
      `app.set('trust proxy', true)` trusted all hops, so `req.ip` was the
      attacker-controlled _leftmost_ `X-Forwarded-For` entry; the
      login/signup/guest limiters key on it. Now `app.set('trust proxy', 1)` —
      Render is exactly one hop — with a regression test proving a rotating
      spoofed XFF prefix still 429s.
- [ ] **Sync queue head-of-line poisoning on 4xx.** `drainAnswers`
      (`syncQueue.ts`) retains the first failure forever — including
      deterministic 4xxs (409 `session_completed`, 404 after a guest prune) — so
      every answer behind it and all future offline completions are blocked for
      the device. Drop entries on `ApiError` status < 500 (keep-and-retry only
      network/5xx); same for `flushAll`'s pending completes.
- [ ] **Sync queue lost-update race.** `drainAnswers` snapshots the queue, then
      unconditionally overwrites storage at the end — an answer enqueued while a
      drain is in flight is silently deleted, never sent. On success re-read
      storage and remove only the entries actually sent.
- [ ] **`goNext` completes a session even when queued answers didn't flush.**
      `PlayPage.tsx` ignores `flushAnswers()`' boolean; the server then computes
      points from an incomplete attempt log and the late replays 409 (feeding the
      poisoning above). Only call `api.complete` after a confirmed drain; else
      `markPendingComplete` + the offline finish path.
- [ ] **Guest "Exit" destroys all progress with zero warning.** The header
      button (`ProfilesPage.tsx`) logs the guest out → account stranded → pruned;
      coins/progress unrecoverable. Confirm dialog with a "Save my progress" CTA
      into the existing UpgradeModal.

### P2 — Quick high-impact wins (perf + kid-facing UX)

- [ ] **No HTTP compression in production.** Render doesn't compress for you;
      the bundle + dashboard JSON ship 3–4× their gzipped size (`app.ts`). Add
      `compression()`.
- [ ] **No Cache-Control on hashed assets.** `express.static` defaults to
      `maxAge: 0`, so every content-hashed asset revalidates per load. Serve
      assets with `maxAge: '1y', immutable`; `index.html` with `no-cache`.
- [ ] **Global Enter/Space handlers hijack Quit/mute during play.** The
      window-level keydown handlers (`MunchBoard.tsx`, `PlayPage.tsx`)
      `preventDefault()` without checking the target — keyboard users can't
      activate Quit or mute for the whole session. Bail when focus is on an
      interactive element.
- [ ] **ProgressPage has no error state** — failed dashboard/progress loads show
      skeletons forever; reuse ProfilesPage's "Couldn't load — Try again" card.
- [ ] **Operator glyph ~1.5:1 contrast.** `.munch-op` / `.equation .op` render
      the one glyph distinguishing `+` from `×` in `--sun` yellow on cream —
      far below the 3:1 large-text minimum. Use the darker per-op shades already
      in `index.css`.
- [ ] **Progress bar pins at 100% while injected re-shows remain**
      (`PlayPage.tsx`) — breaks the §4.8 "clear finish line." Use
      `played / (played + queue.length)`.
- [ ] **Use the delivered `thresholds` for instant "fast" feedback** (DESIGN
      §4.7 pins this). The client never reads `SessionResponse.thresholds`;
      `fast` waits on the answer round trip and is always `false` offline, so an
      offline kid never hears "super fast!". Compute feedback locally; the
      server stays authoritative for scheduling.

### P3 — Server correctness (medium/low bugs)

- [ ] **"All caught up" can become permanently unreachable.** `caughtUp` counts
      _all_ progress rows but the planner serves only enabled sets — a disabled
      set's rows, or `familyTransfer` seeding an inverse sibling whose set isn't
      enabled, strand due rows no session can clear (`session/service.ts`).
      Scope the counts to enabled-set facts; consider gating `familyTransfer` to
      enabled sets.
- [ ] **`unlockReward` non-atomic read-modify-write** (`rewards.ts`) — a
      concurrent session award can be clobbered (absolute `setCoins`); a crash
      between debit and unlock spends coins for nothing; two tabs can
      double-spend. Add a transactional `spendAndUnlock` Db method with a
      conditional `coins >= cost` debit, mirroring `completeSessionAndAward`.
- [ ] **Stale open session closed without awarding its coins.** `startSession`
      plain-`completeSession`s a prior-day open session; the queued offline
      `complete` then sees `firstCompletion === false` and skips the award —
      breaking the offline banner's "coins will update" promise. Award via
      `completeSessionAndAward` when closing.
- [ ] **Repeat `complete()` bumps the streak** — `bumpStreak` runs
      unconditionally; gate it on `firstCompletion`.
- [ ] **End-of-deck re-show splices to index 0** — a fact missed on the last
      card is re-shown immediately, violating §4.4's "never back-to-back"
      (`PlayPage.tsx` inject splice). (Distinct from the pass-4 dropped "recency
      guard" claim, which concerned the dup-free starter deck.)
- [ ] **MunchBoard side effects inside the `setEaten` updater** — sounds/counts
      double-fire under StrictMode and inflate the logged `wrongMunches`. Hoist
      the effects out of the updater.
- [ ] **Email matching is case-sensitive end-to-end** — `Foo@Bar.com` can't log
      in as `foo@bar.com`. Normalize (lowercase) on write and lookup.
- [ ] **Sessions expire 30 days from creation, not "30 days idle"** (DESIGN §2)
      — slide `expires_at` + cookie on use, throttled to ~daily.
- [ ] **`bumpStreak` DST edge** — `now − 24h` lands two calendar days back in
      the first hour after spring-forward, resetting a genuine streak. Compute
      "yesterday" by calendar day.
- [ ] **`responseMs` accepts fractions** — passes validation, then 500s on
      Postgres (`INTEGER` column) _after_ progress already wrote. `Math.round`
      at the existing clamp.

### P4 — Performance (hot path + client pacing)

- [ ] **Wrap `answer()`'s writes in one transaction** — 4–5 separate WAL
      commits / PG round trips per answer today, and a crash can persist
      progress without its attempt row. One transactional Db method, like
      `completeSessionAndAward`.
- [ ] **Don't block the next card on the answer round trip** (`PlayPage.tsx`) —
      200–800 ms dead time per card on slow links, ~20×/session. Advance
      immediately; apply injects/caughtUp when the response lands (injects only
      need to land within `REHEARSAL_GAP`). Pairs with the thresholds item (P2).
- [ ] **Skip the full-deck `working_state` rewrite when `learning` didn't
      change** — 5–15 KB of JSON re-stringified per answer, a no-op for most
      review facts.
- [ ] **Parallelize `startSession`'s independent reads** — ~9 sequential awaits;
      `Promise.all` them as `answer()` already does.
- [ ] **SW cache hygiene.** Old hashed bundles accumulate forever and the
      offline fallback (`/` + assets) is pinned at first-install version
      (`sw.js`). Version the cache per deploy and re-cache `/` on successful
      navigations. (Refines pass 4's "non-issue": online users _do_ get fresh
      shells — the gap is offline-fallback staleness + unbounded growth.)
- [ ] **Confetti animates `top`** — the one non-compositable animation in the
      app; animate `transform: translateY` (+ fold in the per-piece rotation,
      which the keyframe currently overrides).
- [ ] **Trim eagerly-loaded font weights** — 9 woff2 files in the critical path
      (`main.tsx`); verify usage in CSS, drop unused weights.
- [ ] **Drop the 2-space indent on the JSON export** (`api/index.ts`) — halves
      the payload.

### P5 — UI polish & accessibility

- [ ] **Locked reward tiles show no goal** — tappable "⭐ 80 — 45 to go!" note
      instead of a dead 55%-opacity tile; it's the strongest motivation loop.
- [ ] **Profile-create and fact-set save mutations fail silently** — add
      `onError` banners (pattern exists in SettingsModal/AccountModal).
- [ ] **Keyboard-only hint shown on touch devices** — gate "Arrow keys / WASD…"
      behind `(hover: hover) and (pointer: fine)`; tablets see only "tap".
- [ ] **`aria-pressed` on fact-set pills, grade-band and avatar pickers**;
      give avatar buttons an accessible name (bare emoji today).
- [ ] **Munch grid ARIA + focus loss** — `role="grid"` without rows/gridcells;
      a focused cell that's munched becomes `disabled` and drops focus to
      `<body>`. Use `role="group"`, `aria-disabled` + click guard; consider a
      roving tabindex.
- [ ] **Touch targets** — profile-tile action buttons are ~28 px tall;
      `min-height: 44px`.
- [ ] **Fact-grid cell details are hover-`title`-only** — invisible on touch
      (the primary device), keyboard, and SR; same for trend-bar tooltips. Make
      cells focusable with a tap popover or `aria-label`.
- [ ] **PWA icons + orientation** — iOS ignores the SVG `apple-touch-icon`
      (iPad install gets a screenshot blob); single icon is `"any maskable"`
      combined; `"orientation": "portrait"` fights landscape
      tablets/Chromebooks. Add 180 px apple-touch + 192/512 PNGs (separate
      `any`/`maskable`), drop the portrait lock. (Subsumes the earlier
      "PNG icons later" note under Polish.)
- [ ] **RewardsModal loading skeletons** — shop sections render empty while the
      catalog loads; `.skeleton` class already exists.
- [ ] **Quit label mismatch** — `aria-label="Back"` contradicts the visible
      "← Quit" (WCAG 2.5.3); drop the override.
- [ ] **Offline banner can overlap the play header** — fixed top-0 opaque strip
      sits on the Quit button on small screens; make it in-flow (or pad), add
      `safe-area-inset-top`.
- [ ] **Decorative emoji read aloud by SRs** — wrap in
      `<span aria-hidden="true">`; keep text alternatives on streak/coin badges.
- [ ] **No per-munch SR feedback mid-round** — announce munch results through
      the existing live region, throttled.
- [ ] **Midnight theme breaks `--sun` companions** — `.stat.accent` hardcodes
      gold text/shadow against a periwinkle-remapped `--sun`; add
      `--sun-shadow` / `--on-sun` vars overridden per theme.

### P6 — Refactoring

- [ ] **Extract shared `db/rows.ts`** — row interfaces, mappers, and
      `PROFILE_SELECT` are duplicated verbatim across the adapters (~120 lines)
      with drift already present (SQLite `createProfile` omits the streak column
      PG inserts).
- [ ] **Shared Db contract test suite** — one `describeDbContract()` run against
      both adapters; today the PG suite never exercises `upgradeGuestAccount`,
      `completeSessionAndAward`, cascades, or equipped-reward reads.
- [ ] **Use `handle()` in all routers** — 17 handlers in `auth/routes.ts` +
      `api/profiles.ts` hand-roll try/catch around a wrapper that already exists
      in `api/index.ts`; move it to a shared module and rename `SessionError` →
      `HttpError` (it's used by rewards/progress/export/dashboard).
- [ ] **Delete `shared`'s runtime `OPERATIONS` export** — un-importable (all
      imports are `import type`), re-declared in three server files, and exactly
      the hazard CLAUDE.md's type-only note warns about. One server-side module.
- [ ] **Wire `Transition.fraction` into `gradeAnswer`** (or delete the field) —
      the half-interval rule is encoded twice in the engine; tuning one copy
      does nothing.
- [ ] **Unify ownership on `loadOwnedProfile`** — apply the middleware to the
      `/profiles/:id/*` routes in `api/index.ts` and pass `req.profile` into the
      services (drops a redundant `getProfile` per request); keep
      `requireOwnedProfile` only where the id comes from the session row.
- [ ] **Single source for `DEFAULT_SETTINGS` / `SETTING_BOUNDS`** — duplicated
      server×2 (profiles router + auth routes) and client×1; one server
      constants module, and serve bounds via `/catalog` for the client.
- [ ] **Split `ProfilesPage.tsx` (919 lines, 8 components)** — extract the
      reusable a11y `Modal` to `components/`, an `AvatarPicker` (duplicated JSX
      in two modals), and per-modal files.
- [ ] **Drive both `ADDITIVE_COLUMNS` lists from one declaration**
      (`{table, column, sqliteDecl, pgDecl}`).
- [ ] **Client error-message map + query-key hygiene** — auth error strings
      copied in three maps; `qk.me` is dead while `auth.tsx` re-declares
      `ME_KEY` and AccountModal uses a raw `['account']` key.
- [ ] **Move `dayInTz` into the engine** beside `localYMD` (near-duplicate
      idiom), unit-test it directly (DST day, bad-zone fallback).

### P7 — Features (spec gaps + new ideas)

- [ ] **Accuracy-aware new-fact throttle** (DESIGN §4.4's "~80% success" is
      currently a static cap) — shrink the new-fact allotment when recent
      accuracy < ~75%, restore at ≥ 85%; pure planner change, easily tested.
- [ ] **Enforce the ~30-presentation session ceiling** (§10) — nothing bounds a
      miss-loop today but the silent time cap; stop emitting injects past the
      ceiling.
- [ ] **Local rehearsal for offline misses** — a fact missed while offline gets
      no in-session re-show (injects are server-driven); self-requeue locally
      mirroring `REHEARSAL_GAP`.
- [ ] **One-tap "Enable now" on the dashboard suggestion** — the banner
      currently says "Enable it from the Facts screen"; `PUT
/profiles/:id/factsets` already exists.
- [ ] **"Due today" badge on profile tiles** — "5 to review!" / "All caught up
      ✓" chip; `countDueReview`/`countLearning` already exist. Positive framing,
      never homework-backlog.
- [ ] **"Trickiest facts" dashboard panel** — ranked top-5 by low
      `accuracyEwma` / slow `medianMsEwma` (reps ≥ 3); the single most
      actionable parent insight, pure aggregation over existing data.
- [ ] **Name the mastered facts on the session summary** — `complete()` already
      knows them; return `masteredFacts` and render celebration chips instead of
      just a count.
- [ ] **Streak grace / coin-purchasable streak shield** — the hard reset after
      one missed day is the most punitive mechanic left (§4.8), and the coin
      economy needs a sink.
- [ ] **Weekly in-app recap card** — sessions/mastered/accuracy-delta "This
      week" card from the existing attempt log; covers most of the deferred
      email report with zero infra.
- [ ] **Family-transfer refinement: nudge in-progress siblings** (noted as
      future work when `familyTransfer` landed) — capped one-box raise for a
      sibling already in boxes 1–2.
- [ ] **Grade-band gating for `<`/`>` munch relations** — K–1 profiles get
      mostly `=` rounds until comparisons are introduced; `pickRelation` is
      already a pure seeded function.
- [ ] **More reward catalog entries / seasonal items** — a dedicated kid owns
      everything within weeks; date-gated seasonal items are a pure function of
      the date.
- [ ] **Printable mastery certificate** — per-set/operation mastery is already
      computable; print-friendly page + `window.print()`, fridge-door appeal.
- [ ] **Config-driven fluency constants** — let the calibrate tooling's output
      apply via env/DB instead of redeploying `threshold.ts` constants (pairs
      with the open calibration item).

## Features

- [x] **Number Munchers play mode** (pivot — DESIGN.md §12) — replaced typed
      recall with a 5×5 grid game: munch every cell =/</> the fact's answer,
      driven by arrows/WASD or tap. Pure seeded board generator (`engine/munch.ts`);
      `gradeAnswer` now takes `correct` (clean clear) with `responseMs` = time to
      first correct munch, so the spaced-repetition engine + dashboard + rewards
      all carry over. Calm (no enemies/countdown). Verified in-browser end-to-end.
- [x] **Adult session settings** — `PATCH /profiles/:id` edits `sessionCards` /
      `sessionSeconds` / `newPerSession` (partial-merge, bounds-validated route +
      a Settings modal on the profile picker). `sessionSeconds` is carried on the
      session response and enforced client-side as a silent soft cap (§4.4): the
      player wraps up between cards once the budget is spent, no visible
      countdown (§4.8).
- [x] **Resume an interrupted session** (DESIGN.md §10) — `startSession` now
      reuses a same-day open session, rebuilding the remaining deck from
      `workingState` + the `Attempt` log (handled facts dropped, still-learning
      facts kept without re-study, unanswered facts keep study-first). A
      prior-day open session is discarded and a fresh one planned (one active
      session per profile). Note: client-side in-session re-show _injects_ aren't
      reconstructed on resume — the persistent box schedule resurfaces those.
- [x] **Adult dashboard** (roadmap v1.1) — `GET /profiles/:id/dashboard` returns
      14-day accuracy/speed trends (bucketed by account-tz day from the `Attempt`
      log), a mastery summary, and a "suggested next set" (advance within an
      operation once the largest enabled set is ≥80% mastered; pure + unit-tested
      in `engine/dashboard.ts`). The Progress page now renders stat cards, a
      suggestion banner, an accuracy bar chart + speed sparkline, then the grid.
      Cross-operation suggestions (e.g. start subtraction) are intentionally
      out of scope for v1.
- [x] **Unlockable munchers + celebration effects** — the board character is now
      a chosen animal (7 illustrated SVG munchers with idle/chomp/happy/bleh
      animations; cat + dog free, fox/frog/bunny/panda/dragon premium), and the
      correct-answer burst is a chosen effect (confetti free, sparkles/stars/
      fireworks premium). Both are coin-spent reward kinds (additive
      `profile_muncher` / `profile_effect` tables) equipped from the shop and
      carried on the session to the board.
- [x] **Unlockable avatars / themes** (roadmap v1.1) — reward points spend.
      Coins accrue on session completion (credited once, idempotent); a kid-facing
      Rewards shop on the profile picker spends them to unlock avatars + palette
      themes, then equips them. Server-authoritative catalog/costs/ownership
      (`data/rewards.ts`, `rewards.ts`); additive `profile_reward` / `profile_unlock`
      tables (no profile-table migration). Themes apply via `body[data-theme]`
      (palette-only; operation colors stay fixed) on the Play screen and live in
      the shop. Cross-op suggestions/new operations untouched.
- [x] **Subtraction/division fact-family framing** (DESIGN.md §9 "Later") — a new
      sub/div study card now shows its known inverse sibling (`8 × 7 = 56` → `so…`
      → `56 ÷ 7 = 8`). Pure `familyHint(fact)` in `engine/facts.ts` (sub→add,
      div→mul, null for base ops), attached to new cards at deck-build time and
      rendered on the study screen. Presentation-only — no scheduling transfer
      (mastery seeding the sibling's box) yet; that's the deeper follow-up.
- [x] **Offline play + sync** (DESIGN.md §9 "Later") — _bounded scope (PWA +
      resilient sync)_. A service worker (`client/public/sw.js`) caches the app
      shell so it launches offline + is installable (manifest + icon). Failed
      answer reports queue in localStorage (`syncQueue.ts`) and replay in order on
      reconnect; a session finished offline is credited (coins/streak) when
      connectivity returns. An offline banner shows status. Server stays the sole
      state writer. **Not** included: cold-start-offline (planning/grading a brand
      new session with zero connectivity) — that needs the engine on the client
      (a shared runtime package), a deliberate larger follow-up.

## Polish

- [x] **aria-live** announcements for answer feedback (screen-reader support) —
      an assertive `.sr-only` live region in the player announces the study intro
      ("New fact. 7 times 8 equals 56.") and each result ("Correct, and fast!" /
      "Not quite. …equals 56.").
- [x] **PWA manifest** + icons so it installs on a tablet/Chromebook (done with
      the offline work). Note: ships a single SVG icon (Chrome/Chromebook accept
      it); add 192/512 PNG icons later for the strictest install criteria.
- [x] Loading skeletons / nicer empty states — shimmer skeleton tiles on the
      profile picker and skeleton dashboard/grid cards on the progress page while
      data loads.
- [x] Optional sound effects (with a mute toggle) — Web Audio–synthesized cues
      (no binary assets): rising note for correct, sparkle for fast, soft low blip
      for wrong (non-punitive per §4.8), ascending fanfare on complete. Speaker
      toggle in the play header; mute persists in localStorage.

## Engine tuning (needs real usage data — DESIGN.md §4.5, §11)

- [~] Calibrate fluency constants: `K` (1.3), floor (1200ms), per-op ceilings,
  cold-start sample count (20). **Tooling built** — `npm run calibrate -w server`
  reads the attempt log and prints per-op response-time percentiles + advisory
  `K`/ceiling suggestions (pure `engine/calibration.ts`, tested). The actual
  re-tuning still waits on real usage data to run it against.
- [x] Fixed the "extra new facts" flood — a brand-new profile's first session is
      now capped at `DEFAULT_MAX_NEW_PER_SESSION` (6) new cards instead of ~20, so
      beginners get a short gentle start (§4.4 "trickle in, never flood"). The cap
      never lowers an adult's `newPerSession`, and is overridable via the planner.
      (Box-interval calibration still pending real data.)
- [x] Starting fact-set defaults per grade band — `GRADE_BANDS` catalog (K–1,
      Grade 2, Grade 3, Grade 4+) exposed via `/catalog`; profile creation accepts
      a `gradeBand` and enables its sets (unknown/none → starter mix). The Add-a-kid
      modal has a "Starting level" picker. Bands are coarse and editable.

## Deployment / ops

- [x] **Self-healing migrations.** `migrate()` now backfills additive columns
      on a DB created before the column existed (`CREATE TABLE IF NOT EXISTS`
      can't add columns): Postgres via idempotent `ADD COLUMN IF NOT EXISTS`
      (`ADDITIVE_COLUMNS_PG`), SQLite via a `PRAGMA table_info` check then
      `ADD COLUMN` (`ADDITIVE_COLUMNS`). Fixes the live `account.is_guest` drift
      from the partial DB reset — heals on the next deploy from inside Render
      (external DB access is now firewalled). SQLite heal is unit-tested.
- [x] First Render deploy via Blueprint (`render.yaml`) — live at
      https://fact-fluency.onrender.com. Verified end-to-end against the managed
      Postgres: signup (Secure cookie + SSL), profile, full session
      play→complete (coins/streak), unlock+equip, dashboard trends — exercising
      every write path incl. the `ON CONFLICT` upserts and BIGINT columns.
      `migrate()` self-applied the schema on first boot. Node pinned to 24.13.1.
- [x] Auth-session cleanup — `deleteExpiredAuthSessions` on both adapters; pruned
      on boot and every 12h (unref'd timer) in `index.ts`. Adapter-tested.
- [x] Auth hardening — login timing equalization (always run one argon2 verify, so
      a missing account costs the same as a wrong password); security headers
      (`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, prod-only CSP allowing
      Google Fonts); tokenless CSRF defense (same-origin guard on mutating `/api`
      requests, pairing with `SameSite=Lax`). CSP verified in a prod build (no
      violations). `security.ts` + tests.
- [x] Rate-limit auth endpoints — dependency-free fixed-window per-IP limiter
      (`rateLimit.ts`, pure core + thin middleware). Login 10/15min, signup
      6/hr; returns 429 + `Retry-After`. `trust proxy` set to `1` in prod so the
      key is the proxy-observed client IP behind Render (audit pass 6 tightened
      this from `true`, which was spoofable). Unit + HTTP tested.

## Known limitations

- `caughtUp` is computed per profile (due-review + learning counts), not scoped
  to the day's planned intros — fine for now, revisit with the dashboard.
- No automated test against a _live_ Postgres (pg-mem covers the SQL). A manual
  end-to-end smoke flow was run against the live Render Postgres on first deploy
  and passed; consider scripting it as a post-deploy check if deploys get frequent.
