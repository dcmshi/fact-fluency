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
  links.

## Search Console submission (2026-07-31)

- [x] Verified the URL-prefix property — `client/public/google*.html`, served
      byte-for-byte (Prettier ignores it, or its HTML parser rewrites the token).
- [x] **Per-route canonical.** `index.html` hardcodes the landing canonical and
      the prod catch-all serves that shell for every route, so `/how-it-works`
      declared the homepage as its canonical and would have been folded into it
      — while `sitemap.xml` asked Google to index it. `seo.ts` rewrites
      canonical + og:url per public route; non-public paths collapse to `/`.
- [x] `robots.txt` was missing `/calibrate/`, `/race/`, `/feast/` — logged out
      those render the landing content at a 200, i.e. duplicate URLs.
- [ ] In Search Console: submit `sitemap.xml`, then request indexing for `/`
      and `/how-it-works`. Check _Test live URL_ renders the `<h1>` (SPA).

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

- [x] **`playFast()` is dead code** — _resolved; the entry had gone stale._
      It's imported and called in `PlayPage.tsx:255` (`if (fast) playFast()`),
      right where the fast announcement fires, and `sound.ts:72` still holds the
      distinct C6–E6–G6 sparkle. The fluency win has its audio identity.
      (Verified 2026-07-28.)
- [x] **Test-only Db methods have grown** — _resolved by the P6 cleanup above._
      `setCoins` and `addUnlock` are gone from the `Db` interface (only a doc
      comment still mentions `setCoins` by name). `addCoins` deliberately
      stays and is genuinely prod-used — the race and Feast coin awards call it
      (`race/live.ts:316`, `feast/live.ts:443`, `session/race.ts:197`), so the
      "only called from tests" claim no longer holds. (Verified 2026-07-28.)
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

- [x] **Localization (5 languages).** react-i18next; English + Spanish + French + Simplified Chinese + Japanese. `client/src/i18n/{en,es,fr,zh,ja}.ts` (es/fr/zh/ja typed
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

## Audit pass 10 (2026-07-28) — full-repo audit (engine / server / client / live games)

Four parallel review passes. Baseline: 336 tests passing (309 server + 27
client), typecheck + lint clean. Every High/Medium item below was re-verified
against source before listing (file:line refs are from the audit).

**Verified sound, don't re-flag:** no IDOR anywhere (every profile route goes
through `loadOwnedProfile`; session routes use `requireOwnedProfile`); 256-bit
session tokens, argon2id, correct cookie flags, timing-equalized login; engine
purity holds (no `Date.now`/`Math.random`/env in any engine source); fact
generation is dedupe-correct and memoized; race choices provably contain
exactly one correct answer; coin double-award is guarded in both live games
(phase/`awarded` set synchronously before any await); `JSON.parse` is wrapped
in both server WS handlers; SW cache stamping + network-first navigations are
correct; MunchBoard's ref-based munch accounting is exactly-once under rapid
double-taps and StrictMode.

### P1 — Crash-proofing (remote-triggerable, takes down the whole process)

_All done (2026-07-28). 340 tests passing (was 336); typecheck + lint clean._

- [x] **WS sockets have no `error` handler** — _done._ `ws` emits `'error'` on
      the server-side socket for protocol violations (bad RSV bits, oversized
      frames, bad close codes) and TCP resets; an unhandled EventEmitter
      `'error'` throws and kills the process — API and both games — for
      everyone. Both servers now attach a shared `ignoreSocketError` to every
      accepted socket (ws closes the offending socket itself, and the existing
      `'close'` handler still runs the room cleanup).
- [x] **Upgrade sockets have no `error` handler during async auth** — _done._
      During the `await db.findAccountIdByToken(...)` window the raw `Duplex`
      was unowned, so a reset mid-auth threw; the handler's `try/catch` can't
      catch an emitter throw — only a listener can. `socket.on('error', …)` now
      goes on before the first await in both upgrade handlers.
- [x] **`maxPayload` left at the 100 MiB default** — _done._ Both
      `WebSocketServer`s now cap frames at 16 KiB (protocol messages are tens of
      bytes).
- [x] **pg `Pool` has no `'error'` listener** — _done._ `fromUrl` now logs and
      swallows the pool `'error'` an idle client emits when its backend
      connection dies (Render PG restart/failover/idle timeout), instead of
      letting routine DB maintenance take the whole service down.
