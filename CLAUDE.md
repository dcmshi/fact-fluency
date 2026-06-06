# CLAUDE.md

Guidance for working in this repository. Read `DESIGN.md` for the full product
and architecture rationale; this file is the quick operational reference.

## What this is

A browser-based **math fact fluency** app for kids, built on **spaced
repetition** with a **fluency gate** (correct _and_ fast). An adult
(parent/teacher) account holds multiple kid profiles. Runs locally or as a small
single-service deploy on Render. See `DESIGN.md`.

## Stack

- **Frontend:** Vite + React + TypeScript
- **Backend:** Node + Express + TypeScript, cookie-based adult auth
- **DB:** SQLite (dev / small deploy), swappable to Postgres (Render) via one DB
  adapter
- **Deploy:** single service — Express serves the built SPA in production

## Layout

npm-workspaces monorepo (`shared` / `server` / `client`):

```
/shared        Type-only package (Fact, DTOs…), consumed via `import type`
/server        Express API + static serving (CommonJS)
  /engine      Pure scheduling/fluency logic (NO framework/DB imports) + tests
  /db          DB adapter interface + (later) migrations
  /api         Route handlers
  /data        Seed catalog
/client        Vite + React SPA
DESIGN.md
CLAUDE.md
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
npm test          # engine unit tests (vitest, in server)
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
  the DB adapter), `COOKIE_SECRET`.
- Dev-only `npm audit` warnings come from the esbuild/vite/vitest chain
  (GHSA-67mh-4wv8-2f99); they don't affect the production server/static bundle.

## Database adapters

`createDb(DATABASE_URL)` picks an adapter by scheme; both implement the same `Db`
interface (`server/src/db/index.ts`):

- **SQLite** (`sqlite:` — local/dev): better-sqlite3, schema applied in the
  constructor. Tested directly.
- **Postgres** (`postgres://` — Render): `pg`, async `migrate()`. Tested against
  **pg-mem** (no live DB needed). Note PG types: BIGINT for epoch-ms columns
  (INTEGER overflows), and the int8 parser is set to Number.

Bootstrap awaits `db.migrate()` before serving, so a fresh DB self-migrates.

## Deployment (Render)

`render.yaml` is a Blueprint: one Node web service (`npm start`) serving the
built SPA + API, backed by a managed Postgres (`DATABASE_URL` injected). The
build uses `npm install --include=dev` because `NODE_ENV=production` would
otherwise skip the devDependencies the build needs.

## Conventions

- **TypeScript everywhere**, `strict` on. Shared types live in `/shared`, not
  duplicated across client/server.
- Prefer small pure functions for anything in `engine/`; side effects live at the
  edges (api/db).
- Test the engine in isolation before wiring it to HTTP/DB.
- Keep response-time handling honest: capture `responseMs` on the client, but
  treat the server as source of truth for scheduling decisions.

## Git

- Remote: `git@github.com:dcmshi/fact-fluency.git`, default branch `main`.
- Commit/push only when asked. End commit messages with the Co-Authored-By
  trailer.
