# TODO

Where things stand and what's left. v1 (DESIGN.md §9) is complete: auth, all four
operations, the scheduling/fluency engine, the session player, the fact grid,
daily streaks, and Render deploy (SQLite + Postgres). 84 tests passing.

This is a backlog, not a commitment — pick from it as needed.

## Features

- [ ] **Adult session settings** — `PATCH /profiles/:id` to edit `sessionCards`
      / `sessionSeconds` / `newPerSession` (type + DB plumbing exist; needs a
      route + a settings UI).
- [ ] **Resume an interrupted session** (DESIGN.md §10) — same-day reopen should
      resume from `Session.workingState`; today `startSession` always plans fresh.
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
