// The visible part of a card that the picture's edge cuts and the next card covers: a simulator's hand at the bottom of
// a duel video, each card cut by the picture's bottom edge and covered on its right by the next one (only the last card
// is whole). The frame's card detector boxes such a card's visible part as a card shape: too small, and its top too low
// (L0NI4uYw4F0 at 435 s: 0.78-0.88 of the card's width at Balanced's 1280-px look, 0.70-0.78 at Light's 800, the top
// 9-15 px low). Its art box, cut from that outline, is the art zoomed in toward its top-left (1.25-1.45x), with the next
// card's edge along its right side: the clean artwork vectors score it 0.52-0.69. Cut from the card's true geometry,
// with the covered strip left out, the same art scores 0.75-0.85 with the right card first, leading by 0.15-0.31.
//
// coveredCard says whether a Live crop's cut card is covered (the next card's left edge, a straight edge across the
// card's top band, runs inside its outline) and where the card would lie whole: its outline grown about a point of
// its left side, the side no card covers. The engine reads those cards with the covered strip filled with the art's
// mean colour (engine.ts VISIBLE, liveCutReadings).
import type { RGBAImage } from '../shared/preprocess';
import type { Point, Quad } from './geometry';
import type { MaskedWarp } from './truncation';

/** Luma gradients of an image (Sobel, after a [1 2 1] blur each way), per pixel. */
export interface Gradients {
  width: number;
  height: number;
  gx: Float32Array;
  gy: Float32Array;
}

export function gradients(img: RGBAImage): Gradients {
  const { width: w, height: h, data: d } = img;
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) L[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  const t = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      t[i] = (L[x > 0 ? i - 1 : i] + 2 * L[i] + L[x < w - 1 ? i + 1 : i]) / 4;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      L[i] = (t[y > 0 ? i - w : i] + 2 * t[i] + t[y < h - 1 ? i + w : i]) / 4;
    }
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
      const k = L[i + w];
      const m = L[i + w + 1];
      gx[i] = (c + 2 * f + m - (a + 2 * e + g)) / 8;
      gy[i] = (g + 2 * k + m - (a + 2 * b + c)) / 8;
    }
  return { width: w, height: h, gx, gy };
}

/** Bilinear sample of a gradient component at (x, y) (pixel centres at half-integers); NaN off the image's inner part. */
function sample(G: Gradients, arr: Float32Array, x: number, y: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  if (ix < 1 || iy < 1 || ix >= G.width - 2 || iy >= G.height - 2) return NaN;
  const tx = fx - ix;
  const ty = fy - iy;
  const i = iy * G.width + ix;
  return (arr[i] * (1 - tx) + arr[i + 1] * tx) * (1 - ty) + (arr[i + G.width] * (1 - tx) + arr[i + G.width + 1] * tx) * ty;
}

/** A card's own frame on screen: its top-left corner, its x axis (along its top edge) and y axis (unit vectors), its size. */
export interface CardFrame {
  o: Point;
  ex: Point;
  ey: Point;
  w: number;
  h: number;
}

/**
 * `q` (a card's corners: its top-left, top-right, bottom-right and bottom-left) as a CardFrame: its top-left corner, the
 * direction of its mean top and bottom edges, its mean side lengths. With `tilt` (radians: the image's own estimate,
 * refine.ts estimateTilt), the axes turn to it, taken modulo 90° nearest the outline's own direction.
 */
