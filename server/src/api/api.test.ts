import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { SqliteDb } from '../db/sqlite';

let db: SqliteDb;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new SqliteDb(':memory:');
  app = createApp(db, false);
});
afterEach(async () => {
  await db.close();
});

const CREDS = { email: 'parent@home.test', password: 'correcthorse', timezone: 'America/Toronto' };

describe('public endpoints', () => {
  it('serves health and catalog', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    const catalog = await request(app).get('/api/catalog');
    expect(catalog.body.sets.length).toBeGreaterThan(0);
    expect(catalog.body.gradeBands.length).toBeGreaterThan(0);
    expect(catalog.body.gradeBands[0]).toHaveProperty('setIds');
  });
});

describe('auth', () => {
  it('signs up, sets a cookie, and resolves /me', async () => {
    const agent = request.agent(app);
    const signup = await agent.post('/api/auth/signup').send(CREDS);
    expect(signup.status).toBe(201);
    expect(signup.body.email).toBe(CREDS.email);
    expect(signup.headers['set-cookie'][0]).toMatch(/ff_session=/);

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.accountId).toBe(signup.body.accountId);
  });

  it('rejects /me without a session', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
  });

  it('mints an anonymous guest session that can play without signup', async () => {
    const agent = request.agent(app);
    const guest = await agent.post('/api/auth/guest').send({ timezone: 'UTC' });
    expect(guest.status).toBe(201);
    expect(guest.body.guest).toBe(true);
    expect(guest.body.profileId).toBeTruthy();
    expect(guest.headers['set-cookie'][0]).toMatch(/ff_session=/);

    // The guest is authenticated...
    const me = await agent.get('/api/auth/me');
    expect(me.body.accountId).toBe(guest.body.accountId);

    // ...and can immediately start a real session on the auto-created profile.
    const session = await agent.post(`/api/profiles/${guest.body.profileId}/session`);
    expect(session.status).toBe(201);
    expect(session.body.deck.length).toBeGreaterThan(0);
  });

  it('validates signup input', async () => {
    expect(
      (
        await request(app)
          .post('/api/auth/signup')
          .send({ ...CREDS, email: 'nope' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post('/api/auth/signup')
          .send({ ...CREDS, password: 'short' })
      ).status,
    ).toBe(400);
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/auth/signup').send(CREDS);
    expect((await request(app).post('/api/auth/signup').send(CREDS)).status).toBe(409);
  });

  it('logs in with correct creds and rejects wrong ones', async () => {
    await request(app).post('/api/auth/signup').send(CREDS);
    expect(
      (await request(app).post('/api/auth/login').send({ email: CREDS.email, password: 'wrong' }))
        .status,
    ).toBe(401);
    const ok = await request(app)
      .post('/api/auth/login')
      .send({ email: CREDS.email, password: CREDS.password });
    expect(ok.status).toBe(200);
  });

  it('rate-limits repeated login attempts from one IP (429)', async () => {
    const creds = { email: 'nobody@home.test', password: 'whatever123' };
    let last = await request(app).post('/api/auth/login').send(creds);
    for (let i = 0; i < 10; i++) {
      last = await request(app).post('/api/auth/login').send(creds);
    }
    expect(last.status).toBe(429); // 11th attempt blocked (login max = 10)
    expect(last.body.error).toBe('rate_limited');
    expect(last.headers['retry-after']).toBeDefined();
  });

  it('logs out and invalidates the session', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(CREDS);
    expect((await agent.post('/api/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });
});

describe('profiles', () => {
  async function authed() {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(CREDS);
    return agent;
  }

  it('requires auth', async () => {
    expect((await request(app).get('/api/profiles')).status).toBe(401);
  });

  it('rate-limits profile creation per IP', async () => {
    const agent = await authed();
    const create = () => agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    // The window allows 20; the 21st is rejected with 429 + Retry-After.
    for (let i = 0; i < 20; i++) expect((await create()).status).toBe(201);
    const blocked = await create();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('creates a profile with default enabled sets, then lists it', async () => {
    const agent = await authed();
    const created = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    expect(created.status).toBe(201);
    expect(created.body.profile.displayName).toBe('Kid');
    expect(created.body.profile.settings.sessionCards).toBe(20);

    const list = await agent.get('/api/profiles');
    expect(list.body.profiles).toHaveLength(1);

    const factsets = await agent.get(`/api/profiles/${created.body.profile.id}/factsets`);
    expect(factsets.body.catalog.length).toBeGreaterThan(0);
    expect(factsets.body.enabledIds.sort()).toEqual(['add-0-10', 'mul-0-5']);
  });

  it('enables a grade band’s sets at creation, falling back to default', async () => {
    const agent = await authed();
    const g3 = await agent
      .post('/api/profiles')
      .send({ displayName: 'Kid', avatar: '🦊', gradeBand: 'grade-3' });
    expect(
      (await agent.get(`/api/profiles/${g3.body.profile.id}/factsets`)).body.enabledIds.sort(),
    ).toEqual(['div-0-10', 'mul-0-10']);

    // Unknown band → starter default.
    const bad = await agent
      .post('/api/profiles')
      .send({ displayName: 'Kid2', avatar: '🐼', gradeBand: 'nope' });
    expect(
      (await agent.get(`/api/profiles/${bad.body.profile.id}/factsets`)).body.enabledIds.sort(),
    ).toEqual(['add-0-10', 'mul-0-5']);
  });

  it('validates profile creation input', async () => {
    const agent = await authed();
    expect(
      (await agent.post('/api/profiles').send({ displayName: '  ', avatar: '🦊' })).status,
    ).toBe(400);
    expect((await agent.post('/api/profiles').send({ displayName: 'Kid' })).status).toBe(400);
  });

  it('updates enabled fact sets and rejects unknown ids', async () => {
    const agent = await authed();
    const { body } = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    const id = body.profile.id;

    const ok = await agent.put(`/api/profiles/${id}/factsets`).send({ enabledIds: ['mul-0-12'] });
    expect(ok.status).toBe(200);
    expect((await agent.get(`/api/profiles/${id}/factsets`)).body.enabledIds).toEqual(['mul-0-12']);

    expect(
      (await agent.put(`/api/profiles/${id}/factsets`).send({ enabledIds: ['nope'] })).status,
    ).toBe(400);
  });

  it('patches session settings (partial merge) and rejects bad values', async () => {
    const agent = await authed();
    const { body } = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    const id = body.profile.id;

    // Partial PATCH: only sessionCards changes; the others keep their defaults.
    const patched = await agent
      .patch(`/api/profiles/${id}`)
      .send({ settings: { sessionCards: 12 } });
    expect(patched.status).toBe(200);
    expect(patched.body.profile.settings).toEqual({
      sessionCards: 12,
      sessionSeconds: 180,
      newPerSession: 3,
    });

    // newPerSession: 0 is valid (review-only) — not treated as "unset".
    const zeroNew = await agent
      .patch(`/api/profiles/${id}`)
      .send({ settings: { newPerSession: 0 } });
    expect(zeroNew.body.profile.settings.newPerSession).toBe(0);

    // Persisted across reads.
    const list = await agent.get('/api/profiles');
    expect(list.body.profiles[0].settings).toEqual({
      sessionCards: 12,
      sessionSeconds: 180,
      newPerSession: 0,
    });

    // Out-of-range and non-integer values are rejected.
    expect(
      (await agent.patch(`/api/profiles/${id}`).send({ settings: { sessionCards: 1 } })).status,
    ).toBe(400);
    expect(
      (await agent.patch(`/api/profiles/${id}`).send({ settings: { newPerSession: 11 } })).status,
    ).toBe(400);
    expect(
      (await agent.patch(`/api/profiles/${id}`).send({ settings: { sessionCards: 12.5 } })).status,
    ).toBe(400);
    expect((await agent.patch(`/api/profiles/${id}`).send({ settings: 'nope' })).status).toBe(400);
  });

  it("returns 404 patching another account's profile", async () => {
    const a = await authed();
    const { body } = await a.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });

    const b = request.agent(app);
    await b.post('/api/auth/signup').send({ ...CREDS, email: 'other2@home.test' });
    expect(
      (await b.patch(`/api/profiles/${body.profile.id}`).send({ settings: { sessionCards: 10 } }))
        .status,
    ).toBe(404);
  });

  it("hides another account's profile (404 on ownership mismatch)", async () => {
    const a = await authed();
    const { body } = await a.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });

    const b = request.agent(app);
    await b.post('/api/auth/signup').send({ ...CREDS, email: 'other@home.test' });
    expect((await b.get(`/api/profiles/${body.profile.id}/factsets`)).status).toBe(404);
  });
});
