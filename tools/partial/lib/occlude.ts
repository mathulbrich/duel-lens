// Synthetic partly COVERED cards from real footage (partial-report.md): an occluder is pasted into a real
// frame over `fraction` of a labelled card's area (or of a non-card box), at a seeded random place:
//   hand:    a skin-toned palm with four fingers reaching in from one side of the card (a player's hand)
//   patch:   a flat-coloured rectangle, turned (an overlay, a token, a card back)
//   texture: a turned rectangle of the frame's own pixels from elsewhere (another card, the mat, a sleeve)
// The coverage is measured on the card's own outline (its labelled corners, else its box) and the
// occluder's size is searched until it covers the fraction asked for (within 2 points).
import type { RGBAImage } from '../../../src/shared/preprocess';
import type { AxisBox } from '../../realset/lib/types';

export type Occluder = 'hand' | 'patch' | 'texture';
export const OCCLUDERS: readonly Occluder[] = ['hand', 'patch', 'texture'];
export const COVERAGES: readonly number[] = [0.2, 0.35, 0.5];

type Pt = [number, number];

/** mulberry32: a small seeded generator (0–1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function inPoly(poly: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A shape as a point test, in frame pixels. */
type Shape = (x: number, y: number) => boolean;

function ellipse(cx: number, cy: number, rx: number, ry: number, ang: number): Shape {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const u = (dx * c + dy * s) / rx;
    const v = (-dx * s + dy * c) / ry;
    return u * u + v * v <= 1;
  };
}

function capsule(ax: number, ay: number, bx: number, by: number, r: number): Shape {
  const vx = bx - ax;
  const vy = by - ay;
  const l2 = vx * vx + vy * vy || 1;
  return (x, y) => {
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2));
    const dx = x - (ax + t * vx);
    const dy = y - (ay + t * vy);
    return dx * dx + dy * dy <= r * r;
  };
}

function rect(cx: number, cy: number, w: number, h: number, ang: number): Shape {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    return Math.abs(dx * c + dy * s) <= w / 2 && Math.abs(-dx * s + dy * c) <= h / 2;
  };
}

const union = (shapes: Shape[]): Shape => (x, y) => shapes.some((f) => f(x, y));

interface Plan {
  kind: Occluder;
  /** The occluder at size `k` (a scale factor), in frame pixels. */
  shape(k: number): Shape;
  paint(frame: RGBAImage, out: Uint8ClampedArray, x: number, y: number, k: number): void;
}

/** The card's outline: its labelled corners when it has them, else its box. */
export function outlineOf(box: AxisBox, pts?: [number, number][] | null): Pt[] {
  if (pts && pts.length === 4) return pts.map(([x, y]) => [x, y] as Pt);
  return [
    [box.x, box.y],
    [box.x + box.w, box.y],
    [box.x + box.w, box.y + box.h],
    [box.x, box.y + box.h],
  ];
}

