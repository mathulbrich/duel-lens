// Statistics for tools/benchmark.ts: percentiles and the calibration of a model's decision
// thresholds (src/shared/models.ts `thresholds`, applied by decide() in src/shared/search.ts).

/** Percentile with linear interpolation between ranks (numpy's default); NaN for no values. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

export const median = (values: number[]) => percentile(values, 50);

/** One benchmark query: best card score, best other card score, and whether the best was right. */
export interface ScoredQuery {
  s1: number;
  s2: number;
  correct: boolean;
}

export interface Calibration {
  score: number;
  margin: number;
  floor: number;
  /** False when no thresholds reach the target precision; then nothing is ever confident. */
  achieved: boolean;
  /** Share of confident answers that are right, at the returned thresholds. */
  precision: number;
  /** Share of all queries answered confidently, at the returned thresholds. */
  coverage: number;
}

export interface CalibrationOptions {
  /** Required precision of confident answers. Default 0.97. */
  precision?: number;
  /** The floor is this percentile of the right answers' top scores. Default 2. */
  floorPercentile?: number;
  /** Ignore confident sets smaller than this (too noisy). Default max(10, 1% of queries). */
  minConfident?: number;
  marginStep?: number;
  maxMargin?: number;
}

const floorTo = (x: number, digits: number) => Math.floor(x * 10 ** digits + 1e-9) / 10 ** digits;
const ceilTo = (x: number, digits: number) => Math.ceil(x * 10 ** digits - 1e-9) / 10 ** digits;

export interface ThresholdOutcome {
  confident: number;
  /** Share of confident answers that are right (0 if none). */
  precision: number;
  /** Share of queries answered confidently. */
  coverage: number;
  /** Share of queries below the floor ("no card found"). */
  nothing: number;
}

/** decide()'s rule: nothing = s1 < floor; confident = s1 ≥ floor, s1 ≥ score and s1 − s2 ≥ margin. */
export function evaluateThresholds(
  qs: ScoredQuery[],
  t: { score: number; margin: number; floor: number },
): ThresholdOutcome {
  let confident = 0;
  let right = 0;
  let nothing = 0;
  for (const q of qs) {
    if (!(q.s1 >= t.floor)) nothing++;
    else if (q.s1 >= t.score && q.s1 - q.s2 >= t.margin) {
      confident++;
      if (q.correct) right++;
    }
  }
  const n = qs.length || 1;
  return { confident, precision: confident ? right / confident : 0, coverage: confident / n, nothing: nothing / n };
}

/**
 * floor: the `floorPercentile` percentile of the right answers' top scores.
 * score and margin: the loosest pair (most confident answers) whose confident answers are at
 * least `precision` right. For each margin on a grid, sweep the score down through the sorted
 * top scores and keep the deepest cut that still meets the target; take the margin with the
 * most confident answers (the smallest margin on ties).
 */
export function calibrateThresholds(qs: ScoredQuery[], opts: CalibrationOptions = {}): Calibration {
  const target = opts.precision ?? 0.97;
  const minConfident = opts.minConfident ?? Math.max(10, Math.ceil(qs.length * 0.01));
  const step = opts.marginStep ?? 0.0025;
  const maxMargin = opts.maxMargin ?? 0.3;
  const floor = floorTo(percentile(qs.filter((q) => q.correct).map((q) => q.s1), opts.floorPercentile ?? 2), 3);

  let best: { score: number; margin: number; count: number } | undefined;
  for (let k = 0; k * step <= maxMargin + 1e-9; k++) {
    const margin = Math.round(k * step * 1e4) / 1e4;
    const pass = qs.filter((q) => q.s1 >= floor && q.s1 - q.s2 >= margin).sort((a, b) => b.s1 - a.s1);
    let right = 0;
    let cut = 0;
    for (let i = 1; i <= pass.length; i++) {
      if (pass[i - 1].correct) right++;
      if (i < pass.length && pass[i].s1 === pass[i - 1].s1) continue; // cut only between distinct scores
      if (i >= minConfident && right / i >= target) cut = i;
    }
    if (cut > 0 && (!best || cut > best.count)) best = { score: pass[cut - 1].s1, margin, count: cut };
  }

  if (!best) return { score: 1, margin: 1, floor, achieved: false, precision: 0, coverage: 0 };
  const score = Math.max(floor, ceilTo(best.score, 4));
  const e = evaluateThresholds(qs, { score, margin: best.margin, floor });
  return {
    score,
    margin: best.margin,
    floor,
    achieved: e.confident >= minConfident && e.precision >= target,
    precision: e.precision,
    coverage: e.coverage,
  };
}
