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
