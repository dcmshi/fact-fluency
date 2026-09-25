---
name: render-deploy
description: Diagnose and fix a broken Render deployment of fact-fluency (site down, deploy failed, "No open ports detected", getaddrinfo ENOTFOUND dpg-…, Postgres expired/deleted). Use whenever the user says the Render deploy/site is broken.
---

# Fixing the Render deploy

Human-facing background lives in `RENDER.md`; this is the fast path.

## Shape of the deploy

- Blueprint `render.yaml`: web service `fact-fluency` (free, Node, pinned
  `NODE_VERSION`) + Postgres `fact-fluency-db` (free).
- `DATABASE_URL` comes from `fromDatabase: fact-fluency-db / connectionString`
  (the **internal** `dpg-…-a` host — resolves only inside the DB's region).
- Boot: `server/src/index.ts` awaits `db.migrate()` **before** listening. If the
  DB is unreachable, boot throws → no port bound → Render reports
  "No open ports detected" and keeps the previous deploy (or nothing) live.
- Health check: `GET /api/health`. Free web services cold-start (~50s+), so
  one slow `curl` is not proof it's down; a 90s timeout with 0 bytes is.

## Triage order (most likely first)

1. **Free Postgres expired (30 days after creation).** By far the usual cause.
   Symptom in deploy/runtime logs: `getaddrinfo ENOTFOUND dpg-…-a` from
   `migrate()`. Dashboard → Postgres instance shows expired/suspended.
   - Keep data: upgrade the instance to a paid plan during the grace period.
   - Accept data loss: delete it, then **Blueprints → fact-fluency-blueprint →
     Manual sync** to recreate `fact-fluency-db`; `fromDatabase` rewires
     `DATABASE_URL`, and Render auto-triggers a web deploy (trigger
     "Blueprint"). Schema self-applies on boot.
   - **GOTCHA: Manual sync does not apply by itself.** Clicking it opens a
     sync page (`/blueprint/<id>/sync/<exe-id>`) listing the plan ("Create
     database fact-fluency-db", "Update environment variable DATABASE_URL")
     with an **Approve** button. Nothing happens until Approve is clicked —
     the Syncs list shows no new entry meanwhile. This is what "resync didn't
     work" meant on 2026-09-25.
   - If sync shows the DB as "unlinked" and doesn't recreate it: New →
     PostgreSQL, name `fact-fluency-db`, free, **same region as the web
     service**; set web service `DATABASE_URL` to its Internal Database URL.
2. **DB deleted** (same ENOTFOUND). Same recreate steps as above.
3. **Region mismatch** after recreating either side (same ENOTFOUND). Recreate
   the DB in the web service's region.
4. **Build failure** (deploy fails before start). Read the build log; usual
   suspects: devDeps skipped (buildCommand must keep `--include=dev`), a type
   or i18n key error (`npm run build` locally reproduces it), Node version
   drift vs `NODE_VERSION`.
5. **Runtime crash after boot**: check runtime logs; reproduce locally with
   `npm run build && npm start` against a Postgres (`npm run test:pg` spins one
   up in Docker for adapter issues).

Items 1–3 are dashboard/infra state — no repo change fixes them.

## How to drive it

- Preferred: Claude in Chrome on https://dashboard.render.com (user is signed
  in there). Needs the extension connected — if `tabs_context_mcp` says "not
  connected", ask the user to open Chrome with the extension / sign in to
  claude.ai with the same account, or have them paste the failing deploy log.
- Read the **Events** tab and the failed deploy's **Logs** first; the error
  line decides which branch above applies.
- Anything destructive (deleting the DB, upgrading to a paid plan) needs the
  user's explicit OK — it loses data or costs money.

## After a fix

- Verify `curl -m 120 https://<service>.onrender.com/api/health` returns 200.
- Note the new DB's creation date: the free instance expires again 30 days
  later. Tell the user the expiry date.
- Append anything new learned to this file (and `RENDER.md` if user-facing).

## Dashboard landmarks

- Blueprint: https://dashboard.render.com/blueprint/exs-d8gusa3eo5us73d5peqg
  (Resources / Syncs tabs; "Manual sync" top right).
- Web service: https://dashboard.render.com/web/srv-d8gusoi8pkls73bnhbg0
- Live site: https://fact-fluency.onrender.com (region: oregon, DB too).

## Log

- 2026-09-25: site unreachable (`/` timed out, 0 bytes). Suspected expired
  free Postgres (previous instance hit the same). Chrome extension was not
  connected at first. User had deleted the expired DB; their Manual sync sat
  unapproved. Re-ran Manual sync → Approve → DB recreated (PostgreSQL 18,
  oregon), blueprint auto-deployed, `/api/health` → `{"ok":true}`. All prior
  data gone. **New free DB expires ~2026-10-25.**
