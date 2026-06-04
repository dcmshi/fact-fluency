/**
 * HTTP security hardening: response headers and a tokenless CSRF defense.
 *
 * The session cookie is already SameSite=Lax (which blocks cross-site POSTs
 * carrying it); the same-origin guard is defense-in-depth, rejecting mutating
 * requests whose `Origin` doesn't match the host. It fails open when no `Origin`
 * is present (server-to-server calls, some same-origin requests) so it never
 * locks out a legitimate client.
 */
import type { RequestHandler } from 'express';

/** Baseline headers always; a strict CSP only in production (Vite's dev server
 *  needs inline scripts / eval / websockets that a prod CSP would block). */
export function securityHeaders(isProd: boolean): RequestHandler {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "manifest-src 'self'",
  ].join('; ');

  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (isProd) res.setHeader('Content-Security-Policy', csp);
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reject mutating requests from a different origin (CSRF defense-in-depth). */
export function sameOriginGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get('origin');
    if (!origin) return next(); // no cross-origin signal — SameSite=Lax covers it
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      res.status(403).json({ error: 'bad_origin' });
      return;
    }
    if (originHost !== req.get('host')) {
      res.status(403).json({ error: 'cross_origin' });
      return;
    }
    return next();
  };
}
