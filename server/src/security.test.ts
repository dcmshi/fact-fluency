import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import { SqliteDb } from './db/sqlite';

const dbs: SqliteDb[] = [];
function app(isProd: boolean) {
  const db = new SqliteDb(':memory:');
  dbs.push(db);
  return createApp(db, isProd);
}
afterEach(async () => {
  await Promise.all(dbs.splice(0).map((d) => d.close()));
});

describe('security headers', () => {
  it('sets baseline headers always, and a CSP only in production', async () => {
    const dev = await request(app(false)).get('/api/health');
    expect(dev.headers['x-content-type-options']).toBe('nosniff');
    expect(dev.headers['x-frame-options']).toBe('DENY');
    expect(dev.headers['referrer-policy']).toBe('no-referrer');
    expect(dev.headers['content-security-policy']).toBeUndefined();

    const prod = await request(app(true)).get('/api/health');
    expect(prod.headers['content-security-policy']).toContain("default-src 'self'");
    // Fonts are self-hosted — no third-party origins in the CSP.
    expect(prod.headers['content-security-policy']).toContain("font-src 'self'");
    expect(prod.headers['content-security-policy']).not.toContain('fonts.gstatic.com');
    expect(prod.headers['content-security-policy']).not.toContain('fonts.googleapis.com');
    // HSTS in prod only.
    expect(prod.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(dev.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('error handling', () => {
  it('returns 400 (not 500) for a malformed JSON body, with no stack leak', async () => {
    const res = await request(app(false))
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });
});

describe('compression', () => {
  it('gzips compressible JSON when the client accepts it', async () => {
    // Render's proxy doesn't compress; the middleware must. The catalog is the
    // biggest public payload (well past compression's 1kb threshold).
    const res = await request(app(true)).get('/api/catalog').set('Accept-Encoding', 'gzip');
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.sets.length).toBeGreaterThan(0); // still parses end-to-end
  });
});

describe('rate limiting behind the proxy (trust proxy = 1)', () => {
  it('is not evaded by rotating a spoofed X-Forwarded-For prefix in prod', async () => {
    // Render appends the real client IP as the *last* XFF entry; everything to
    // its left is client-supplied. With `trust proxy: true` an attacker who
    // rotates the leftmost entry gets a fresh rate-limit bucket per request —
    // with exactly one trusted hop, req.ip stays the proxy-observed address.
    const a = app(true);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(a)
        .post('/api/auth/login')
        .set('X-Forwarded-For', `198.51.100.${i}, 203.0.113.7`)
        .send({ email: 'a@b.co', password: 'whatever12' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401)); // limit is 10/15min
    expect(statuses[10]).toBe(429);
  });
});

describe('same-origin guard (CSRF defense-in-depth, prod only)', () => {
  it('rejects a cross-origin mutating request in prod', async () => {
    const res = await request(app(true))
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: 'a@b.co', password: 'whatever12' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_origin');
  });

  it('allows a mutating request with no Origin (fails open)', async () => {
    const res = await request(app(true))
      .post('/api/auth/login')
      .send({ email: 'a@b.co', password: 'whatever12' });
    expect(res.status).not.toBe(403); // reaches the handler (401 invalid creds)
  });

  it('does not block safe (GET) requests', async () => {
    const res = await request(app(true)).get('/api/health').set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
  });

  it('does not guard in dev (Vite proxy rewrites Host)', async () => {
    const res = await request(app(false))
      .post('/api/auth/login')
      .set('Origin', 'http://evil.example')
      .send({ email: 'a@b.co', password: 'whatever12' });
    expect(res.status).not.toBe(403); // dev relies on SameSite=Lax instead
  });
});
