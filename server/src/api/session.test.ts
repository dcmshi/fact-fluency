import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Card, SessionResponse } from '@shared';
import { createApp } from '../app';
import { SqliteDb } from '../db/sqlite';
import * as sessions from '../session/service';

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

  it('frames new sub/div cards with their inverse sibling (fact families)', async () => {
    const { agent, profileId } = await setup();
    await agent.put(`/api/profiles/${profileId}/factsets`).send({ enabledIds: ['div-0-5'] });
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const divCard = (session.deck as Card[]).find((c) => c.fact.operation === 'div' && c.isNew);
    expect(divCard).toBeDefined();
    // The sibling is the multiplication that produces the dividend.
    expect(divCard!.family).toEqual({
      operandA: divCard!.fact.answer,
      operandB: divCard!.fact.operandB,
      operation: 'mul',
      answer: divCard!.fact.operandA,
    });
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
      .send({ factId: first.fact.id, correct: true, responseMs: 1500 });
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
      .send({ factId: second.fact.id, correct: false, responseMs: 1500 });
    expect(wrong.body.correct).toBe(false);
    expect(wrong.body.fast).toBe(false);

    // Play the rest correctly, then complete.
    for (const card of deck.slice(2)) {
      await agent
        .post(`/api/sessions/${sessionId}/answer`)
        .send({ factId: card.fact.id, correct: true, responseMs: 1500 });
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

  it('resumes a same-day interrupted session, dropping handled facts', async () => {
    const { agent, profileId } = await setup();
    const { body: first } = await agent.post(`/api/profiles/${profileId}/session`);
    const deck = first.deck as Card[];
    const [c0, c1, c2] = deck;

    const send = (factId: string, correct: boolean) =>
      agent
        .post(`/api/sessions/${first.sessionId}/answer`)
        .send({ factId, correct, responseMs: 1500 });

    // Graduate c0 (two correct → box 1), partially learn c1 (one correct → box 0).
    await send(c0.fact.id, true);
    await send(c0.fact.id, true);
    await send(c1.fact.id, true);

    // Reopen the same day → same session id, handled fact gone, learning fact kept.
    const { body: resumed } = await agent.post(`/api/profiles/${profileId}/session`);
    expect(resumed.sessionId).toBe(first.sessionId);
    const ids = (resumed.deck as Card[]).map((c) => c.fact.id);
    expect(ids).not.toContain(c0.fact.id); // graduated → dropped
    const r1 = (resumed.deck as Card[]).find((c) => c.fact.id === c1.fact.id);
    expect(r1?.isNew).toBe(false); // still learning, already studied today
    const r2 = (resumed.deck as Card[]).find((c) => c.fact.id === c2.fact.id);
    expect(r2?.isNew).toBe(true); // never reached → keeps study-first

    // And it stayed a single open session (one active session per profile).
    expect((await db.getOpenSession(profileId))?.id).toBe(first.sessionId);
  });

  it('discards a stale prior-day session and plans fresh', async () => {
    const accountId = await db.createAccount('p@x.co', 'h', 'UTC');
    const profile = await db.createProfile({
      accountId,
      displayName: 'K',
      avatar: '🦊',
      settings: { sessionCards: 20, sessionSeconds: 180, newPerSession: 3 },
    });
    await db.setEnabledSetIds(profile.id, ['add-0-10']);

    const yesterday = Date.UTC(2026, 5, 3, 12);
    const today = Date.UTC(2026, 5, 4, 12);
    const first = await sessions.startSession(db, accountId, profile.id, yesterday);
    const second = await sessions.startSession(db, accountId, profile.id, today);

    expect(second.sessionId).not.toBe(first.sessionId);
    // The stale one is closed; only the fresh session is open.
    expect((await db.getOpenSession(profile.id))?.id).toBe(second.sessionId);
  });

  it('graduates a new fact to box 1 after two in-session correct answers', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const { sessionId } = session;
    const card = (session.deck as Card[])[0];

    const a1 = await agent
      .post(`/api/sessions/${sessionId}/answer`)
      .send({ factId: card.fact.id, correct: true, responseMs: 1500 });
    expect(a1.body.updatedProgress.box).toBe(0);

    const a2 = await agent
      .post(`/api/sessions/${sessionId}/answer`)
      .send({ factId: card.fact.id, correct: true, responseMs: 1500 });
    expect(a2.body.updatedProgress.box).toBe(1);
    expect(a2.body.updatedProgress.state).toBe('review');
  });
});

