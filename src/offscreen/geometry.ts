// Plane geometry and image warps for click to scan and the engine: rotated boxes, their bounds and
// overlaps, non-maximum suppression, the detection a user's box means, straightening a quad (a
// projective warp) and letterboxing an image into a square model input.
//
// Provenance: a clean-room rewrite, from scratch, of the textbook mathematical definitions written out
// below. Only the names and signatures of the helpers it replaced were kept, never their code.
//
// Conventions: screen coordinates, x right and y down, in pixels. Angles are radians, clockwise on
// screen. Pixel (i, j) covers [i, i + 1) × [j, j + 1), so its centre is (i + 0.5, j + 0.5), and an
// image w pixels wide spans [0, w].
import { resizeToFloatRGB, type RGBAImage } from '../shared/preprocess';

export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned rectangle: top-left corner, width and height. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Corners of a box, clockwise on screen from the top-left of the box's own frame. */
export type Quad = [Point, Point, Point, Point];

/** One detected card: an oriented box, with its corners, in pixels of the image it was found in. */
export interface ScoredBox {
  cx: number;
  cy: number;
  /** Portrait: w ≤ h. */
  w: number;
  h: number;
  /** Radians, clockwise on screen: the w×h box turned this much about its centre. Its top edge faces (sin, −cos). */
  angle: number;
  /** 0–1. */
  confidence: number;
  /** boxCorners(cx, cy, w, h, angle). */
  corners: Quad;
}

// ---------- rotated boxes ----------

/**
 * Corners of a w×h box centred on (cx, cy) and turned `angle` radians clockwise on screen: the box's
 * own top-left, top-right, bottom-right and bottom-left.
 *
 * With y pointing down, turning by θ clockwise takes the box's own x axis to (cos θ, sin θ) and its
 * own y axis to (−sin θ, cos θ). The corner at offset (±w/2, ±h/2) from the centre in the box's own
 * frame therefore lands at centre ± (w/2)·(cos θ, sin θ) ± (h/2)·(−sin θ, cos θ).
 */
export function boxCorners(cx: number, cy: number, w: number, h: number, angle: number): Quad {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // Half of the box's width along its own x axis, and half of its height along its own y axis.
  const ux = (w / 2) * cos;
  const uy = (w / 2) * sin;
  const vx = -(h / 2) * sin;
  const vy = (h / 2) * cos;
  return [
    { x: cx - ux - vx, y: cy - uy - vy },
    { x: cx + ux - vx, y: cy + uy - vy },
    { x: cx + ux + vx, y: cy + uy + vy },
    { x: cx - ux + vx, y: cy - uy + vy },
  ];
}

/** The axis-aligned bounds of some points (a quad's corners, say): the smallest Rect holding them all. */
export function boundsOf(points: readonly Point[]): Rect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const p of points) {
    if (p.x < left) left = p.x;
    if (p.x > right) right = p.x;
    if (p.y < top) top = p.y;
    if (p.y > bottom) bottom = p.y;
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ---------- axis-aligned rectangles ----------

/** Area of a rectangle; one with a negative side is empty. */
const areaOf = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);

/** Area of the intersection of two rectangles: the product of the overlaps of their x and y extents. */
function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Intersection over union of two rectangles, |A ∩ B| / (|A| + |B| − |A ∩ B|): 1 for the same
 * rectangle, 0 when they don't overlap (or only touch). 0 when both are empty.
 */
export function iou(a: Rect, b: Rect): number {
  const inter = intersectionArea(a, b);
  if (inter <= 0) return 0;
  return inter / (areaOf(a) + areaOf(b) - inter);
}

/** The share of `a`'s area inside `b`, |A ∩ B| / |A| (0–1); 0 when `a` is empty. */
export function insideShare(a: Rect, b: Rect): number {
  const area = areaOf(a);
  return area > 0 ? Math.min(1, intersectionArea(a, b) / area) : 0;
}

// ---------- convex polygons ----------

