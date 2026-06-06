/**
 * Auth middleware — resolves the session cookie to an account id (DESIGN.md §2).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../db';
import { COOKIE_NAME } from './session';

/**
 * Populates `req.accountId` when a valid, unexpired session cookie is present.
 * Never rejects — pair with `requireAuth` to guard protected routes.
 */
export function attachAccount(db: Db): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[COOKIE_NAME] as string | undefined;
    if (token) {
      try {
        const accountId = await db.findAccountIdByToken(token);
        if (accountId) req.accountId = accountId;
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}

/** Rejects with 401 unless `attachAccount` resolved an account. */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (!req.accountId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  next();
};

/**
 * Loads the `:id` profile, 404s unless it belongs to the authenticated account,
 * and attaches it as `req.profile`. Use after `requireAuth` on profile-scoped
 * routes so handlers can skip the repeated own-this-profile check (and the
 * load-all-profiles lookup it used to do).
 */
export function loadOwnedProfile(db: Db): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await db.getProfile(req.params.id);
      if (!profile || profile.accountId !== req.accountId) {
        res.status(404).json({ error: 'profile_not_found' });
        return;
      }
      req.profile = profile;
      next();
    } catch (err) {
      next(err);
    }
  };
}
