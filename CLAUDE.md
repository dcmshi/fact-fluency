# CLAUDE.md

Guidance for working in this repository. Read `DESIGN.md` for the full product
and architecture rationale; this file is the quick operational reference.

## What this is

A browser-based **math fact fluency** app for kids, built on **spaced
repetition** with a **fluency gate** (correct _and_ fast). An adult
(parent/teacher) account holds multiple kid profiles. Runs locally or as a small
single-service deploy on Render. See `DESIGN.md`.

Beyond the core Number Munchers solo mode there are two multiplayer games — an
async/live **Race** (`MULTIPLAYER.md`) and the real-time **Number Feast** arena
(`FEAST.md`) — a public `/how-it-works` methodology page, and full UI
localization in **en/es/fr/zh** (`COMPETITORS.md` tracks the competitive
feature backlog).

## Stack

- **Frontend:** Vite + React + TypeScript; react-i18next for localization (en/
  es/fr/zh)
- **Backend:** Node + Express + TypeScript, cookie-based adult auth; raw `ws`
  WebSocket servers for the live multiplayer games
- **DB:** SQLite (dev / small deploy), swappable to Postgres (Render) via one DB
  adapter
- **Deploy:** single service — Express serves the built SPA in production

## Layout

npm-workspaces monorepo (`shared` / `server` / `client`):

```
/shared        Type-only package (Fact, DTOs…), consumed via `import type`
/server        Express API + static serving (CommonJS)
  /engine      Pure scheduling/fluency logic + game engines (race, feast) — NO
               framework/DB imports; injected time/rng; the most-tested code
  /db          DB adapter interface + migrations; `contractSuite.ts` is the
               one behavioral spec every adapter must satisfy
  /api         Route handlers
  /session     Session/race orchestration (IO around the engine); `sessionLock`
               serializes answer handling per session
  /race        Live Race WebSocket server (MULTIPLAYER.md)
  /feast       Live Number Feast WebSocket server + tick loop (FEAST.md)
  /ws          Concerns shared by both WS servers: liveness heartbeat, upgrade
               origin check + guard for unclaimed paths
  /data        Seed catalog + reward/settings data
/client        Vite + React SPA
  /pages       Route screens (Auth, Profiles, Play, Progress, Race, Feast, …)
  /i18n        react-i18next setup + en/es/fr/zh dictionaries (es/fr/zh typed
               `typeof en`, so a missing key fails the build)
  /components  Shared UI (Muncher, MunchBoard, Modal, ErrorBoundary, …)
  timing.ts    `activeNow()` — the clock all answer timing uses
/scripts       Dev CLIs (git hooks installer, Postgres test runner)
DESIGN.md  CLAUDE.md  MULTIPLAYER.md  FEAST.md  COMPETITORS.md
```

> `shared` is **type-only** — everything imports it with `import type`, so it's
> erased at build time and needs no compile step or runtime wiring. tsc resolves
> it via the `@shared` path alias (`tsconfig.base.json`); Vite via a matching
> resolve alias. If shared ever exports a runtime value, revisit this.

## Core principles

1. **The engine is pure and the most-tested code in the repo.** All
   spaced-repetition / fluency / session-planning logic lives in `server/engine`
   as framework-free pure functions. No DB, no HTTP, no `Date.now()` reached for
   directly — pass time in. This makes scheduling behavior trivially unit-testable
   and is where correctness matters most.
2. **Facts are generated, not hand-stored.** A pure function produces the fact
   universe for an operation/range. Don't seed 169 multiplication rows by hand.
3. **Fluency = correct AND fast.** Accuracy alone never masters a fact. Speed is
   a first-class signal; thresholds are per-kid and adaptive.
4. **Never make it tedious.** Short sessions, ~80% success rate, new facts
   trickle in, feedback is warm and never punitive about slow answers. Any
   feature that adds grind is wrong by default.
5. **Kids don't authenticate.** Profiles sit behind the adult's session; profile
   selection is a tap, not a login.
6. **Keep the DB swap clean.** App logic talks to the DB through one adapter
   interface so SQLite↔Postgres is a single seam.

