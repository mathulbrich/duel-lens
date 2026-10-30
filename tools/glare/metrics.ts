// Glare metrics on a straightened card (the engine's CARD_W×CARD_H corners view, upright or upside down), and the
// glare score, for the glare harvest (tools/glare/harvest.ts).
//
// Two kinds of evidence:
//   - the card alone (glareMetrics), on the layout check's cell-mean grid (src/offscreen/layout-check.ts layoutGrid,
//     118×172 cells, which also smooths the video's compression noise): the black level (p02 grey), contrast, chroma,
//     and bright unsaturated blobs on the artwork's core (the part of the art box that is art whichever way up the
//     card lies: ART_BOX y 0.181-0.706 upright, 0.294-0.819 upside down). Glare LIFTS THE BLACKS: the darkest cells
//     of a washed-out card are grey (data/debug/glare/64049762-blitzclique-breakaway.png: p02 174);
//   - the card against its own artwork (coarseMetrics; data/artworks/<imageId>.jpg, the image the index is built
//     from, for the engine's first card with its thresholds off): the artwork's DARK cells (ink, shadows) observed
//     bright and unsaturated. Blur can't do that; a reflection or a wash does. Pastel and white artwork, which the
//     card-alone measures take for glare, has no dark cells to lift.
// Broadcasts differ a lot (one camera's ordinary card has p02 45, another's 95), so glareScore() compares each card
// with its video's typical card (VideoStats: medians over every face-up card read in the video).
// Calibrated on ordinary and glare cards of real frames (harvest.ts --local: data/debug/frames and data/realset2/frames,
// read only): see SCORE.
import { layoutGrid, GRID_H, GRID_W } from '../../src/offscreen/layout-check';
import { ART_BOX } from '../../src/shared/card-layout';
import { rotate180, type RGBAImage } from '../../src/shared/preprocess';

type Box = readonly [x0: number, x1: number, y0: number, y1: number];

/** The card inside its outline, leaving the outline's own error (a few % of mat or sleeve edge) out. */
export const CARD_INSET: Box = [0.05, 0.95, 0.04, 0.96];
/** The artwork's core, art whichever way up the card lies (see the header). */
export const ART_CORE: Box = [0.14, 0.86, 0.3, 0.7];

/** A cell is "glare" when it is this bright (max channel, 0-255)... */
export const GLARE_V = 185;
/** ...and this unsaturated (chroma / max channel). */
export const GLARE_S = 0.22;

export interface RegionMetrics {
  /** Grey-level percentiles ((R+G+B)/3 per cell). */
  p02: number;
  p10: number;
  p50: number;
  p90: number;
  p98: number;
  /** p98 - p02. */
  range: number;
  /** Mean chroma (max - min channel) and mean saturation (chroma / max). */
  chroma: number;
  sat: number;
  /** Share of cells that are glare (GLARE_V, GLARE_S). */
  glareFrac: number;
  /** Share of cells brighter than 220 (any saturation): blown highlights. */
  blownFrac: number;
  /** Mean R, G, B minus the mean grey level: the colour cast. */
  cast: [number, number, number];
}