/**
 * The shoelace formula: a simple polygon's signed area, ½·Σ (xᵢ·yᵢ₊₁ − xᵢ₊₁·yᵢ). Positive when the
 * vertices go clockwise on screen (y down), as boxCorners' do; negative the other way round.
 */
export function signedArea(points: readonly Point[]): number {
  let twice = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    twice += p.x * q.y - q.x * p.y;
  }
  return twice / 2;
}

/** A simple polygon's area, whichever way its vertices go. */
export const polygonArea = (points: readonly Point[]): number => Math.abs(signedArea(points));

/**
 * The part of polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman): clip against
 * each of `clip`'s edges in turn, keeping what lies on its inner side. A point p is on the inner
 * side of edge a→b when the cross product (b − a) × (p − a) has the sign of `clip`'s signed area;
 * where a side of `subject` crosses the edge's line, that cross product is linear along the side,
 * so the crossing is at the ratio of its values at the two ends.
 */
export function clipToConvex(subject: readonly Point[], clip: readonly Point[]): Point[] {
  const orientation = Math.sign(signedArea(clip));
  if (orientation === 0) return [];
  let out: Point[] = subject.slice();
  for (let k = 0, m = clip.length; k < m && out.length > 0; k++) {
    const a = clip[k];
    const b = clip[(k + 1) % m];
    const inner = (p: Point) => orientation * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    const input = out;
    out = [];
    let prev = input[input.length - 1];
    let prevSide = inner(prev);
    for (const cur of input) {
      const curSide = inner(cur);
      if ((curSide >= 0) !== (prevSide >= 0)) {
        const t = prevSide / (prevSide - curSide);
        out.push({ x: prev.x + t * (cur.x - prev.x), y: prev.y + t * (cur.y - prev.y) });
      }
      if (curSide >= 0) out.push(cur);
      prev = cur;
      prevSide = curSide;
    }
  }
  return out;
}

/**
 * Intersection over union of two convex polygons (a rotated box's corners, say): the intersection
 * by Sutherland–Hodgman clipping, the areas by the shoelace formula. 0 when both are empty.
 */
export function polygonIou(a: readonly Point[], b: readonly Point[]): number {
  const inter = polygonArea(clipToConvex(a, b));
  if (inter <= 0) return 0;
  return inter / (polygonArea(a) + polygonArea(b) - inter);
}

// ---------- non-maximum suppression ----------

/**
 * How nms measures the overlap of two boxes: 'bounds' is the IoU of their axis-aligned bounds (the
 * measure the tiled card search's merge was tuned with, tools/lib/tiled-detector.ts); 'outline' is
 * the IoU of the rotated rectangles themselves, which doesn't take side-by-side tilted cards for
 * duplicates.
 */
export type Overlap = 'bounds' | 'outline';

/**
 * Non-maximum suppression: the boxes strongest first (equal confidences keep their order), each
 * kept unless it overlaps a stronger box already kept by more than `threshold` (IoU). By default
 * the overlap is that of the boxes' axis-aligned bounds; `overlap: 'outline'` compares the rotated
 * boxes themselves.
 */
export function nms<T extends ScoredBox>(boxes: readonly T[], threshold: number, overlap: Overlap = 'bounds'): T[] {
  type Entry = { box: T; bounds: Rect };
  // Array.prototype.sort is stable, so equal confidences keep their input order.
  const ranked: Entry[] = boxes.map((box) => ({ box, bounds: boundsOf(box.corners) })).sort((p, q) => q.box.confidence - p.box.confidence);
  const overlapOf =
    overlap === 'outline' ? (p: Entry, q: Entry) => polygonIou(p.box.corners, q.box.corners) : (p: Entry, q: Entry) => iou(p.bounds, q.bounds);
  const kept: Entry[] = [];
  for (const candidate of ranked) {
    if (kept.every((k) => overlapOf(k, candidate) <= threshold)) kept.push(candidate);
  }
  return kept.map((k) => k.box);
}

// ---------- the detection a user's box means ----------

