/**
 * API router (DESIGN.md §8). Auth + profile management are live; session and
 * progress endpoints remain stubbed pending the session-planner work.
 */
import { Router, type Request, type Response } from 'express';
import { createAuthRouter } from '../auth/routes';
import { SEED_CATALOG } from '../data/catalog';
import type { Db } from '../db';
import { createProfileRouter } from './profiles';

export function createApiRouter(db: Db, isProd: boolean): Router {
  const router = Router();

  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.get('/catalog', (_req, res) => res.json({ sets: SEED_CATALOG }));

  router.use('/auth', createAuthRouter(db, isProd));
  router.use('/profiles', createProfileRouter(db));

  // --- stubs (501) — implemented with the session layer ---
  const notImplemented = (_req: Request, res: Response) =>
    res.status(501).json({ error: 'not_implemented' });

  router.post('/profiles/:id/session', notImplemented);
  router.post('/sessions/:id/answer', notImplemented);
  router.post('/sessions/:id/complete', notImplemented);
  router.get('/profiles/:id/progress', notImplemented);

  return router;
}
