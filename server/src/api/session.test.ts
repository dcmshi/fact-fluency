import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Card, SessionResponse } from '@shared';
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

const CREDS = { email: 'parent@home.test', password: 'correcthorse', timezone: 'UTC' };

/** Sign up and create a profile (with default enabled sets). Returns an agent
 *  and the profile id. */
async function setup() {
  const agent = request.agent(app);
  await agent.post('/api/auth/signup').send(CREDS);
  const { body } = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
  return { agent, profileId: body.profile.id as string };
}

describe('session loop', () => {
  it('starts a session with a deck and per-operation thresholds', async () => {
    const { agent, profileId } = await setup();
    const res = await agent.post(`/api/profiles/${profileId}/session`);
    expect(res.status).toBe(201);
    const session = res.body as SessionResponse;
    expect(session.deck.length).toBeGreaterThan(0);
    // Brand-new profile → every card is a new-fact introduction.
    expect(session.deck.every((c: Card) => c.isNew)).toBe(true);
    expect(session.thresholds.mul).toBeGreaterThan(0);
    expect(session.thresholds.add).toBeGreaterThan(0);
    // Soft time budget travels with the deck so the client can cap silently.
    expect(session.sessionSeconds).toBe(180);
  });

  it('reflects an edited sessionSeconds in the next session', async () => {
    const { agent, profileId } = await setup();
    await agent.patch(`/api/profiles/${profileId}`).send({ settings: { sessionSeconds: 90 } });
    const res = await agent.post(`/api/profiles/${profileId}/session`);
    expect((res.body as SessionResponse).sessionSeconds).toBe(90);
  });

  it('grades answers, re-queues new facts, and produces a summary', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const sessionId = session.sessionId as string;
    const deck = session.deck as Card[];

    // Answer the first card correctly and quickly.
    const first = deck[0];
    const ok = await agent
      .post(`/api/sessions/${sessionId}/answer`)
      .send({ factId: first.fact.id, given: first.answer, responseMs: 1500 });
    expect(ok.status).toBe(200);
    expect(ok.body.correct).toBe(true);
    expect(ok.body.fast).toBe(true);
    // A brand-new fact stays in box 0 after one correct → re-shown in-session.
    expect(ok.body.updatedProgress.box).toBe(0);
    expect(ok.body.injects).toEqual([{ factId: first.fact.id, afterOffset: 3 }]);
    // Not "caught up" mid-learning — a fact is still in the learning phase.
    expect(ok.body.caughtUp).toBe(false);

    // A wrong answer on the second card is graded incorrect.
    const second = deck[1];
    const wrong = await agent
      .post(`/api/sessions/${sessionId}/answer`)
      .send({ factId: second.fact.id, given: second.answer + 1, responseMs: 1500 });
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.fast).toBe(false);

    // Play the rest correctly, then complete.
    for (const card of deck.slice(2)) {
      await agent
        .post(`/api/sessions/${sessionId}/answer`)
        .send({ factId: card.fact.id, given: card.answer, responseMs: 1500 });
    }
    const summary = await agent.post(`/api/sessions/${sessionId}/complete`);
    expect(summary.status).toBe(200);
    expect(summary.body.cardsPlayed).toBe(deck.length);
    expect(summary.body.correct).toBe(deck.length - 1); // the one wrong answer
    expect(summary.body.pointsEarned).toBeGreaterThan(0);
    expect(summary.body.streak).toBe(1); // first day playing
  });

  it('keeps the streak at 1 when completing twice the same day', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const first = await agent.post(`/api/sessions/${session.sessionId}/complete`);
    const second = await agent.post(`/api/sessions/${session.sessionId}/complete`);
    expect(first.body.streak).toBe(1);
    expect(second.body.streak).toBe(1);
    // And it surfaces on the profile.
    const profiles = await agent.get('/api/profiles');
    expect(profiles.body.profiles[0].streak).toBe(1);
  });

  it('graduates a new fact to box 1 after two in-session correct answers', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const { sessionId } = session;
    const card = (session.deck as Card[])[0];

    const a1 = await agent
      .post(`/api/sessions/${sessionId}/answer`)
      .send({ factId: card.fact.id, given: card.answer, responseMs: 1500 });
    expect(a1.body.updatedProgress.box).toBe(0);

    const a2 = await agent
      .post(`/api/sessions/${sessionId}/answer`)
      .send({ factId: card.fact.id, given: card.answer, responseMs: 1500 });
    expect(a2.body.updatedProgress.box).toBe(1);
    expect(a2.body.updatedProgress.state).toBe('review');
  });
});

describe('session errors', () => {
  it('401 without auth', async () => {
    const { profileId } = await setup();
    expect((await request(app).post(`/api/profiles/${profileId}/session`)).status).toBe(401);
  });

  it('400 when the profile has no enabled fact sets', async () => {
    const { agent, profileId } = await setup();
    await agent.put(`/api/profiles/${profileId}/factsets`).send({ enabledIds: [] });
    const res = await agent.post(`/api/profiles/${profileId}/session`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_enabled_sets');
  });

  it('400 when answering a fact that is not in the session', async () => {
    const { agent, profileId } = await setup();
    const { body } = await agent.post(`/api/profiles/${profileId}/session`);
    const res = await agent
      .post(`/api/sessions/${body.sessionId}/answer`)
      .send({ factId: 'mul:99x99', given: 0, responseMs: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fact_not_in_session');
  });

  it("404 when starting a session on another account's profile", async () => {
    const { profileId } = await setup();
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ ...CREDS, email: 'other@home.test' });
    expect((await other.post(`/api/profiles/${profileId}/session`)).status).toBe(404);
  });
});

describe('progress view', () => {
  it('returns a grid per enabled operation with unseen cells initially', async () => {
    const { agent, profileId } = await setup();
    const res = await agent.get(`/api/profiles/${profileId}/progress`);
    expect(res.status).toBe(200);
    // Default enabled sets are add-0-10 and mul-0-5.
    const ops = res.body.grids.map((g: { operation: string }) => g.operation);
    expect(ops).toEqual(['add', 'mul']);
    const add = res.body.grids.find((g: { operation: string }) => g.operation === 'add');
    expect(add.cells.length).toBe(66); // 0..10 canonicalized = 11*12/2
    expect(add.cells.every((c: { state: string }) => c.state === 'unseen')).toBe(true);
  });

  it('reflects learning progress after a session answer', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const card = session.deck[0];
    await agent
      .post(`/api/sessions/${session.sessionId}/answer`)
      .send({ factId: card.fact.id, given: card.answer, responseMs: 1500 });

    const res = await agent.get(`/api/profiles/${profileId}/progress`);
    const learning = res.body.grids
      .flatMap((g: { cells: { state: string }[] }) => g.cells)
      .filter((c: { state: string }) => c.state === 'learning');
    expect(learning.length).toBe(1);
  });
});
