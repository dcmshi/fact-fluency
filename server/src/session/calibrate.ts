/**
 * Guest calibration orchestration. The pure engine (engine/placement.ts) picks
 * the probe and decides placement; this layer does the IO: enable the chosen
 * grade band's sets, hand the client a tap-answer warm-up, then seed the
 * kid's starting schedule from how they did. See DESIGN.md §4.4.
 */
import type { CalibrationQuestion, Profile } from '@shared';
import { DEFAULT_ENABLED_SET_IDS, gradeBandById, SEED_CATALOG } from '../data/catalog';
import type { Db } from '../db';
import { generateFactsForSets } from '../engine/facts';
import { makeRng, seedFrom } from '../engine/munch';
import {
  buildCalibrationProbe,
  buildChoices,
  placeFromCalibration,
  type CalibrationResult,
} from '../engine/placement';
import { HttpError } from '../httpError';
import { computeThresholds } from './service';

/** Questions in one warm-up — short enough to stay a warm-up, not a test. */
const PROBE_COUNT = 10;
/** Guard the submit against an over-long client payload. */
const MAX_RESULTS = 100;
const MAX_RESPONSE_MS = 60_000;

const factsFor = (setIds: string[]) =>
  generateFactsForSets(SEED_CATALOG.filter((s) => setIds.includes(s.id)));

/**
 * Enable the grade band's sets (unknown/absent band → the starter default) and
 * return a difficulty-spread tap warm-up over the resulting fact universe.
 */
export async function startCalibration(
  db: Db,
  profile: Profile,
  grade: unknown,
  now: number,
): Promise<{ questions: CalibrationQuestion[] }> {
  const band = typeof grade === 'string' ? gradeBandById(grade) : undefined;
  const setIds = band ? band.setIds : DEFAULT_ENABLED_SET_IDS;
  await db.setEnabledSetIds(profile.id, setIds);
  // K/1 bands start equality-only; carry that onto the profile (keep the rest).
  if (band?.comparisons === false && profile.settings.comparisons !== false) {
    await db.updateProfileSettings(profile.id, { ...profile.settings, comparisons: false });
  }

  const facts = factsFor(setIds);
  // Vary the probe per attempt without Math.random (kept out of the engine).
  const rng = makeRng(seedFrom(`${profile.id}:${now}`));
  const questions = buildCalibrationProbe(facts, rng, PROBE_COUNT).map((fact) => ({
    fact,
    choices: buildChoices(fact, rng),
  }));
  return { questions };
}

/**
 * Grade the warm-up (authoritatively, from each fact's real answer — the client
 * isn't trusted) and seed the kid's starting schedule at their fluency edge.
 */
export async function submitCalibration(
  db: Db,
  profile: Profile,
  accountId: string,
  results: unknown,
  now: number,
): Promise<{ seeded: number }> {
  if (!Array.isArray(results)) throw new HttpError(400, 'invalid_results');

  const setIds = await db.listEnabledSetIds(profile.id);
  const facts = factsFor(setIds);
  const answerByFactId = new Map(facts.map((f) => [f.id, f.answer]));

  const graded: CalibrationResult[] = [];
  const seen = new Set<string>();
  for (const r of results.slice(0, MAX_RESULTS)) {
    if (
      typeof r?.factId !== 'string' ||
      typeof r?.given !== 'number' ||
      typeof r?.responseMs !== 'number' ||
      !Number.isFinite(r.responseMs) ||
      r.responseMs < 0 ||
      !answerByFactId.has(r.factId) ||
      // One probe per fact: a repeated id would weight that fact twice in the
      // percentile maths behind every starting box.
      seen.has(r.factId)
    ) {
      continue;
    }
    seen.add(r.factId);
    graded.push({
      factId: r.factId,
      correct: answerByFactId.get(r.factId) === r.given,
      responseMs: Math.round(Math.min(r.responseMs, MAX_RESPONSE_MS)),
    });
  }

  const [thresholds, timezone] = await Promise.all([
    computeThresholds(db, profile.id),
    db.getAccountTimezone(accountId),
  ]);
  const seeds = placeFromCalibration({
    profileId: profile.id,
    facts,
    results: graded,
    thresholds,
    now,
    timeZone: timezone ?? 'UTC',
  });
  await db.upsertProgressMany(seeds);
  return { seeded: seeds.length };
}
