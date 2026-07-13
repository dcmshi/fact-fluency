# Multiplayer "Race" — design & plan

A competitive fact-fluency race, TypeRacer-style, that **adds to** the solo game
without ever putting the single-player/offline experience at risk. Decisions
locked so far:

- **Phased**: async ghost/challenge races first, live real-time rooms second, on
  one shared data model.
- **Munch input**: races use the same Number Munchers board as solo play (one
  consistent mechanic), accepting a slightly longer race (~60–90s).
- **Household-first & safe**: racing stays within an adult account (siblings) or
  an explicit shared link/code. **No public stranger matchmaking** in scope —
  kids don't authenticate, so cross-account matching needs a deliberate
  safety/COPPA review, not a default build.

## Principles

1. **Solo/offline is untouched.** Race mode is additive. Ghost/time-trial races
   run fully offline (cached deck + ghost); live races need connectivity and
   fall back to the async path.
2. **Non-punitive.** No elimination, no "you lost." Everyone finishes; results
   are warm ("You raced your best!" / "So close — rematch?"). A wrong munch
   costs a little time, never a life.
3. **Fair-ish across levels.** A race is a single **seeded deck** (identical
   facts for all racers) → a true head-to-head. See _Fairness_ for the
   mixed-level caveat.

## The race mechanic

- A race = a fixed **seeded deck of ~6 munch rounds** (kept short because each
  munch round is ~10s; ~60–90s total keeps it "racey").
- Your "car" advances one step each time you **clear a round** (all correct
  cells eaten). Finish line = deck cleared.
- **Rank by total time** to clear the deck; wrong munches just cost time (they
  slow the clear), they don't eliminate.
- The deck is drawn from the **creator's enabled facts** (optionally scoped to
  one operation), then shared verbatim with every racer so it's the same race.

## Phase 1 — async ghost / challenge (offline-capable)

Race a **recorded ghost**: your own best run, or a sibling's latest run ("Beat
Maya's time!"). The ghost's car advances against the wall clock using its
recorded per-round times while you play.

### Data model

- `race`: `id`, `account_id`, `created_by_profile_id`, `deck_json` (seeded fact
  list + per-round board seeds, like a session's working state), `fact_count`,
  `created_at`, optional short `code` for link-share.
- `race_run`: `id`, `race_id`, `profile_id`, `total_ms`, `correct_count`,
  `per_round_json` (per-round ms — this _is_ the ghost), `finished_at`.
- Leaderboard = a race's runs ordered by `total_ms` (all-correct first).

### Endpoints (mirror the session loop's shape)

- `POST /profiles/:id/races` — build a seeded race deck (like `startSession`
  but no scheduling writes), persist the `race`, return `{ raceId, deck,
ghost? }`. `ghost` = the target run (your best, or a challenged sibling's).
- `POST /races/:id/run` — submit `{ perRoundMs[], totalMs, correct }`; persist a
  `race_run`; return placement + leaderboard. Client-authoritative timing (low
  stakes); server does light sanity clamping like `answer()` does for
  `responseMs`.
- `GET /races/:id` — deck + runs (ghosts + leaderboard), for a challenge link.
- Scope via the existing `loadOwnedProfile` (creator) / account ownership;
  sibling opponents live under the same account. A `code` enables link-share to
  known people.

### Client

- **Setup**: a "Race" entry on the profile tile / play screen → pick an
  opponent: _your best time_ (ghost time-trial) or _a sibling_ (their latest
  ghost).
- **RacePage**: a race-track header (your car + ghost car[s]) above the normal
  `MunchBoard`; the ghost advances on its recorded splits. Finish → placement +
  times + a warm result.
- **Offline**: the deck is client-held like a session; a ghost/time-trial race
  runs offline and the run **syncs via the existing sync queue** on reconnect;
  the ghost is cached.

## Phase 2 — live rooms (real-time)

- A **WebSocket** layer (Render supports WS; a `ws`/socket.io endpoint can ride
  the existing Express service). Room keyed by the race `code`: join → ready →
  countdown → each client emits "round cleared" ticks → server broadcasts
  positions → live bars.
- Handle disconnect/reconnect (a dropped player becomes a ghost at their
  last-known position). If WS is unavailable/offline, **fall back to the Phase 1
  async path** — same deck, same result screen.

## Fairness

- **Same level** → the shared seeded deck is a genuinely fair race.
- **Mixed level** → a shared deck favors the stronger racer (harder facts take
  longer). Phase 1 keeps it simple (shared deck; race similar levels). A later
  **handicap** mode (each races their own-level deck of equal length, ranked by
  time) can normalize this — deferred.

## Decisions

1. **Race rounds do not touch the scheduler or practice stats.** Race data lives
   only in `race_run` (ghosts + leaderboard); it never writes spaced-repetition
   state (boxes/dueAt/op-stats) or the practice attempt log — so a shared-deck
   race can't distort a kid's personal schedule or their dashboard trends.
2. **A race does not count toward the daily "done for today."** The daily goal
   stays about focused solo practice; races are bonus.
3. **Coins scale with placement, with a floor.** Better placement earns more;
   last place still earns a guaranteed minimum (non-punitive — everyone leaves
   with something). Solo ghost/time-trial: a small participation reward plus a
   bonus for beating the ghost / setting a personal best.
4. **Phase 2 transport (socket.io vs raw `ws`) — deferred to Phase 2, and not a
   latency decision.** For a low-tick-rate race with a few players, per-message
   latency is effectively identical (network RTT dominates; raw `ws` is only
   microseconds/bytes leaner). Leaning **socket.io** for its built-in
   reconnection, rooms, and transport fallback (which cover the flaky-WiFi
   cases we'd otherwise hand-roll), with the client **lazy-loaded into the race
   chunk** so it doesn't bloat the main bundle. Raw `ws` stays viable if we want
   zero extra deps.

## Suggested build order

1. Engine: pure race-deck builder + ghost/placement helpers (unit-tested), in
   the spirit of `engine/planner.ts` / `engine/placement.ts`.
2. DB: `race` + `race_run` tables and adapter methods (SQLite + Postgres +
   contract test).
3. API: the three endpoints above.
4. Client: setup flow + RacePage (reusing `MunchBoard`) + result screen +
   offline sync.
5. Phase 2: the WS room layer, with the async path as fallback.
