/**
 * Auth session cookie helpers (DESIGN.md §2). The cookie holds a random opaque
 * token; the server-side `auth_session` row is the source of truth, so the
 * cookie itself is unsigned — the token's entropy is the secret.
 */
import { randomBytes } from 'node:crypto';
import type { CookieOptions, Response } from 'express';

export const COOKIE_NAME = 'ff_session';

/** 30 days of *idle* expiry (DESIGN.md §2): the window slides forward on use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Don't slide the expiry (a DB write + cookie re-issue) more than once per this
 *  window — a daily player shouldn't trigger a refresh on every request. */
export const SESSION_SLIDE_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** A URL-safe, high-entropy opaque session token. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function cookieOptions(isProd: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export function setSessionCookie(res: Response, token: string, isProd: boolean): void {
  res.cookie(COOKIE_NAME, token, cookieOptions(isProd));
}

export function clearSessionCookie(res: Response, isProd: boolean): void {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(isProd), maxAge: undefined });
}
