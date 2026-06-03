/**
 * Auth routes — signup / login / logout / me (DESIGN.md §2, §8).
 */
import { Router } from 'express';
import type { Db } from '../db';
import { hashPassword, verifyPassword } from './password';
import {
  SESSION_TTL_MS,
  clearSessionCookie,
  COOKIE_NAME,
  generateToken,
  setSessionCookie,
} from './session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export function createAuthRouter(db: Db, isProd: boolean): Router {
  const router = Router();

  async function startSession(accountId: string, res: import('express').Response) {
    const token = generateToken();
    await db.createAuthSession(accountId, token, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token, isProd);
  }

  router.post('/signup', async (req, res, next) => {
    try {
      const { email, password, timezone } = req.body ?? {};
      if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: 'weak_password' });
      }
      const tz = typeof timezone === 'string' && timezone ? timezone : 'UTC';

      if (await db.findAccountByEmail(email)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      const accountId = await db.createAccount(email, await hashPassword(password), tz);
      await startSession(accountId, res);
      return res.status(201).json({ accountId, email });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'invalid_credentials' });
      }
      const account = await db.findAccountByEmail(email);
      // Verify even when the account is missing would be ideal to avoid timing
      // leaks; acceptable here given the threat model (DESIGN.md §4.7).
      if (!account || !(await verifyPassword(account.passwordHash, password))) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      await startSession(account.id, res);
      return res.json({ accountId: account.id, email });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/logout', async (req, res, next) => {
    try {
      const token = req.cookies?.[COOKIE_NAME] as string | undefined;
      if (token) await db.deleteAuthSession(token);
      clearSessionCookie(res, isProd);
      return res.status(204).end();
    } catch (err) {
      return next(err);
    }
  });

  router.get('/me', (req, res) => {
    if (!req.accountId) return res.status(401).json({ error: 'unauthenticated' });
    return res.json({ accountId: req.accountId });
  });

  return router;
}
