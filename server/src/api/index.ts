/**
 * API router. Routes follow DESIGN.md §8. Handlers are stubbed pending the
 * persistence and session layers; the catalog endpoint is live so the client
 * has something real to render against during scaffolding.
 */
import { Router } from 'express';
import { SEED_CATALOG } from '../data/catalog';
import type { Db } from '../db';

// `db` is threaded in for the auth / profile / session handlers landing next.
export function createApiRouter(db: Db): Router {
  void db;
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Live: the seeded fact-set catalog (DESIGN.md §3.3).
  router.get('/catalog', (_req, res) => {
    res.json({ sets: SEED_CATALOG });
  });

  // --- stubs (501) — implemented with the auth / persistence / session work ---
  const notImplemented = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
    res.status(501).json({ error: 'not_implemented' });

  router.post('/auth/signup', notImplemented);
  router.post('/auth/login', notImplemented);
  router.post('/auth/logout', notImplemented);
  router.get('/profiles', notImplemented);
  router.post('/profiles', notImplemented);
  router.post('/profiles/:id/session', notImplemented);
  router.post('/sessions/:id/answer', notImplemented);
  router.post('/sessions/:id/complete', notImplemented);
  router.get('/profiles/:id/progress', notImplemented);

  return router;
}
