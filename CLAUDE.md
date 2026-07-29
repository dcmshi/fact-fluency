# CLAUDE.md

Quick operational reference. `DESIGN.md` carries the full product and
architecture rationale — read it rather than re-deriving intent.

## What this is

A browser-based **math fact fluency** app for kids, built on **spaced
repetition** with a **fluency gate** (correct _and_ fast). An adult
(parent/teacher) account holds multiple kid profiles. Beyond the Number Munchers
solo mode there are two multiplayer games — an async/live **Race**
(`MULTIPLAYER.md`) and the real-time **Number Feast** arena (`FEAST.md`) — a
public `/how-it-works` methodology page, and full UI localization in en/es/fr/zh.
`TODO.md` is the working backlog; `COMPETITORS.md` the competitive scan.

## Stack

Vite + React + TypeScript client (react-i18next) · Node + Express + TypeScript
server, cookie-based adult auth, raw `ws` servers for the live games · SQLite
(dev / small deploy) or Postgres (Render) behind one DB adapter · single-service
deploy: Express serves the built SPA in production.

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
  /ws          Shared by both WS servers: liveness heartbeat, upgrade origin
               check + guard for unclaimed paths
  /data        Seed catalog + reward/settings data
/client        Vite + React SPA
  /pages       Route screens (Auth, Profiles, Play, Progress, Race, Feast, …)
  /i18n        react-i18next setup + en/es/fr/zh dictionaries (es/fr/zh typed
               `typeof en`, so a missing key fails the build)
  /components  Shared UI (Muncher, MunchBoard, Modal, ErrorBoundary, …)
  timing.ts    `activeNow()` — the clock all answer timing uses
/scripts       Dev CLIs (git hooks installer, Postgres test runner)
```

> `shared` is **type-only** — everything imports it with `import type`, so it's
> erased at build time and needs no compile step or runtime wiring. tsc resolves
> it via the `@shared` path alias (`tsconfig.base.json`); Vite via a matching
> resolve alias. If shared ever exports a runtime value, revisit this.

## Core principles

1. **The engine is pure and the most-tested code in the repo.** All
   spaced-repetition / fluency / session-planning logic lives in `server/engine`
   as framework-free pure functions — no DB, no HTTP, no `Date.now()` reached for
   directly; pass time in.
2. **Facts are generated, not hand-stored.** A pure function produces the fact
   universe for an operation/range.
3. **Fluency = correct AND fast.** Accuracy alone never masters a fact; speed is
   a first-class signal and thresholds are per-kid and adaptive.
4. **Never make it tedious.** Short sessions, ~80% success rate, new facts
   trickle in, feedback is warm and never punitive about slow answers. Anything
   that adds grind is wrong by default.
5. **Kids don't authenticate.** Profiles sit behind the adult's session; picking
   one is a tap, not a login.
6. **Keep the DB swap clean.** App logic talks to the DB through one adapter
   interface, so SQLite↔Postgres stays a single seam.

## Commands

Run from the repo root; append `-w server` / `-w client` / `-w shared` to target
one workspace (e.g. `npm run test:watch -w server`).

```
npm install       # install all workspaces
npm run dev       # Express (tsx watch, :3001) + Vite (:5173), /api proxied
npm run build     # shared (tsc) → server (esbuild → dist) → client (vite build)
npm start         # production: node server/dist/index.js serves the built SPA
npm test          # server + client unit/HTTP tests (vitest); needs no services
npm run test:pg   # Db contract vs a real Postgres in Docker (see Testing)
npm run typecheck # tsc --noEmit across all three workspaces
npm run lint      # eslint; `npm run format` / `format:write` for prettier
```

The committed pre-commit hook (`.githooks/`, wired up by `npm install`) runs
lint, format, typecheck and tests — so a commit fails on unformatted code.

## Build notes

- **Server build = esbuild**, not `tsc` — esbuild drops the type-only `@shared`
  import cleanly and bundles `src/` to one CommonJS `dist/index.js`, with npm
  deps left external. `tsc` is used only for `--noEmit` typechecking (setting
  `rootDir` would trip TS6059 on the cross-package type import).
- **Config is env-only and `.env.example` documents every var** — `DATABASE_URL`
  (scheme selects the adapter), Postgres TLS, `FF_FLUENCY_*` / `FF_CEILING_*`
  fluency tuning, and the live-game cadences (whose production values are
  human-paced, so the test suites shrink them). All parsed once at boot in
  `config.ts`; engine defaults in `engine/threshold.ts`. There is no cookie
  secret — the session cookie is an unsigned opaque token (`auth/session.ts`).
- The service worker source lives at `client/src/sw.js` (NOT public/) — the build
  emits it with a per-build cache name (`emit-stamped-sw` plugin in
  vite.config.ts), so each deploy evicts the previous SW cache.
- Dev-only `npm audit` warnings come from the esbuild/vite/vitest chain
  (GHSA-67mh-4wv8-2f99); they don't affect the production server/static bundle.
- **Deploy is a Render Blueprint** (`render.yaml`, steps in README): one Node web
  service serving the built SPA + API, backed by managed Postgres. Its build runs
  `npm install --include=dev` because `NODE_ENV=production` would otherwise skip
  the devDependencies the build needs.

## Database adapters

`createDb(DATABASE_URL)` picks an adapter by scheme; both implement the same `Db`
interface (`server/src/db/index.ts`). SQLite (`sqlite:`, local/dev) uses
better-sqlite3 and applies its schema in the constructor; Postgres
(`postgres://`, Render) uses `pg` with an async `migrate()`. Bootstrap awaits
`db.migrate()` before serving, so a fresh DB self-migrates.

