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

  it('upgrades a guest into a real account in place, keeping the session', async () => {
    const agent = request.agent(app);
    const guest = await agent.post('/api/auth/guest').send({});
    expect((await agent.get('/api/auth/me')).body.guest).toBe(true);

    const up = await agent
      .post('/api/auth/upgrade')
      .send({ email: 'saved@home.test', password: 'correcthorse' });
    expect(up.status).toBe(200);
    expect(up.body.accountId).toBe(guest.body.accountId); // same account, same id
    expect((await agent.get('/api/auth/me')).body.guest).toBe(false); // no longer a guest

    // The new credentials work from a fresh client, resolving the same account.
    const fresh = request.agent(app);
    const login = await fresh
      .post('/api/auth/login')
      .send({ email: 'saved@home.test', password: 'correcthorse' });
    expect(login.status).toBe(200);
    expect(login.body.accountId).toBe(guest.body.accountId);
  });

  it('rejects upgrade when unauthenticated, non-guest, or email taken', async () => {
    expect(
      (
        await request(app)
          .post('/api/auth/upgrade')
          .send({ email: 'x@y.co', password: 'correcthorse' })
      ).status,
    ).toBe(401);

    const real = request.agent(app);
    await real.post('/api/auth/signup').send(CREDS);
    const notGuest = await real
      .post('/api/auth/upgrade')
      .send({ email: 'new@home.test', password: 'correcthorse' });
    expect(notGuest.status).toBe(409);
    expect(notGuest.body.error).toBe('not_a_guest');

    const g = request.agent(app);
    await g.post('/api/auth/guest').send({});
    const taken = await g
      .post('/api/auth/upgrade')
      .send({ email: CREDS.email, password: 'correcthorse' });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('email_taken');
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

  it('treats email case-insensitively for signup, dedupe, and login', async () => {
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ ...CREDS, email: 'Parent@Home.test' });
    expect(signup.status).toBe(201);
    expect(signup.body.email).toBe('parent@home.test'); // stored normalized

    // A different-cased variant is the same account — can't re-register.
    const dup = await request(app)
      .post('/api/auth/signup')
      .send({ ...CREDS, email: 'PARENT@HOME.TEST' });
    expect(dup.status).toBe(409);

    // ...and can log in.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'PARENT@home.TEST', password: CREDS.password });
    expect(login.status).toBe(200);
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

  it('deletes the account + all data (cascade) and ends the session', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(CREDS);
    await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });

    expect((await agent.delete('/api/auth/account')).status).toBe(204);
    // Session is gone (cookie cleared + auth_session cascaded).
    expect((await agent.get('/api/auth/me')).status).toBe(401);
    // The email is free again — the account row (and its profiles) are gone.
    const fresh = await request(app).post('/api/auth/signup').send(CREDS);
    expect(fresh.status).toBe(201);
    const relog = request.agent(app);
    await relog.post('/api/auth/login').send({ email: CREDS.email, password: CREDS.password });
    expect((await relog.get('/api/profiles')).body.profiles).toHaveLength(0);
  });

  it('rejects account deletion without auth', async () => {
    expect((await request(app).delete('/api/auth/account')).status).toBe(401);
  });

  it('reads and edits account email / password / timezone', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(CREDS);

    const acct = await agent.get('/api/auth/account');
    expect(acct.body).toEqual({ email: CREDS.email, timezone: CREDS.timezone });

    const patched = await agent
      .patch('/api/auth/account')
      .send({ email: 'new@home.test', timezone: 'UTC', password: 'newpassword1' });
    expect(patched.status).toBe(200);
    expect(patched.body).toEqual({ email: 'new@home.test', timezone: 'UTC' });

    // New credentials work; old email is freed.
    const relog = request.agent(app);
    const ok = await relog
      .post('/api/auth/login')
      .send({ email: 'new@home.test', password: 'newpassword1' });
    expect(ok.status).toBe(200);
    expect(
      (
        await request(app)
          .post('/api/auth/login')
          .send({ email: CREDS.email, password: CREDS.password })
      ).status,
    ).toBe(401);
  });

  it('rejects an account edit to a taken email and a weak password', async () => {
    const a = request.agent(app);
    await a.post('/api/auth/signup').send(CREDS);
    const b = request.agent(app);
    await b.post('/api/auth/signup').send({ ...CREDS, email: 'b@home.test' });

    // b tries to take a's email.
    expect((await b.patch('/api/auth/account').send({ email: CREDS.email })).body.error).toBe(
      'email_taken',
    );
    expect((await b.patch('/api/auth/account').send({ password: 'short' })).status).toBe(400);
    // Editing to your own email is fine (no false conflict).
    expect((await b.patch('/api/auth/account').send({ email: 'b@home.test' })).status).toBe(200);
    expect((await request(app).get('/api/auth/account')).status).toBe(401); // unauth
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

  it('deletes a profile (and it disappears from the list)', async () => {
    const agent = await authed();
    const a = await agent.post('/api/profiles').send({ displayName: 'A', avatar: '🦊' });
    const b = await agent.post('/api/profiles').send({ displayName: 'B', avatar: '🐼' });

    expect((await agent.delete(`/api/profiles/${a.body.profile.id}`)).status).toBe(204);

    const list = await agent.get('/api/profiles');
    expect(list.body.profiles.map((p: { id: string }) => p.id)).toEqual([b.body.profile.id]);
    // The deleted profile is gone (its routes 404).
    expect((await agent.get(`/api/profiles/${a.body.profile.id}/factsets`)).status).toBe(404);
  });

  it("won't delete another account's profile", async () => {
    const agent = await authed();
    const mine = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ ...CREDS, email: 'other@home.test' });
    expect((await other.delete(`/api/profiles/${mine.body.profile.id}`)).status).toBe(404);
    // Still there for the owner.
    expect((await agent.get('/api/profiles')).body.profiles).toHaveLength(1);
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

  it('renames a profile (displayName + avatar) and rejects an empty name', async () => {
    const agent = await authed();
    const { body } = await agent.post('/api/profiles').send({ displayName: 'Kd', avatar: '🦊' });
    const id = body.profile.id;

    const renamed = await agent
      .patch(`/api/profiles/${id}`)
      .send({ displayName: 'Kid', avatar: '🐼' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.profile.displayName).toBe('Kid');
    expect(renamed.body.profile.avatar).toBe('🐼');
    // Settings untouched by a name-only edit.
    expect(renamed.body.profile.settings.sessionCards).toBe(20);

    expect((await agent.patch(`/api/profiles/${id}`).send({ displayName: '   ' })).status).toBe(
      400,
    );
    expect((await agent.patch(`/api/profiles/${id}`).send({})).status).toBe(400); // nothing_to_update
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

describe('input limits', () => {
  async function authed() {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(CREDS);
    return agent;
  }

  it('rejects an oversized request body before parsing it', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(20_000) }));
    expect(res.status).toBe(413);
  });

  it('rejects an over-long avatar', async () => {
    const agent = await authed();
    const res = await agent
      .post('/api/profiles')
      .send({ displayName: 'Kid', avatar: 'x'.repeat(40) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_avatar');
  });

  it('rejects more enabled sets than the catalog holds', async () => {
    const agent = await authed();
    const { body } = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    const tooMany = Array.from({ length: 100 }, () => 'add-0-5'); // valid id, absurd count
    const res = await agent
      .put(`/api/profiles/${body.profile.id}/factsets`)
      .send({ enabledIds: tooMany });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_set_ids');
  });
});