/** How pickBox chooses among detections; the same whichever detector found them. */
export interface PickOptions {
  /**
   * A detection at least this share inside the user's box counts, whatever its IoU with it: the box
   * may be drawn loosely, several times larger than the card. Less than this (and under minIoU), it
   * is a neighbouring card caught in the margin.
   */
  minContained: number;
  /**
   * Detections at most this much less inside the box than the most-inside one tie with it, and the
   * tie goes to the one nearest the box's centre: of the cards a loose box holds whole, the one it
   * was drawn around.
   */
  tie: number;
  /**
   * A detection at least this share inside a larger detection is part of that card (its art box,
   * say), not a card of its own. Overlapping cards (an XYZ on its materials) are less inside each other.
   */
  partOf: number;
}

export const PICK: PickOptions = { minContained: 0.5, tie: 0.1, partOf: 0.9 };

/**
 * pickBox's `minIoU` for a user's box: a detection overlapping the box by at least this much (IoU)
 * counts even when less than half of it is inside the box (a box drawn on a card's art, inside the
 * card). The value the engine has always used, whichever detector found the boxes.
 */
export const PICK_MIN_IOU = 0.1;

/**
 * The detection the user meant with `user`, a box they drew; null when no detection counts.
 *
 * Every detection is measured by its axis-aligned bounds. One that is `partOf` inside a larger
 * detection never counts. The others count when their IoU with the box is at least `minIoU` (a box
 * drawn on a card's art lies inside the card) or at least `minContained` of them is inside the box.
 * Of those counted, the pick is the most inside the box; among those within `tie` of the most
 * inside, the one whose centre is nearest the box's centre; at equal distances, the most confident.
 * So a tight box picks its card over neighbours caught in the margin, a loose box (even several
 * times the card's size) picks the card it was drawn around, and a box around several cards picks
 * the one nearest its centre.
 */
export function pickBox<T extends ScoredBox>(boxes: readonly T[], user: Rect, minIoU: number, opts: PickOptions = PICK): T | null {
  const bounds = boxes.map((b) => boundsOf(b.corners));
  const areas = bounds.map(areaOf);
  const isPart = (i: number) => bounds.some((other, j) => areas[j] > areas[i] && insideShare(bounds[i], other) >= opts.partOf);

  const counted: { box: T; inside: number }[] = [];
  bounds.forEach((r, i) => {
    if (isPart(i)) return;
    const inside = insideShare(r, user);
    if (inside >= opts.minContained || iou(r, user) >= minIoU) counted.push({ box: boxes[i], inside });
  });
  if (counted.length === 0) return null;

  const most = Math.max(...counted.map((c) => c.inside));
  const ux = user.x + user.w / 2;
  const uy = user.y + user.h / 2;
  let best: T | null = null;
  let bestDistance = Infinity;
  for (const { box, inside } of counted) {
    if (most - inside > opts.tie) continue;
    const distance = (box.cx - ux) ** 2 + (box.cy - uy) ** 2;
    if (best === null || distance < bestDistance || (distance === bestDistance && box.confidence > best.confidence)) {
      best = box;
      bestDistance = distance;
    }
  }
  return best;
}

// ---------- straightening a quad ----------

/**
 * A projective map (homography) of the unit square, relative to the point (ox, oy):
 *   x = ox + (a·u + b·v) / w,  y = oy + (d·u + e·v) / w,  where w = 1 + g·u + h·v.
 */
interface SquareMap {
  ox: number;
  oy: number;
  a: number;
  b: number;
  d: number;
  e: number;
  g: number;
  h: number;
}

