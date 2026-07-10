/**
 * Env-driven tuning at the edge (DESIGN.md §4.5, §11). The engine stays pure:
 * it takes a FluencyTuning as input, and this module builds one from env so a
 * calibration run's suggestions (npm run calibrate -w server) can be applied
 * via config instead of redeploying threshold.ts constants.
 *
 *   FF_FLUENCY_K            multiplier on the rolling median (default 1.3)
 *   FF_FLUENCY_FLOOR_MS     hard floor on the fast cutoff (default 1200)
 *   FF_FLUENCY_COLD_START   correct samples before the warm threshold (20)
 *   FF_CEILING_ADD/_SUB/_MUL/_DIV   per-op cold-start ceilings (ms)
 */
import { DEFAULT_TUNING, type FluencyTuning } from './engine/threshold';

function num(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Pure so it's testable: build the effective tuning from an env map. */
export function parseFluencyTuning(env: Record<string, string | undefined>): FluencyTuning {
  return {
    K: num(env.FF_FLUENCY_K, DEFAULT_TUNING.K),
    floorMs: num(env.FF_FLUENCY_FLOOR_MS, DEFAULT_TUNING.floorMs),
    coldStartSamples: num(env.FF_FLUENCY_COLD_START, DEFAULT_TUNING.coldStartSamples),
    ceilings: {
      add: num(env.FF_CEILING_ADD, DEFAULT_TUNING.ceilings.add),
      sub: num(env.FF_CEILING_SUB, DEFAULT_TUNING.ceilings.sub),
      mul: num(env.FF_CEILING_MUL, DEFAULT_TUNING.ceilings.mul),
      div: num(env.FF_CEILING_DIV, DEFAULT_TUNING.ceilings.div),
    },
  };
}

/** The process-wide effective tuning (env overrides applied once at boot). */
export const FLUENCY_TUNING: FluencyTuning = parseFluencyTuning(process.env);
