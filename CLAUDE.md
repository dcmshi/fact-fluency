# CLAUDE.md

Guidance for working in this repository. Read `DESIGN.md` for the full product
and architecture rationale; this file is the quick operational reference.

## What this is

A browser-based **math fact fluency** app for kids, built on **spaced
repetition** with a **fluency gate** (correct *and* fast). An adult
(parent/teacher) account holds multiple kid profiles. Runs locally or as a small
single-service deploy on Render. See `DESIGN.md`.

## Stack

- **Frontend:** Vite + React + TypeScript
- **Backend:** Node + Express + TypeScript, cookie-based adult auth
- **DB:** SQLite (dev / small deploy), swappable to Postgres (Render) via one DB
  adapter
- **Deploy:** single service — Express serves the built SPA in production

## Intended layout

```
/client        Vite + React SPA
/server        Express API + static serving
  /engine      Pure scheduling/fluency logic (NO framework/DB imports)
  /db          DB adapter + migrations
  /api         Route handlers
/shared        Types shared between client and server (Fact, etc.)
DESIGN.md
CLAUDE.md
```

> The repo is currently just docs — this layout is the target as code lands.

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

> Scaffolding is not in place yet. Update this section as `package.json` scripts
> are added. Target scripts:

```
npm run dev       # Vite dev server + Express (concurrently), proxied /api
npm run build     # build client, compile server
npm start         # production: Express serves built SPA
npm test          # unit tests (engine first)
npm run lint
npm run typecheck
```

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