/**
 * The projective map taking the unit square's corners (0,0), (1,0), (1,1), (0,1) to the quad's
 * corners 0–3, or null when no such map is one-to-one on the square: the quad is degenerate (three
 * corners on a line, a repeated corner) or not convex (a reflex corner, or crossing sides).
 *
 * Measured from corner 0 (x₀ = y₀ = 0, so the map has no constant term), corners 1 and 3 fix
 * a = x₁·(1 + g), d = y₁·(1 + g), b = x₃·(1 + h), e = y₃·(1 + h). Corner 2 then leaves the linear
 * pair  g·(x₁ − x₂) + h·(x₃ − x₂) = x₀ − x₁ + x₂ − x₃  (and the same in y), solved by Cramer's rule.
 * A parallelogram gives g = h = 0, an affine map. w is affine in (u, v) and 1 at corner 0, so it
 * stays positive over the square exactly when it is positive at corners 1–3 (1 + g, 1 + g + h,
 * 1 + h); that holds for a convex quad and fails for any other.
 */
function squareMap(quad: Quad): SquareMap | null {
  const [q0, q1, q2, q3] = quad;
  const x1 = q1.x - q0.x;
  const y1 = q1.y - q0.y;
  const x2 = q2.x - q0.x;
  const y2 = q2.y - q0.y;
  const x3 = q3.x - q0.x;
  const y3 = q3.y - q0.y;
  // Tolerances scale with the quad's size squared (the unit of the cross products below).
  const size2 = Math.max(x1 * x1 + y1 * y1, x2 * x2 + y2 * y2, x3 * x3 + y3 * y3);
  const tiny = 1e-10 * size2;
  const px = x1 - x2;
  const py = y1 - y2;
  const qx = x3 - x2;
  const qy = y3 - y2;
  const sx = x2 - x1 - x3;
  const sy = y2 - y1 - y3;
  const den = px * qy - qx * py;
  if (!(Math.abs(den) > tiny)) return null;
  const g = (sx * qy - qx * sy) / den;
  const h = (px * sy - sx * py) / den;
  if (!(1 + g > 1e-9 && 1 + h > 1e-9 && 1 + g + h > 1e-9)) return null;
  if (!(Math.abs(x1 * y3 - x3 * y1) > tiny)) return null;
  return { ox: q0.x, oy: q0.y, a: x1 * (1 + g), b: x3 * (1 + h), d: y1 * (1 + g), e: y3 * (1 + h), g, h };
}

/**
 * The projective map (homography) taking the unit square's corners (0,0), (1,0), (1,1), (0,1) to
 * `quad`'s corners in order, as a function of (u, v); null for a degenerate or non-convex quad.
 */
export function quadMap(quad: Quad): ((u: number, v: number) => Point) | null {
  const m = squareMap(quad);
  if (!m) return null;
  return (u, v) => {
    const w = 1 + m.g * u + m.h * v;
    return { x: m.ox + (m.a * u + m.b * v) / w, y: m.oy + (m.d * u + m.e * v) / w };
  };
}

/**
 * Straighten `quad` into an outW×outH image: its corners go to the output's top-left, top-right,
 * bottom-right and bottom-left. Null for a degenerate quad (and for a non-convex one, which no
 * projective map straightens).
 *
 * Each output pixel's centre, as a point (u, v) of the unit square, maps through quadMap to a
 * point of `img`, sampled bilinearly between the four nearest pixel centres; at the image's border
 * the nearest pixels repeat. Samples that fall outside the image are opaque black. The input's
 * alpha is ignored; the output is opaque. So the image's own bounds as the quad copy it exactly,
 * and its corners taken in turned order turn it (rotate90, rotate180).
 */
