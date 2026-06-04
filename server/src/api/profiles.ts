/**
 * Profile + fact-set routes (DESIGN.md §2, §7, §8). All require an authenticated
 * adult; profiles are scoped to the adult's account, so every :id route checks
 * ownership.
 */
import { Router } from 'express';
import type { ProfileSettings } from '@shared';
import type { Db } from '../db';
import { requireAuth } from '../auth/middleware';
import { DEFAULT_ENABLED_SET_IDS, gradeBandById, SEED_CATALOG } from '../data/catalog';

const DEFAULT_SETTINGS: ProfileSettings = {
  sessionCards: 20,
  sessionSeconds: 180,
  newPerSession: 3,
};

const CATALOG_IDS = new Set(SEED_CATALOG.map((s) => s.id));

/** Inclusive bounds for each editable setting (DESIGN.md §4.4). */
const SETTING_BOUNDS: Record<keyof ProfileSettings, [min: number, max: number]> = {
  sessionCards: [5, 50],
  sessionSeconds: [30, 600],
  newPerSession: [0, 10],
};

/** Returns the first invalid field name, or null if every field is in range. */
function invalidSetting(s: ProfileSettings): keyof ProfileSettings | null {
  for (const key of Object.keys(SETTING_BOUNDS) as (keyof ProfileSettings)[]) {
    const [min, max] = SETTING_BOUNDS[key];
    const v = s[key];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return key;
  }
  return null;
}

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
      const { displayName, avatar, gradeBand } = req.body ?? {};
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
      // Onboarding pre-check: a chosen grade band's sets, else the starter mix
      // (DESIGN.md §3.3). An unknown band id falls back to the default.
      const band = typeof gradeBand === 'string' ? gradeBandById(gradeBand) : undefined;
      await db.setEnabledSetIds(profile.id, band ? band.setIds : DEFAULT_ENABLED_SET_IDS);
      return res.status(201).json({ profile });
    } catch (err) {
      return next(err);
    }
  });

  // Edit per-profile session settings (DESIGN.md §8). Partial PATCH: provided
  // fields override, the rest keep their current value; the merged result is
  // validated as a whole.
  router.patch('/:id', async (req, res, next) => {
    try {
      const profile = await db.getProfile(req.params.id);
      if (!profile || profile.accountId !== req.accountId!) {
        return res.status(404).json({ error: 'profile_not_found' });
      }
      const incoming = (req.body ?? {}).settings;
      if (typeof incoming !== 'object' || incoming === null) {
        return res.status(400).json({ error: 'invalid_settings' });
      }
      const merged: ProfileSettings = {
        sessionCards: incoming.sessionCards ?? profile.settings.sessionCards,
        sessionSeconds: incoming.sessionSeconds ?? profile.settings.sessionSeconds,
        newPerSession: incoming.newPerSession ?? profile.settings.newPerSession,
      };
      if (invalidSetting(merged)) {
        return res.status(400).json({ error: 'invalid_settings' });
      }
      const updated = await db.updateProfileSettings(req.params.id, merged);
      return res.json({ profile: updated });
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
