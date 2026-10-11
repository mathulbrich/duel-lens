// The layout check (accuracy-report.md): which way up a straightened card lies. From a small grid of the card
// (GRID_W×GRID_H cell means; under 1 ms on a 590×860 card), it compares the text box (a light band at the bottom of
// an upright card) with the same band turned 180°. The engine reads a face-up card it calls upside down turned 180°
// first. Calibrated on straightened cards with known orientation that are no gate (accuracy-report.md).
// A frame-colour classifier (a frame-type prior) and a card-layout score (a sleeve guard) were built on the same grid,
// measured, and left out (accuracy-report.md).
import type { RGBAImage } from '../shared/preprocess';

export const GRID_W = 118;
export const GRID_H = 172;

export interface Orientation {
  /**
   * The text box's band at the bottom minus the same band at the top (mean grey level, 0-255): positive when the card
   * is upright, negative when it is upside down.
   */
  orientationEvidence: number;
  /** 'upright' or 'upside-down' when |orientationEvidence| ≥ ORIENTATION_MIN, else null (no call). */
  orientation: 'upright' | 'upside-down' | null;
}

/**
 * Orientation calls need the two bands this far apart (grey levels). On 2,502 calibration cards whose true orientation
 * the embedder settles (the true card's score read upright against turned 180°; tools/diag-accuracy), the sign alone is
 * right on 97.2%; at 30, 79% get a call and 1% of those are wrong (foils, glare, a card cut by the picture's edge). On
 * the gates' straightened cards (measured, not fitted) 70% (realset) and 80% (realset2) get a call, none wrong. A wrong
 * call only changes the order the engine reads the two ways up in, as for every card straightened upside down before.
 */
export const ORIENTATION_MIN = 30;

interface Grid {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

/** `img` as GRID_W×GRID_H cell means (each cell the mean of the pixels it covers; a smaller image is sampled). */
export function layoutGrid(img: RGBAImage): Grid {
  const { width: w, height: h, data } = img;
  const n = GRID_W * GRID_H;
  const out: Grid = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
  for (let gy = 0; gy < GRID_H; gy++) {
    const y0 = Math.floor((gy * h) / GRID_H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / GRID_H));
    for (let gx = 0; gx < GRID_W; gx++) {
      const x0 = Math.floor((gx * w) / GRID_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / GRID_W));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0, i = (y * w + x0) * 4; x < x1; x++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      const k = gy * GRID_W + gx;
      const c = (y1 - y0) * (x1 - x0);
      out.r[k] = r / c;
      out.g[k] = g / c;
      out.b[k] = b / c;
    }
  }
  return out;
}

type Box = readonly [x0: number, x1: number, y0: number, y1: number];
/** Regions as fractions of an upright card (x0, x1, y0, y1). */
const TEXT_BOX: Box = [0.09, 0.91, 0.775, 0.915];

interface RegionStats {
  /** Mean R, G, B. */
  m: [number, number, number];
  /** Mean grey level ((R+G+B)/3), mean chroma (max−min), grey level's standard deviation... */
  L: number;
  C: number;
  sd: number;
  /** ...and the standard deviation of its column means (flat across a text box, not across art). */
  col: number;
}

function stats(grid: Grid, [x0, x1, y0, y1]: Box): RegionStats {
  const c0 = Math.round(x0 * GRID_W);
  const c1 = Math.round(x1 * GRID_W);
  const r0 = Math.round(y0 * GRID_H);
  const r1 = Math.round(y1 * GRID_H);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sc = 0;
  let sl = 0;
  let sl2 = 0;
  const colSum = new Float64Array(c1 - c0);
  for (let y = r0; y < r1; y++) {
    for (let x = c0; x < c1; x++) {
      const k = y * GRID_W + x;
      const r = grid.r[k];
      const g = grid.g[k];
      const b = grid.b[k];
      const l = (r + g + b) / 3;
      sr += r;
      sg += g;
      sb += b;
      sc += Math.max(r, g, b) - Math.min(r, g, b);
      sl += l;
      sl2 += l * l;
      colSum[x - c0] += l;
    }
  }
  const n = (r1 - r0) * (c1 - c0);
  const L = sl / n;
  let cm = 0;
  let cm2 = 0;
  for (const s of colSum) {
    const v = s / (r1 - r0);
    cm += v;
    cm2 += v * v;
  }
  cm /= colSum.length;
  return {
    m: [sr / n, sg / n, sb / n],
    L,
    C: sc / n,
    sd: Math.sqrt(Math.max(0, sl2 / n - L * L)),
    col: Math.sqrt(Math.max(0, cm2 / colSum.length - cm * cm)),
  };
}

const meanL = (grid: Grid, box: Box) => stats(grid, box).L;

/** Which way up `card` lies (what the engine uses): the text box's band against the same band turned 180°. */
export function orientationOf(card: RGBAImage, grid = layoutGrid(card)): Orientation {
  const evidence = meanL(grid, TEXT_BOX) - meanL(grid, [TEXT_BOX[0], TEXT_BOX[1], 1 - TEXT_BOX[3], 1 - TEXT_BOX[2]]);
  return { orientationEvidence: evidence, orientation: Math.abs(evidence) >= ORIENTATION_MIN ? (evidence > 0 ? 'upright' : 'upside-down') : null };
}