export function warpQuad(img: RGBAImage, quad: Quad, outW: number, outH: number): RGBAImage | null {
  const m = squareMap(quad);
  if (!m) return null;
  const { width, height, data: src } = img;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const lastX = width - 1;
  const lastY = height - 1;
  // Pixel centres sit at half-integers; bilinear weights are measured from them.
  const ox = m.ox - 0.5;
  const oy = m.oy - 0.5;
  const du = 1 / outW;
  const dv = 1 / outH;
  let o = 0;
  for (let j = 0; j < outH; j++) {
    const v = (j + 0.5) * dv;
    // Along a row only u changes, and x, y and w are affine in it.
    const xRow = m.b * v;
    const yRow = m.e * v;
    const wRow = 1 + m.h * v;
    for (let i = 0; i < outW; i++, o += 4) {
      const u = (i + 0.5) * du;
      const inv = 1 / (wRow + m.g * u);
      const fx = ox + (m.a * u + xRow) * inv;
      const fy = oy + (m.d * u + yRow) * inv;
      out[o + 3] = 255;
      if (!(fx >= -0.5 && fy >= -0.5 && fx <= lastX + 0.5 && fy <= lastY + 0.5)) continue;
      const left = Math.floor(fx);
      const top = Math.floor(fy);
      const tx = fx - left;
      const ty = fy - top;
      const x0 = left < 0 ? 0 : left;
      const x1 = left + 1 > lastX ? lastX : left + 1;
      const row0 = (top < 0 ? 0 : top) * width;
      const row1 = (top + 1 > lastY ? lastY : top + 1) * width;
      const p00 = (row0 + x0) * 4;
      const p01 = (row0 + x1) * 4;
      const p10 = (row1 + x0) * 4;
      const p11 = (row1 + x1) * 4;
      const w11 = tx * ty;
      const w01 = tx - w11;
      const w10 = ty - w11;
      const w00 = 1 - tx - w10;
      out[o] = src[p00] * w00 + src[p01] * w01 + src[p10] * w10 + src[p11] * w11;
      out[o + 1] = src[p00 + 1] * w00 + src[p01 + 1] * w01 + src[p10 + 1] * w10 + src[p11 + 1] * w11;
      out[o + 2] = src[p00 + 2] * w00 + src[p01 + 2] * w01 + src[p10 + 2] * w10 + src[p11 + 2] * w11;
    }
  }
  return { data: out, width: outW, height: outH };
}

// ---------- letterboxing ----------

export interface Letterbox {
  /** [3, size, size], RGB in [0, 1]. */
  tensor: Float32Array;
  /** Input pixels per crop pixel. */
  scale: number;
  /** Where the crop's left and top edges sit in the input, in input pixels. */
  padX: number;
  padY: number;
}

/**
 * A square size×size model input holding `img` whole: `img` scaled by one factor (shrunk or grown)
 * so its long side covers `contentFraction` (0–1) of the square's side, centred (an odd leftover
 * pixel goes after it), the rest filled with the grey `fill` (0–255). Each side is rounded to whole
 * pixels. The resize is the shared antialiased bilinear one (resizeToFloatRGB), so a large crop
 * doesn't alias. An input point p maps back to `img` at (p − pad) / scale (fromLetterbox).
 */
export function letterbox(img: RGBAImage, size: number, contentFraction: number, fill: number): Letterbox {
  const scale = (contentFraction * size) / Math.max(img.width, img.height);
  // Rounding keeps the long side at exactly contentFraction·size when that is whole.
  const fit = (side: number) => Math.min(size, Math.max(1, Math.round(side * scale)));
  const w = fit(img.width);
  const h = fit(img.height);
  const padX = Math.floor((size - w) / 2);
  const padY = Math.floor((size - h) / 2);
  const rgb = resizeToFloatRGB(img, w, h);
  const plane = size * size;
  const tensor = new Float32Array(3 * plane).fill(fill / 255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = (y * w + x) * 3;
      const to = (y + padY) * size + x + padX;
      tensor[to] = rgb[from] / 255;
      tensor[plane + to] = rgb[from + 1] / 255;
      tensor[2 * plane + to] = rgb[from + 2] / 255;
    }
  }
  return { tensor, scale, padX, padY };
}

/**
 * A point of a letterboxed model input (a detection's centre, say), back in the pixels of the image
 * letterbox was given: letterbox's scale and pad undone. Lengths map back by dividing by `scale`.
 */
export function fromLetterbox(lb: Pick<Letterbox, 'scale' | 'padX' | 'padY'>, p: Point): Point {
  return { x: (p.x - lb.padX) / lb.scale, y: (p.y - lb.padY) / lb.scale };
}
