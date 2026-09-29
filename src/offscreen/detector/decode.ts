// Turns the detector's output maps into cards: an oriented box and the card's 4 corners (a keystone
// quad when the camera isn't overhead). tools/train-detector/targets.py's decode(), which the training
// evaluation uses, does the same.
//
// A detection is a heatmap cell that equals its 3×3 max-pool (the graph's `peak` output) and scores at
// least `minScore`. Its box is read from the same cell: centre = (cell + 0.5 + offset) × stride,
// size = exp(log size) × stride (w, h along the card's own width and height edges), angle =
// atan2(sin 2θ, cos 2θ) / 2 taken in the box frame's range (−45°, 135°]. A 14-channel model adds 8
// corner residuals: corner k = centre + R(θ)·((rect_k + residual_k) ⊙ (w/2, h/2)), rect = the
// rectangle's corners (−1,−1), (1,−1), (1,1), (−1,1) in the box frame. A 6-channel model's corners are
// the box's. The reported box is then made portrait (w ≤ h, angle in (−π/2, π/2]) and the corners are
// cycled to start at the one nearest its own top-left (DetectedCardBox's convention). Peaks of both
// classes go through one greedy NMS on the boxes' polygon IoU, so a card seen as both face-up and
// face-down keeps its stronger reading.
import type { CardKind } from './spec';
import { boxCorners, polygonIoU, wrapHalfTurn, type Pt } from './geometry';

/** One card the detector found, in pixels of the image it ran on. */
export interface CardBox {
  /** The oriented box: centre, portrait size (w ≤ h) and angle (radians, clockwise on screen, in (−π/2, π/2]). */
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  /** The winning class's heatmap score, 0–1. */
  conf: number;
  kind: CardKind;
  /** Both classes' scores at the winning cell. */
  scores: Record<CardKind, number>;
  /** The card's 4 corners, clockwise, starting nearest the box's own top-left (a keystone quad under perspective). */
  pts: Pt[];
  /** The oriented box's own corners (for NMS and for drawing a clean rectangle). */
  box: Pt[];
}

export interface OutputMaps {
  /** [K, gh, gw] probabilities. */
  heat: ArrayLike<number>;
  /** [C, gh, gw]: dx, dy, log w, log h, sin 2θ, cos 2θ, then (C = 14) 8 corner residuals. */
  box: ArrayLike<number>;
  /** Box channels: 6 (rotated box only) or 14 (with corners). */
  boxChannels?: number;
  /** [K, gh, gw]: 3×3 max-pool of heat; null computes it here. */
  peak: ArrayLike<number> | null;
  classes: readonly CardKind[];
  gh: number;
  gw: number;
}

export interface DecodeOptions {
  stride: number;
  minScore: number;
  nmsIoU: number;
  maxDetections: number;
}

/** The rectangle's corners in its box frame, in (w/2, h/2) units: TL, TR, BR, BL. */
const RECT: Pt[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

function maxPool3(heat: ArrayLike<number>, k: number, gh: number, gw: number): Float32Array {
  const out = new Float32Array(k * gh * gw);
  for (let c = 0; c < k; c++) {
    const base = c * gh * gw;
    for (let i = 0; i < gh; i++) {
      for (let j = 0; j < gw; j++) {
        let m = -Infinity;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= gh) continue;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= gw) continue;
            const v = heat[base + ii * gw + jj];
            if (v > m) m = v;
          }
        }
        out[base + i * gw + j] = m;
      }
    }
  }
  return out;
}

/** `quad` cycled (clockwise order kept) so its first corner is the one nearest `box`'s first. */
export function alignCorners(quad: Pt[], box: Pt[]): Pt[] {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s < 4; s++) {
    let d = 0;
    for (let k = 0; k < 4; k++) {
      const [x, y] = quad[(k + s) % 4];
      d += Math.hypot(x - box[k][0], y - box[k][1]);
    }
    if (d < bestD) [best, bestD] = [s, d];
  }
  return [0, 1, 2, 3].map((k) => quad[(k + best) % 4]);
}

/** Every card in the output maps, strongest first, in the model input's pixels. */
export function decodeCards(maps: OutputMaps, opts: DecodeOptions): CardBox[] {
  const { heat, box, classes, gh, gw } = maps;
  const K = classes.length;
  const plane = gh * gw;
  const channels = maps.boxChannels ?? Math.round(box.length / plane);
  const peak = maps.peak ?? maxPool3(heat, K, gh, gw);
  const found: { k: number; cell: number; score: number }[] = [];
  for (let k = 0; k < K; k++) {
    const base = k * plane;
    for (let cell = 0; cell < plane; cell++) {
      const v = heat[base + cell];
      if (v >= opts.minScore && v >= peak[base + cell]) found.push({ k, cell, score: v });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const kept: CardBox[] = [];
  for (const f of found) {
    if (kept.length >= opts.maxDetections) break;
    const i = Math.floor(f.cell / gw);
    const j = f.cell - i * gw;
    const at = (ch: number) => box[ch * plane + f.cell];
    const cx = (j + 0.5 + at(0)) * opts.stride;
    const cy = (i + 0.5 + at(1)) * opts.stride;
    let w = Math.exp(Math.min(8, at(2))) * opts.stride;
    let h = Math.exp(Math.min(8, at(3))) * opts.stride;
    let angle = 0.5 * Math.atan2(at(4), at(5));
    if (angle <= -Math.PI / 4) angle += Math.PI; // the box frame's range, (−45°, 135°]
    let corners: Pt[];
    if (channels >= 14) {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      corners = RECT.map(([u, v], k) => {
        const lx = (u + at(6 + 2 * k)) * (w / 2);
        const ly = (v + at(7 + 2 * k)) * (h / 2);
        return [cx + lx * c - ly * s, cy + lx * s + ly * c] as Pt;
      });
    } else {
      corners = boxCorners(cx, cy, w, h, angle);
    }
    if (w > h) {
      [w, h] = [h, w];
      angle += Math.PI / 2;
    }
    angle = wrapHalfTurn(angle);
    const rbox = boxCorners(cx, cy, w, h, angle);
    if (kept.some((b) => polygonIoU(b.box, rbox) > opts.nmsIoU)) continue;
    const scores = Object.fromEntries(classes.map((cls, q) => [cls, heat[q * plane + f.cell]])) as Record<CardKind, number>;
    kept.push({ cx, cy, w, h, angle, conf: f.score, kind: classes[f.k], scores, pts: alignCorners(corners, rbox), box: rbox });
  }
  return kept;
}