export interface GlareMetrics {
  card: RegionMetrics;
  art: RegionMetrics;
  /** The biggest 4-connected blob of glare cells in the art core, as a share of the core. */
  artBlob: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

interface Grid {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

function cellsOf([x0, x1, y0, y1]: Box): { c0: number; c1: number; r0: number; r1: number } {
  return { c0: Math.round(x0 * GRID_W), c1: Math.round(x1 * GRID_W), r0: Math.round(y0 * GRID_H), r1: Math.round(y1 * GRID_H) };
}

const isGlare = (r: number, g: number, b: number) => {
  const v = Math.max(r, g, b);
  return v >= GLARE_V && (v - Math.min(r, g, b)) / Math.max(1, v) <= GLARE_S;
};

function region(grid: Grid, box: Box): RegionMetrics {
  const { c0, c1, r0, r1 } = cellsOf(box);
  const n = (c1 - c0) * (r1 - r0);
  const L = new Float32Array(n);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sc = 0;
  let ss = 0;
  let glare = 0;
  let blown = 0;
  let k = 0;
  for (let y = r0; y < r1; y++) {
    for (let x = c0; x < c1; x++) {
      const i = y * GRID_W + x;
      const r = grid.r[i];
      const g = grid.g[i];
      const b = grid.b[i];
      const v = Math.max(r, g, b);
      const c = v - Math.min(r, g, b);
      sr += r;
      sg += g;
      sb += b;
      sc += c;
      ss += c / Math.max(1, v);
      if (isGlare(r, g, b)) glare++;
      if ((r + g + b) / 3 > 220) blown++;
      L[k++] = (r + g + b) / 3;
    }
  }
  L.sort();
  const mL = (sr + sg + sb) / (3 * n);
  return {
    p02: r2(percentile(L, 0.02)),
    p10: r2(percentile(L, 0.1)),
    p50: r2(percentile(L, 0.5)),
    p90: r2(percentile(L, 0.9)),
    p98: r2(percentile(L, 0.98)),
    range: r2(percentile(L, 0.98) - percentile(L, 0.02)),
    chroma: r2(sc / n),
    sat: r3(ss / n),
    glareFrac: r3(glare / n),
    blownFrac: r3(blown / n),
    cast: [r2(sr / n - mL), r2(sg / n - mL), r2(sb / n - mL)],
  };
}

/** The biggest 4-connected blob of glare cells inside `box`, as a share of the box's cells. */
function biggestBlob(grid: Grid, box: Box): number {
  const { c0, c1, r0, r1 } = cellsOf(box);
  const w = c1 - c0;
  const h = r1 - r0;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y + r0) * GRID_W + (x + c0);
    mask[y * w + x] = isGlare(grid.r[i], grid.g[i], grid.b[i]) ? 1 : 0;
  }
  let best = 0;
  const stack: number[] = [];
  for (let s = 0; s < mask.length; s++) {
    if (mask[s] !== 1) continue;
    mask[s] = 2;
    stack.push(s);
    let size = 0;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && mask[q] === 1) {
          mask[q] = 2;
          stack.push(q);
        }
      }
    }
    best = Math.max(best, size);
  }
  return r3(best / (w * h));
}

export function glareMetrics(card: RGBAImage): GlareMetrics {
  const grid = layoutGrid(card);
  return { card: region(grid, CARD_INSET), art: region(grid, ART_CORE), artBlob: biggestBlob(grid, ART_CORE) };
}

// ---------- coarse comparison: what blur and a slightly-off outline can't explain ----------
//
// At broadcast size the artwork is 30-80 px across: a fine grid against the sharp reference mostly measures blur.
// Here both sides are 12×12 cells, the reference blurred one cell, and the cue is the artwork's DARK cells (ink,
// shadows: reference grey < DARK_REF) showing up bright and washed out: blur can't make a dark region bright.

export const COARSE = 12;
export const DARK_REF = 80;

export interface CoarseMetrics {
  turn: 0 | 180;
  r: number;
  /** Reference cells darker than DARK_REF (of COARSE²)... */
  darkN: number;
  /** ...their mean observed grey level, and the share of them observed bright (>= 150) and unsaturated (<= 0.35). */
  darkLift: number;
  darkBright: number;
  /** Observed grey level over the reference's brightest 20% of cells (the camera's white). */
  white: number;
}

interface CellGrid {
  L: Float32Array;
  sat: Float32Array;
}

function pearson(x: Float32Array, y: Float32Array): number {
  const n = x.length;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let cxy = 0;
  let cxx = 0;
  let cyy = 0;
  for (let i = 0; i < n; i++) {
    cxy += (x[i] - mx) * (y[i] - my);
    cxx += (x[i] - mx) ** 2;
    cyy += (y[i] - my) ** 2;
  }
  return cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : 0;
}

