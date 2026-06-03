/**
 * Server bootstrap — DESIGN.md §5.2. In production Express serves the built
 * client bundle (single-service deploy). In dev it serves only /api; the Vite
 * dev server proxies /api here.
 */
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createApiRouter } from './api';

const PORT = Number(process.env.PORT ?? 3001);
const isProd = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET ?? 'dev-only-change-me'));

app.use('/api', createApiRouter());

if (isProd) {
  // Built client lives at client/dist relative to the repo root.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback for client-side routing.
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Fact Fluency API listening on http://localhost:${PORT} (${isProd ? 'prod' : 'dev'})`);
});
