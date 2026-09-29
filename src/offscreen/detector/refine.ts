// Refines a detected card's outline against the image, classically (no model):
//   1. the in-plane tilt, from a histogram of gradient orientations inside the box: a card's edges and
//      its frame lines (name bar, art box, text box) are all parallel to its sides, so the orientations
//      pile up at the tilt, modulo 90 degrees, whatever the artwork;
//   2. each side as the strong straight edge nearest where the (tilt-corrected) box puts it, allowing
//      a few degrees of slant per side (keystone under a tilted camera): a small search over the line's
//      offset and slant, scoring the image gradient across it;
//   3. the corners as the sides' intersections.
// The detector's own angle regression is weak on real cards (it mostly snaps to 0/90 degrees; see
// detector-report.md), so the extension should refine the card it straightens (the drag case, the
// clicked card). A few milliseconds per card. Falls back to the detection (or just its tilt) when the
// image doesn't support a better outline.
import type { RGBAImage } from '../../shared/preprocess';
import { alignCorners } from './decode';
import { boxCorners, polygonArea, wrapHalfTurn, type Pt } from './geometry';

export interface BoxLike {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

export interface Refined {
  /** The card's 4 corners, clockwise from the refined box's own top-left. */
  pts: Pt[];
  /** The refined in-plane angle (radians, the box's own convention). */
  angle: number;
  /** 'quad': sides fitted; 'tilt': only the tilt corrected; 'none': the detection as it was. */
  refined: 'quad' | 'tilt' | 'none';
}

export const REFINE = {
  /** The region searched: the box's bounds grown by this share of its size. */
  margin: 0.2,
  /** The tilt is looked for within this of the detection's angle (radians, modulo 90 degrees). */
  maxTiltChange: (30 * Math.PI) / 180,
  /** The histogram's peak must stand this many times above its mean, or the tilt is unknown. */
  minPeakRatio: 1.8,
  /** Each side is searched this far in and out of the tilt box's side (share of the perpendicular size). */
  sideRange: 0.14,
  /** ...and turned up to this much (radians) against it. */
  maxSlant: (10 * Math.PI) / 180,
  /** Preference for the detected position: a Gaussian of this width (share of the perpendicular size). */
  prior: 0.09,
  /** Of the candidate lines scoring at least this share of the best, the outermost is the card's edge. */
  outerShare: 0.75,
};

interface Grad {
  x0: number;
  y0: number;
  w: number;
  h: number;
  gx: Float32Array;
  gy: Float32Array;
}

/** Sobel gradients of the luma over a clipped region. */
function gradients(img: RGBAImage, x0: number, y0: number, x1: number, y1: number): Grad | null {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.width, Math.ceil(x1));
  y1 = Math.min(img.height, Math.ceil(y1));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const raw = new Float32Array(w * h);
  const d = img.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = ((y + y0) * img.width + (x + x0)) * 4;
      raw[y * w + x] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
  // a [1 2 1] binomial blur first: pixel staircases and JPEG blocks otherwise pull the orientations to 0/90
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = (raw[i - (x > 0 ? 1 : 0)] + 2 * raw[i] + raw[i + (x < w - 1 ? 1 : 0)]) / 4;
    }
  let L = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      L[i] = (tmp[i - (y > 0 ? w : 0)] + 2 * tmp[i] + tmp[i + (y < h - 1 ? w : 0)]) / 4;
    }
  // twice (together about a Gaussian of sigma 1)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      tmp[i] = (L[i - (x > 0 ? 1 : 0)] + 2 * L[i] + L[i + (x < w - 1 ? 1 : 0)]) / 4;
    }
  const L2 = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      L2[i] = (tmp[i - (y > 0 ? w : 0)] + 2 * tmp[i] + tmp[i + (y < h - 1 ? w : 0)]) / 4;
    }
  L = L2;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = L[i - w - 1];
      const b = L[i - w];
      const c = L[i - w + 1];
      const e = L[i - 1];
      const f = L[i + 1];
      const g = L[i + w - 1];
      const hh = L[i + w];
      const k = L[i + w + 1];
      gx[i] = c + 2 * f + k - (a + 2 * e + g);
      gy[i] = g + 2 * hh + k - (a + 2 * b + c);
    }
  return { x0, y0, w, h, gx, gy };
}

