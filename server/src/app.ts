/**
 * Express app assembly (DESIGN.md §5.2). Separated from the listen() bootstrap
 * so tests can construct the app over an in-memory DB.
 */
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type Application, type NextFunction, type Request, type Response } from 'express';
import { createApiRouter } from './api';
import { attachAccount } from './auth/middleware';
import type { Db } from './db';

export function createApp(db: Db, isProd: boolean): Application {
  const app = express();
  // Behind Render's proxy in prod: trust X-Forwarded-For so req.ip is the real
  // client IP (per-IP rate limiting depends on this). Off in dev/test so req.ip
  // is the local socket.
  if (isProd) app.set('trust proxy', true);
  app.use(express.json());
  app.use(cookieParser(process.env.COOKIE_SECRET ?? 'dev-only-change-me'));
  app.use(attachAccount(db));

  app.use('/api', createApiRouter(db, isProd));

  if (isProd) {
    const clientDist = path.resolve(__dirname, '../../client/dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  // Centralized error handler — route handlers forward errors via next(err).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
