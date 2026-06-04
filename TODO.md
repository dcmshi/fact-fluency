# TODO

Where things stand and what's left. v1 (DESIGN.md §9) is complete: auth, all four
operations, the scheduling/fluency engine, the session player, the fact grid,
daily streaks, and Render deploy (SQLite + Postgres). 84 tests passing.

This is a backlog, not a commitment — pick from it as needed.

## Features

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
- [ ] **Adult dashboard** (roadmap v1.1) — accuracy/speed trends from the
      `Attempt` log; "suggested next set to enable".
- [ ] **Unlockable avatars / themes** (roadmap v1.1) — reward points spend.
- [ ] **Subtraction/division fact-family framing** (DESIGN.md §9 "Later") — link
      `7×8` ↔ `56÷7` for transfer.
- [ ] **Offline play + sync** (DESIGN.md §9 "Later").

## Polish

- [ ] **aria-live** announcements for answer feedback (screen-reader support).
- [ ] **PWA manifest** + icons so it installs on a tablet/Chromebook.
- [ ] Loading skeletons / nicer empty states (profiles, progress).
- [ ] Optional sound effects (with a mute toggle).

## Engine tuning (needs real usage data — DESIGN.md §4.5, §11)

- [ ] Calibrate fluency constants: `K` (1.3), floor (1200ms), per-op ceilings,
      cold-start sample count (20).
- [ ] Revisit box intervals and the "extra new facts" fill for a brand-new
      profile's first session (currently can be ~20 new cards at once).
- [ ] Starting fact-set defaults per grade band.

## Deployment / ops

- [ ] First Render deploy via Blueprint (`render.yaml`) — verify Postgres SSL +
      `migrate()` on a live instance.
- [ ] Decide on auth-session cleanup (expired `auth_session` rows accumulate;
      add a periodic prune or a TTL job).
- [ ] Rate-limit auth endpoints.

## Known limitations

- `caughtUp` is computed per profile (due-review + learning counts), not scoped
  to the day's planned intros — fine for now, revisit with the dashboard.
- No automated test against a *live* Postgres (pg-mem covers the SQL); smoke-test
  on the first Render deploy.
