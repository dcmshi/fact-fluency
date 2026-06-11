/**
 * Express app assembly (DESIGN.md §5.2). Separated from the listen() bootstrap
 * so tests can construct the app over an in-memory DB.
 */
import path from 'node:path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import { createApiRouter } from './api';
import { attachAccount } from './auth/middleware';
import type { Db } from './db';
import { sameOriginGuard, securityHeaders } from './security';

export function createApp(db: Db, isProd: boolean): Application {
  const app = express();
  // Behind Render's proxy in prod: trust exactly one hop so req.ip is the
  // address Render saw (per-IP rate limiting depends on this). `true` would
  // take the *leftmost* X-Forwarded-For entry, which the client controls —
  // letting an attacker rotate fake IPs past the auth rate limits. Off in
  // dev/test so req.ip is the local socket.
  if (isProd) app.set('trust proxy', 1);
  // Render's proxy doesn't compress responses — without this every first visit
  // ships the JS bundle (and the chunky dashboard/progress JSON) at 3-4x its
  // gzipped size.
  app.use(compression());
  app.use(securityHeaders(isProd));
  // Cap request bodies — every endpoint takes small JSON (credentials, a setId
  // list, one answer). 16kb is generous headroom; anything larger is malformed
  // or hostile and is rejected before it's parsed into memory.
  app.use(express.json({ limit: '16kb' }));
  app.use(cookieParser(process.env.COOKIE_SECRET ?? 'dev-only-change-me'));
  app.use(attachAccount(db));

  // CSRF same-origin guard is a production concern (and the dev Vite proxy
  // rewrites Host so Origin wouldn't match). Dev still has SameSite=Lax cookies.
  const apiGuards = isProd ? [sameOriginGuard()] : [];
  app.use('/api', ...apiGuards, createApiRouter(db, isProd));

  if (isProd) {
    const clientDist = path.resolve(__dirname, '../../client/dist');
    // Vite content-hashes everything under assets/, so those are safe to cache
    // forever. Root-level files keep their names across deploys (sw.js,
    // manifest.webmanifest, icon.svg) and index.html names the hashed bundles,
    // so they must always revalidate (`index: false` routes index.html through
    // the catch-all).
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders: (res, filePath) => {
          const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
          res.setHeader(
            'Cache-Control',
            immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
          );
        },
      }),
    );
    app.get('*', (_req, res) =>
      res.sendFile(path.join(clientDist, 'index.html'), {
        headers: { 'Cache-Control': 'no-cache' },
      }),
    );
  }

  // Centralized error handler — route handlers forward errors via next(err).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Client errors raised by middleware (e.g. body-parser on malformed JSON,
    // which sets status 400) shouldn't be reported as a server fault.
    const status =
      (err as { status?: number; statusCode?: number })?.status ??
      (err as { statusCode?: number })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: 'invalid_request' });
      return;
    }
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
