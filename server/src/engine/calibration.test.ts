import { describe, expect, it } from 'vitest';
import {
  analyzeCalibration,
  MIN_CALIBRATION_SAMPLES,
  percentile,
  type AttemptLike,
} from './calibration';

describe('percentile', () => {
  it('handles empty, single, and interpolated cases', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([0, 10], 0.5)).toBe(5); // interpolated midpoint
    expect(percentile([0, 100, 200, 300], 0.5)).toBe(150);
  });
});

function attempt(factId: string, correct: boolean, responseMs: number): AttemptLike {
  return { factId, correct, responseMs };
}

describe('analyzeCalibration', () => {
  it('reports no suggestions until an op has enough correct samples', () => {
    const attempts = [attempt('add:1+1', true, 1500), attempt('add:2+2', false, 9000)];
    const report = analyzeCalibration(attempts);
    const add = report.perOperation.find((o) => o.operation === 'add')!;
    expect(add.attempts).toBe(2);
    expect(add.correctSamples).toBe(1);
    expect(add.accuracy).toBe(0.5);
    expect(add.enoughData).toBe(false);
    expect(add.suggestedK).toBeNull();
    expect(add.suggestedCeilingMs).toBeNull();
  });

  it('computes percentiles and suggestions once warm', () => {
    // 40 correct mul attempts at a spread of response times.
    const times = Array.from({ length: 40 }, (_, i) => 800 + i * 100); // 800..4700
    const attempts: AttemptLike[] = times.map((t, i) => attempt(`mul:${i}`, true, t));
    const report = analyzeCalibration(attempts);
    const mul = report.perOperation.find((o) => o.operation === 'mul')!;

    expect(mul.correctSamples).toBe(40);
    expect(mul.enoughData).toBe(true);
    expect(mul.p50).toBeGreaterThan(mul.p25!);
    expect(mul.p90).toBeGreaterThan(mul.p75!);
    // K ≈ p75/p50, clamped to [1.1, 1.6]
    expect(mul.suggestedK).toBeGreaterThanOrEqual(1.1);
    expect(mul.suggestedK).toBeLessThanOrEqual(1.6);
    // suggested ceiling is rounded to the nearest 250ms near p90
    expect(mul.suggestedCeilingMs! % 250).toBe(0);
  });

  it('separates operations by fact-id prefix and ignores wrong answers in speed', () => {
    const attempts = [
      attempt('div:8/2', true, 2000),
      attempt('div:9/3', true, 3000),
      attempt('div:6/2', false, 100), // wrong → excluded from percentiles
      attempt('add:1+1', true, 1000),
    ];
    const report = analyzeCalibration(attempts);
    const div = report.perOperation.find((o) => o.operation === 'div')!;
    expect(div.attempts).toBe(3);
    expect(div.correctSamples).toBe(2);
    expect(div.p50).toBe(2500); // median of [2000, 3000], wrong 100 excluded
    expect(report.perOperation.find((o) => o.operation === 'add')!.correctSamples).toBe(1);
  });

  it('surfaces the current constants for reference', () => {
    const report = analyzeCalibration([]);
    expect(report.currentConstants.coldStartSamples).toBeGreaterThan(0);
    expect(MIN_CALIBRATION_SAMPLES).toBeGreaterThan(0);
  });
});
