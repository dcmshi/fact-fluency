/**
 * Auth routes — signup / login / logout / me (DESIGN.md §2, §8).
 */
import { Router } from 'express';
import type { Db } from '../db';
import { DEFAULT_ENABLED_SET_IDS } from '../data/catalog';
import { rateLimit } from '../rateLimit';
import { requireAuth } from './middleware';
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

const MINUTE = 60_000;
// Per-IP limits (tunable). Login is the brute-force surface; signup the
// account-spam surface. argon2id already makes each guess server-expensive.
const LOGIN_WINDOW_MS = 15 * MINUTE;
const LOGIN_MAX = 10;
const SIGNUP_WINDOW_MS = 60 * MINUTE;
const SIGNUP_MAX = 6;
const GUEST_WINDOW_MS = 60 * MINUTE;
const GUEST_MAX = 30; // each mints an anonymous account row; cap the spam surface

/** Default per-profile session settings (mirrors the profiles router). */
const DEFAULT_SETTINGS = { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 };

export function createAuthRouter(db: Db, isProd: boolean): Router {
  const router = Router();

  const loginLimit = rateLimit({ windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX, keyPrefix: 'login:' });
  const signupLimit = rateLimit({
    windowMs: SIGNUP_WINDOW_MS,
    max: SIGNUP_MAX,
    keyPrefix: 'signup:',
  });
  const guestLimit = rateLimit({ windowMs: GUEST_WINDOW_MS, max: GUEST_MAX, keyPrefix: 'guest:' });
  const upgradeLimit = rateLimit({ windowMs: SIGNUP_WINDOW_MS, max: 10, keyPrefix: 'upgrade:' });

  // A throwaway hash to verify against when the email is unknown, so a missing
  // account costs the same argon2 time as a wrong password (no timing oracle).
  const dummyHash = hashPassword('timing-equalizer-not-a-real-password');

  async function startSession(accountId: string, res: import('express').Response) {
    const token = generateToken();
    await db.createAuthSession(accountId, token, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token, isProd);
  }

  router.post('/signup', signupLimit, async (req, res, next) => {
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

  // "Play for fun" — no signup. Mints an anonymous account + one default
  // profile and drops a session cookie, so the kid can play immediately. The
  // account is disposable: clearing the cookie strands it, and the guest prune
  // (index.ts) reclaims stranded guests.
  router.post('/guest', guestLimit, async (req, res, next) => {
    try {
      const { timezone } = req.body ?? {};
      const tz = typeof timezone === 'string' && timezone ? timezone : 'UTC';
      const accountId = await db.createGuestAccount(tz);
      const profile = await db.createProfile({
        accountId,
        displayName: 'Guest',
        avatar: '🦊',
        settings: DEFAULT_SETTINGS,
      });
      await db.setEnabledSetIds(profile.id, DEFAULT_ENABLED_SET_IDS);
      await startSession(accountId, res);
      return res.status(201).json({ accountId, profileId: profile.id, guest: true });
    } catch (err) {
      return next(err);
    }
  });

  // Upgrade a guest in place: attach real credentials so their existing profile
  // and progress carry over (same account id + session — nothing is migrated).
  router.post('/upgrade', requireAuth, upgradeLimit, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: 'weak_password' });
      }
      if (await db.findAccountByEmail(email)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      const upgraded = await db.upgradeGuestAccount(
        req.accountId!,
        email,
        await hashPassword(password),
      );
      if (!upgraded) return res.status(409).json({ error: 'not_a_guest' });
      return res.json({ accountId: req.accountId, email });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/login', loginLimit, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'invalid_credentials' });
      }
      const account = await db.findAccountByEmail(email);
      // Always run one verify so a missing account and a wrong password take the
      // same time (no account-enumeration timing oracle).
      const ok = await verifyPassword(account?.passwordHash ?? (await dummyHash), password);
      if (!account || !ok) {
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

  router.get('/me', requireAuth, async (req, res, next) => {
    try {
      return res.json({
        accountId: req.accountId,
        guest: await db.isGuestAccount(req.accountId!),
      });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
