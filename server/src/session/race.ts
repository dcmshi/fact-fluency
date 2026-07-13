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
import { buildBoard, makeRng, pickRelation, seedFrom } from '../engine/munch';
import {
  buildBotGhost,
  buildRaceDeck,
  placementCoins,
  RACE_ROUNDS,
  rankRuns,
} from '../engine/race';

const BOT_NAME = 'Robo-racer';
const BOT_AVATAR = '🤖';
/** Clamp a client-reported time before it's stored/ranked (a race is short). */
const MAX_RACE_MS = 10 * 60 * 1000;
const clampMs = (ms: number) => Math.round(Math.min(Math.max(0, ms), MAX_RACE_MS));

/** Build the playable deck: one munch board per fact, seeded per (race, fact,
 *  index) so it's reproducible and identical for every racer. Mirrors the
 *  session loop; equality-only when the profile has comparisons off. */
function buildDeckCards(
  facts: ReturnType<typeof generateFactsForSets>,
  raceId: string,
  comparisons: boolean | undefined,
): Card[] {
  return facts.map((fact, i) => {
    const rng = makeRng(seedFrom(`${raceId}:${fact.id}:${i}`));
    const relation = comparisons === false ? '=' : pickRelation(fact.answer, rng);
    const board = buildBoard({ target: fact.answer, relation, rng });
    return { fact, answer: fact.answer, isNew: false, board };
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
  const deck = buildDeckCards(facts, raceId, profile.settings.comparisons);
  await db.createRace({
    id: raceId,
    accountId: profile.accountId,
    createdByProfileId: profile.id,
    deck: JSON.stringify(deck),
    factCount: deck.length,
    createdAt: now,
  });
  return { raceId, deck, ghost: botGhostFor(raceId, deck.length) };
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
  return { raceId, deck, ghost };
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
    body.perRoundMs.length === 0 ||
    body.perRoundMs.some((n) => typeof n !== 'number' || !Number.isFinite(n)) ||
    typeof body.totalMs !== 'number' ||
    !Number.isFinite(body.totalMs)
  ) {
    throw new HttpError(400, 'invalid_run');
  }
  const totalMs = clampMs(body.totalMs);
  const correctCount =
    typeof body.correctCount === 'number'
      ? Math.max(0, Math.min(race.factCount, Math.trunc(body.correctCount)))
      : 0;
  await db.addRaceRun({
    id: randomUUID(),
    raceId,
    profileId: profile.id,
    totalMs,
    correctCount,
    perRound: JSON.stringify(body.perRoundMs.map(clampMs)),
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
  const coinsEarned = placementCoins(mine.placement, ranked.length);
  await db.addCoins(profile.id, coinsEarned);

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
  return Promise.all(
    races.map(async (race) => {
      const [runs, creator] = await Promise.all([
        db.listRaceRuns(race.id),
        db.getProfile(race.createdByProfileId),
      ]);
      return {
        id: race.id,
        createdByName: creator?.displayName ?? 'Racer',
        createdByAvatar: creator?.avatar ?? '🦊',
        factCount: race.factCount,
        createdAt: race.createdAt,
        runCount: runs.length,
        played: runs.some((r) => r.profileId === profile.id),
      };
    }),
  );
}
