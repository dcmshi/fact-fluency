# Fact Fluency

A browser-based **math fact fluency** game for kids. It builds genuine
automaticity in the four operations through **spaced repetition** with a
**fluency gate** (a fact is only mastered when answered _correctly **and**
fast_), wrapped in a **Number Munchers–style** grid game so practice feels like
play, not a worksheet.

An adult (parent/teacher) account holds multiple kid profiles; kids just tap
their avatar and play — no logins for them.

### ▶️ Try it live

**https://fact-fluency.onrender.com**

> Runs on Render's free tier, so the first request after it's been idle may take
> ~50s to cold-start. Sign up with any email (it's a demo) to create a profile.

---

## Screenshots

**Number Munchers play** — munch every cell that's `= / < / >` the fact, with a
muncher you drive by keyboard or tap (shown here in the unlockable _Ocean_ theme):

![Munch round](docs/screenshots/munch-v2.png)

| Profile picker                                | Adult dashboard                                 | Rewards shop                                |
| --------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| ![Profiles](docs/screenshots/profiles-v2.png) | ![Dashboard](docs/screenshots/dashboard-v2.png) | ![Rewards](docs/screenshots/rewards-v2.png) |

---

## What's inside

- **Spaced-repetition + fluency engine** — Leitner boxes for the across-session
  schedule, an in-session rehearsal queue, and a per-kid adaptive speed
  threshold. All pure, framework-free, and the most-tested code in the repo.
- **Number Munchers play mode** — a 5×5 grid; munch everything equal to / less
  than / greater than the fact's answer. Calm and non-punitive (no chasing
  enemies, no on-screen countdown).
- **Adult dashboard** — 14-day accuracy & speed trends, a mastery summary, and a
  "suggested next set to enable".
- **Rewards** — coins earned per session unlock avatars and palette themes.
- **Fact grid, daily streaks, fact-family framing** (e.g. `7 × 8 = 56` framing
  `56 ÷ 7`).
- **PWA + offline-resilient sync** — installable; a flaky connection never loses
  practice (answers queue locally and replay on reconnect).
- **Accessible & friendly** — screen-reader announcements, sound effects with a
  mute toggle, loading skeletons.

See **[DESIGN.md](DESIGN.md)** for the full product/architecture rationale and
**[CLAUDE.md](CLAUDE.md)** for the quick operational reference.

## Tech stack

- **Frontend:** Vite + React + TypeScript
- **Backend:** Node + Express + TypeScript, cookie-based adult auth (argon2id,
  server-side sessions; auth endpoints are rate-limited)
- **DB:** SQLite for local/dev, Postgres for deploy — swappable behind one DB
  adapter interface
- **Deploy:** a single Render service serves the built SPA + the API

npm-workspaces monorepo: `shared` (type-only DTOs) · `server` (API + pure
engine) · `client` (SPA).

## Run locally

Requires Node `24.x` (see `.node-version`).

```bash
npm install        # install all workspaces
npm run dev        # Express API on :3001 + Vite on :5173 (/api proxied)
```

Open http://localhost:5173 and sign up. By default it uses a local SQLite file
(`server/data/fact-fluency.sqlite`); no other setup needed.

### Other commands

```bash
npm test           # engine + API unit tests (vitest)
npm run typecheck  # tsc --noEmit across all three workspaces
npm run build      # shared (tsc) → server (esbuild) → client (vite build)
npm start          # production: serve the built SPA + API from one process
```

Config is via env (`.env.example`): `PORT`, `DATABASE_URL` (the scheme —
`sqlite:` vs `postgres://` — selects the adapter).

## Deploy (Render)

`render.yaml` is a Blueprint: one Node web service serving the built SPA + API,
backed by a managed Postgres (`DATABASE_URL` injected, Node pinned via
`NODE_VERSION`).

1. Render dashboard → **New + → Blueprint**, connect this repo.
2. Apply — Render provisions Postgres, builds, and starts. The schema
   self-applies via `migrate()` on first boot.

`autoDeploy` is on, so pushes to `main` redeploy automatically.
