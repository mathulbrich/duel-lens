import { describe, expect, it } from 'vitest';
import { getModel } from './models';

describe('getModel', () => {
  // tools/benchmark.ts --apply/--write rewrites every threshold in MODELS, including this
  // one, from its own calibration run - silently overwriting the hand-lowered floor (see
  // the comment by dinov3-small-q4's thresholds, and docs/DEVELOPMENT.md's "Models"
  // section). Pin it here so a benchmark rewrite that forgets to reset the floor back to
  // 0.5 afterwards fails a test instead of shipping.
  it("dinov3-small-q4's floor stays hand-lowered to 0.5, even after a benchmark rewrite", () => {
    expect(getModel('dinov3-small-q4').thresholds.floor).toBe(0.5);
  });

  // The default model's thresholds were calibrated on real footage (tools/eval-real.ts --raw on
  // data/realset, 3 productions, plus the non-card boxes in negatives.json), not by the synthetic
  // benchmark: its 'video' level is saturated for this model and gives a floor that calls real
  // cards "nothing found". Pin them for the same reason as above.
  it("dinov2-small-duel keeps its real-footage thresholds, even after a benchmark rewrite", () => {
    expect(getModel('dinov2-small-duel').thresholds).toEqual({
      score: 0.8,
      margin: 0.02,
      floor: 0.74,
      second: { score: 0.73, margin: 0.1 },
      cardBackMargin: 0.1,
    });
  });
});
