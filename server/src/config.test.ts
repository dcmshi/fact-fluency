import { describe, expect, it } from 'vitest';
import { parseFluencyTuning } from './config';
import { DEFAULT_TUNING } from './engine/threshold';

describe('parseFluencyTuning', () => {
  it('returns the engine defaults for an empty env', () => {
    expect(parseFluencyTuning({})).toEqual(DEFAULT_TUNING);
  });

  it('applies numeric overrides per knob', () => {
    const t = parseFluencyTuning({
      FF_FLUENCY_K: '1.5',
      FF_FLUENCY_FLOOR_MS: '1000',
      FF_FLUENCY_COLD_START: '30',
      FF_CEILING_MUL: '9000',
    });
    expect(t.K).toBe(1.5);
    expect(t.floorMs).toBe(1000);
    expect(t.coldStartSamples).toBe(30);
    expect(t.ceilings.mul).toBe(9000);
    expect(t.ceilings.add).toBe(DEFAULT_TUNING.ceilings.add); // untouched knob
  });

  it('ignores junk values (non-numeric, zero, negative)', () => {
    const t = parseFluencyTuning({
      FF_FLUENCY_K: 'fast',
      FF_FLUENCY_FLOOR_MS: '-5',
      FF_CEILING_DIV: '0',
    });
    expect(t).toEqual(DEFAULT_TUNING);
  });
});
