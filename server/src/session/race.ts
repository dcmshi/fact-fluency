/**
 * Race orchestration (MULTIPLAYER.md, Phase 1 — async). The pure engine
 * (engine/race.ts) picks the deck and scores; this layer does the IO: build the
 * munch boards (like the session loop), persist the race + runs, and shape the
 * client DTOs. Deliberately isolated from the scheduler and the attempt log —
 * racing never writes spaced-repetition state; only coins are credited.
 */
import { randomUUID } from 'node:crypto';
import type {
  Card,
  Profile,
  RaceGhost,
  RaceResult,
  RaceRunRequest,
  RaceStanding,
  RaceStartResponse,
  RaceSummary,
} from '@shared';
import { SEED_CATALOG } from '../data/catalog';
import type { Db, RaceRecord } from '../db';
import { HttpError } from '../httpError';
import { generateFactsForSets } from '../engine/facts';
import { makeRng, seedFrom } from '../engine/munch';
import { buildChoices } from '../engine/placement';
import {
  buildBotGhost,
  buildRaceDeck,
  placementCoins,
  RACE_CHOICES,
  RACE_ROUNDS,
  rankRuns,
} from '../engine/race';

const BOT_NAME = 'Robo-racer';
const BOT_AVATAR = '🤖';
/** Clamp a client-reported time before it's stored/ranked (a race is short). */
const MAX_RACE_MS = 10 * 60 * 1000;
/** Floor for a single round. Reading the question, choosing, and tapping is
 *  never quicker than this, so a smaller value is a forged/replayed run — the
 *  same reasoning as MIN_RESPONSE_MS in session/service.ts. */
const MIN_ROUND_MS = 250;
const clampRoundMs = (ms: number) => Math.round(Math.min(Math.max(MIN_ROUND_MS, ms), MAX_RACE_MS));
const clampMs = (ms: number) => Math.round(Math.min(Math.max(0, ms), MAX_RACE_MS));

/** Build the playable deck: one tap-the-answer question per fact, seeded per
 *  (race, fact, index) so it's reproducible and identical for every racer.
 *  Strictly the `=` form — a race is always "solve a op b". */
function buildDeckCards(facts: ReturnType<typeof generateFactsForSets>, raceId: string): Card[] {
  return facts.map((fact, i) => {
    const rng = makeRng(seedFrom(`${raceId}:${fact.id}:${i}`));
    const choices = buildChoices(fact, rng, RACE_CHOICES);
    return { fact, answer: fact.answer, isNew: false, choices };
  });
}

/** The bot opponent for a race — deterministic from the race id, so the same
 *  race always faces the same bot at create, join, and scoring time. */
function botGhostFor(raceId: string, rounds: number): RaceGhost {
  const perRoundMs = buildBotGhost(rounds, makeRng(seedFrom(`bot:${raceId}`)));
  return {
    name: BOT_NAME,
    avatar: BOT_AVATAR,
    perRoundMs,
    totalMs: perRoundMs.reduce((a, b) => a + b, 0),
    isBot: true,
  };
}

async function requireOwnedRace(db: Db, profile: Profile, raceId: string): Promise<RaceRecord> {
  const race = await db.getRace(raceId);
  if (!race || race.accountId !== profile.accountId) throw new HttpError(404, 'race_not_found');
  return race;
}

/** Create a fresh race for this profile — a shuffled deck of the kid's enabled
 *  facts — and hand back the deck plus a bot opponent to chase. */
export async function createRace(
  db: Db,
  profile: Profile,
  now: number,
): Promise<RaceStartResponse> {
  const enabledSetIds = await db.listEnabledSetIds(profile.id);
  const sets = SEED_CATALOG.filter((s) => enabledSetIds.includes(s.id));
  if (sets.length === 0) throw new HttpError(400, 'no_enabled_sets');

  const raceId = randomUUID();
  const facts = buildRaceDeck(generateFactsForSets(sets), makeRng(seedFrom(raceId)), RACE_ROUNDS);
  const deck = buildDeckCards(facts, raceId);
  await db.createRace({
    id: raceId,
    accountId: profile.accountId,
    createdByProfileId: profile.id,
    deck: JSON.stringify(deck),
    factCount: deck.length,
    createdAt: now,
  });
  const [muncher, effect] = await Promise.all([
    db.getEquippedMuncher(profile.id),
    db.getEquippedEffect(profile.id),
  ]);
  return { raceId, deck, ghost: botGhostFor(raceId, deck.length), muncher, effect };
}

/** Join/rematch an existing race: the same deck, with the fastest run by
 *  *another* racer as the ghost (else the bot). */
export async function getRaceForPlay(
  db: Db,
  profile: Profile,
  raceId: string,
): Promise<RaceStartResponse> {
  const race = await requireOwnedRace(db, profile, raceId);
  const deck = JSON.parse(race.deck) as Card[];
  const runs = await db.listRaceRuns(raceId); // fastest-first
  const rival = runs.find((r) => r.profileId !== profile.id);
  let ghost: RaceGhost;
  if (rival) {
    const p = await db.getProfile(rival.profileId);
    ghost = {
      name: p?.displayName ?? 'Racer',
      avatar: p?.avatar ?? '🦊',
      perRoundMs: JSON.parse(rival.perRound) as number[],
      totalMs: rival.totalMs,
      isBot: false,
    };
  } else {
    ghost = botGhostFor(raceId, race.factCount);
  }
  const [muncher, effect] = await Promise.all([
    db.getEquippedMuncher(profile.id),
    db.getEquippedEffect(profile.id),
  ]);
  return { raceId, deck, ghost, muncher, effect };
}

