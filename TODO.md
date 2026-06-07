# TODO

Where things stand and what's left. v1 (DESIGN.md §9) is complete: auth, all four
operations, the scheduling/fluency engine, the session player, the fact grid,
daily streaks, and Render deploy (SQLite + Postgres). 149 tests passing.

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
- [ ] **Cross-operation "next" suggestion.** `suggestNextSet` only advances within
      an operation; once a kid's add sets are ≥80% mastered, suggest the easiest
      set of the next operation. ~S.
- [ ] **"All caught up" celebration.** `caughtUp` is computed + passed to the
      client but only flips a flag; give it a distinct celebratory end screen with
      an "ask a grown-up to add more" CTA. ~S.
- [ ] **Data export (CSV/JSON).** `GET /profiles/:id/export` — attempts + progress
      snapshot, for a tutor/parent. ~S.
- [ ] **Classroom mode** (DESIGN.md §9 "Later") — many profiles, quick switch, a
      teacher aggregate view. ~L. **Parent email/progress reports** — ~M. Both
      are larger and lower-priority than the above.

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

### Client polish

- [ ] **Lazy-load routes.** `App.tsx` eagerly imports all four pages into one
      ~245 KB bundle; `React.lazy` + `Suspense` would trim first paint. ~S.
- [ ] **Minor render/input hygiene.** `React.memo` the pure animation components
      (`Confetti`, `CelebrationBurst`, `Muncher`); add `e.repeat` guards to the
      key handlers; clean up the flash/burst `setTimeout`s on unmount (harmless in
      React 18 but tidy). ~S, low value.

### Engine (minor)

- [ ] **DST day-boundary.** `dueAt` snapping can be off by up to an hour across a
      DST transition; masked by ≥1-day box intervals, so very low impact. ~S.
- [ ] **Engine test gaps.** Add cases: a box-4 "correct but slow" answer (stays,
      half interval), and `accuracyEwma` trending toward 0 over repeated misses.

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
      6/hr; returns 429 + `Retry-After`. `trust proxy` enabled in prod so the
      key is the real client IP behind Render. Unit + HTTP tested.

## Known limitations

- `caughtUp` is computed per profile (due-review + learning counts), not scoped
  to the day's planned intros — fine for now, revisit with the dashboard.
- No automated test against a _live_ Postgres (pg-mem covers the SQL). A manual
  end-to-end smoke flow was run against the live Render Postgres on first deploy
  and passed; consider scripting it as a post-deploy check if deploys get frequent.
