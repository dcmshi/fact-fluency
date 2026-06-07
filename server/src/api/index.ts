/**
 * API router (DESIGN.md §8). Auth, profile management, and the session loop are
 * live; the progress dashboard remains stubbed (roadmap v1.1).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { createAuthRouter } from '../auth/routes';
import { GRADE_BANDS, SEED_CATALOG } from '../data/catalog';
import type { Db } from '../db';
import { getDashboardView } from '../dashboard';
import { attemptsToCsv, buildExport } from '../export';
import { getProgressView } from '../progress';
import { equipReward, getRewards, unlockReward } from '../rewards';
import * as sessions from '../session/service';
import { SessionError } from '../session/service';
import { createProfileRouter } from './profiles';

/** Wrap an async handler, mapping SessionError to its HTTP status. */
function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((err) => {
      if (err instanceof SessionError) {
        res.status(err.status).json({ error: err.code });
        return;
      }
      next(err);
    });
  };
}

export function createApiRouter(db: Db, isProd: boolean): Router {
  const router = Router();

  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.get('/catalog', (_req, res) => res.json({ sets: SEED_CATALOG, gradeBands: GRADE_BANDS }));

  router.use('/auth', createAuthRouter(db, isProd));
  router.use('/profiles', createProfileRouter(db));

  // --- session loop (DESIGN.md §4.9) ---
  router.post(
    '/profiles/:id/session',
    requireAuth,
    handle(async (req, res) => {
      const result = await sessions.startSession(db, req.accountId!, req.params.id, Date.now());
      res.status(201).json(result);
    }),
  );

  router.post(
    '/sessions/:id/answer',
    requireAuth,
    handle(async (req, res) => {
      const result = await sessions.answer(db, req.accountId!, req.params.id, req.body, Date.now());
      res.json(result);
    }),
  );

  router.post(
    '/sessions/:id/complete',
    requireAuth,
    handle(async (req, res) => {
      const result = await sessions.complete(db, req.accountId!, req.params.id, Date.now());
      res.json(result);
    }),
  );

  // --- progress (fact grid, DESIGN.md §7) ---
  router.get(
    '/profiles/:id/progress',
    requireAuth,
    handle(async (req, res) => {
      res.json(await getProgressView(db, req.accountId!, req.params.id));
    }),
  );

  router.get(
    '/profiles/:id/dashboard',
    requireAuth,
    handle(async (req, res) => {
      res.json(await getDashboardView(db, req.accountId!, req.params.id, Date.now()));
    }),
  );

  // Data export (DESIGN.md §9): ?format=csv (attempt log) or json (everything).
  router.get(
    '/profiles/:id/export',
    requireAuth,
    handle(async (req, res) => {
      const data = await buildExport(db, req.accountId!, req.params.id, Date.now());
      const slug = data.profile.displayName.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'profile';
      const stamp = new Date().toISOString().slice(0, 10);
      const base = `fact-fluency-${slug}-${stamp}`;
      if (req.query.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
        res.send(attemptsToCsv(data.attempts));
      } else {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
        res.send(JSON.stringify(data, null, 2));
      }
    }),
  );

  // --- rewards (roadmap v1.1) ---
  router.get(
    '/profiles/:id/rewards',
    requireAuth,
    handle(async (req, res) => {
      res.json(await getRewards(db, req.accountId!, req.params.id));
    }),
  );

  router.post(
    '/profiles/:id/rewards/unlock',
    requireAuth,
    handle(async (req, res) => {
      res.json(await unlockReward(db, req.accountId!, req.params.id, req.body?.itemId));
    }),
  );

  router.post(
    '/profiles/:id/rewards/equip',
    requireAuth,
    handle(async (req, res) => {
      res.json(await equipReward(db, req.accountId!, req.params.id, req.body?.itemId));
    }),
  );

  return router;
}