## Commands

Run from the repo root (npm workspaces):

```
npm install       # install all workspaces
npm run dev       # Express (tsx watch, :3001) + Vite (:5173), /api proxied
npm run build     # shared (tsc) → server (esbuild → dist) → client (vite build)
npm start         # production: node server/dist/index.js serves the built SPA
npm test          # server + client unit/HTTP tests (vitest); needs no services
npm run test:pg   # Db contract vs a real Postgres in Docker (see Testing below)
npm run typecheck # tsc --noEmit across all three workspaces
```

Per-workspace: append `-w server` / `-w client` / `-w shared` (e.g.
`npm run test:watch -w server`).

## Build notes

- **Server build = esbuild**, not `tsc` — esbuild drops the type-only `@shared`
  import cleanly and bundles `src/` to one CommonJS `dist/index.js`, with npm
  deps left external. `tsc` is used only for `--noEmit` typechecking (setting
  `rootDir` would trip TS6059 on the cross-package type import).
- **Config via env** (`.env.example`): `PORT`, `DATABASE_URL` (scheme selects
  the DB adapter), optional `FF_FLUENCY_*` / `FF_CEILING_*` fluency-tuning
  overrides (parsed once at boot in `config.ts`; engine defaults in
  `engine/threshold.ts`). No cookie secret — the session cookie is an unsigned
  opaque token (auth/session.ts). Live-game cadences are also env-overridable
  (`FF_WS_PING_MS`, `FF_RACE_COUNTDOWN_MS`, `FF_FEAST_ROUND_MS`) — production
  values are human-paced and would otherwise dominate the test suite.
  `PGSSLROOTCERT` / `?sslmode=verify-full` opt Postgres into real certificate
  verification (the default for a managed provider is encrypted-but-unverified).
- The service worker source lives at `client/src/sw.js` (NOT public/) — the
  build emits it with a per-build cache name (`emit-stamped-sw` plugin in
  vite.config.ts), so each deploy evicts the previous SW cache.
- Dev-only `npm audit` warnings come from the esbuild/vite/vitest chain
  (GHSA-67mh-4wv8-2f99); they don't affect the production server/static bundle.

## Database adapters

`createDb(DATABASE_URL)` picks an adapter by scheme; both implement the same `Db`
interface (`server/src/db/index.ts`):

- **SQLite** (`sqlite:` — local/dev): better-sqlite3, schema applied in the
  constructor. Tested directly.
- **Postgres** (`postgres://` — Render): `pg`, async `migrate()`. Note PG types:
  BIGINT for epoch-ms columns (INTEGER overflows), and the int8 parser is set to
  Number.

