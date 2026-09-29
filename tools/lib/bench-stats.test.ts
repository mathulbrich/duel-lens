import { describe, expect, it } from 'vitest';
import { calibrateThresholds, evaluateThresholds, median, percentile, type ScoredQuery } from './bench-stats';

describe('percentile / median', () => {
  it('interpolates linearly between ranks', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20], 25)).toBe(12.5);
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 100)).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('is NaN for no values', () => {
    expect(percentile([], 50)).toBeNaN();
  });
});

const q = (s1: number, s2: number, correct: boolean): ScoredQuery => ({ s1, s2, correct });

describe('calibrateThresholds', () => {
  it('puts the floor at the 2nd percentile of correct top-1 scores', () => {
    const qs = Array.from({ length: 101 }, (_, i) => q(0.4 + i * 0.005, 0.1, true));
    const t = calibrateThresholds(qs);
    expect(t.floor).toBeCloseTo(0.41, 3);
  });

  it('finds the loosest score that keeps confident answers ≥ 97% precise', () => {
    // 100 right answers at 0.60–0.99, 20 wrong ones at 0.30–0.49, and a weak right tail at
    // 0.20–0.28 that keeps the floor low. Admitting the 3 best wrong answers (0.49, 0.48,
    // 0.47) still gives 100/103 ≥ 97%; a 4th would not.
    const right = Array.from({ length: 100 }, (_, i) => q(0.6 + i * 0.0039, 0.2, true));
    const weak = Array.from({ length: 5 }, (_, i) => q(0.2 + i * 0.02, 0.1, true));
    const wrong = Array.from({ length: 20 }, (_, i) => q(0.3 + i * 0.01, 0.2, false));
    const t = calibrateThresholds([...right, ...weak, ...wrong]);
    expect(t.achieved).toBe(true);
    expect(t.floor).toBeLessThan(0.3);
    expect(t.score).toBeCloseTo(0.47, 4);
    expect(t.margin).toBe(0);
    expect(t.precision).toBeCloseTo(100 / 103, 6);
    expect(t.coverage).toBeCloseTo(103 / 125, 6);
  });

  it('uses the margin when wrong answers score high but close to the runner-up', () => {
    // Wrong answers score as high as right ones but only just beat the next card.
    const right = Array.from({ length: 100 }, (_, i) => q(0.7 + i * 0.002, 0.5, true)); // gaps ≥ 0.2
    const wrong = Array.from({ length: 50 }, (_, i) => q(0.7 + i * 0.004, 0.692 + i * 0.004, false)); // gap 0.008
    const t = calibrateThresholds([...right, ...wrong]);
    expect(t.achieved).toBe(true);
    expect(t.margin).toBeGreaterThan(0.008);
    expect(t.margin).toBeLessThanOrEqual(0.2);
    expect(t.precision).toBe(1);
    // Every right answer above the floor (the floor drops the lowest 2%).
    expect(t.coverage).toBeGreaterThan(0.6);
    expect(t.coverage).toBeLessThanOrEqual(100 / 150);
  });

  it('never claims confidence when the precision target cannot be met', () => {
    const qs = Array.from({ length: 100 }, (_, i) => q(0.5 + (i % 10) * 0.01, 0.3, i % 2 === 0));
    const t = calibrateThresholds(qs);
    expect(t.achieved).toBe(false);
    expect(t.score).toBe(1);
    expect(t.coverage).toBe(0);
  });

  it('keeps the score threshold at or above the floor', () => {
    const qs = Array.from({ length: 100 }, (_, i) => q(0.2 + i * 0.006, 0, true));
    const t = calibrateThresholds(qs);
    expect(t.score).toBeGreaterThanOrEqual(t.floor);
  });
});

describe('evaluateThresholds', () => {
  it("applies decide()'s rule and reports precision and coverage", () => {
    const qs = [q(0.9, 0.5, true), q(0.8, 0.79, false), q(0.7, 0.3, false), q(0.2, 0.1, true)];
    expect(evaluateThresholds(qs, { score: 0.6, margin: 0.05, floor: 0.3 })).toEqual({
      confident: 2, precision: 0.5, coverage: 0.5, nothing: 0.25,
    });
  });
});
