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
    expect(prod.headers['content-security-policy']).toContain('https://fonts.gstatic.com');
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