Bootstrap awaits `db.migrate()` before serving, so a fresh DB self-migrates.
Adding a column to an existing table needs an entry in `db/additiveColumns.ts`
(CREATE TABLE IF NOT EXISTS can't alter one) — that's what makes a deploy
self-heal.

## Testing

`npm test` is the gate that must always pass and needs no external services.
`npm run test:pg` is the extra layer for database work.

- **The Db contract** (`db/contractSuite.ts`) is one behavioral spec run against
  **three** backends: SQLite and pg-mem on every `npm test`, and a **real
  Postgres 16** in Docker via `npm run test:pg` (`docker-compose.test.yml` +
  `scripts/pg-test.mjs`, which starts the container, waits on its healthcheck,
  and always tears it down). Add adapter methods to the contract suite, not to a
  single adapter's test file.
- **Run `npm run test:pg` whenever you touch SQL or the adapters.** pg-mem is a
  reimplementation and it lies in ways that matter: it silently ignores
  `COUNT(*) FILTER` (counting every row) and it cannot honor `ROLLBACK`. The
  integration file also covers what only real PG can show — transaction
  rollback, BIGINT epoch-ms round-tripping, the one-open-session partial unique
  index, repeat `migrate()` on an existing DB, and the additive-column self-heal.
- The live-game WebSocket servers have a real harness (`race/live.test.ts`):
  actual HTTP server, actual `ws` client, in-memory SQLite. Protocol/robustness
  bugs belong there; pure room logic belongs in `engine/raceRoom.test.ts`.
- The engine stays the most-tested code in the repo, and it's testable precisely
  because it's pure — keep it that way.

## Deployment (Render)

`render.yaml` is a Blueprint: one Node web service (`npm start`) serving the
built SPA + API, backed by a managed Postgres (`DATABASE_URL` injected). The
build uses `npm install --include=dev` because `NODE_ENV=production` would
otherwise skip the devDependencies the build needs.

## Conventions

- **TypeScript everywhere**, `strict` on. Shared types live in `/shared`, not
  duplicated across client/server. `shared` must stay **type-only** — never
  export a runtime value from it (server-side runtime lists live in e.g.
  `server/src/engine/operations.ts`).
- Prefer small pure functions for anything in `engine/`; side effects live at the
  edges (api/db).
- Test the engine in isolation before wiring it to HTTP/DB. The DB adapters
  share a behavioral contract suite (`db/contractSuite.ts`) — add adapter
  methods there, not just per-adapter tests (see **Testing**).
- Route handlers use the shared `handle()` wrapper (`api/handle.ts`) and throw
  `HttpError` (`httpError.ts`) — no hand-rolled try/catch in routers.
- Profile-scoped routes use the `loadOwnedProfile` middleware; services take
  the loaded `Profile`, not `(accountId, profileId)` pairs.
- Keep response-time handling honest: capture `responseMs` on the client, but
  treat the server as source of truth for scheduling decisions. It's clamped
  **both** ways before it grades or feeds the EWMA — an upper cap so a slow
  outlier can't inflate the threshold, and a ~250ms floor because no kid reads,
  decides, and taps faster than that, so a smaller value is a replayed POST.
  Client-side, time the tab spent hidden doesn't count: use `activeNow()`
  (`client/src/timing.ts`), never `performance.now()` directly.
- **Answer reports are idempotent.** Each round carries a client `attemptId`;
  `recordAnswer` drops a repeat inside its transaction. A failed POST is
  indistinguishable from one that committed before the response was lost, so the
  offline queue must be free to replay. Relatedly, `answer()` is serialized per
  session (`session/sessionLock.ts`) — it reads working state, grades against
  it, and writes it back, and the client doesn't wait for the previous POST.
- **Localize every user-facing string.** Add new copy to all four dictionaries
  in `client/src/i18n/` (the build enforces it — es/fr/zh are typed `typeof en`).
  Never build user-facing prose on the server; emit a `LocalizedText {key,
params}` (see `Card.strategy`, `SetSuggestion.reason`) or a stable id the
  client resolves via `tLabel()`. Standards codes (`FactSet.standards`) stay
  as-is.
- **Live games** (`race/`, `feast/`) are server-authoritative WebSocket rooms:
  the pure engine holds game state, the WS layer owns IO + the tick loop, and
  results are ephemeral (only coins persist). Both WS servers attach to the one
  HTTP server and each claim only their own upgrade path (registered via
  `claimUpgradePath`, so the guard in `index.ts` can destroy upgrades nobody
  claimed — Node stops auto-closing them once any listener exists).
- **WebSocket rules that are easy to regress**, all of which cost the whole
  process or a stuck room when missed:
  - every accepted socket **and** the raw upgrade socket needs an `'error'`
    listener — an unhandled emitter `'error'` throws and kills the process;
  - keep `maxPayload` small (the default is 100 MiB);
  - both games decide a round is over by counting _connected_ players, so they
    depend on the heartbeat (`ws/heartbeat.ts`) to notice a half-open socket;
  - a reconnect swaps `player.ws`, so any `'close'` handler must ignore a socket
    that is no longer the player's current one;
  - re-check the start condition on disconnect, or whoever is left waits in a
    lobby that can never start.

## Git

- Remote: `git@github.com:dcmshi/fact-fluency.git`, default branch `main`.
- Commit/push only when asked. No Co-Authored-By (or other) trailers on
  commit messages.
