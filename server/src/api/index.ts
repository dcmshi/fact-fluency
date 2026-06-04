/**
 * API router (DESIGN.md §8). Auth, profile management, and the session loop are
 * live; the progress dashboard remains stubbed (roadmap v1.1).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { requireAuth } from '../auth/middleware';
import { createAuthRouter } from '../auth/routes';
import { SEED_CATALOG } from '../data/catalog';
import type { Db } from '../db';
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
  router.get('/catalog', (_req, res) => res.json({ sets: SEED_CATALOG }));

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

  // --- stub (501) — adult dashboard, roadmap v1.1 ---
  router.get('/profiles/:id/progress', (_req: Request, res: Response) =>
    res.status(501).json({ error: 'not_implemented' }),
  );

  return router;
}