/** Record a finished run, rank it against the field (best run per racer + the
 *  bot), award placement coins over a floor, and return the standings. */
export async function submitRaceRun(
  db: Db,
  profile: Profile,
  raceId: string,
  body: RaceRunRequest,
  now: number,
): Promise<RaceResult> {
  const race = await requireOwnedRace(db, profile, raceId);
  if (
    !Array.isArray(body?.perRoundMs) ||
    // A run has to account for every round of the race it claims to be part of.
    body.perRoundMs.length !== race.factCount ||
    body.perRoundMs.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
    typeof body.totalMs !== 'number' ||
    !Number.isFinite(body.totalMs)
  ) {
    throw new HttpError(400, 'invalid_run');
  }
  const perRoundMs = body.perRoundMs.map(clampRoundMs);
  // Derive the total from the floored splits instead of trusting `totalMs` —
  // the client computes it as exactly this sum, so nothing honest changes, but
  // a forged `{totalMs: 0}` can no longer take first place.
  const totalMs = clampMs(perRoundMs.reduce((a, b) => a + b, 0));
  const correctCount =
    typeof body.correctCount === 'number'
      ? Math.max(0, Math.min(race.factCount, Math.trunc(body.correctCount)))
      : 0;
  // Coins are for setting a new mark, not for pressing submit: without this a
  // loop of identical runs paid out every time.
  const previousBest = (await db.listRaceRuns(raceId))
    .filter((r) => r.profileId === profile.id)
    .reduce<
      number | null
    >((best, r) => (best == null || r.totalMs < best ? r.totalMs : best), null);
  const improved = previousBest == null || totalMs < previousBest;
  await db.addRaceRun({
    id: randomUUID(),
    raceId,
    profileId: profile.id,
    totalMs,
    correctCount,
    perRound: JSON.stringify(perRoundMs),
    finishedAt: now,
  });

  // Field = each racer's *best* run + the bot; rank this profile among them.
  const runs = await db.listRaceRuns(raceId);
  const bestByProfile = new Map<string, number>();
  for (const r of runs) {
    const cur = bestByProfile.get(r.profileId);
    if (cur == null || r.totalMs < cur) bestByProfile.set(r.profileId, r.totalMs);
  }
  const bot = botGhostFor(raceId, race.factCount);
  const ranked = rankRuns([
    ...[...bestByProfile].map(([profileId, ms]) => ({ profileId, totalMs: ms, isBot: false })),
    { profileId: 'bot', totalMs: bot.totalMs, isBot: true },
  ]);

  const mine = ranked.find((r) => !r.isBot && r.profileId === profile.id)!;
  const coinsEarned = improved ? placementCoins(mine.placement, ranked.length) : 0;
  if (coinsEarned > 0) await db.addCoins(profile.id, coinsEarned);

  const profiles = await db.listProfiles(profile.accountId);
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const standings: RaceStanding[] = ranked.map((r) => {
    if (r.isBot) {
      return {
        name: bot.name,
        avatar: bot.avatar,
        totalMs: r.totalMs,
        placement: r.placement,
        isBot: true,
        isYou: false,
      };
    }
    const p = byId.get(r.profileId);
    return {
      name: p?.displayName ?? 'Racer',
      avatar: p?.avatar ?? '🦊',
      totalMs: r.totalMs,
      placement: r.placement,
      isBot: false,
      isYou: r.profileId === profile.id,
    };
  });

  return {
    placement: mine.placement,
    racers: ranked.length,
    coinsEarned,
    standings,
    personalBest: bestByProfile.get(profile.id) === totalMs,
  };
}

/** Recent races under the account, for the lobby (join a sibling's / rematch). */
export async function listRaces(db: Db, profile: Profile, limit = 10): Promise<RaceSummary[]> {
  const races = await db.listRacesForAccount(profile.accountId, limit);
  if (races.length === 0) return [];
  // Three queries total, not two per race: every creator is a profile on this
  // same account, and the runs come back in one batch and are grouped here.
  const [runs, profiles] = await Promise.all([
    db.listRaceRunsForRaces(races.map((r) => r.id)),
    db.listProfiles(profile.accountId),
  ]);
  const byRace = new Map<string, { count: number; mine: boolean }>();
  for (const run of runs) {
    const entry = byRace.get(run.raceId) ?? { count: 0, mine: false };
    entry.count += 1;
    entry.mine ||= run.profileId === profile.id;
    byRace.set(run.raceId, entry);
  }
  const creators = new Map(profiles.map((p) => [p.id, p]));

  return races.map((race) => {
    const stats = byRace.get(race.id);
    const creator = creators.get(race.createdByProfileId);
    return {
      id: race.id,
      createdByName: creator?.displayName ?? 'Racer',
      createdByAvatar: creator?.avatar ?? '🦊',
      factCount: race.factCount,
      createdAt: race.createdAt,
      runCount: stats?.count ?? 0,
      played: stats?.mine ?? false,
    };
  });
}