- PG types: BIGINT for epoch-ms columns (INTEGER overflows), and the int8 parser
  is set to Number.
- Adding a column to an existing table needs an entry in `db/additiveColumns.ts`
  (CREATE TABLE IF NOT EXISTS can't alter one) — that's what makes a deploy
  self-heal.

## Testing

`npm test` is the gate that must always pass and needs no external services.

- **The Db contract** (`db/contractSuite.ts`) is one behavioral spec run against
  **three** backends: SQLite and pg-mem on every `npm test`, and a **real
  Postgres 16** in Docker via `npm run test:pg` (which starts the container,
  waits on its healthcheck, and always tears it down). Add adapter methods to the
  contract suite, not to a single adapter's test file.
- **Run `npm run test:pg` whenever you touch SQL or the adapters.** pg-mem is a
  reimplementation that lies in ways that matter — it silently ignores
  `COUNT(*) FILTER` and cannot honor `ROLLBACK` — and only real PG covers
  transaction rollback, BIGINT epoch-ms round-tripping, the one-open-session
  partial unique index, repeat `migrate()`, and the additive-column self-heal.
- The live-game WebSocket servers have a real harness (`race/live.test.ts`):
  actual HTTP server, actual `ws` client, in-memory SQLite. Protocol/robustness
  bugs belong there; pure room logic belongs in `engine/raceRoom.test.ts`.
- The engine stays the most-tested code in the repo, and it's testable precisely
  because it's pure — keep it that way.

## Conventions

- **TypeScript everywhere**, `strict` on. Shared types live in `/shared`, not
  duplicated across client/server, and `shared` must stay **type-only** —
  server-side runtime lists live in e.g. `engine/operations.ts`.
- Prefer small pure functions in `engine/`; side effects live at the edges
  (api/db). Test the engine in isolation before wiring it to HTTP/DB.
- Route handlers use the shared `handle()` wrapper (`api/handle.ts`) and throw
  `HttpError` (`httpError.ts`) — no hand-rolled try/catch in routers.
  Profile-scoped routes use the `loadOwnedProfile` middleware; services take the
  loaded `Profile`, not `(accountId, profileId)` pairs.
- **Keep response-time handling honest.** The client captures `responseMs`, but
  the server is source of truth and clamps it **both** ways before grading or
  feeding the EWMA — an upper cap so a slow outlier can't inflate the threshold,
  and a ~250ms floor because no kid reads, decides and taps faster than that, so
  a smaller value is a replayed POST. Client-side, time the tab spent hidden
  doesn't count: use `activeNow()` (`client/src/timing.ts`), never
  `performance.now()` directly.
- **Answer reports are idempotent.** Each round carries a client `attemptId`;
  `recordAnswer` drops a repeat inside its transaction, because a failed POST is
  indistinguishable from one that committed before the response was lost — the
  offline queue must be free to replay. Relatedly, `answer()` is serialized per
  session (`session/sessionLock.ts`): it reads working state, grades against it,
  and writes it back, and the client doesn't wait for the previous POST.
- **Localize every user-facing string.** Add new copy to all four dictionaries in
  `client/src/i18n/` (the build enforces it — es/fr/zh are typed `typeof en`).
  Never build user-facing prose on the server; emit a `LocalizedText {key,
params}` (see `Card.strategy`, `SetSuggestion.reason`) or a stable id the
  client resolves via `tLabel()`. Standards codes (`FactSet.standards`) stay
  as-is.
- **Live games** (`race/`, `feast/`) are server-authoritative WebSocket rooms:
  the pure engine holds game state, the WS layer owns IO + the tick loop, and
  results are ephemeral (only coins persist). Both attach to the one HTTP server
  and claim only their own upgrade path (`claimUpgradePath`), so the guard in
  `index.ts` can destroy upgrades nobody claimed — Node stops auto-closing them
  once any listener exists.
- **Two WS rules that cost the whole process when missed**: every accepted socket
  _and_ the raw upgrade socket needs an `'error'` listener (an unhandled emitter
  `'error'` throws and kills the process), and `maxPayload` must stay small (the
  default is 100 MiB). The room-lifetime traps — heartbeat-backed liveness,
  ignoring a stale socket's `close` after a reconnect, re-checking the start
  condition on disconnect — are written up in `MULTIPLAYER.md` and `FEAST.md`;
  regressing any of them wedges a room.

## Git

- Remote: `git@github.com:dcmshi/fact-fluency.git`, default branch `main`.
- Commit/push only when asked. No Co-Authored-By (or other) trailers on commit
  messages.