describe('rewards', () => {
  async function setup() {
    const agent = request.agent(app);
    await agent.post('/api/auth/signup').send(CREDS);
    const { body } = await agent.post('/api/profiles').send({ displayName: 'Kid', avatar: '🦊' });
    return { agent, profileId: body.profile.id as string };
  }

  it('credits coins once on completion and exposes the rewards view', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    for (const c of session.deck as Card[]) {
      await agent
        .post(`/api/sessions/${session.sessionId}/answer`)
        .send({ factId: c.fact.id, correct: true, responseMs: 1200 });
    }
    const first = await agent.post(`/api/sessions/${session.sessionId}/complete`);
    expect(first.body.pointsEarned).toBeGreaterThan(0);
    expect(first.body.coins).toBe(first.body.pointsEarned);
    // Re-completing must not farm more coins — or advance the streak.
    const second = await agent.post(`/api/sessions/${session.sessionId}/complete`);
    expect(second.body.coins).toBe(first.body.coins);
    expect(second.body.streak).toBe(first.body.streak);

    const rewards = await agent.get(`/api/profiles/${profileId}/rewards`);
    expect(rewards.body.coins).toBe(first.body.coins);
    expect(rewards.body.catalog.length).toBeGreaterThan(0);
    expect(rewards.body.owned).toContain('theme-classic'); // free item owned by default
    expect(rewards.body.equippedTheme).toBe('classic');
    expect(rewards.body.equippedMuncher).toBe('cat'); // default muncher
    expect(rewards.body.equippedEffect).toBe('confetti'); // default effect
  });

  it('equips an owned celebration effect, surfaced on the session', async () => {
    const { agent, profileId } = await setup();
    await db.addCoins(profileId, 100);
    const unlock = await agent
      .post(`/api/profiles/${profileId}/rewards/unlock`)
      .send({ itemId: 'effect-sparkles' }); // cost 50
    expect(unlock.status).toBe(200);
    const equip = await agent
      .post(`/api/profiles/${profileId}/rewards/equip`)
      .send({ itemId: 'effect-sparkles' });
    expect(equip.body.equippedEffect).toBe('sparkles');
    const session = await agent.post(`/api/profiles/${profileId}/session`);
    expect(session.body.effect).toBe('sparkles');
  });

  it('equips an owned muncher and surfaces it on the session', async () => {
    const { agent, profileId } = await setup();
    // 'dog' is a free muncher → equippable without coins.
    const equip = await agent
      .post(`/api/profiles/${profileId}/rewards/equip`)
      .send({ itemId: 'muncher-dog' });
    expect(equip.status).toBe(200);
    expect(equip.body.equippedMuncher).toBe('dog');
    const session = await agent.post(`/api/profiles/${profileId}/session`);
    expect(session.body.muncher).toBe('dog'); // travels with the deck to the board
  });

  it('unlocks and equips with coins, rejecting overspend and unowned equips', async () => {
    const { agent, profileId } = await setup();
    await db.addCoins(profileId, 100);

    const unlock = await agent
      .post(`/api/profiles/${profileId}/rewards/unlock`)
      .send({ itemId: 'avatar-butterfly' }); // cost 40
    expect(unlock.status).toBe(200);
    expect(unlock.body.coins).toBe(60);
    expect(unlock.body.owned).toContain('avatar-butterfly');

    const equip = await agent
      .post(`/api/profiles/${profileId}/rewards/equip`)
      .send({ itemId: 'avatar-butterfly' });
    expect(equip.body.equippedAvatar).toBe('🦋');
    const profiles = await agent.get('/api/profiles');
    const me = (profiles.body.profiles as { id: string; avatar: string }[]).find(
      (p) => p.id === profileId,
    );
    expect(me?.avatar).toBe('🦋');

    // Overspend: alien costs 150, only 60 left.
    const over = await agent
      .post(`/api/profiles/${profileId}/rewards/unlock`)
      .send({ itemId: 'avatar-alien' });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('insufficient_coins');

    // Equip something not owned → 403.
    expect(
      (
        await agent
          .post(`/api/profiles/${profileId}/rewards/equip`)
          .send({ itemId: 'avatar-alien' })
      ).status,
    ).toBe(403);

    // Free items: equip OK, but "unlocking" a free item is rejected.
    expect(
      (
        await agent
          .post(`/api/profiles/${profileId}/rewards/equip`)
          .send({ itemId: 'theme-classic' })
      ).body.equippedTheme,
    ).toBe('classic');
    expect(
      (
        await agent
          .post(`/api/profiles/${profileId}/rewards/unlock`)
          .send({ itemId: 'theme-classic' })
      ).status,
    ).toBe(400);
    expect(
      (await agent.post(`/api/profiles/${profileId}/rewards/unlock`).send({ itemId: 'nope' }))
        .status,
    ).toBe(400);
  });

  it('404s rewards for another account', async () => {
    const { profileId } = await setup();
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ ...CREDS, email: 'r@home.test' });
    expect((await other.get(`/api/profiles/${profileId}/rewards`)).status).toBe(404);
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

  it('two concurrent starts converge on one session (no 500)', async () => {
    const { agent, profileId } = await setup();
    const [a, b] = await Promise.all([
      agent.post(`/api/profiles/${profileId}/session`),
      agent.post(`/api/profiles/${profileId}/session`),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // One creates it, the other resumes it — same session, never a duplicate.
    expect(a.body.sessionId).toBe(b.body.sessionId);
  });

  it('400 when answering a fact that is not in the session', async () => {
    const { agent, profileId } = await setup();
    const { body } = await agent.post(`/api/profiles/${profileId}/session`);
    const res = await agent
      .post(`/api/sessions/${body.sessionId}/answer`)
      .send({ factId: 'mul:99x99', correct: true, responseMs: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('fact_not_in_session');
  });

  it("404 when starting a session on another account's profile", async () => {
    const { profileId } = await setup();
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ ...CREDS, email: 'other@home.test' });
    expect((await other.post(`/api/profiles/${profileId}/session`)).status).toBe(404);
  });

  it('400 on a negative or non-finite responseMs (would skew the fast threshold)', async () => {
    const { agent, profileId } = await setup();
    const { body } = await agent.post(`/api/profiles/${profileId}/session`);
    const { fact } = body.deck[0];
    for (const responseMs of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
      const res = await agent
        .post(`/api/sessions/${body.sessionId}/answer`)
        .send({ factId: fact.id, correct: true, responseMs });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_answer');
    }
  });

  it('clamps an absurdly large responseMs instead of recording it raw', async () => {
    const { agent, profileId } = await setup();
    const { body } = await agent.post(`/api/profiles/${profileId}/session`);
    const { fact } = body.deck[0];
    const res = await agent
      .post(`/api/sessions/${body.sessionId}/answer`)
      .send({ factId: fact.id, correct: true, responseMs: 10 * 60 * 1000 });
    // Accepted (not a 4xx) — the server clamps rather than rejecting a slow-but-
    // plausible answer; a clean clear is still correct, just not fast.
    expect(res.status).toBe(200);
    expect(res.body.correct).toBe(true);
    expect(res.body.fast).toBe(false);
  });

  it('rounds a fractional responseMs (the attempt column is INTEGER)', async () => {
    const { agent, profileId } = await setup();
    const { body } = await agent.post(`/api/profiles/${profileId}/session`);
    const { fact } = body.deck[0];
    // A fractional latency would 500 on Postgres's INTEGER column (after
    // progress already wrote); SQLite accepts it but the export must stay clean.
    const res = await agent
      .post(`/api/sessions/${body.sessionId}/answer`)
      .send({ factId: fact.id, correct: true, responseMs: 1234.7 });
    expect(res.status).toBe(200);
    const csv = await agent.get(`/api/profiles/${profileId}/export?format=csv`);
    expect(csv.text).toContain(',1235,'); // rounded, not 1234.7
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

  it('summarizes attempts into dashboard trends', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const deck = session.deck as Card[];
    // Two correct, one wrong.
    await agent
      .post(`/api/sessions/${session.sessionId}/answer`)
      .send({ factId: deck[0].fact.id, correct: true, responseMs: 1200 });
    await agent
      .post(`/api/sessions/${session.sessionId}/answer`)
      .send({ factId: deck[1].fact.id, correct: true, responseMs: 1300 });
    await agent
      .post(`/api/sessions/${session.sessionId}/answer`)
      .send({ factId: deck[2].fact.id, correct: false, responseMs: 1300 });

    const res = await agent.get(`/api/profiles/${profileId}/dashboard`);
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe('Kid');
    expect(res.body.windowDays).toBe(14);
    expect(res.body.trends).toHaveLength(14);
    expect(res.body.summary.attempts).toBe(3);
    expect(res.body.summary.accuracy).toBeCloseTo(2 / 3);
    expect(res.body.summary.daysActive).toBe(1);
    // Today is the last bucket and holds the activity.
    expect(res.body.trends[13].attempts).toBe(3);
    // Brand-new kid → not ready to advance yet.
    expect(res.body.suggestion).toBeNull();
  });

  it('404s the dashboard for another account', async () => {
    const { profileId } = await setup();
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ ...CREDS, email: 'd@home.test' });
    expect((await other.get(`/api/profiles/${profileId}/dashboard`)).status).toBe(404);
  });

  it('reflects learning progress after a session answer', async () => {
    const { agent, profileId } = await setup();
    const { body: session } = await agent.post(`/api/profiles/${profileId}/session`);
    const card = session.deck[0];
    await agent
      .post(`/api/sessions/${session.sessionId}/answer`)
      .send({ factId: card.fact.id, correct: true, responseMs: 1500 });

    const res = await agent.get(`/api/profiles/${profileId}/progress`);
    const learning = res.body.grids
      .flatMap((g: { cells: { state: string }[] }) => g.cells)
      .filter((c: { state: string }) => c.state === 'learning');
    expect(learning.length).toBe(1);
  });
});

describe('data export', () => {
  it('exports JSON (progress + attempts) and CSV (the attempt log)', async () => {
    const { agent, profileId } = await setup();
    const { body } = await agent.post(`/api/profiles/${profileId}/session`);
    await agent
      .post(`/api/sessions/${body.sessionId}/answer`)
      .send({ factId: body.deck[0].fact.id, correct: true, responseMs: 1200 });

    const json = await agent.get(`/api/profiles/${profileId}/export?format=json`);
    expect(json.status).toBe(200);
    expect(json.headers['content-disposition']).toContain('.json');
    expect(json.body.profile.id).toBe(profileId);
    expect(json.body.attempts.length).toBeGreaterThan(0);
    expect(Array.isArray(json.body.progress)).toBe(true);

    const csv = await agent.get(`/api/profiles/${profileId}/export?format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.split('\r\n');
    expect(lines[0]).toBe('answeredAt,factId,correct,fast,responseMs,wrongMunches');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('404s export for another account', async () => {
    const { profileId } = await setup();
    const other = request.agent(app);
    await other.post('/api/auth/signup').send({ ...CREDS, email: 'x@home.test' });
    expect((await other.get(`/api/profiles/${profileId}/export`)).status).toBe(404);
  });
});
