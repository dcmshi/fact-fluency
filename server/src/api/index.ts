/**
 * API router (DESIGN.md §8). Auth, profile management, and the session loop are
 * live; the progress dashboard remains stubbed (roadmap v1.1).
 */
import { Router } from 'express';
import { loadOwnedProfile, requireAuth } from '../auth/middleware';
import { createAuthRouter } from '../auth/routes';
import { handle } from './handle';
import { GRADE_BANDS, SEED_CATALOG } from '../data/catalog';
import { SETTING_BOUNDS } from '../data/settings';
import type { Db } from '../db';
import { getDashboardView } from '../dashboard';
import { attemptsToCsv, buildExport } from '../export';
import { getProgressView } from '../progress';
import { equipReward, getRewards, unlockReward } from '../rewards';
import * as calibration from '../session/calibrate';
import * as sessions from '../session/service';
import { createProfileRouter } from './profiles';

export function createApiRouter(db: Db, isProd: boolean): Router {
  const router = Router();
  // Loads the :id profile and 404s unless the caller owns it (req.profile).
  const owned = loadOwnedProfile(db);

  router.get('/health', (_req, res) => res.json({ ok: true }));
  router.get('/catalog', (_req, res) =>
    res.json({ sets: SEED_CATALOG, gradeBands: GRADE_BANDS, settingBounds: SETTING_BOUNDS }),
  );

  router.use('/auth', createAuthRouter(db, isProd));
  router.use('/profiles', createProfileRouter(db));

  // --- guest calibration warm-up (DESIGN.md §4.4) ---
  router.post(
    '/profiles/:id/calibration/start',
    requireAuth,
    owned,
    handle(async (req, res) => {
      res.json(await calibration.startCalibration(db, req.profile!, req.body?.grade, Date.now()));
    }),
  );

  router.post(
    '/profiles/:id/calibration',
    requireAuth,
    owned,
    handle(async (req, res) => {
      res.json(
        await calibration.submitCalibration(
          db,
          req.profile!,
          req.accountId!,
          req.body?.results,
          Date.now(),
        ),
      );
    }),
  );

  // --- session loop (DESIGN.md §4.9) ---
  router.post(
    '/profiles/:id/session',
    requireAuth,
    owned,
    handle(async (req, res) => {
      const result = await sessions.startSession(db, req.profile!, Date.now());
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
    owned,
    handle(async (req, res) => {
      res.json(await getProgressView(db, req.profile!));
    }),
  );

  router.get(
    '/profiles/:id/dashboard',
    requireAuth,
    owned,
    handle(async (req, res) => {
      res.json(await getDashboardView(db, req.profile!, Date.now()));
    }),
  );

  // Data export (DESIGN.md §9): ?format=csv (attempt log) or json (everything).
  router.get(
    '/profiles/:id/export',
    requireAuth,
    owned,
    handle(async (req, res) => {
      const data = await buildExport(db, req.profile!, Date.now());
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
        // No pretty-print indent — it ~doubles a long-lived profile's export
        // (all-time attempts + progress); it's a download, not meant to be read raw.
        res.send(JSON.stringify(data));
      }
    }),
  );

  // --- rewards (roadmap v1.1) ---
  router.get(
    '/profiles/:id/rewards',
    requireAuth,
    owned,
    handle(async (req, res) => {
      res.json(await getRewards(db, req.profile!, Date.now()));
    }),
  );

  router.post(
    '/profiles/:id/rewards/unlock',
    requireAuth,
    owned,
    handle(async (req, res) => {
      res.json(await unlockReward(db, req.profile!, req.body?.itemId, Date.now()));
    }),
  );

  router.post(
    '/profiles/:id/rewards/equip',
    requireAuth,
    owned,
    handle(async (req, res) => {
      res.json(await equipReward(db, req.profile!, req.body?.itemId));
    }),
  );

  return router;
}