function blur3(L: Float32Array, n: number): Float32Array {
  const k = [0.25, 0.5, 0.25];
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0;
    let w = 0;
    for (let d = -1; d <= 1; d++) if (x + d >= 0 && x + d < n) (s += k[d + 1] * L[y * n + x + d]), (w += k[d + 1]);
    tmp[y * n + x] = s / w;
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0;
    let w = 0;
    for (let d = -1; d <= 1; d++) if (y + d >= 0 && y + d < n) (s += k[d + 1] * tmp[(y + d) * n + x]), (w += k[d + 1]);
    out[y * n + x] = s / w;
  }
  return out;
}

function gridN(img: RGBAImage, box: { x: number; y: number; w: number; h: number }, n: number): CellGrid {
  const L = new Float32Array(n * n);
  const sat = new Float32Array(n * n);
  const X0 = box.x * img.width;
  const Y0 = box.y * img.height;
  const cw = (box.w * img.width) / n;
  const ch = (box.h * img.height) / n;
  for (let gy = 0; gy < n; gy++) {
    const y0 = Math.max(0, Math.floor(Y0 + gy * ch));
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor(Y0 + (gy + 1) * ch)));
    for (let gx = 0; gx < n; gx++) {
      const x0 = Math.max(0, Math.floor(X0 + gx * cw));
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor(X0 + (gx + 1) * cw)));
      let r = 0;
      let g = 0;
      let b = 0;
      let c = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, i = (y * img.width + x0) * 4; x < x1; x++, i += 4) {
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        c++;
      }
      c = Math.max(1, c);
      const v = Math.max(r, g, b) / c;
      L[gy * n + gx] = (r + g + b) / (3 * c);
      sat[gy * n + gx] = (v - Math.min(r, g, b) / c) / Math.max(1, v);
    }
  }
  return { L, sat };
}

function coarseFor(obs: CellGrid, refL: Float32Array): Omit<CoarseMetrics, 'turn'> {
  const n = refL.length;
  let darkN = 0;
  let lift = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    if (refL[i] >= DARK_REF) continue;
    darkN++;
    lift += obs.L[i];
    if (obs.L[i] >= 150 && obs.sat[i] <= 0.35) bright++;
  }
  const order = Array.from(refL.keys()).sort((p, q) => refL[q] - refL[p]);
  const top = order.slice(0, Math.max(1, Math.round(n * 0.2)));
  const white = top.reduce((s, i) => s + obs.L[i], 0) / top.length;
  return { r: r3(pearson(obs.L, refL)), darkN, darkLift: r2(darkN ? lift / darkN : 0), darkBright: r3(darkN ? bright / darkN : 0), white: r2(white) };
}

export function coarseMetrics(card: RGBAImage, artwork: RGBAImage): CoarseMetrics {
  const refL = blur3(gridN(artwork, { x: 0, y: 0, w: 1, h: 1 }, COARSE).L, COARSE);
  const up = coarseFor(gridN(card, ART_BOX, COARSE), refL);
  const down = coarseFor(gridN(rotate180(card), ART_BOX, COARSE), refL);
  return up.r >= down.r ? { turn: 0, ...up } : { turn: 180, ...down };
}

// ---------- the glare score ----------

/** A video's typical face-up card (medians over every one read in it). */
export interface VideoStats {
  cards: number;
  /** Median card black level (GlareMetrics.card.p02). */
  black: number;
  /** Median darkLift over cards whose artwork has at least SCORE.dark.minDark dark cells (DEFAULT_DARK_LIFT with too few). */
  darkLift: number;
}

export const DEFAULT_DARK_LIFT = 70;

