/**
 * Profile + fact-set routes (DESIGN.md §2, §7, §8). All require an authenticated
 * adult; profiles are scoped to the adult's account, so every :id route checks
 * ownership.
 */
import { Router } from 'express';
import type { ProfileSettings } from '@shared';
import type { Db } from '../db';
import { loadOwnedProfile, requireAuth } from '../auth/middleware';
import { DEFAULT_ENABLED_SET_IDS, gradeBandById, SEED_CATALOG } from '../data/catalog';
import { rateLimit } from '../rateLimit';

/** Profile creation is a rare adult action; cap it so a logged-in client can't
 *  spam rows. Generous enough that a parent setting up several kids never hits
 *  it (per-IP fixed window, like the auth limiters). */
const CREATE_PROFILE_WINDOW_MS = 60 * 60 * 1000;
const CREATE_PROFILE_MAX = 20;

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
  const owned = loadOwnedProfile(db);

  router.get('/', async (req, res, next) => {
    try {
      return res.json({ profiles: await db.listProfiles(req.accountId!) });
    } catch (err) {
      return next(err);
    }
  });

  const createLimit = rateLimit({
    windowMs: CREATE_PROFILE_WINDOW_MS,
    max: CREATE_PROFILE_MAX,
    keyPrefix: 'profile-create:',
  });

  router.post('/', createLimit, async (req, res, next) => {
    try {
      const { displayName, avatar, gradeBand } = req.body ?? {};
      if (typeof displayName !== 'string' || !displayName.trim()) {
        return res.status(400).json({ error: 'invalid_display_name' });
      }
      // A single emoji/glyph from the picker — a few code units at most. Cap the
      // length so a profile row can't be bloated with a huge string.
      if (typeof avatar !== 'string' || !avatar || avatar.length > 16) {
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
  // Partial profile edit: any of displayName / avatar / settings.
  router.patch('/:id', owned, async (req, res, next) => {
    try {
      const profile = req.profile!;
      const body = req.body ?? {};
      const editsName = 'displayName' in body;
      const editsAvatar = 'avatar' in body;
      const editsSettings = 'settings' in body;
      if (!editsName && !editsAvatar && !editsSettings) {
        return res.status(400).json({ error: 'nothing_to_update' });
      }

      // Validate every provided field before applying any of them — a 400 must
      // mean nothing changed, never a half-applied edit.
      if (editsName && (typeof body.displayName !== 'string' || !body.displayName.trim())) {
        return res.status(400).json({ error: 'invalid_display_name' });
      }
      if (
        editsAvatar &&
        (typeof body.avatar !== 'string' || !body.avatar || body.avatar.length > 16)
      ) {
        return res.status(400).json({ error: 'invalid_avatar' });
      }
      let merged: ProfileSettings | null = null;
      if (editsSettings) {
        const incoming = body.settings;
        if (typeof incoming !== 'object' || incoming === null) {
          return res.status(400).json({ error: 'invalid_settings' });
        }
        merged = {
          sessionCards: incoming.sessionCards ?? profile.settings.sessionCards,
          sessionSeconds: incoming.sessionSeconds ?? profile.settings.sessionSeconds,
          newPerSession: incoming.newPerSession ?? profile.settings.newPerSession,
        };
        if (invalidSetting(merged)) {
          return res.status(400).json({ error: 'invalid_settings' });
        }
      }

      if (editsName) await db.updateProfileName(profile.id, body.displayName.trim());
      if (editsAvatar) await db.updateProfileAvatar(profile.id, body.avatar);
      if (merged) await db.updateProfileSettings(profile.id, merged);
      return res.json({ profile: await db.getProfile(profile.id) });
    } catch (err) {
      return next(err);
    }
  });

  // Delete a kid profile and all its data (cascades). Ownership-checked by
  // `owned`; 404 for a foreign/missing profile.
  router.delete('/:id', owned, async (req, res, next) => {
    try {
      await db.deleteProfile(req.params.id);
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  router.get('/:id/factsets', owned, async (req, res, next) => {
    try {
      const enabledIds = await db.listEnabledSetIds(req.params.id);
      return res.json({ catalog: SEED_CATALOG, enabledIds });
    } catch (err) {
      return next(err);
    }
  });

  router.put('/:id/factsets', owned, async (req, res, next) => {
    try {
      const { enabledIds } = req.body ?? {};
      if (!Array.isArray(enabledIds) || enabledIds.some((id) => !CATALOG_IDS.has(id))) {
        return res.status(400).json({ error: 'invalid_set_ids' });
      }
      // De-duplicate before storing: a repeated id would violate the
      // (profile_id, fact_set_id) primary key and 500. The Set also bounds the
      // list at the catalog size, since every id was checked against it above.
      const unique = [...new Set(enabledIds as string[])];
      await db.setEnabledSetIds(req.params.id, unique);
      return res.json({ enabledIds: unique });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
