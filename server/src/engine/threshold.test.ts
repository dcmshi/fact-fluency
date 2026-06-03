import { describe, expect, it } from 'vitest';
import {
  CEILING_MS,
  COLD_START_SAMPLES,
  FLOOR_MS,
  K,
  ewma,
  fluencyThreshold,
  isFast,
  updateOperationStat,
} from './threshold';

describe('ewma', () => {
  it('moves toward the sample by alpha', () => {
    expect(ewma(1000, 2000, 0.2)).toBeCloseTo(1200);
  });
});

describe('updateOperationStat', () => {
  it('seeds the median with the first correct sample', () => {
    const s = updateOperationStat({ medianMsEwma: 0, correctSamples: 0 }, 3000);
    expect(s.medianMsEwma).toBe(3000);
    expect(s.correctSamples).toBe(1);
  });

  it('blends subsequent samples', () => {
    let s = updateOperationStat({ medianMsEwma: 0, correctSamples: 0 }, 3000);
    s = updateOperationStat(s, 2000);
    expect(s.medianMsEwma).toBeCloseTo(2800); // 3000 + 0.2*(2000-3000)
    expect(s.correctSamples).toBe(2);
  });
});

describe('fluencyThreshold', () => {
  it('returns the lenient ceiling during cold start', () => {
    const stat = { medianMsEwma: 1000, correctSamples: COLD_START_SAMPLES - 1 };
    expect(fluencyThreshold('mul', stat)).toBe(CEILING_MS.mul);
  });

  it('uses K x median once warm', () => {
    const stat = { medianMsEwma: 2000, correctSamples: COLD_START_SAMPLES };
    expect(fluencyThreshold('add', stat)).toBeCloseTo(K * 2000);
  });

  it('clamps to the floor for a very fast kid', () => {
    const stat = { medianMsEwma: 500, correctSamples: COLD_START_SAMPLES };
    expect(fluencyThreshold('add', stat)).toBe(FLOOR_MS);
  });

  it('clamps to the ceiling for a slow kid', () => {
    const stat = { medianMsEwma: 99000, correctSamples: COLD_START_SAMPLES };
    expect(fluencyThreshold('div', stat)).toBe(CEILING_MS.div);
  });
});

describe('isFast', () => {
  it('is fast at or under the threshold', () => {
    expect(isFast(3000, 3000)).toBe(true);
    expect(isFast(3001, 3000)).toBe(false);
  });
});
