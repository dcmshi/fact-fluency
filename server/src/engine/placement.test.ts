import { describe, expect, it } from 'vitest';
import type { Operation } from '@shared';
import { generateFacts } from './facts';
import { makeRng } from './munch';
import {
  buildCalibrationProbe,
  CALIBRATION_EDGE_BOX,
  CALIBRATION_KNOWN_BOX,
  placeFromCalibration,
  type CalibrationResult,
} from './placement';

const ADD_0_5 = generateFacts('add', { aMin: 0, aMax: 5, bMin: 0, bMax: 5 });
const THRESHOLDS: Record<Operation, number> = { add: 3000, sub: 3000, mul: 3000, div: 3000 };

const place = (results: CalibrationResult[], facts = ADD_0_5) =>
  placeFromCalibration({
    profileId: 'p1',
    facts,
    results,
    thresholds: THRESHOLDS,
    now: 1_000_000,
    timeZone: 'UTC',
  });
const boxOf = (seeds: ReturnType<typeof place>, id: string) =>
  seeds.find((s) => s.factId === id)?.box;

describe('buildCalibrationProbe', () => {
  it('returns the whole universe when it is smaller than count', () => {
    const probe = buildCalibrationProbe(ADD_0_5.slice(0, 4), makeRng(1), 10);
    expect(probe).toHaveLength(4);
  });

  it('samples `count` facts spread easy→hard', () => {
    const probe = buildCalibrationProbe(ADD_0_5, makeRng(42), 5);
    expect(probe).toHaveLength(5);
    // Ascending difficulty (operand sum): the spread eases in.
    const sums = probe.map((f) => f.operandA + f.operandB);
    for (let i = 1; i < sums.length; i++) expect(sums[i]).toBeGreaterThanOrEqual(sums[i - 1]);
    // First pick comes from the easy end, last from the hard end.
    expect(sums[0]).toBeLessThan(sums[sums.length - 1]);
  });

  it('is deterministic for a given seed', () => {
    const a = buildCalibrationProbe(ADD_0_5, makeRng(7), 6).map((f) => f.id);
    const b = buildCalibrationProbe(ADD_0_5, makeRng(7), 6).map((f) => f.id);
    expect(a).toEqual(b);
  });
});

describe('placeFromCalibration', () => {
  it('seeds a fast+correct fact and every easier same-op fact as known', () => {
    const seeds = place([{ factId: 'add:2+3', correct: true, responseMs: 900 }]); // sum 5, fast
    expect(boxOf(seeds, 'add:2+3')).toBe(CALIBRATION_KNOWN_BOX);
    expect(boxOf(seeds, 'add:0+0')).toBe(CALIBRATION_KNOWN_BOX); // easier → assumed known
    // Harder than the fluent frontier (sum 5) is left for the normal new-fact flow.
    expect(boxOf(seeds, 'add:3+4')).toBeUndefined(); // sum 7
    expect(boxOf(seeds, 'add:5+5')).toBeUndefined(); // sum 10
  });

  it('places a correct-but-slow fact at the edge, not as known', () => {
    const seeds = place([{ factId: 'add:5+5', correct: true, responseMs: 6000 }]); // slow
    expect(boxOf(seeds, 'add:5+5')).toBe(CALIBRATION_EDGE_BOX);
    // No fast frontier ⇒ nothing else is assumed known.
    expect(boxOf(seeds, 'add:0+0')).toBeUndefined();
  });

  it('an explicit slow answer wins over the easier-than-frontier rule', () => {
    const seeds = place([
      { factId: 'add:5+5', correct: true, responseMs: 800 }, // fast, frontier = 10
      { factId: 'add:1+4', correct: true, responseMs: 7000 }, // slow, sum 5 (below frontier)
    ]);
    expect(boxOf(seeds, 'add:1+4')).toBe(CALIBRATION_EDGE_BOX);
    expect(boxOf(seeds, 'add:0+0')).toBe(CALIBRATION_KNOWN_BOX); // below frontier, not probed slow
  });

  it('leaves a missed fact unseeded even when it is below the frontier', () => {
    const seeds = place([
      { factId: 'add:2+3', correct: true, responseMs: 700 }, // fast, frontier = 5
      { factId: 'add:0+0', correct: false, responseMs: 4000 }, // missed, easiest
    ]);
    expect(boxOf(seeds, 'add:0+0')).toBeUndefined(); // reintroduced as a new fact
    expect(boxOf(seeds, 'add:1+2')).toBe(CALIBRATION_KNOWN_BOX); // still assumed known
  });

  it('keeps frontiers per operation independent', () => {
    const facts = [
      ...generateFacts('add', { aMin: 0, aMax: 5, bMin: 0, bMax: 5 }),
      ...generateFacts('mul', { aMin: 0, aMax: 5, bMin: 0, bMax: 5 }),
    ];
    const seeds = place([{ factId: 'mul:2x3', correct: true, responseMs: 900 }], facts);
    expect(boxOf(seeds, 'mul:1x2')).toBe(CALIBRATION_KNOWN_BOX); // easier mul → known
    // A fast mul fact says nothing about addition.
    expect(seeds.some((s) => s.factId.startsWith('add:'))).toBe(false);
  });

  it('marks clearly-known facts mastered so the planner skips them (jump-start)', () => {
    // box 5 is what keeps known facts out of active review — a lower box lands
    // them in "upcoming", which the planner pulls forward and replays as 0 + 0.
    expect(CALIBRATION_KNOWN_BOX).toBe(5);
    expect(CALIBRATION_EDGE_BOX).toBeLessThan(5);
    const seeds = place([
      { factId: 'add:5+5', correct: true, responseMs: 500 }, // fast → mastered
      { factId: 'add:1+4', correct: true, responseMs: 7000 }, // slow → edge review
    ]);
    expect(boxOf(seeds, 'add:5+5')).toBe(5);
    expect(boxOf(seeds, 'add:0+0')).toBe(5); // easier than the frontier → also mastered
    expect(boxOf(seeds, 'add:1+4')).toBe(CALIBRATION_EDGE_BOX);
  });
});
