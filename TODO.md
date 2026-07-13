# TODO

Where things stand and what's left. v1 (DESIGN.md §9) is complete — auth, all
four operations, the scheduling/fluency engine, the session player, the fact
grid, daily streaks, Render deploy (SQLite + Postgres) — and the P4–P7 backlog
(perf, UI/a11y, refactoring, features) is fully cleared as of 2026-07-10.
278 tests passing.

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
      silently signing cookies with a public key. _(Superseded in pass 7: the
      cookie was never signed — the guard and the secret were removed as dead
      config; the token's entropy is the secret.)_

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
- [x] **Sync queue head-of-line poisoning on 4xx.** `drainAnswers` retained the
      first failure forever — including deterministic 4xxs (409
      `session_completed`, 404 after a guest prune) — blocking every answer
      behind it and all future offline completions. Now a permanent rejection
      (`ApiError` status < 500) is dropped and the drain continues; only
      network/5xx failures keep-and-retry. Same rule applied to `flushAll`'s
      pending completes. Regression-tested.
- [x] **Sync queue lost-update race.** `drainAnswers` snapshotted the queue then
      unconditionally overwrote storage, silently deleting an answer enqueued
      while a drain was in flight. It now re-reads storage and drops exactly the
      settled prefix (drains are serialized; enqueue only appends).
      Regression-tested.
- [x] **`goNext` completes a session even when queued answers didn't flush.**
      `PlayPage.tsx` ignored `flushAnswers()`' boolean; the server then computed
      points from an incomplete attempt log and the late replays 409'd. Now a
      partial drain takes the offline-finish path (`markPendingComplete`), and
      the session completes on reconnect with the full log.
- [x] **Guest "Exit" destroys all progress with zero warning.** The header
      button logged the guest out → account stranded → pruned; coins/progress
      unrecoverable. Now confirm-gated ("Leaving already?") with a "Save my
      progress" CTA into the existing UpgradeModal; the destructive path is an
      explicit "Exit and delete my progress".

### P2 — Quick high-impact wins (perf + kid-facing UX)

- [x] **No HTTP compression in production.** Render doesn't compress for you;
      the bundle + dashboard JSON shipped 3–4× their gzipped size. Added
      `compression()` ahead of all routes; gzip round-trip tested.
- [x] **No Cache-Control on hashed assets.** `express.static` defaulted to
      `maxAge: 0`, so every content-hashed asset revalidated per load. Now
      `assets/*` (Vite's hashed output) is `max-age=1y, immutable`; root-level
      un-hashed files (index.html, sw.js, manifest, icon) are `no-cache` —
      deliberately, since their names never change across deploys. Verified
      against a prod build.
- [x] **Global Enter/Space handlers hijack Quit/mute during play.** The
      window-level keydown handlers `preventDefault()`ed without checking the
      target — keyboard users couldn't activate Quit or mute all session. The
      activation keys (Enter/Space) now yield to a focused interactive element
      (`keys.ts` helper); movement keys stay global since focus sits on a cell
      button after any tap.
- [x] **ProgressPage has no error state** — failed dashboard/progress loads
      showed skeletons forever. Now renders the same "Couldn't load — Try again"
      retry card ProfilesPage uses (skeletons suppressed on error; retry
      refetches only the failed query/queries).
- [x] **Operator glyph ~1.5:1 contrast.** `.munch-op` / `.equation .op` rendered
      the one glyph distinguishing `+` from `×` in `--sun` yellow on cream — far
      below the 3:1 large-text minimum. Operators (and the study-card answer
      reveal) now use the op's darker `--shadow` shade (3:1+, hue preserved).
- [x] **Progress bar pins at 100% while injected re-shows remain** — divided by
      the starter deck only, so after a few misses the bar promised "done!" with
      cards still coming. Now `played / (played + queue.length)` — the live
      remaining count, injects included.
- [x] **Use the delivered `thresholds` for instant "fast" feedback** (DESIGN
      §4.7 pins this). The client never read `SessionResponse.thresholds`;
      `fast` waited on the answer round trip and was always `false` offline.
      The round announcement now computes `fast` locally from the session's
      per-op threshold and fires before the network call; the server stays
      authoritative for scheduling.

### P3 — Server correctness (medium/low bugs)

- [x] **"All caught up" can become permanently unreachable.** `caughtUp` counted
      _all_ progress rows but the planner serves only enabled sets — a disabled
      set's rows, or `familyTransfer` seeding an inverse sibling whose set isn't
      enabled, stranded due rows no session could clear. `answer()` now builds
      the enabled fact universe and (a) scopes both caught-up counts to it (new
      optional `factIds` filter on `countDueReview`/`countLearning`, both
      adapters) and (b) only seeds a sibling that's actually reachable.
      Service-level tested.
- [x] **`unlockReward` non-atomic read-modify-write** — a concurrent session
      award could be clobbered (absolute `setCoins`); a crash between debit and
      unlock spent coins for nothing; two tabs could double-spend. New
      transactional `spendAndUnlock` Db method (both adapters) claims the item,
      then debits with a conditional relative `coins >= cost` update, all in one
      transaction. SQLite tests cover the concurrent-double-spend and
      award-survives-mid-spend races and the insufficient-rollback; pg-mem
      covers the debit math (note: pg-mem can't honor ROLLBACK, so the
      rollback side-effect is asserted on the SQLite adapter). (`setCoins` is now
      test-only — a dead-code cleanup for the refactor pass; audit pass 8 found
      `addCoins` and `addUnlock` have joined it.)
- [x] **Stale open session closed without awarding its coins.** `startSession`
      plain-`completeSession`d a prior-day open session; the queued offline
      `complete` then saw `firstCompletion === false` and skipped the award —
      breaking the offline banner's "coins will update" promise. New
      `closeAndAward` helper reconciles attempts (coins + streak) when closing;
      `completeSessionAndAward` sets `completedAt` transactionally so the late
      `complete` can't double-award. Service-level tested across a day boundary.
- [x] **Repeat `complete()` bumps the streak** — `bumpStreak` ran
      unconditionally, so a re-POST straddling midnight advanced the streak with
      no new play. Now gated on `firstCompletion` (coins already were); a repeat
      completion just reads the current streak back.
- [x] **End-of-deck re-show splices to index 0** — a fact missed on the last
      card was re-shown immediately, violating §4.4's "never back-to-back". The
      splice now skips an inject that would land at index 0 (only happens with
      an empty queue, since `afterOffset` is always 3); the demoted box schedule
      resurfaces the fact instead.
- [x] **MunchBoard side effects inside the `setEaten` updater** — sounds, the
      wrong-munch count, and `onComplete` ran inside the state updater, so
      StrictMode's double-invoke double-fired them and inflated the logged
      `wrongMunches`. Munch state now lives in `eatenRef` (read/written
      synchronously, guarding re-munch); the updater is pure and effects run
      once outside it. Verified in-browser (clean round → advance).
- [x] **Email matching is case-sensitive end-to-end** — `Foo@Bar.com` couldn't
      log in as `foo@bar.com`, and the same mailbox could register twice. A
      `normalizeEmail` (trim + lowercase) is now applied on every store and
      lookup (signup, login, upgrade, account edit). Tested.
- [x] **Sessions expire 30 days from creation, not "30 days idle"** (DESIGN §2)
      — a daily player was hard-logged-out every 30 days. `attachAccount` now
      slides `expires_at` forward on use via a new conditional `slideAuthSession`
      (both adapters), throttled to ~once/day, and re-issues the cookie so the
      browser copy slides too. Db-level tested (slide / throttled / expired).
- [x] **`bumpStreak` DST edge** — `now − 24h` landed two calendar days back in
      the first hour after spring-forward, resetting a genuine streak. "Yesterday"
      is now computed by calendar arithmetic (`previousDay`), DST-proof. Unit
      tested across spring-forward, month, year, and leap boundaries.
- [x] **`responseMs` accepts fractions** — passed validation, then 500'd on
      Postgres (`INTEGER` column) _after_ progress already wrote. Now
      `Math.round`ed at the existing clamp; tested via the CSV export.

### P4 — Performance (hot path + client pacing)

- [x] **Wrap `answer()`'s writes in one transaction** — _done._ New
      `db.recordAnswer(AnswerWrite)` persists progress + per-op stat + family
      seed + attempt + working-state in one transaction on both adapters (one
      WAL commit / one PG connection round trip); rollback asserted on SQLite.
- [x] **Don't block the next card on the answer round trip** — _done._
      `finishRound` advances immediately; the response reconciles into the
      _live_ queue when it lands (pure `spliceInject`, position compensated by
      rounds played meanwhile, never index 0, unit-tested) and completion
      awaits the in-flight POSTs so the server scores a full attempt log.
      Verified in-browser: instant advance, re-shows land at the rehearsal
      gap, summary scores all attempts.
- [x] **Skip the full-deck `working_state` rewrite when `learning` didn't
      change** — the deck half of workingState is static, so for a review fact
      (the majority) the per-answer rewrite of 5–15 KB of JSON was pure waste.
      `answer()` now tracks whether the learning map changed and only writes
      then.
- [x] **Parallelize `startSession`'s independent reads** — the ~6 post-gate
      reads (enabled sets, timezone, open session, thresholds, muncher, effect)
      now run in one `Promise.all` batch, and both return branches share a
      `common` fields object instead of re-fetching muncher/effect/thresholds.
- [x] **SW cache hygiene.** The offline `/` shell was pinned at the
      first-install version. Navigations now refresh the cached shell on success;
      and the deferred half is done too — sw.js moved to `client/src/` and is
      emitted at build time with a per-build id stamped into the cache name
      (`emit-stamped-sw` plugin), so each deploy's activate evicts the previous
      cache automatically. (Fun autopsy: the first stamp attempts "worked" but
      `String.replace` was stamping the placeholder's _mention in the header
      comment_, not the CACHE constant — replaceAll now.)
- [x] **Confetti animates `top`** — the one non-compositable animation in the
      app (28 pieces forcing layout every frame). Now animates
      `transform: translateY` with the per-piece rotation folded into the
      keyframe via a `--rot` custom property; `will-change: transform`.
- [x] **Trim eagerly-loaded font weights** — audited every `font-weight`
      against its font family: Fredoka 400 (display elements only use 500/600/700)
      and Nunito 700-italic (no italic anywhere) were never requested. Dropped
      both imports (9 → 7 woff2 in the critical path). The rest are all in use.
- [x] **Drop the 2-space indent on the JSON export** (`api/index.ts`) — halved
      the payload; it's a download, not read raw.

### P5 — UI polish & accessibility

_All done (2026-07-10)._

- [x] **Locked reward tiles show no goal** — locked tiles stay tappable, read
      "⭐ 80 · 45 to go!", and tapping shows an encouraging goal banner
      ("needs N more ⭐ — keep playing!"). Verified in-browser.
- [x] **Profile-create and fact-set save mutations fail silently** — both
      modals gained `onError` banners (SettingsModal pattern).
- [x] **Keyboard-only hint shown on touch devices** — the munch hint is split:
      keyboard text only under `(hover: hover) and (pointer: fine)`, plain
      "Tap a number to munch it" otherwise.
- [x] **`aria-pressed` on fact-set pills, grade-band and avatar pickers** —
      plus accessible names on the bare-emoji avatar buttons and full set
      labels on the pills.
- [x] **Munch grid ARIA + focus loss** — `role="group"` (no fake grid
      semantics), munched cells use `aria-disabled` + a click guard instead of
      `disabled` (focus no longer drops to `<body>`), and a roving tabindex:
      one tab stop at the muncher's cell, focus follows arrow-key movement.
- [x] **Touch targets** — profile-tile action buttons now `min-height: 44px`.
- [x] **Fact-grid cell details are hover-`title`-only** — cells (and trend-bar
      days) are tappable and carry `aria-label`s; a tap writes the details
      into a visible caption line. Cells stay out of the Tab order (~170 tab
      stops would bury every other control).
- [x] **PWA icons + orientation** — real PNGs generated by a committed,
      dependency-free rasterizer (`client/scripts/gen-icons.mjs`): 192/512
      `any`, a 512 `maskable` with the star in the safe zone, and a 180px
      apple-touch icon (iOS ignores SVG). `"orientation": "portrait"` dropped.
- [x] **RewardsModal loading skeletons** — tile-shaped shimmer per section
      while the catalog loads.
- [x] **Quit label mismatch** — dropped the `aria-label="Back"` override; the
      accessible name now matches the visible "Quit" (WCAG 2.5.3), arrow
      hidden as decoration.
- [x] **Offline banner can overlap the play header** — now sticky and in-flow
      (pushes content instead of covering Quit), with safe-area-inset padding.
- [x] **Decorative emoji read aloud by SRs** — big-emoji, brand glyphs, ⭐/🔥
      wrapped `aria-hidden`; streak/coin badges keep text alternatives via
      `role="img"` labels.
- [x] **No per-munch SR feedback mid-round** — each munch announces through
      the existing live region ("Munched 7. 3 left." / "Oops — 4 isn't one."),
      self-throttling by replacement; the round-complete announcement
      supersedes.
- [x] **Midnight theme breaks `--sun` companions** — new `--sun-shadow` /
      `--on-sun` vars (overridden per theme) now drive `.btn.sun`, the brand
      glyph, `.stat.accent`, the equipped reward tile, and the offline banner.

### P6 — Refactoring

_All done (2026-07-10)._

- [x] **Extract shared `db/rows.ts`** — row interfaces, mappers, and
      `PROFILE_SELECT` now live once; the drift (SQLite `createProfile`
      omitted the streak column PG inserts) is fixed with an explicit insert.
- [x] **Shared Db contract test suite** — `db/contract.test.ts` runs one
      behavioral spec against SQLite _and_ pg-mem (guest upgrade + prune,
      slide throttle, conditional session award, scoped caught-up counts,
      equipped defaults, profile/account cascades). Adapter quirks stay in the
      per-adapter files.
- [x] **Use `handle()` in all routers** — 15 hand-rolled try/catch handlers in
      `auth/routes.ts` + `api/profiles.ts` now use the shared wrapper
      (`api/handle.ts`); `SessionError` renamed to `HttpError` in its own
      module (it was never session-specific).
- [x] **Delete `shared`'s runtime `OPERATIONS` export** — `shared` is truly
      type-only again; one `engine/operations.ts` list (also the curriculum
      order) replaces four server re-declarations.
- [x] **Wire `Transition.fraction` into `gradeAnswer`** — the half-interval
      rule now lives only in `transitionReview`; grade.ts consumes it instead
      of re-deriving it.
- [x] **Unify ownership on `loadOwnedProfile`** — the middleware now guards
      every `/profiles/:id/*` route (session, progress, dashboard, export,
      rewards×3) and services take the loaded `Profile` (one fewer
      `getProfile` per request); `requireOwnedProfile` remains only where the
      id comes from the session row (answer/complete). Foreign-profile 404s
      covered by one HTTP test over all seven routes.
- [x] **Single source for `DEFAULT_SETTINGS` / `SETTING_BOUNDS`** —
      `data/settings.ts`; `/catalog` serves the bounds and the client's
      SettingsModal reads them from there (with an offline fallback).
- [x] **Split `ProfilesPage.tsx`** — page is ~210 lines; the a11y `Modal` and
      an `AvatarPicker` moved to `components/` (with their CSS), and each
      modal (Account, Rewards, Settings, AddProfile, FactSets, Upgrade) to
      `pages/profiles/`.
- [x] **Drive both `ADDITIVE_COLUMNS` lists from one declaration** —
      `db/additiveColumns.ts` (`{table, column, sqliteDecl, pgDecl}`).
- [x] **Client error-message map + query-key hygiene** — shared
      `messages.ts` (auth + edit maps with per-screen overrides); `qk.me` is
      used by auth.tsx (ME_KEY deleted), AccountModal uses a new `qk.account`,
      and both catalog consumers share one full-payload query with `select`.
- [x] **Move `dayInTz` into the engine** — beside `localYMD` (which now
      reuses it) along with `previousDay`; both unit-tested directly (DST day,
      bad-zone fallback, leap/month/year boundaries).
- [x] _(pass-8 follow-up)_ **Test-only Db methods removed** — `setCoins` and
      `addUnlock` are gone from the contract (tests unlock via the atomic
      `spendAndUnlock`); `addCoins` stays as the legitimate seeding/award
      primitive.

### P7 — Features (spec gaps + new ideas)

_All done (2026-07-10)._

- [x] **Accuracy-aware new-fact throttle** — pure `newFactAllotment` in the
      planner: recent accuracy < 75% pauses cold intros entirely (padding cap
      included), 75–85% halves them, ≥ 85% (or no data) flows the full
      allotment. `startSession` samples the last week's attempts (min 10, max
      20). Engine-tested.
- [x] **Enforce the ~30-presentation session ceiling** (§10) — past
      `SESSION_PRESENTATION_CEILING` attempts the server stops emitting
      in-session re-shows; the demoted box schedule resurfaces the fact.
- [x] **Local rehearsal for offline misses** — a fact missed while the answer
      POST fails self-requeues through the same `spliceInject` at the
      rehearsal gap, so re-shows still happen with the server unreachable.
- [x] **One-tap "Enable now" on the dashboard suggestion** — merges the
      suggested set into the enabled list in place and refreshes
      factsets/progress/dashboard.
- [x] **"Due today" badge on profile tiles** — `dueToday` (due review +
      learning, scoped to enabled sets) on `GET /profiles`; tiles show
      "N to review!" or "All caught up ✓" — invitation framing only.
      Verified in-browser.
- [x] **"Trickiest facts" dashboard panel** — top-5 by worst `accuracyEwma`
      (ties → slowest `medianMsEwma`), reps ≥ 3 and unmastered only; rendered
      as chips with accuracy + a speed tooltip.
- [x] **Name the mastered facts on the session summary** — `masteredFacts` on
      the summary, rendered as op-colored celebration chips.
- [x] **Streak grace / coin-purchasable streak shield** — `perk-streak-shield`
      (60 coins): `bumpStreak` consumes an owned shield to absorb exactly one
      missed day (the atomic `removeUnlock` is both check and spend; never
      stretches two days). The shop's Power-ups section sells it, "Ready"
      when owned. Service + contract tested.
- [x] **Weekly in-app recap card** — "This week" line on the Progress page
      (sessions · answers · accuracy ± delta vs last week · mastered),
      computed from the already-fetched 14-day attempt window. Verified
      in-browser.
- [x] **Family-transfer refinement: nudge in-progress siblings** — a freshly
      mastered sub/div fact now raises a box-1/2 inverse sibling one box
      (stats kept, capped at box 3); learning-phase and box-3+ siblings stay
      untouched. Engine-tested.
- [x] **Grade-band gating for `<`/`>` munch relations** — new boolean
      `comparisons` profile setting (K–1 band starts false): the server picks
      `=` for every board when off; Settings has the toggle. Verified
      in-browser.
- [x] **More reward catalog entries / seasonal items** — 4 seasonal avatars on
      month windows via pure `activeRewardCatalog(now)`; out-of-season
      purchase 400s while owned items stay owned/equipped. Tested.
- [x] **Printable mastery certificate** — a fully-mastered operation grid gets
      a "Print certificate" button; print CSS isolates a fridge-door
      certificate sheet (`window.print()`).
- [x] **Config-driven fluency constants** — `FluencyTuning` threads through
      threshold/grade/calibration with engine defaults; `config.ts` parses
      `FF_FLUENCY_*` / `FF_CEILING_*` env overrides once at boot (documented
      in `.env.example`), so calibration output applies without redeploying.

## Features

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
- [x] **Sync queue head-of-line poisoning on 4xx.** `drainAnswers` retained the
      first failure forever — including deterministic 4xxs (409
      `session_completed`, 404 after a guest prune) — blocking every answer
      behind it and all future offline completions. Now a permanent rejection
      (`ApiError` status < 500) is dropped and the drain continues; only
      network/5xx failures keep-and-retry. Same rule applied to `flushAll`'s
      pending completes. Regression-tested.
- [x] **Sync queue lost-update race.** `drainAnswers` snapshotted the queue then
      unconditionally overwrote storage, silently deleting an answer enqueued
      while a drain was in flight. It now re-reads storage and drops exactly the
      settled prefix (drains are serialized; enqueue only appends).
      Regression-tested.
- [x] **`goNext` completes a session even when queued answers didn't flush.**
      `PlayPage.tsx` ignored `flushAnswers()`' boolean; the server then computed
      points from an incomplete attempt log and the late replays 409'd. Now a
      partial drain takes the offline-finish path (`markPendingComplete`), and
      the session completes on reconnect with the full log.
- [x] **Guest "Exit" destroys all progress with zero warning.** The header
      button logged the guest out → account stranded → pruned; coins/progress
      unrecoverable. Now confirm-gated ("Leaving already?") with a "Save my
      progress" CTA into the existing UpgradeModal; the destructive path is an
      explicit "Exit and delete my progress".

### P2 — Quick high-impact wins (perf + kid-facing UX)

- [x] **No HTTP compression in production.** Render doesn't compress for you;
      the bundle + dashboard JSON shipped 3–4× their gzipped size. Added
      `compression()` ahead of all routes; gzip round-trip tested.
- [x] **No Cache-Control on hashed assets.** `express.static` defaulted to
      `maxAge: 0`, so every content-hashed asset revalidated per load. Now
      `assets/*` (Vite's hashed output) is `max-age=1y, immutable`; root-level
      un-hashed files (index.html, sw.js, manifest, icon) are `no-cache` —
      deliberately, since their names never change across deploys. Verified
      against a prod build.
- [x] **Global Enter/Space handlers hijack Quit/mute during play.** The
      window-level keydown handlers `preventDefault()`ed without checking the
      target — keyboard users couldn't activate Quit or mute all session. The
      activation keys (Enter/Space) now yield to a focused interactive element
      (`keys.ts` helper); movement keys stay global since focus sits on a cell
      button after any tap.
- [x] **ProgressPage has no error state** — failed dashboard/progress loads
      showed skeletons forever. Now renders the same "Couldn't load — Try again"
      retry card ProfilesPage uses (skeletons suppressed on error; retry
      refetches only the failed query/queries).
- [x] **Operator glyph ~1.5:1 contrast.** `.munch-op` / `.equation .op` rendered
      the one glyph distinguishing `+` from `×` in `--sun` yellow on cream — far
      below the 3:1 large-text minimum. Operators (and the study-card answer
      reveal) now use the op's darker `--shadow` shade (3:1+, hue preserved).
- [x] **Progress bar pins at 100% while injected re-shows remain** — divided by
      the starter deck only, so after a few misses the bar promised "done!" with
      cards still coming. Now `played / (played + queue.length)` — the live
      remaining count, injects included.
- [x] **Use the delivered `thresholds` for instant "fast" feedback** (DESIGN
      §4.7 pins this). The client never read `SessionResponse.thresholds`;
      `fast` waited on the answer round trip and was always `false` offline.
      The round announcement now computes `fast` locally from the session's
      per-op threshold and fires before the network call; the server stays
      authoritative for scheduling.

### P3 — Server correctness (medium/low bugs)

- [x] **"All caught up" can become permanently unreachable.** `caughtUp` counted
      _all_ progress rows but the planner serves only enabled sets — a disabled
      set's rows, or `familyTransfer` seeding an inverse sibling whose set isn't
      enabled, stranded due rows no session could clear. `answer()` now builds
      the enabled fact universe and (a) scopes both caught-up counts to it (new
      optional `factIds` filter on `countDueReview`/`countLearning`, both
      adapters) and (b) only seeds a sibling that's actually reachable.
      Service-level tested.
- [x] **`unlockReward` non-atomic read-modify-write** — a concurrent session
      award could be clobbered (absolute `setCoins`); a crash between debit and
      unlock spent coins for nothing; two tabs could double-spend. New
      transactional `spendAndUnlock` Db method (both adapters) claims the item,
      then debits with a conditional relative `coins >= cost` update, all in one
      transaction. SQLite tests cover the concurrent-double-spend and
      award-survives-mid-spend races and the insufficient-rollback; pg-mem
      covers the debit math (note: pg-mem can't honor ROLLBACK, so the
      rollback side-effect is asserted on the SQLite adapter). (`setCoins` is now
      test-only — a dead-code cleanup for the refactor pass; audit pass 8 found
      `addCoins` and `addUnlock` have joined it.)
- [x] **Stale open session closed without awarding its coins.** `startSession`
      plain-`completeSession`d a prior-day open session; the queued offline
      `complete` then saw `firstCompletion === false` and skipped the award —
      breaking the offline banner's "coins will update" promise. New
      `closeAndAward` helper reconciles attempts (coins + streak) when closing;
      `completeSessionAndAward` sets `completedAt` transactionally so the late
      `complete` can't double-award. Service-level tested across a day boundary.
- [x] **Repeat `complete()` bumps the streak** — `bumpStreak` ran
      unconditionally, so a re-POST straddling midnight advanced the streak with
      no new play. Now gated on `firstCompletion` (coins already were); a repeat
      completion just reads the current streak back.
- [x] **End-of-deck re-show splices to index 0** — a fact missed on the last
      card was re-shown immediately, violating §4.4's "never back-to-back". The
      splice now skips an inject that would land at index 0 (only happens with
      an empty queue, since `afterOffset` is always 3); the demoted box schedule
      resurfaces the fact instead.
- [x] **MunchBoard side effects inside the `setEaten` updater** — sounds, the
      wrong-munch count, and `onComplete` ran inside the state updater, so
      StrictMode's double-invoke double-fired them and inflated the logged
      `wrongMunches`. Munch state now lives in `eatenRef` (read/written
      synchronously, guarding re-munch); the updater is pure and effects run
      once outside it. Verified in-browser (clean round → advance).
- [x] **Email matching is case-sensitive end-to-end** — `Foo@Bar.com` couldn't
      log in as `foo@bar.com`, and the same mailbox could register twice. A
      `normalizeEmail` (trim + lowercase) is now applied on every store and
      lookup (signup, login, upgrade, account edit). Tested.
- [x] **Sessions expire 30 days from creation, not "30 days idle"** (DESIGN §2)
      — a daily player was hard-logged-out every 30 days. `attachAccount` now
      slides `expires_at` forward on use via a new conditional `slideAuthSession`
      (both adapters), throttled to ~once/day, and re-issues the cookie so the
      browser copy slides too. Db-level tested (slide / throttled / expired).
- [x] **`bumpStreak` DST edge** — `now − 24h` landed two calendar days back in
      the first hour after spring-forward, resetting a genuine streak. "Yesterday"
      is now computed by calendar arithmetic (`previousDay`), DST-proof. Unit
      tested across spring-forward, month, year, and leap boundaries.
- [x] **`responseMs` accepts fractions** — passed validation, then 500'd on
      Postgres (`INTEGER` column) _after_ progress already wrote. Now
      `Math.round`ed at the existing clamp; tested via the CSV export.

### P4 — Performance (hot path + client pacing)

- [x] **Wrap `answer()`'s writes in one transaction** — _done._ New
      `db.recordAnswer(AnswerWrite)` persists progress + per-op stat + family
      seed + attempt + working-state in one transaction on both adapters (one
      WAL commit / one PG connection round trip); rollback asserted on SQLite.
- [x] **Don't block the next card on the answer round trip** — _done._
      `finishRound` advances immediately; the response reconciles into the
      _live_ queue when it lands (pure `spliceInject`, position compensated by
      rounds played meanwhile, never index 0, unit-tested) and completion
      awaits the in-flight POSTs so the server scores a full attempt log.
      Verified in-browser: instant advance, re-shows land at the rehearsal
      gap, summary scores all attempts.
- [x] **Skip the full-deck `working_state` rewrite when `learning` didn't
      change** — the deck half of workingState is static, so for a review fact
      (the majority) the per-answer rewrite of 5–15 KB of JSON was pure waste.
      `answer()` now tracks whether the learning map changed and only writes
      then.
- [x] **Parallelize `startSession`'s independent reads** — the ~6 post-gate
      reads (enabled sets, timezone, open session, thresholds, muncher, effect)
      now run in one `Promise.all` batch, and both return branches share a
      `common` fields object instead of re-fetching muncher/effect/thresholds.
- [x] **SW cache hygiene.** The offline `/` shell was pinned at the
      first-install version. Navigations now refresh the cached shell on success;
      and the deferred half is done too — sw.js moved to `client/src/` and is
      emitted at build time with a per-build id stamped into the cache name
      (`emit-stamped-sw` plugin), so each deploy's activate evicts the previous
      cache automatically. (Fun autopsy: the first stamp attempts "worked" but
      `String.replace` was stamping the placeholder's _mention in the header
      comment_, not the CACHE constant — replaceAll now.)
- [x] **Confetti animates `top`** — the one non-compositable animation in the
      app (28 pieces forcing layout every frame). Now animates
      `transform: translateY` with the per-piece rotation folded into the
      keyframe via a `--rot` custom property; `will-change: transform`.
- [x] **Trim eagerly-loaded font weights** — audited every `font-weight`
      against its font family: Fredoka 400 (display elements only use 500/600/700)
      and Nunito 700-italic (no italic anywhere) were never requested. Dropped
      both imports (9 → 7 woff2 in the critical path). The rest are all in use.
- [x] **Drop the 2-space indent on the JSON export** (`api/index.ts`) — halved
      the payload; it's a download, not read raw.

### P5 — UI polish & accessibility

_All done (2026-07-10)._

- [x] **Locked reward tiles show no goal** — locked tiles stay tappable, read
      "⭐ 80 · 45 to go!", and tapping shows an encouraging goal banner
      ("needs N more ⭐ — keep playing!"). Verified in-browser.
- [x] **Profile-create and fact-set save mutations fail silently** — both
      modals gained `onError` banners (SettingsModal pattern).
- [x] **Keyboard-only hint shown on touch devices** — the munch hint is split:
      keyboard text only under `(hover: hover) and (pointer: fine)`, plain
      "Tap a number to munch it" otherwise.
- [x] **`aria-pressed` on fact-set pills, grade-band and avatar pickers** —
      plus accessible names on the bare-emoji avatar buttons and full set
      labels on the pills.
- [x] **Munch grid ARIA + focus loss** — `role="group"` (no fake grid
      semantics), munched cells use `aria-disabled` + a click guard instead of
      `disabled` (focus no longer drops to `<body>`), and a roving tabindex:
      one tab stop at the muncher's cell, focus follows arrow-key movement.
- [x] **Touch targets** — profile-tile action buttons now `min-height: 44px`.
- [x] **Fact-grid cell details are hover-`title`-only** — cells (and trend-bar
      days) are tappable and carry `aria-label`s; a tap writes the details
      into a visible caption line. Cells stay out of the Tab order (~170 tab
      stops would bury every other control).
- [x] **PWA icons + orientation** — real PNGs generated by a committed,
      dependency-free rasterizer (`client/scripts/gen-icons.mjs`): 192/512
      `any`, a 512 `maskable` with the star in the safe zone, and a 180px
      apple-touch icon (iOS ignores SVG). `"orientation": "portrait"` dropped.
- [x] **RewardsModal loading skeletons** — tile-shaped shimmer per section
      while the catalog loads.
- [x] **Quit label mismatch** — dropped the `aria-label="Back"` override; the
      accessible name now matches the visible "Quit" (WCAG 2.5.3), arrow
      hidden as decoration.
- [x] **Offline banner can overlap the play header** — now sticky and in-flow
      (pushes content instead of covering Quit), with safe-area-inset padding.
- [x] **Decorative emoji read aloud by SRs** — big-emoji, brand glyphs, ⭐/🔥
      wrapped `aria-hidden`; streak/coin badges keep text alternatives via
      `role="img"` labels.
- [x] **No per-munch SR feedback mid-round** — each munch announces through
      the existing live region ("Munched 7. 3 left." / "Oops — 4 isn't one."),
      self-throttling by replacement; the round-complete announcement
      supersedes.
- [x] **Midnight theme breaks `--sun` companions** — new `--sun-shadow` /
      `--on-sun` vars (overridden per theme) now drive `.btn.sun`, the brand
      glyph, `.stat.accent`, the equipped reward tile, and the offline banner.

### P6 — Refactoring

_All done (2026-07-10)._

- [x] **Extract shared `db/rows.ts`** — row interfaces, mappers, and
      `PROFILE_SELECT` now live once; the drift (SQLite `createProfile`
      omitted the streak column PG inserts) is fixed with an explicit insert.
- [x] **Shared Db contract test suite** — `db/contract.test.ts` runs one
      behavioral spec against SQLite _and_ pg-mem (guest upgrade + prune,
      slide throttle, conditional session award, scoped caught-up counts,
      equipped defaults, profile/account cascades). Adapter quirks stay in the
      per-adapter files.
- [x] **Use `handle()` in all routers** — 15 hand-rolled try/catch handlers in
      `auth/routes.ts` + `api/profiles.ts` now use the shared wrapper
      (`api/handle.ts`); `SessionError` renamed to `HttpError` in its own
      module (it was never session-specific).
- [x] **Delete `shared`'s runtime `OPERATIONS` export** — `shared` is truly
      type-only again; one `engine/operations.ts` list (also the curriculum
      order) replaces four server re-declarations.
- [x] **Wire `Transition.fraction` into `gradeAnswer`** — the half-interval
      rule now lives only in `transitionReview`; grade.ts consumes it instead
      of re-deriving it.
- [x] **Unify ownership on `loadOwnedProfile`** — the middleware now guards
      every `/profiles/:id/*` route (session, progress, dashboard, export,
      rewards×3) and services take the loaded `Profile` (one fewer
      `getProfile` per request); `requireOwnedProfile` remains only where the
      id comes from the session row (answer/complete). Foreign-profile 404s
      covered by one HTTP test over all seven routes.
- [x] **Single source for `DEFAULT_SETTINGS` / `SETTING_BOUNDS`** —
      `data/settings.ts`; `/catalog` serves the bounds and the client's
      SettingsModal reads them from there (with an offline fallback).
- [x] **Split `ProfilesPage.tsx`** — page is ~210 lines; the a11y `Modal` and
      an `AvatarPicker` moved to `components/` (with their CSS), and each
      modal (Account, Rewards, Settings, AddProfile, FactSets, Upgrade) to
      `pages/profiles/`.
- [x] **Drive both `ADDITIVE_COLUMNS` lists from one declaration** —
      `db/additiveColumns.ts` (`{table, column, sqliteDecl, pgDecl}`).
- [x] **Client error-message map + query-key hygiene** — shared
      `messages.ts` (auth + edit maps with per-screen overrides); `qk.me` is
      used by auth.tsx (ME_KEY deleted), AccountModal uses a new `qk.account`,
      and both catalog consumers share one full-payload query with `select`.
- [x] **Move `dayInTz` into the engine** — beside `localYMD` (which now
      reuses it) along with `previousDay`; both unit-tested directly (DST day,
      bad-zone fallback, leap/month/year boundaries).
- [x] _(pass-8 follow-up)_ **Test-only Db methods removed** — `setCoins` and
      `addUnlock` are gone from the contract (tests unlock via the atomic
      `spendAndUnlock`); `addCoins` stays as the legitimate seeding/award
      primitive.

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

## Audit pass 7 (2026-07-09) — full-repo re-read

A fresh top-to-bottom read after pass 6 (engine, DB adapters/schemas, auth, API
routes, client pages, sync queue, service worker, deploy/CI config). The engine
math, scheduling, sync-queue serialization, reward atomicity, and security
posture from earlier passes all re-verified sound. New, verified findings below
(ordered most- to least-severe); pass-6 leftovers (P4–P7) remain tracked above.

### Correctness

- [x] **Concurrent `complete()` double-awards coins and streak.** `complete()`
      reads `session.completedAt`, then `completeSessionAndAward` sets it
      _unconditionally_ — two in-flight completes (e.g. the play screen's
      complete racing a reconnect `flushAll` replay, or two tabs) both see
      `firstCompletion === true` and both credit coins + bump the streak. Make
      the transition conditional (`WHERE completed_at IS NULL`), return whether
      this call won it, and gate the award/streak on that (both adapters;
      `closeAndAward` gets the same treatment).
- [x] **A guest can set real credentials via `PATCH /auth/account` without
      clearing `is_guest`** — the account then has a working email/password but
      `deleteExpiredGuests` still reclaims it once its sessions lapse (silent
      data loss for an account the user believes is saved), bypassing the
      upgrade flow. Reject email/password edits for guest accounts (409
      `guest_account`); `/auth/upgrade` is the supported path. (UI already hides
      Account for guests — this closes the server-side hole.)
- [x] **Partial write before validation in the PATCH handlers.** Both
      `PATCH /auth/account` and `PATCH /profiles/:id` validate-and-apply field
      by field, so `{ email: valid, password: "short" }` persists the email
      change and _then_ returns 400 `weak_password` — a response that reads as
      "nothing happened" after half the edit landed. Validate every provided
      field first, then write.
- [x] **Email uniqueness check-then-write races return raw 500s.** Signup,
      guest upgrade, and account email edit all do `findAccountByEmail` → write;
      two concurrent requests with the same email both pass the check and the
      loser dies on the DB unique constraint as `internal_error`. Catch the
      write failure, re-check the email, and return the honest 409
      `email_taken`. (Also: `POST /auth/login` echoes the submitted email
      verbatim instead of the normalized form — return the stored casing.)
- [x] **Duplicate ids in `PUT /profiles/:id/factsets` → 500.** The validation
      admits `["add-0-5","add-0-5"]` (length + membership checks pass); the
      insert then violates the `(profile_id, fact_set_id)` primary key.
      De-duplicate before validating length.
- [x] **Unknown `/api/*` paths fall through to the SPA catch-all** — in prod a
      typo'd API GET returns 200 + index.html instead of a 404 (and JSON
      consumers choke on HTML). Add a JSON 404 fallback at the end of the /api
      chain.

### Hygiene / perf

- [x] **`attachAccount` runs a DB session lookup for every static asset and
      navigation request in prod** — only `/api` handlers read `req.accountId`.
      Scope the middleware to the /api mount.
- [x] **`COOKIE_SECRET` is dead config guarded by boot-refusal theater.** The
      session cookie is deliberately unsigned (the token's entropy is the
      secret — auth/session.ts); `cookieParser(secret)` only signs cookies
      created with `signed: true`, which nothing uses. Yet index.ts refuses to
      boot in prod without a strong value (added in pass 1 under the belief the
      cookie was signed) and render.yaml generates one. Remove the unused
      wiring, the guard, and the env entries; document the actual security
      model where the cookie is set.
- [x] **Windows checkout breaks `npm run format` and the pre-commit hook.** No
      `.gitattributes`, so `core.autocrlf=true` smudges every file to CRLF and
      Prettier (endOfLine: lf) flags all of them — the hook's format gate can't
      pass, inviting `--no-verify` habits. Add `.gitattributes`
      (`* text=auto eol=lf`, binaries marked) and normalize the working tree.

## SEO pass (2026-07-10)

On-page SEO for the live site. Expectation-setting: metadata mostly improves
result presentation/CTR and social shares; ranking comes from content,
performance, and links — the free-tier cold start (~50s) remains the biggest
technical handicap, and a custom domain would beat the shared-reputation
`onrender.com` subdomain if this ever gets serious.

- [x] Keyword-relevant `<title>` + meta description; canonical URL.
- [x] Open Graph + Twitter card tags (og:image = the 512 icon).
- [x] JSON-LD structured data (`WebApplication`, EducationalApplication,
      price 0) readable without executing the SPA bundle.
- [x] `robots.txt` (auth-gated /play, /progress, /api disallowed) +
      `sitemap.xml` (the landing page is the only public URL).
- [x] Crawlable landing content — the auth page (the one public route) gained
      an `<h1>` and a below-the-fold semantic section (what it is, spaced
      repetition, made-for-families) so search engines have real text to rank.
- Not done (bigger levers, deliberate): SSR/prerender (Google renders JS fine
  at this scale), a custom domain, paid tier for cold starts, and off-page
  links. Submit the site in Google Search Console to start indexing.

## Audit pass 9 (2026-07-10) — coverage check after the P4–P7 clear

A targeted audit of what the big batch left untested. Three service-level gaps
found and closed the same pass (all passed first-run — the features behaved as
designed):

- [x] **Presentation ceiling had no test** — added: repeated misses re-show via
      injects until the session's attempt count crosses the ceiling, then stop.
- [x] **`comparisons: false` gating untested at the board level** — added: a
      session planned for such a profile emits `=` boards exclusively.
- [x] **Accuracy-throttle service wiring untested** (engine was covered) —
      added: a ~30%-accuracy session yields a next-day plan with zero cold
      intros.
- [x] **`masteredFacts` asserted on the HTTP completion summary** (shape +
      empty case).
- Non-gaps, verified: seasonal/perk rules, streak shield, `removeUnlock`,
  `recordAnswer` atomicity, `dueToday`, trickiest/weekly, config parsing, the
  throttle bands, and the sibling nudge all landed with tests in their own
  commits; `spliceInject` is unit-tested and its PlayPage wiring was verified
  in-browser (the imperative game loop stays untested by design — see the
  React Query note in pass 2).

## Audit pass 8 (2026-07-10) — remaining-files sweep

Covered what pass 7 skimmed or skipped: `ops.ts`, `sound.ts`, the
Muncher/CelebrationBurst/Confetti components, `calibrate.ts` +
`engine/calibration.ts`, `password.ts`, the manifest, eslint/tsconfig/vitest
configs, the hooks installer, and README — plus a fresh-eyes re-read of the
pass-7 changes. All clean except:

- [ ] **`playFast()` is dead code — a fast round sounds identical to a normal
      correct one.** `sound.ts` ships a "correct AND fast" sparkle arpeggio
      that nothing imports; the P2 thresholds work made the client compute
      `fast` locally (in `finishRound`), so wiring it is a two-line change
      right where the fast announcement fires. Until then the fluency win has
      no audio identity (§4.7's instant feedback is visual/SR-only).
- [ ] **Test-only Db methods have grown**: `addCoins`, `setCoins`, _and_
      `addUnlock` are now only called from tests — prod paths use the
      transactional `completeSessionAndAward` / `spendAndUnlock`. Fold into
      the P6 dead-code cleanup (which currently names only `setCoins`);
      either delete them from the `Db` interface or move them to a test
      helper.
- Non-findings, verified sound this pass: calibration percentile math +
  advisory clamps; argon2 verify's catch-all (malformed hash → false, no
  throw); the hooks installer's non-git guard; eslint flat config coverage;
  `pendingCount` (a legitimate test observability helper); no TODO/FIXME
  markers anywhere in source. Manifest icon/orientation gaps were already
  tracked in P5.

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

- [~] **Free Render Postgres expires every ~30 days — accepted for now.** The
  original `fact-fluency-db` was suspended on 2026-07-04 (Render's free-tier
  limit), which crash-looped the service (`migrate()` can't reach the DB, boot
  exits 1) and failed the 2026-07-09 deploy. Resolved 2026-07-10 by deleting
  the suspended DB and re-syncing the Blueprint (fresh free instance; the
  schema self-applies via `migrate()`; prior data was discarded — user count
  negligible). **Decision (2026-07-10): stay on the free tier until there's
  real user traffic** — the monthly delete + Blueprint re-sync is the accepted
  routine, and losing demo data is fine. **The clock restarts each cycle:
  expect the next suspension around 2026-08-09** (Render emails two warnings
  first). Upgrade to a paid instance only once real users would be hurt by a
  reset.
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

## Session 2026-07-12/13 — localization, accessibility, credibility, game variety

Worked the COMPETITORS.md §5 differentiation backlog. 303 server + 18 client
tests passing. Remaining §5 items are all externally gated: emailed recap
(#2, needs a domain + a Security-approved email vendor), opt-in outcome tracking
(#6, parked on a COPPA/consent decision — the methodology page shipped), and
classroom/SSO (#9, vendor-gated). See the COMPETITORS.md §5 checklist for status.

- [x] **Localization (4 languages).** react-i18next; English + Spanish + French + Simplified Chinese. `client/src/i18n/{en,es,fr,zh}.ts` (es/fr/zh typed
      `typeof en`, so a missing key fails the build). Device-level detection
      (localStorage `ff_lang` + navigator), switcher on the landing hero +
      profiles header, `<html lang>` synced. **Server-generated prose** is
      emitted as structured `LocalizedText` `{key, params}` (strategy hints,
      dashboard suggestion) or resolved by id (catalog/reward labels), so all
      copy lives in the client dictionaries — no server locale needed.
- [x] **Narrated audio (#5).** On-device Web Speech API (`client/src/speech.ts`);
      per-profile `narrate` accessibility setting; reads the study equation and
      each munch prompt (as a question, no answer) aloud, with a replay button.
      Also localized `MunchBoard` (a gap missed in the initial i18n sweep).
- [x] **Methodology / efficacy page (#6, page half).** Public `/how-it-works`
      (lazy route, linked from the landing + sitemap), honest — no fabricated
      outcomes — with a children's-data privacy promise. Localized.
- [x] **Collectible sticker book (#11).** A read-only collection gallery over
      the rewards catalog (owned vs. locked "?"), progress bar + completion
      celebration; shared `RewardPreview` with the shop.
- [x] **Number Feast — real-time multiplayer arena (#10).** A "sushi-go-round":
      a belt of numbered plates, tap the ones matching the fact for points, bump
      rivals; score-attack timer; solo-vs-bots or live (same account, other
      devices). Server-authoritative tick loop over a new `/api/feast-ws`
      (`server/src/feast/live.ts`) stepping a pure engine (`engine/feast.ts`,
      12 unit tests). Client arena `FeastPage`. Full design in **FEAST.md**.
- [x] **Deploy fix.** Server now binds `0.0.0.0` (was Node's default IPv6 `::`),
      which Render's IPv4 port scan couldn't detect under the Node 24 pin —
      deploys were timing out with "no open ports detected".

## Known limitations

- `caughtUp` is computed per profile (due-review + learning counts), not scoped
  to the day's planned intros — fine for now, revisit with the dashboard.
- No automated test against a _live_ Postgres (pg-mem covers the SQL). A manual
  end-to-end smoke flow was run against the live Render Postgres on first deploy
  and passed; consider scripting it as a post-deploy check if deploys get frequent.
