import { describe, expect, it } from 'vitest';
import {
  clamp01,
  fracFromPoint,
  GAP,
  inBumpRange,
  invPlateFrac,
  pickTarget,
  plateFrac,
  pointOnCircle,
  stepRimPos,
} from './feastArena';

describe('clamp01', () => {
  it('clamps to [0,1]', () => {
    expect(clamp01(-0.3)).toBe(0);
    expect(clamp01(1.7)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });
});

describe('plateFrac / invPlateFrac', () => {
  it('maps pos 0→1 into the belt arc, leaving a top gap', () => {
    expect(plateFrac(0)).toBeCloseTo(GAP / 2, 6); // 0.06
    expect(plateFrac(1)).toBeCloseTo(1 - GAP / 2, 6); // 0.94
    expect(plateFrac(0.5)).toBeCloseTo(0.5, 6);
  });
  it('round-trips and clamps', () => {
    expect(invPlateFrac(plateFrac(0.37))).toBeCloseTo(0.37, 6);
    expect(invPlateFrac(0)).toBe(0); // below arc → clamp to 0
    expect(invPlateFrac(1)).toBe(1); // above arc → clamp to 1
  });
});

describe('pointOnCircle / fracFromPoint', () => {
  it('places frac 0 at top and 0.25 at right (clockwise)', () => {
    const top = pointOnCircle(0, 0, 10, 0);
    expect(top.x).toBeCloseTo(0, 6);
    expect(top.y).toBeCloseTo(-10, 6);
    const right = pointOnCircle(0, 0, 10, 0.25);
    expect(right.x).toBeCloseTo(10, 6);
    expect(right.y).toBeCloseTo(0, 6);
  });
  it('inverts pointOnCircle', () => {
    const p = pointOnCircle(5, 5, 8, 0.6);
    expect(fracFromPoint(5, 5, p.x, p.y)).toBeCloseTo(0.6, 6);
  });
});

describe('stepRimPos', () => {
  it('eases toward the target, capped by speed, and snaps when close', () => {
    expect(stepRimPos(0.5, 0.3, 100)).toBeCloseTo(0.5 - 0.16, 6); // 0.0016*100 = 0.16
    expect(stepRimPos(0.5, 0.52, 1000)).toBe(0.52); // within one step → snap
    expect(stepRimPos(0.9, 2, 1000)).toBe(1); // clamped
  });
});

describe('pickTarget', () => {
  const plates = [
    { id: 1, pos: 0.3 },
    { id: 2, pos: 0.5 },
    { id: 3, pos: 0.9 },
  ];
  it('returns the in-reach plate nearest the aim', () => {
    expect(pickTarget(plates, 0.4, 0.31)).toBe(1); // 0.3 & 0.5 in reach; aim closest to 0.3
    expect(pickTarget(plates, 0.5, 0.52)).toBe(2);
  });
  it('returns null when nothing is within reach', () => {
    expect(pickTarget(plates, 0.1, 0.1)).toBeNull();
    expect(pickTarget([], 0.5, 0.5)).toBeNull();
  });
});

describe('inBumpRange', () => {
  it('is true only within BUMP_RANGE', () => {
    expect(inBumpRange(0.5, 0.53)).toBe(true);
    expect(inBumpRange(0.5, 0.7)).toBe(false);
  });
});
