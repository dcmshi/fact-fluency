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

  it('validates signup input', async () => {
    expect((await request(app).post('/api/auth/signup').send({ ...CREDS, email: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/auth/signup').send({ ...CREDS, password: 'short' })).status).toBe(400);
  });

  it('rejects a duplicate email', async () => {
    await request(app).post('/api/auth/signup').send(CREDS);
    expect((await request(app).post('/api/auth/signup').send(CREDS)).status).toBe(409);
  });

  it('logs in with correct creds and rejects wrong ones', async () => {
    await request(app).post('/api/auth/signup').send(CREDS);
    expect((await request(app).post('/api/auth/login').send({ email: CREDS.email, password: 'wrong' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ email: CREDS.email, password: CREDS.password });
    expect(ok.status).toBe(200);
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

  it('validates profile creation input', async () => {
    const agent = await authed();
    expect((await agent.post('/api/profiles').send({ displayName: '  ', avatar: '🦊' })).status).toBe(400);
    expect((await agent.post('/api/profiles').send({ displayName: 'Kid' })).status).toBe(400);
  });

  it('updates enabled fact sets and rejects unknown ids', async () => {
    const agent = await authed();
    const { body } = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    const id = body.profile.id;

    const ok = await agent.put(`/api/profiles/${id}/factsets`).send({ enabledIds: ['mul-0-12'] });
    expect(ok.status).toBe(200);
    expect((await agent.get(`/api/profiles/${id}/factsets`)).body.enabledIds).toEqual(['mul-0-12']);

    expect((await agent.put(`/api/profiles/${id}/factsets`).send({ enabledIds: ['nope'] })).status).toBe(400);
  });

  it("hides another account's profile (404 on ownership mismatch)", async () => {
    const a = await authed();
    const { body } = await a.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });

    const b = request.agent(app);
    await b.post('/api/auth/signup').send({ ...CREDS, email: 'other@home.test' });
    expect((await b.get(`/api/profiles/${body.profile.id}/factsets`)).status).toBe(404);
  });
});