- [x] **New: WS test harness** — there were _no_ tests over either WS server.
      `race/live.test.ts` stands up a real HTTP server + real `ws` client
      against an in-memory SQLite DB: authenticated upgrade, rejected
      unauthenticated upgrade, and "an oversized frame closes that socket
      without taking the server down" (the regression test for the three fixes
      above — it hung before the cap, passes after). The pool-error regression
      test lives in `db/postgres.test.ts`.

### P2 — Liveness (a dropped connection ruins a live game)

_All done (2026-07-28). 347 tests passing; typecheck, lint, format, and a
production build all clean._

- [x] **No WS heartbeat** — _done._ A half-open socket (lid closed, wifi drop)
      stays `readyState === OPEN` and `connected: true` for as long as the OS
      takes to notice, and both games count _connected_ players to decide when a
      round ends — so a zombie stalled the room forever (the kid who actually
      finished never got their placement, and the room was never GC'd). New
      shared `ws/heartbeat.ts`: ping each interval, `terminate()` anyone who
      missed the previous one (terminate fires `'close'`, so the existing room
      cleanup still runs). Cadence overridable via `FF_WS_PING_MS`; the timer is
      `unref`'d so it never holds the process open.
- [x] **Stale-socket `close` handler falsely disconnects a reconnected player**
      — _done._ `joinRoom` swaps `player.ws` on reconnect, but the old socket's
      late `close` unconditionally cleared `connected` — marking a live racer
      disconnected and, in Feast, tearing the room down under the new socket.
      Both close handlers now bail with `if (player.ws !== ws) return;`, and
      `joinRoom` closes the socket it replaced. Regression-tested: without the
      guard the live socket is orphaned and receives no broadcasts.
- [x] **Client has no `ws.onclose` anywhere** — _done._ RacePage now checks
      `readyState` before the finish send (a `send()` on a closing socket is
      silently discarded), handles `onclose`, and has a 15s cap on `placing`, so
      a blip mid-race lands on a "Lost the connection" screen offering the bot
      race or a way back instead of a dead-end heading. FeastPage's `onclose`
      returns to the connecting/lobby view, which already renders the error
      banner and a Quit button, instead of freezing the arena silently. Both
      `onmessage` handlers now guard `JSON.parse` (folded in from P6).
- [x] **No ErrorBoundary in the client tree** — _done._ New
      `components/ErrorBoundary.tsx` wraps the app: a chunk-load failure (the
      post-deploy case, where the SW evicted the old build's cache) auto-reloads
      once, guarded by a 10s sessionStorage cooldown so it can't loop but a
      _later_ deploy still self-heals; anything else renders a localized reload
      card. The browser-specific error strings are unit-tested — that predicate
      decides whether a kid's blank screen repairs itself.
- [x] **Race: no phase guard on join** — _done._ Newcomers are refused during
      `countdown`/`racing` with `{error, code:'race_in_progress'}` (they used to
      be admitted unfinished and never sent `go`, so the race could never end
      for anyone), while an _existing_ racer can still reconnect mid-race. A
      newcomer joining a `finished` room now recycles it back to the lobby
      instead of leaving it bricked. RacePage shows the refusal as copy.
- [x] **Feast: `go()` races `teardown()`** — _done._ `go()` re-checks for
      connected humans after its `await db.listEnabledSetIds` and bails (with a
      `teardown()`), so a room everyone left during the countdown can't start an
      orphaned 90s tick loop that nothing can clear. Note the per-player award
      check was deliberately _not_ tightened: a kid whose wifi drops in the last
      seconds of a round they played should still get their coins, and the
      phantom-game case is prevented at the source.

### P3 — Trust (server believes client-reported performance data)

_All done (2026-07-28). 359 tests passing; typecheck, lint, format clean._

- [x] **`responseMs` has no plausibility floor** — _done._ Validation rejected
      only negative/non-finite values and clamped the upper bound, so a scripted
      client replaying `POST /sessions/:id/answer` straight from the deck it was
      served could report 1ms per fact: correct **and fast**, mastering the whole
      universe in seconds while dragging the per-op median EWMA (the basis of
      every fluency decision) to the floor. Now floored at `MIN_RESPONSE_MS`
      (250ms — below simple-reaction time) before it grades or feeds stats.
      Floored rather than rejected, so an honest client with a sloppy clock still
      gets its answer counted, just not as evidence of speed. HTTP-tested via the
      CSV export.
- [x] **Async race runs are forgeable and re-award coins every submission** —
      _done._ `perRoundMs.length` must now equal `race.factCount`; each split is
      floored at 250ms; and `totalMs` is **derived** from the floored splits
      rather than trusted (the client already computes it as exactly that sum, so
      nothing honest changes, but `{totalMs: 0}` can no longer take first). Coins
      are awarded only when the run is a new personal best, killing the
      resubmit-farm loop. HTTP-tested.
- [x] **Live race `finish` is fully client-trusted** — _done._ The room records
      `startedAt` when `go` goes out and floors any reported time at the elapsed
      wall clock the server itself observed, so `{finish, totalMs: 0}` the
      instant `go` lands can't outrank a real racer; a second `finish` from an
      already-finished player is ignored (it used to let them keep improving
      their time mid-race). Regression-tested over a real socket.
- [x] **Account changes need re-auth + session revocation** — _done._
      `PATCH /auth/account` (email/password) and `DELETE /auth/account` now
      require `currentPassword` — a cookie alone isn't proof on a device shared
      with kids — and a password change revokes every _other_ session via the new
      `deleteAuthSessionsForAccount` (both adapters + contract test), so it can
      actually evict a stolen or shared login instead of one that slides forward
      forever. Timezone-only edits stay one-tap; guests are exempt (no password,
      and their credential path is `/auth/upgrade`). AccountModal gained the
      field and the two new error messages, localized in all four dictionaries.
      `DELETE` also picked up the account rate limiter.
- [x] **Client `responseMs` includes backgrounded time** — _done._ New
      `client/src/timing.ts` exposes `activeNow()`: `performance.now()` minus
      every interval the document spent hidden, via one app-wide
      `visibilitychange` listener. MunchBoard, RaceQuiz, CalibratePage, and
      PlayPage's session-seconds budget all use it, so a kid who presses the home
      button mid-round no longer returns to a ~180s "answer" that demotes the
      fact and trips the session cap on the next card. Unit-tested (visible
      elapsed, a hidden stretch, and a read taken _while_ hidden — the clock
      freezes and never runs backwards). RacePage deliberately keeps the wall
      clock: a race is a timed competition, and the server floors it anyway.

### P4 — Core-loop logic bugs

_All done (2026-07-28). 363 tests passing; typecheck, lint, format, build clean._

- [x] **Deck interleave clusters new facts at the deck's tail** — _done._ `gap`
      was computed per _total_ card while `sinceFresh` counted only review cards,
      so the review pool drained faster than the fresh one and the leftovers piled
      up at the end (14 due + 6 new → `rrrFrrrFrrrFrrrFrrFF`: two cold intros
      back-to-back exactly when a kid is most tired, contradicting the function's
      own "never cluster" docstring). Now `floor(review.length / fresh.length)` —
      reviews per fresh card, the same unit `sinceFresh` counts. The existing test
      only covered the 3-fresh case; added one for the short-deck-padding case
      where new facts are a large share of the deck.
- [x] **Feast: one plate tap sends two `grab`s** — _done._ Plates sit inside the
      ring, so a tap fired the tongue at whatever was nearest _in reach_ of the
      aim **and** sent a second grab for the plate actually tapped — so tapping a
      correct plate across the belt could munch a different, wrong-valued one and
      stun the kid for a tap that was right. Now one path: the plate's handler
      stops propagation, aims at that plate, and fires, so it behaves exactly like
      tapping the belt there and reach is still honoured (`invPlateFrac ∘
plateFrac` is the identity, so a plate's `pos` _is_ its aim coordinate).
- [x] **syncQueue can duplicate answers** — _done (the dedupe half)._ A failed
      POST is indistinguishable from one the server committed before the response
      was lost, so the queue must assume the write may have landed. Rounds now
      carry a client-generated `attemptId` (`newAttemptId()`), reused verbatim by
      any replay; `recordAnswer` checks it **inside** its existing transaction and
      returns false without writing when the round is already logged, so a replay
      can't append twice or advance the fact's schedule on one answer. New
      nullable `attempt.attempt_id` column in both schemas + `ADDITIVE_COLUMNS`
      (so existing deploys self-heal); covered in the shared contract suite
      (dedupes, distinct rounds still write, keyless writes never dedupe) and
      end-to-end over HTTP.
      _Still open:_ the multi-tab drain race (two tabs sharing
      `ff_pending_answers` both replay and race the `slice(settled)` rewrite) —
      wants `navigator.locks`. Much less severe now that replays are idempotent
      server-side; tracked in P6 below.

### P5 — Performance

- [x] **Feast rAF loop re-renders the whole arena at 60fps even when idle** —
      _done._ `setSelfRender` built a fresh object every frame regardless of
      movement, so every plate, rival, and the scoreboard reconciled 60×/s even
      while the muncher stood still — real dropped frames on the older tablets
      this targets. Now returns the previous state when pos/aim moved less than
      `MOVE_EPSILON` (well under a pixel on the belt), so React bails out.
- [x] **Race lobby N+1** — _done._ Was `listRaceRuns` + `getProfile` per race
      (~21 queries per lobby view on PG); now three total regardless of race
      count. Every creator is a profile on the same account, so one
      `listProfiles` covers them, and a new `listRaceRunsForRaces` (both
      adapters + contract test) fetches the runs in one batch, grouped in
      memory for the count and the "have I played this?" flag.
- [x] **Profile list is 4 queries per profile** — _done_ (the first pass
      deferred this; revisited). Now 2 + N queries instead of 1 + 4N — for four
      kids, 6 instead of 17. Three changes: `PROFILE_SELECT` carries
      `last_played_day`, so the per-profile streak lookup is gone entirely (the
      data was already on the row being read); one
      `listEnabledSetIdsForProfiles` covers every kid's enabled sets; and a new
      `countDueAndLearning` does both counts in one pass, which is the win that
      matters — the filter is the whole ~1,000-id enabled fact universe and it
      was being scanned twice per profile. Both new methods are in the contract
      suite, including that the combined counts equal the separate ones.
      _Note:_ Postgres uses `SUM(CASE …)` not `COUNT(*) FILTER` — pg-mem
      silently ignores `FILTER` and counts every row, which the contract suite
      caught.
- [x] **Calibration seeds upserted one await at a time** — _done._ New
      transactional `upsertProgressMany` (both adapters + contract test)
      replaces the per-seed await loop: one round trip instead of a few hundred
      sequential ones on Render PG, and a calibration now either seeds the whole
      schedule or none of it rather than leaving a half-seeded plan behind.
      Duplicate `factId`s in the submitted results are also dropped now — a
      repeated id would have weighted that fact twice in the percentile maths
      behind every starting box.
- [x] **Missing FK indexes** on `race.created_by_profile_id` and
      `race_run.profile_id` — _done._ Added `idx_race_creator` /
      `idx_race_run_profile` to both schemas, so a profile or account delete no
      longer scans both race tables once per cascaded row.

### P6 — Hardening

- [x] **Unclaimed WS upgrade requests are left hanging** — _done._ Once any
      `'upgrade'` listener exists Node stops auto-closing unhandled upgrades, so
      every probe to `/api/anything` leaked a half-open socket. New
      `ws/upgrade.ts`: each game claims its path, and `attachUpgradeGuard`
      (attached last in `index.ts`, since listeners run in registration order)
      destroys anything nobody claimed. Regression-tested.
- [x] **No Origin check on either WS upgrade (CSWSH)** — _done._ The handshake
      authenticates from the session cookie alone, so any page a parent visited
      could open a socket into their kids' game — `SameSite=Lax` was the entire
      defence, one browser-policy change from nothing. Now same-origin is
      required explicitly. A _missing_ Origin is still allowed (non-browser
      clients don't send one, and the attack is specifically a browser on
      another site), and loopback origins are allowed outside production so the
      Vite dev proxy's :5173 → :3001 hop keeps working. Regression-tested.
- [x] **PG TLS uses `rejectUnauthorized: false` unconditionally** — _done._
      Extracted to `sslFor(url)`: managed Postgres still gets the unverified
      default (its CA isn't one we hold), but `?sslmode=verify-ca|verify-full`
      or a `PGSSLROOTCERT` bundle now opts into real verification instead of
      every non-local connection being encrypted-but-unauthenticated.
- [x] **Client WS `onmessage` does unguarded `JSON.parse`** — _done_ (folded
      into the P2 client work): both handlers try/catch and ignore unparseable
      frames instead of losing that update to a throw.
- [x] **Engine timezone fallbacks disagree** — _done._ `dayInTz` now falls back
      to **UTC**, matching `tzOffsetMinutes`. They used to disagree (machine
      calendar vs 0), and `startOfDayAfter` combines them — so with an invalid
      account tz on a host west of UTC, a just-promoted box-1 fact could get a
      `dueAt` already in the past and come due immediately. It also made engine
      output depend on the host's ambient zone, which nothing else here does.
      (Masked in prod: Render runs UTC.) Test updated to pin UTC, not "some
      date-shaped string".
- [x] **Concurrent answers can clobber `workingState`** — _done._ `answer()` is
      a read-modify-write over the session's working state, and the client
      deliberately doesn't wait for the previous POST, so two answers really do
      overlap: both read the same snapshot and the second write erased the
      first's learning counter. Reproduced first — one counter came back
      `undefined`. Note a conditional/merged _write_ wouldn't have been enough:
      the stale read also feeds `inSessionCorrect`, so the second answer graded
      against a stale count too. The whole critical section is now serialized
      per session id (`session/sessionLock.ts`), with the chain surviving a
      failed answer and the map entry released once nothing is queued behind it
      (both covered by tests). Scope is one process — fine for a single web
      service with one open session per profile, and documented as needing a row
      lock if this ever runs multi-instance.
- [x] **Queued answers can land out of order vs live successes** — _done._ Once
      anything is queued, every later answer for that session joins the queue
      instead of going live, and the queue drains in order. Previously a fact
      missed at round N (queued) then re-shown correctly at N+1 (live) reached
      the server as correct-then-miss, inverting that fact's box scheduling. The
      queued path keeps the same local rehearsal fallback as the offline one and
      kicks a drain, so a recovered connection still catches up mid-session.
- [x] **syncQueue has no timed retry** — _done._ Flushes ran only on mount,
      `online`, and session completion, so a transient 5xx _while connectivity
      stayed up_ fires no `online` event and stranded an offline session's coins
      and streak until the kid next played. Now a capped exponential backoff
      (5s → 5min), skipped entirely while `navigator.onLine` is false (the
      `online` event covers that) and reset once answers get through, with one
      timer at a time so every open tab doesn't pile onto a struggling server.
      Unit-tested with fake timers.
- [x] **syncQueue multi-tab drain race** (carried over from P4) — _done._ The
      promise chain only serialized within a tab, but the queue is shared
      localStorage: an installed PWA plus a browser tab both replayed it and
      raced the `slice(settled)` rewrite, which can drop an entry that never
      sent. The drain now runs under a Web Locks lock where available (older
      Safari falls back to the in-tab chain alone).

### P7 — Polish

_All done (2026-07-28)._

- [x] **Race `finished` advertises coins that were never credited** — _done._
      The broadcast attached `coinsEarned` to every standing while the award
      loop skipped non-finishers, and the client renders it verbatim, so a kid
      who dropped saw "+N ⭐" their balance never received. The broadcast now
      mirrors the award condition.
- [x] **Lobby start condition isn't re-checked on disconnect** — _done_ (both
      games). A readies, B leaves, and nothing re-ran `shouldStart`/`maybeStart`
      — so whoever was left sat in a lobby that could never start, their own
      ready button already disabled. Both `close` handlers re-check.
- [x] **Feast `MAX_PLAYERS` is enforced only for bots** — _done._ An account
      with five-plus profiles could crowd the documented 1–4 arena; humans are
      capped too now (refused with `arena_full`), with reconnects exempt since
      they already hold a seat.
- [x] **Muncher `aria-label` is hardcoded English** — _done._ It read "Cat
      muncher" to a screen reader in an otherwise fully localized game. Now
      `munch.muncherLabel` (all four dicts) interpolated with the animal name
      reused from the existing `rewards.items.muncher-*` labels rather than
      duplicating them. The unused English `OP_LABEL` is deleted — operation
      names live in the dictionaries as `ops.*`, and a hardcoded English map
      sitting next to `OP_SYMBOL` was a trap waiting for the next caller.
- [x] **RaceQuiz's lock drops keyboard focus to `<body>`** — _done._ Swapped
      `disabled` for `aria-disabled` (+ the matching CSS selector); `pick()`
      already ignored taps while locked. A keyboard user no longer has to Tab
      back into the row after every wrong answer, mid-race.
- [x] **`transitionReview` docstring contradicts the box-5 rule** — _done._
      Documented _why_ box 5 demotes on a slow-correct (mastery means correct
      **and** fast, so a slow answer is no longer evidence of it), renamed the
      misleading `stayed` local, and left a note not to "simplify" it — in the
      repo's most correctness-critical function, that comment was an invitation
      to break the fluency gate.
- [x] **Race ties at the clamp get arbitrary placements** — _done._ The
      "sub-ms ties are impossible" comment was false: times are whole ms clamped
      at `MAX_RACE_MS`, and a live race _defaults_ an unreadable time to that
      cap, so two capped racers tie exactly and sort order decided 1st vs 2nd
      (and the coins). `rankRuns` now uses competition ranking (1, 2, 2, 4).

## Known limitations

- `caughtUp` is computed per profile (due-review + learning counts), not scoped
  to the day's planned intros — fine for now, revisit with the dashboard.
- No automated test against a _live_ Postgres (pg-mem covers the SQL). A manual
  end-to-end smoke flow was run against the live Render Postgres on first deploy
  and passed; consider scripting it as a post-deploy check if deploys get frequent.
