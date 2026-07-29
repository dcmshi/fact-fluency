/**
 * Auth routes — signup / login / logout / me (DESIGN.md §2, §8).
 */
import { Router } from 'express';
import type { Db } from '../db';
import { DEFAULT_ENABLED_SET_IDS } from '../data/catalog';
import { DEFAULT_SETTINGS } from '../data/settings';
import { handle } from '../api/handle';
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

// Emails are case-insensitive in practice — normalize on every store and lookup
// so `Foo@Bar.com` and `foo@bar.com` are the same account (and can't both be
// created). Validated against EMAIL_RE before normalizing.
const normalizeEmail = (email: string) => email.trim().toLowerCase();

const MINUTE = 60_000;
// Per-IP limits (tunable). Login is the brute-force surface; signup the
// account-spam surface. argon2id already makes each guess server-expensive.
const LOGIN_WINDOW_MS = 15 * MINUTE;
const LOGIN_MAX = 10;
const SIGNUP_WINDOW_MS = 60 * MINUTE;
const SIGNUP_MAX = 6;
const GUEST_WINDOW_MS = 60 * MINUTE;
const GUEST_MAX = 30; // each mints an anonymous account row; cap the spam surface

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
  const accountLimit = rateLimit({ windowMs: SIGNUP_WINDOW_MS, max: 20, keyPrefix: 'account:' });

  // A throwaway hash to verify against when the email is unknown, so a missing
  // account costs the same argon2 time as a wrong password (no timing oracle).
  const dummyHash = hashPassword('timing-equalizer-not-a-real-password');

  /**
   * Re-authenticate before a change that could lock the parent out or destroy
   * every kid's record. A live cookie is not proof of identity here: the device
   * is shared with children and left unlocked. Guests have no password, so
   * there's nothing to prove — they're exempt (and credential edits on a guest
   * are refused outright; /auth/upgrade is that path).
   *
   * Returns an error code to send, or null when the caller may proceed.
   */
  async function reauthFailure(
    accountId: string,
    currentPassword: unknown,
  ): Promise<'password_required' | 'invalid_credentials' | null> {
    const hash = await db.getAccountPasswordHash(accountId);
    if (!hash) return null; // guest / passwordless account
    if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
      return 'password_required';
    }
    return (await verifyPassword(hash, currentPassword)) ? null : 'invalid_credentials';
  }

  // The email-uniqueness checks below are check-then-write: two concurrent
  // requests claiming the same email can both pass the check, and the loser
  // dies on the DB unique constraint. Map that write failure back to the
  // honest 409 (the email *is* taken) instead of surfacing a raw 500.
  async function claimingEmail<T>(normEmail: string, write: () => Promise<T>): Promise<T | null> {
    try {
      return await write();
    } catch (err) {
      if (await db.findAccountByEmail(normEmail)) return null; // lost the race
      throw err;
    }
  }

  async function startSession(accountId: string, res: import('express').Response) {
    const token = generateToken();
    await db.createAuthSession(accountId, token, Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token, isProd);
  }

  router.post(
    '/signup',
    signupLimit,
    handle(async (req, res) => {
      const { email, password, timezone } = req.body ?? {};
      if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: 'weak_password' });
      }
      const tz = typeof timezone === 'string' && timezone ? timezone : 'UTC';
      const normEmail = normalizeEmail(email);

      if (await db.findAccountByEmail(normEmail)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      const passwordHash = await hashPassword(password);
      const accountId = await claimingEmail(normEmail, () =>
        db.createAccount(normEmail, passwordHash, tz),
      );
      if (accountId === null) return res.status(409).json({ error: 'email_taken' });
      await startSession(accountId, res);
      return res.status(201).json({ accountId, email: normEmail });
    }),
  );

  // "Play for fun" — no signup. Mints an anonymous account + one default
  // profile and drops a session cookie, so the kid can play immediately. The
  // account is disposable: clearing the cookie strands it, and the guest prune
  // (index.ts) reclaims stranded guests.
  router.post(
    '/guest',
    guestLimit,
    handle(async (req, res) => {
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
    }),
  );

  // Upgrade a guest in place: attach real credentials so their existing profile
  // and progress carry over (same account id + session — nothing is migrated).
  router.post(
    '/upgrade',
    requireAuth,
    upgradeLimit,
    handle(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
        return res.status(400).json({ error: 'weak_password' });
      }
      const normEmail = normalizeEmail(email);
      if (await db.findAccountByEmail(normEmail)) {
        return res.status(409).json({ error: 'email_taken' });
      }
      const passwordHash = await hashPassword(password);
      const upgraded = await claimingEmail(normEmail, () =>
        db.upgradeGuestAccount(req.accountId!, normEmail, passwordHash),
      );
      if (upgraded === null) return res.status(409).json({ error: 'email_taken' });
      if (!upgraded) return res.status(409).json({ error: 'not_a_guest' });
      return res.json({ accountId: req.accountId, email: normEmail });
    }),
  );

  router.post(
    '/login',
    loginLimit,
    handle(async (req, res) => {
      const { email, password } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'invalid_credentials' });
      }
      const normEmail = normalizeEmail(email);
      const account = await db.findAccountByEmail(normEmail);
      // Always run one verify so a missing account and a wrong password take the
      // same time (no account-enumeration timing oracle).
      const ok = await verifyPassword(account?.passwordHash ?? (await dummyHash), password);
      if (!account || !ok) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }
      await startSession(account.id, res);
      return res.json({ accountId: account.id, email: normEmail });
    }),
  );

  // Current account fields (for the account screen). No password hash.
  router.get(
    '/account',
    requireAuth,
    handle(async (req, res) => {
      const account = await db.getAccount(req.accountId!);
      if (!account) return res.status(404).json({ error: 'not_found' });
      return res.json(account);
    }),
  );

  // Edit account: any of email / password / timezone.
  router.patch(
    '/account',
    requireAuth,
    accountLimit,
    handle(async (req, res) => {
      const body = req.body ?? {};
      const { email, password, timezone } = body;
      const editsEmail = 'email' in body;
      const editsPassword = 'password' in body;
      const editsTimezone = 'timezone' in body;
      if (!editsEmail && !editsPassword && !editsTimezone) {
        return res.status(400).json({ error: 'nothing_to_update' });
      }

      // Validate *every* provided field before applying any of them — a 400
      // must mean nothing changed, never "the first half of your edit landed".
      if (editsEmail && (typeof email !== 'string' || !EMAIL_RE.test(email))) {
        return res.status(400).json({ error: 'invalid_email' });
      }
      if (editsPassword && (typeof password !== 'string' || password.length < MIN_PASSWORD)) {
        return res.status(400).json({ error: 'weak_password' });
      }
      if (editsTimezone && (typeof timezone !== 'string' || !timezone)) {
        return res.status(400).json({ error: 'invalid_timezone' });
      }

      // Credentials on a guest account must go through /auth/upgrade: a PATCH
      // would leave is_guest set, so the account the user believes is saved
      // would still be reclaimed by the guest prune once its sessions lapse.
      if ((editsEmail || editsPassword) && (await db.isGuestAccount(req.accountId!))) {
        return res.status(409).json({ error: 'guest_account' });
      }

      // Changing credentials means proving you own them. Timezone alone is not
      // sensitive, so it stays a one-tap fix for the wrong-schedule trap.
      if (editsEmail || editsPassword) {
        const failure = await reauthFailure(req.accountId!, body.currentPassword);
        if (failure) return res.status(403).json({ error: failure });
      }

      if (editsEmail) {
        const normEmail = normalizeEmail(email);
        const existing = await db.findAccountByEmail(normEmail);
        if (existing && existing.id !== req.accountId) {
          return res.status(409).json({ error: 'email_taken' });
        }
        const claimed = await claimingEmail(normEmail, async () => {
          await db.updateAccountEmail(req.accountId!, normEmail);
          return true;
        });
        if (claimed === null) return res.status(409).json({ error: 'email_taken' });
      }
      if (editsPassword) {
        await db.updateAccountPassword(req.accountId!, await hashPassword(password));
        // Changing the password is how a parent evicts a session they no longer
        // trust. Sessions slide forward on use, so without this an old cookie
        // would stay valid indefinitely and the change would achieve nothing.
        const keep = (req.cookies?.[COOKIE_NAME] as string | undefined) ?? null;
        await db.deleteAuthSessionsForAccount(req.accountId!, keep);
      }
      if (editsTimezone) {
        await db.updateAccountTimezone(req.accountId!, timezone);
      }
      return res.json(await db.getAccount(req.accountId!));
    }),
  );

  // Right-to-erasure: delete the account and all kids' data (cascades), then
  // clear the cookie. The session row is gone with the account.
  router.delete(
    '/account',
    requireAuth,
    accountLimit,
    handle(async (req, res) => {
      // Irreversible and takes every kid's history with it — prove it's you.
      // (A guest has no password: their "exit and delete" path is unaffected.)
      const failure = await reauthFailure(req.accountId!, req.body?.currentPassword);
      if (failure) return res.status(403).json({ error: failure });
      await db.deleteAccount(req.accountId!);
      clearSessionCookie(res, isProd);
      return res.status(204).end();
    }),
  );

  router.post(
    '/logout',
    handle(async (req, res) => {
      const token = req.cookies?.[COOKIE_NAME] as string | undefined;
      if (token) await db.deleteAuthSession(token);
      clearSessionCookie(res, isProd);
      return res.status(204).end();
    }),
  );

  router.get(
    '/me',
    requireAuth,
    handle(async (req, res) => {
      return res.json({
        accountId: req.accountId,
        guest: await db.isGuestAccount(req.accountId!),
      });
    }),
  );

  return router;
}
