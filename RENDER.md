# Deploying to Render

`render.yaml` is a Blueprint: one Node web service serving the built SPA + API,
backed by a managed Postgres (`DATABASE_URL` injected, Node pinned via
`NODE_VERSION`).

## First deploy

1. Render dashboard → **New + → Blueprint**, connect this repo.
2. Apply — Render provisions Postgres, builds, and starts. The schema
   self-applies via `migrate()` on first boot.

`autoDeploy` is on, so pushes to `main` redeploy automatically. A failed boot
(e.g. DB unreachable) keeps the previous deploy live.

## Troubleshooting

**`getaddrinfo ENOTFOUND dpg-…-a` at boot (in `migrate()`), deploy ends with
"No open ports detected":** the web service can't resolve the Postgres
instance's internal hostname. Two possible causes:

- **Free Postgres expired.** Render's free databases expire 30 days after
  creation and become inaccessible. Dashboard → the Postgres instance: either
  upgrade it to a paid plan (an expired instance stays restorable for a grace
  period, keeping your data), or delete it and recreate it (see below). A
  fresh database starts empty — `migrate()` re-applies the schema on boot —
  but free instances have no backups, so user data is gone.
- **Region mismatch.** The injected `connectionString` uses the internal
  hostname (`dpg-…-a`), which only resolves within the database's own region.
  Keep the web service and the database in the same region; if either is ever
  recreated, place it in the same region as the other. The external connection
  string (`dpg-…-a.<region>-postgres.render.com`) is only for connecting from
  outside Render — the adapter already sets
  `ssl.rejectUnauthorized=false` for it.

Neither is fixable from the repo — it's dashboard/infra state, not code.

## Recreating a deleted database

A plain redeploy only restarts the web service — databases are provisioned by
the blueprint, not by deploys. Either:

- **Re-sync the blueprint.** Dashboard → **Blueprints** → this repo's
  blueprint → **Manual Sync**. Render sees `fact-fluency-db` is missing and
  recreates it, and the `fromDatabase` wiring re-points the web service's
  `DATABASE_URL` automatically. (If the deleted DB shows as "unlinked" and
  isn't recreated, use the manual route.)
- **Create it manually.** Dashboard → **New + → PostgreSQL**: name
  `fact-fluency-db` (must match `render.yaml`), free plan, **same region as
  the web service**. Then web service → **Environment** → set `DATABASE_URL`
  to the new database's **Internal Database URL** (its Connect panel).

The fresh database starts empty — `migrate()` re-applies the schema on boot,
but free instances have no backups, so prior user data is gone. The new free
database expires 30 days after creation; upgrade to a paid plan before then
to avoid a repeat.