/**
 * Each ramp runs from `lo` (ordinary cards) to `hi` (plainly glare). Calibrated on real frames (harvest.ts --local):
 * on 743 face-up cards of data/realset2/frames (4 held-out videos, read only) the score keeps 39 at >= 0.5, about 30 of
 * them plainly glare or washed out and most others mild; 28 of 31 cards picked out by eye as glare.
 */
export const SCORE = {
  /** wash: the card's black level above its video's typical card (lift), and grey at least (absolute p02). */
  wash: { lift: [35, 65], abs: [80, 100] },
  /**
   * dark: the artwork's dark cells observed bright, above the video's typical darkLift (lift) and absolutely (abs),
   * corroborated by some black-level lift (a wrong first card can't fake that: booster packs and box art on the desk
   * read as cards matched to a wrong artwork). Needs the artwork to correlate a little (minR) and minDark dark cells.
   */
  dark: { lift: [25, 55], abs: [100, 120], black: [20, 35], minDark: 4, minR: 0.15 },
  /** patch: share of the artwork's dark cells observed bright and unsaturated (a reflection over part of the art). */
  patch: { share: [0.15, 0.4], minDark: 8, minR: 0.15 },
} as const;

export interface GlareScore {
  /** Each part 0..1, and the score, their max. */
  wash: number;
  dark: number;
  patch: number;
  score: number;
  /** The card's black level and darkLift above its video's typical card. */
  blackLift: number;
  darkLiftAbove: number | null;
}

const ramp = (v: number, [lo, hi]: readonly [number, number]) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

export function glareScore(m: GlareMetrics, coarse: CoarseMetrics | null, video: VideoStats): GlareScore {
  const blackLift = m.card.p02 - video.black;
  const wash = ramp(blackLift, SCORE.wash.lift) * ramp(m.card.p02, SCORE.wash.abs);
  let dark = 0;
  let patch = 0;
  let darkLiftAbove: number | null = null;
  if (coarse && coarse.r >= SCORE.dark.minR && coarse.darkN >= SCORE.dark.minDark) {
    darkLiftAbove = coarse.darkLift - video.darkLift;
    dark = ramp(darkLiftAbove, SCORE.dark.lift) * ramp(coarse.darkLift, SCORE.dark.abs) * ramp(blackLift, SCORE.dark.black);
  }
  if (coarse && coarse.r >= SCORE.patch.minR && coarse.darkN >= SCORE.patch.minDark) patch = ramp(coarse.darkBright, SCORE.patch.share);
  return {
    wash: r3(wash),
    dark: r3(dark),
    patch: r3(patch),
    score: r3(Math.max(wash, dark, patch)),
    blackLift: Math.round(blackLift),
    darkLiftAbove: darkLiftAbove === null ? null : Math.round(darkLiftAbove),
  };
}

/** The video's typical card, from every face-up card read in it. */
export function videoStats(cards: readonly { metrics: GlareMetrics; coarse: CoarseMetrics | null }[]): VideoStats {
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const lifts = cards.filter((c) => c.coarse && c.coarse.darkN >= SCORE.dark.minDark).map((c) => c.coarse!.darkLift);
  return { cards: cards.length, black: r2(med(cards.map((c) => c.metrics.card.p02))), darkLift: r2(lifts.length >= 5 ? med(lifts) : DEFAULT_DARK_LIFT) };
}

/**
 * Worth saving for the video's final scoring (its VideoStats are known only once the video is done): anything that
 * could score above SCORE's lower ends in a video whose typical card is dark.
 */
export function looseCandidate(m: GlareMetrics, coarse: CoarseMetrics | null): boolean {
  if (m.card.p02 >= SCORE.wash.abs[0]) return true;
  if (coarse && coarse.darkN >= SCORE.dark.minDark && coarse.darkLift >= SCORE.dark.abs[0]) return true;
  return !!coarse && coarse.darkN >= SCORE.patch.minDark && coarse.darkBright >= SCORE.patch.share[0];
}
