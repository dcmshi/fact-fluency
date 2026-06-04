# TODO

Where things stand and what's left. v1 (DESIGN.md §9) is complete: auth, all four
operations, the scheduling/fluency engine, the session player, the fact grid,
daily streaks, and Render deploy (SQLite + Postgres). 84 tests passing.

This is a backlog, not a commitment — pick from it as needed.

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
      session per profile). Note: client-side in-session re-show *injects* aren't
      reconstructed on resume — the persistent box schedule resurfaces those.
- [x] **Adult dashboard** (roadmap v1.1) — `GET /profiles/:id/dashboard` returns
      14-day accuracy/speed trends (bucketed by account-tz day from the `Attempt`
      log), a mastery summary, and a "suggested next set" (advance within an
      operation once the largest enabled set is ≥80% mastered; pure + unit-tested
      in `engine/dashboard.ts`). The Progress page now renders stat cards, a
      suggestion banner, an accuracy bar chart + speed sparkline, then the grid.
      Cross-operation suggestions (e.g. start subtraction) are intentionally
      out of scope for v1.
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
- [x] **Offline play + sync** (DESIGN.md §9 "Later") — *bounded scope (PWA +
      resilient sync)*. A service worker (`client/public/sw.js`) caches the app
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

- [ ] Calibrate fluency constants: `K` (1.3), floor (1200ms), per-op ceilings,
      cold-start sample count (20).
- [ ] Revisit box intervals and the "extra new facts" fill for a brand-new
      profile's first session (currently can be ~20 new cards at once).
- [ ] Starting fact-set defaults per grade band.

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
- No automated test against a *live* Postgres (pg-mem covers the SQL). A manual
  end-to-end smoke flow was run against the live Render Postgres on first deploy
  and passed; consider scripting it as a post-deploy check if deploys get frequent.
