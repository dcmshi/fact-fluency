/**
 * Async route-handler wrapper: awaits the handler, maps a thrown HttpError to
 * its JSON status response, and forwards anything else to the Express error
 * middleware. Every router uses this instead of hand-rolled try/catch.
 */
import type { Request, RequestHandler, Response } from 'express';
import { HttpError } from '../httpError';

export function handle(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch((err) => {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code });
        return;
      }
      next(err);
    });
  };
}