function regionOf(box: BoxLike, margin: number) {
  const pts = boxCorners(box.cx, box.cy, box.w, box.h, box.angle);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const mx = margin * Math.max(box.w, box.h);
  return [Math.min(...xs) - mx, Math.min(...ys) - mx, Math.max(...xs) + mx, Math.max(...ys) + mx] as const;
}

/** An angle modulo 90 degrees, in [−45°, 45°). */
const wrapQuarter = (a: number) => {
  const q = Math.PI / 2;
  return ((((a + q / 2) % q) + q) % q) - q / 2;
};

/**
 * The card's in-plane tilt (radians, in the box's convention, within `maxTiltChange` of box.angle modulo
 * 90 degrees), or null when the gradients inside the box show no clear direction.
 */
export function estimateTilt(img: RGBAImage, box: BoxLike, opts = REFINE): number | null {
  const [rx0, ry0, rx1, ry1] = regionOf(box, 0.05);
  const G = gradients(img, rx0, ry0, rx1, ry1);
  if (!G) return null;
  const bins = 180; // half-degree bins over 90 degrees
  const hist = new Float64Array(bins);
  const q = Math.PI / 2;
  for (let i = 0; i < G.gx.length; i++) {
    const gx = G.gx[i];
    const gy = G.gy[i];
    const m = Math.hypot(gx, gy);
    if (m < 40) continue; // weak gradients: noise, JPEG blocks
    let a = Math.atan2(gy, gx) % q;
    if (a < 0) a += q;
    hist[Math.min(bins - 1, Math.floor((a / q) * bins))] += m;
  }
  // circular smoothing (about 2 degrees)
  const sm = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    let s = 0;
    for (let k = -3; k <= 3; k++) s += hist[(b + k + bins) % bins] * (4 - Math.abs(k));
    sm[b] = s;
  }
  const mean = sm.reduce((a, b) => a + b, 0) / bins;
  if (!(mean > 0)) return null;
  // the best bin within maxTiltChange of the detection's angle (modulo 90)
  const center = wrapQuarter(box.angle);
  let best = -1;
  let bestV = -Infinity;
  for (let b = 0; b < bins; b++) {
    const a = ((b + 0.5) / bins) * q;
    if (Math.abs(wrapQuarter(a - center)) > opts.maxTiltChange) continue;
    if (sm[b] > bestV) [best, bestV] = [b, sm[b]];
  }
  if (best < 0 || bestV < opts.minPeakRatio * mean) return null;
  // refine: the circular mean of the orientations near the peak (period 90 degrees, so over 4*phi),
  // weighted by squared magnitude - more precise than the histogram's bin, and less pulled to the grid
  const seed = ((best + 0.5) / bins) * q;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < G.gx.length; i++) {
    const gx = G.gx[i];
    const gy = G.gy[i];
    const m2 = gx * gx + gy * gy;
    if (m2 < 1600) continue;
    const a = Math.atan2(gy, gx);
    if (Math.abs(wrapQuarter(a - seed)) > (6 * Math.PI) / 180) continue;
    sx += m2 * Math.cos(4 * a);
    sy += m2 * Math.sin(4 * a);
  }
  const peak = sx === 0 && sy === 0 ? seed : Math.atan2(sy, sx) / 4;
  return box.angle + wrapQuarter(peak - box.angle);
}

/** Bilinear sample of a gradient component at image point (x, y); 0 outside the region. */
function sample(G: Grad, arr: Float32Array, x: number, y: number): number {
  const fx = x - G.x0 - 0.5;
  const fy = y - G.y0 - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix >= G.w - 1 || iy >= G.h - 1) return 0;
  const tx = fx - ix;
  const ty = fy - iy;
  const i = iy * G.w + ix;
  return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - ty) + (arr[i + G.w] * (1 - tx) + arr[i + G.w + 1] * tx) * ty;
}

interface Line {
  p: Pt;
  u: Pt;
}

function intersect(a: Line, b: Line): Pt | null {
  const den = a.u[0] * b.u[1] - a.u[1] * b.u[0];
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.p[0] - a.p[0]) * b.u[1] - (b.p[1] - a.p[1]) * b.u[0]) / den;
  return [a.p[0] + t * a.u[0], a.p[1] + t * a.u[1]];
}