function planFor(kind: Occluder, card: Pt[], frame: RGBAImage, r: () => number): Plan {
  const xs = card.map((p) => p[0]);
  const ys = card.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const cw = x1 - x0;
  const ch = y1 - y0;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const size = Math.max(cw, ch);
  if (kind === 'hand') {
    // Fingers reach in from a random side; the palm stays outside the card, beyond that side.
    const side = Math.floor(r() * 4);
    const along = 0.2 + 0.6 * r(); // where along that side the hand enters
    const dir: Pt = side === 0 ? [0, 1] : side === 1 ? [-1, 0] : side === 2 ? [0, -1] : [1, 0]; // pointing into the card
    const entry: Pt = side === 0 ? [x0 + along * cw, y0] : side === 1 ? [x1, y0 + along * ch] : side === 2 ? [x0 + along * cw, y1] : [x0, y0 + along * ch];
    const skin = [200 + 40 * r(), 145 + 40 * r(), 115 + 40 * r()];
    const tilt = (r() - 0.5) * 0.8;
    const d: Pt = [dir[0] * Math.cos(tilt) - dir[1] * Math.sin(tilt), dir[0] * Math.sin(tilt) + dir[1] * Math.cos(tilt)];
    const n: Pt = [-d[1], d[0]];
    return {
      kind,
      shape: (k) => {
        const reach = k * size; // how far the fingertips go past the entry point
        const palmC: Pt = [entry[0] - d[0] * 0.35 * size, entry[1] - d[1] * 0.35 * size];
        const palm = ellipse(palmC[0], palmC[1], 0.32 * size, 0.28 * size, Math.atan2(d[1], d[0]));
        const fingers: Shape[] = [];
        for (let f = 0; f < 4; f++) {
          const off = (f - 1.5) * 0.11 * size;
          const len = reach * (f === 0 || f === 3 ? 0.8 : 1);
          const ax = palmC[0] + n[0] * off;
          const ay = palmC[1] + n[1] * off;
          fingers.push(capsule(ax, ay, entry[0] + n[0] * off + d[0] * len, entry[1] + n[1] * off + d[1] * len, 0.05 * size));
        }
        return union([palm, ...fingers]);
      },
      paint: (_frame, out, x, y) => {
        const o = (y * frame.width + x) * 4;
        const shade = 0.85 + 0.15 * Math.sin(x * 0.05 + y * 0.03);
        out[o] = skin[0] * shade;
        out[o + 1] = skin[1] * shade;
        out[o + 2] = skin[2] * shade;
      },
    };
  }
  const ang = r() * Math.PI;
  const aspect = 0.5 + 1.5 * r();
  const px = cx + (r() - 0.5) * cw;
  const py = cy + (r() - 0.5) * ch;
  if (kind === 'patch') {
    const palette = [
      [20, 20, 20],
      [235, 235, 235],
      [90, 90, 95],
      [180, 40, 40],
      [40, 90, 170],
      [220, 190, 60],
    ];
    const col = palette[Math.floor(r() * palette.length)];
    return {
      kind,
      shape: (k) => rect(px, py, k * size * Math.sqrt(aspect), (k * size) / Math.sqrt(aspect), ang),
      paint: (_frame, out, x, y) => {
        const o = (y * frame.width + x) * 4;
        out[o] = col[0];
        out[o + 1] = col[1];
        out[o + 2] = col[2];
      },
    };
  }
  // texture: the frame's own pixels from a random offset (at least a card away)
  const offAng = r() * 2 * Math.PI;
  const offLen = size * (1.2 + r());
  const ox = Math.round(Math.cos(offAng) * offLen);
  const oy = Math.round(Math.sin(offAng) * offLen);
  return {
    kind,
    shape: (k) => rect(px, py, k * size * Math.sqrt(aspect), (k * size) / Math.sqrt(aspect), ang),
    paint: (fr, out, x, y) => {
      const sx = Math.min(fr.width - 1, Math.max(0, x + ox));
      const sy = Math.min(fr.height - 1, Math.max(0, y + oy));
      const o = (y * fr.width + x) * 4;
      const s = (sy * fr.width + sx) * 4;
      out[o] = fr.data[s];
      out[o + 1] = fr.data[s + 1];
      out[o + 2] = fr.data[s + 2];
    },
  };
}

/** The share of the card outline's pixels a shape covers (sampled on a grid of about 60×60 points). */
function coverage(card: Pt[], shape: Shape): number {
  const xs = card.map((p) => p[0]);
  const ys = card.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const step = Math.max(Math.max(...xs) - x0, Math.max(...ys) - y0) / 60;
  let n = 0;
  let c = 0;
  for (let y = y0 + step / 2; y < Math.max(...ys); y += step)
    for (let x = x0 + step / 2; x < Math.max(...xs); x += step) {
      if (!inPoly(card, x, y)) continue;
      n++;
      if (shape(x, y)) c++;
    }
  return n ? c / n : 0;
}

export interface Occlusion {
  frame: RGBAImage;
  /** The coverage reached (share of the card outline's area). */
  covered: number;
  kind: Occluder;
}

/**
 * `frame` with `kind` pasted over `fraction` of the card (outline `card`), placed by `seed`. Null when the
 * search can't reach the coverage within 0.02 (a shape that can't grow into the card enough).
 */
export function occlude(frame: RGBAImage, card: Pt[], kind: Occluder, fraction: number, seed: number): Occlusion | null {
  const r = rng(seed);
  for (let attempt = 0; attempt < 6; attempt++) {
    const plan = planFor(kind, card, frame, r);
    let lo = 0.01;
    let hi = 3;
    let k = 0;
    let got = 0;
    for (let it = 0; it < 22; it++) {
      k = (lo + hi) / 2;
      got = coverage(card, plan.shape(k));
      if (Math.abs(got - fraction) <= 0.01) break;
      if (got < fraction) lo = k;
      else hi = k;
    }
    if (Math.abs(got - fraction) > 0.02) continue;
    const shape = plan.shape(k);
    const out = new Uint8ClampedArray(frame.data);
    // Paint the shape's pixels (within its reach of the card, grown by a card's size).
    const xs = card.map((p) => p[0]);
    const ys = card.map((p) => p[1]);
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    const bx0 = Math.max(0, Math.floor(Math.min(...xs) - 1.5 * size));
    const bx1 = Math.min(frame.width, Math.ceil(Math.max(...xs) + 1.5 * size));
    const by0 = Math.max(0, Math.floor(Math.min(...ys) - 1.5 * size));
    const by1 = Math.min(frame.height, Math.ceil(Math.max(...ys) + 1.5 * size));
    for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) if (shape(x + 0.5, y + 0.5)) plan.paint(frame, out, x, y, k);
    return { frame: { data: out, width: frame.width, height: frame.height }, covered: got, kind };
  }
  return null;
}