export function frameOf(q: Quad, tilt: number | null = null): CardFrame {
  const [a, b, c, d] = q;
  let angle = Math.atan2(b.y - a.y + (c.y - d.y), b.x - a.x + (c.x - d.x));
  if (tilt !== null && Number.isFinite(tilt)) angle = tilt + Math.round((angle - tilt) / (Math.PI / 2)) * (Math.PI / 2);
  const ex = { x: Math.cos(angle), y: Math.sin(angle) };
  const w = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - d.x, c.y - d.y)) / 2;
  const h = (Math.hypot(d.x - a.x, d.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
  return { o: a, ex, ey: { x: -ex.y, y: ex.x }, w, h };
}

/** The point `u` px along `f`'s top edge and `v` px down its side from its top-left corner. */
export const at = (f: CardFrame, u: number, v: number): Point => ({ x: f.o.x + u * f.ex.x + v * f.ey.x, y: f.o.y + u * f.ex.y + v * f.ey.y });

/**
 * How strongly a straight line of the card's frame stands out: the mean absolute gradient across the segment `u` px
 * along its top edge, from `v0` to `v1` px down (a line parallel to its sides). NaN unless a third of it lies inside
 * the image.
 */
export function sideLine(G: Gradients, f: CardFrame, u: number, v0: number, v1: number): number {
  const n = Math.max(4, Math.round(Math.abs(v1 - v0)));
  let acc = 0;
  let count = 0;
  for (let k = 0; k <= n; k++) {
    const p = at(f, u, v0 + ((v1 - v0) * k) / n);
    const g = sample(G, G.gx, p.x, p.y) * f.ex.x + sample(G, G.gy, p.x, p.y) * f.ex.y;
    if (Number.isNaN(g)) continue;
    acc += Math.abs(g);
    count++;
  }
  return count >= Math.max(3, n / 3) ? acc / count : NaN;
}

/** Where `line` is strongest for u from `lo` to `hi` (half-pixel steps), and how strong; null when nowhere inside the image. */
export function strongestLine(line: (u: number) => number, lo: number, hi: number): { u: number; score: number } | null {
  let best: { u: number; score: number } | null = null;
  for (let u = lo; u <= hi + 1e-9; u += 0.5) {
    const score = line(u);
    if (!Number.isNaN(score) && (!best || score > best.score)) best = { u, score };
  }
  return best;
}

/**
 * How coveredCard finds a covered card, and where it reads it. Measured on L0NI4uYw4F0 at 435 s (the 7-card hand; the
 * next card covers 30% of each), Live's crops at Light's and Balanced's detector looks (tools/diag-frame):
 * - the cover edge: the next card's left side crosses the covered card's top band (the name bar and the level stars,
 *   the outline's top `band` of its height), where a card's own frame has no line along its sides but at its edges. The
 *   strongest such line between `search` shares of the outline's width is the cover edge when it lies before `covered`
 *   of that width (the detector's outline of a covered card runs past it: the edge comes at 0.82-0.96 of it; the whole card's
 *   own right edge at 1.01-1.04). Only a card whose outline's top edge lies in the crop is
 *   looked at: a hand is cut at its bottom. Cut at its top or on a side, part of its band is outside the picture and
 *   an inner line of its frame stands in for the edge: on the partial study's synthetic cuts (Live's crops of the real
 *   set's cards with the picture cut 25-55% into them, Balanced's look) that called 35% of whole cards covered, 5% with it;
 *   on the hand at 425-440 s it drops only the cut preview card at the picture's top-left, never a hand card;
 * - the whole card: the outline grown `grow` times about the point of its left side `pivot` of its height down (the
 *   middle of the part the picture shows: the detector boxes that part as a card). 1.3 reads every card of the hand
 *   first with a lead of 0.10 or more at both looks; 1.15 and 1.45 lose 1 to 3 of them, the outline as it is 4.
 */
export interface CoverOptions {
  band: number;
  /** The covered strip starts this share of the outline's width before the cover edge (the next card's own border). */
  inset: number;
  search: readonly [number, number];
  covered: number;
  grow: readonly number[];
  pivot: number;
}

export const COVER: CoverOptions = { band: 0.2, inset: 0.015, search: [0.4, 1.15], covered: 0.97, grow: [1.3], pivot: 0.4 };

/** A covered card, as coveredCard finds it: where it would lie whole (one quad per `grow`), and how much of each shows. */
export interface CoveredCard {
  /** The whole card's corners, top-left first, clockwise (crop pixels). */
  quads: Quad[];
  /** Per quad: the share of its width, from its left side, that no card covers (the cover edge's place). */
  visible: number[];
}

/**
 * Whether the card outlined by `corners` (top-left first, clockwise; crop pixels) in `img` is covered on its right by
 * another card, and if so where it lies whole (COVER). `tilt`: the image's own estimate of its tilt, if any. Null when no
 * cover edge is found inside its outline, or its outline's top edge is not in `img`.
 */
export function coveredCard(img: RGBAImage, corners: Quad, tilt: number | null, opts: CoverOptions = COVER): CoveredCard | null {
  const inside = (p: Point) => p.x >= -1 && p.y >= -1 && p.x <= img.width + 1 && p.y <= img.height + 1;
  if (!inside(corners[0]) || !inside(corners[1])) return null;
  const f = frameOf(corners, tilt);
  if (!(f.w >= 8 && f.h >= 8)) return null;
  const G = gradients(img);
  const edge = strongestLine((u) => sideLine(G, f, u, 0, opts.band * f.h), opts.search[0] * f.w, opts.search[1] * f.w);
  if (!edge || !(edge.score > 0) || edge.u >= opts.covered * f.w) return null;
  const quads: Quad[] = [];
  const visible: number[] = [];
  for (const s of opts.grow) {
    const w = s * f.w;
    const h = s * f.h;
    const top = at(f, 0, opts.pivot * f.h * (1 - s));
    const g = { ...f, o: top };
    quads.push([at(g, 0, 0), at(g, w, 0), at(g, w, h), at(g, 0, h)]);
    visible.push(Math.max(0, edge.u - opts.inset * f.w) / w);
  }
  return { quads, visible };
}

/** `w` (a straightened card) with every column from `share` of its width on marked unseen: the covered strip. */
export function hideRight(w: MaskedWarp, share: number): MaskedWarp {
  const { width: W, height: H } = w.image;
  const from = Math.max(0, Math.min(W, Math.floor(share * W)));
  if (from >= W) return w;
  const seen = new Uint8Array(w.seen);
  let gone = 0;
  for (let y = 0; y < H; y++) {
    for (let x = from; x < W; x++) gone += seen[y * W + x];
    seen.fill(0, y * W + from, (y + 1) * W);
  }
  return { ...w, seen, seenShare: w.seenShare - gone / (W * H) };
}