function isConvex(q: Pt[]): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const [ax, ay] = q[k];
    const [bx, by] = q[(k + 1) % 4];
    const [cx, cy] = q[(k + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (z === 0) return false;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

/** The detected card's outline fitted to the image (see the file header). */
export function refineCard(img: RGBAImage, det: BoxLike & { pts: Pt[] }, opts = REFINE): Refined {
  const none: Refined = { pts: det.pts, angle: det.angle, refined: 'none' };
  const tilt = estimateTilt(img, det, opts);
  if (tilt === null) return none;
  const B = boxCorners(det.cx, det.cy, det.w, det.h, tilt);
  const tilted: Refined = { pts: B, angle: tilt, refined: 'tilt' };
  const [rx0, ry0, rx1, ry1] = regionOf({ ...det, angle: tilt }, opts.margin);
  const G = gradients(img, rx0, ry0, rx1, ry1);
  if (!G) return tilted;
  const lines: Line[] = [];
  for (let k = 0; k < 4; k++) {
    const a = B[k];
    const b = B[(k + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u: Pt = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const n: Pt = [u[1], -u[0]]; // outward for a clockwise (on screen) quad
    const perp = k % 2 === 0 ? det.h : det.w;
    const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const range = opts.sideRange * perp;
    const step = Math.max(0.5, range / 30);
    const slants = 11;
    const samples = 28;
    const cands: { t: number; score: number; line: Line }[] = [];
    for (let t = -range; t <= range + 1e-9; t += step) {
      let best: { score: number; line: Line } | null = null;
      for (let si = 0; si < slants; si++) {
        const d = -opts.maxSlant + (2 * opts.maxSlant * si) / (slants - 1);
        const c = Math.cos(d);
        const s = Math.sin(d);
        const ud: Pt = [u[0] * c - u[1] * s, u[0] * s + u[1] * c];
        const nd: Pt = [ud[1], -ud[0]];
        const p: Pt = [mid[0] + t * n[0], mid[1] + t * n[1]];
        let acc = 0;
        for (let j = 0; j < samples; j++) {
          const sPos = (-0.36 + (0.72 * j) / (samples - 1)) * len;
          const x = p[0] + sPos * ud[0];
          const y = p[1] + sPos * ud[1];
          acc += Math.abs(sample(G, G.gx, x, y) * nd[0] + sample(G, G.gy, x, y) * nd[1]);
        }
        const score = (acc / samples) * Math.exp(-0.5 * (t / (opts.prior * perp)) ** 2);
        if (!best || score > best.score) best = { score, line: { p, u: ud } };
      }
      cands.push({ t, score: best!.score, line: best!.line });
    }
    const top = Math.max(...cands.map((c) => c.score));
    if (!(top > 20)) return tilted; // no edge along this side
    // local maxima at or above outerShare of the best: the outermost is the card's (or sleeve's) edge
    const peaks = cands.filter((c, i) => c.score >= opts.outerShare * top && (i === 0 || c.score >= cands[i - 1].score) && (i === cands.length - 1 || c.score >= cands[i + 1].score));
    const pick = peaks.reduce((a, c) => (c.t > a.t ? c : a), peaks[0] ?? cands.reduce((a, c) => (c.score > a.score ? c : a)));
    lines.push(pick.line);
  }
  const quad: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    // corner k joins side k-1 (entering it) and side k (leaving it)
    const pnt = intersect(lines[(k + 3) % 4], lines[k]);
    if (!pnt) return tilted;
    quad.push(pnt);
  }
  const area = polygonArea(quad);
  const boxArea = det.w * det.h;
  const maxShift = 0.25 * Math.max(det.w, det.h);
  if (!isConvex(quad) || area < 0.6 * boxArea || area > 1.6 * boxArea || quad.some((p, k) => Math.hypot(p[0] - B[k][0], p[1] - B[k][1]) > maxShift)) {
    return tilted;
  }
  return { pts: alignCorners(quad, boxCorners(det.cx, det.cy, det.w, det.h, wrapHalfTurn(tilt))), angle: wrapHalfTurn(tilt), refined: 'quad' };
}
