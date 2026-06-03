/**
 * Profile + fact-set routes (DESIGN.md §2, §7, §8). All require an authenticated
 * adult; profiles are scoped to the adult's account, so every :id route checks
 * ownership.
 */
import { Router } from 'express';
import type { ProfileSettings } from '@shared';
import type { Db } from '../db';
import { requireAuth } from '../auth/middleware';
import { DEFAULT_ENABLED_SET_IDS, SEED_CATALOG } from '../data/catalog';

const DEFAULT_SETTINGS: ProfileSettings = {
  sessionCards: 20,
  sessionSeconds: 180,
  newPerSession: 3,
};

const CATALOG_IDS = new Set(SEED_CATALOG.map((s) => s.id));

export function createProfileRouter(db: Db): Router {
  const router = Router();
  router.use(requireAuth);

  async function owns(accountId: string, profileId: string): Promise<boolean> {
    const profiles = await db.listProfiles(accountId);
    return profiles.some((p) => p.id === profileId);
  }

  router.get('/', async (req, res, next) => {
    try {
      return res.json({ profiles: await db.listProfiles(req.accountId!) });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const { displayName, avatar } = req.body ?? {};
      if (typeof displayName !== 'string' || !displayName.trim()) {
        return res.status(400).json({ error: 'invalid_display_name' });
      }
      if (typeof avatar !== 'string' || !avatar) {
        return res.status(400).json({ error: 'invalid_avatar' });
      }
      const profile = await db.createProfile({
        accountId: req.accountId!,
        displayName: displayName.trim(),
        avatar,
        settings: DEFAULT_SETTINGS,
      });
      // Onboarding pre-check (DESIGN.md §3.3).
      await db.setEnabledSetIds(profile.id, DEFAULT_ENABLED_SET_IDS);
      return res.status(201).json({ profile });
    } catch (err) {
      return next(err);
    }
  });

  router.get('/:id/factsets', async (req, res, next) => {
    try {
      if (!(await owns(req.accountId!, req.params.id))) {
        return res.status(404).json({ error: 'profile_not_found' });
      }
      const enabledIds = await db.listEnabledSetIds(req.params.id);
      return res.json({ catalog: SEED_CATALOG, enabledIds });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/:id/factsets', async (req, res, next) => {
    try {
      if (!(await owns(req.accountId!, req.params.id))) {
        return res.status(404).json({ error: 'profile_not_found' });
      }
      const { enabledIds } = req.body ?? {};
      if (!Array.isArray(enabledIds) || enabledIds.some((id) => !CATALOG_IDS.has(id))) {
        return res.status(400).json({ error: 'invalid_set_ids' });
      }
      await db.setEnabledSetIds(req.params.id, enabledIds);
      return res.json({ enabledIds });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
