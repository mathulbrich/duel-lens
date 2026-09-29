import { describe, expect, it } from 'vitest';
import { resizeToFloatRGB, rotate180, rotate90, type RGBAImage } from '../shared/preprocess';
import {
  boundsOf,
  boxCorners,
  fromLetterbox,
  insideShare,
  iou,
  letterbox,
  nms,
  PICK,
  pickBox,
  polygonArea,
  polygonIou,
  quadMap,
  signedArea,
  warpQuad,
  type Point,
  type Quad,
  type ScoredBox,
} from './geometry';

const SQRT1_2 = Math.SQRT1_2;

function expectPoint(p: Point, x: number, y: number, digits = 9): void {
  expect(p.x).toBeCloseTo(x, digits);
  expect(p.y).toBeCloseTo(y, digits);
}

const card = (cx: number, cy: number, w = 60, h = 88, confidence = 0.9, angle = 0): ScoredBox => ({
  cx,
  cy,
  w,
  h,
  angle,
  confidence,
  corners: boxCorners(cx, cy, w, h, angle),
});

/** A w×h image from a function of the pixel's column and row. */
function image(w: number, h: number, rgb: (x: number, y: number) => [number, number, number], alpha = 255): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set([...rgb(x, y), alpha], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}

/** Deterministic pseudo-random bytes. */
function noise(w: number, h: number, seed = 1): RGBAImage {
  let s = seed;
  const next = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24;
  return image(w, h, () => [next(), next(), next()], 255);
}

const pixel = (img: RGBAImage, x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('boxCorners', () => {
  it("gives an unturned box's top-left, top-right, bottom-right and bottom-left", () => {
    const [tl, tr, br, bl] = boxCorners(10, 20, 4, 6, 0);
    expectPoint(tl, 8, 17);
    expectPoint(tr, 12, 17);
    expectPoint(br, 12, 23);
    expectPoint(bl, 8, 23);
  });

  it("turns a unit square 45° clockwise: its own top-left corner goes straight up", () => {
    const r = SQRT1_2;
    const [tl, tr, br, bl] = boxCorners(0.5, 0.5, 1, 1, Math.PI / 4);
    expectPoint(tl, 0.5, 0.5 - r);
    expectPoint(tr, 0.5 + r, 0.5);
    expectPoint(br, 0.5, 0.5 + r);
    expectPoint(bl, 0.5 - r, 0.5);
  });

  it('turns a portrait box a quarter turn clockwise into a landscape one whose top edge faces right', () => {
    const [tl, tr, br, bl] = boxCorners(10, 20, 2, 4, Math.PI / 2);
    expectPoint(tl, 12, 19);
    expectPoint(tr, 12, 21);
    expectPoint(br, 8, 21);
    expectPoint(bl, 8, 19);
  });

  it('keeps the centre and the sides, goes clockwise and faces its top edge (sin, −cos) at any angle', () => {
    for (const angle of [-3, -1.2, -0.3, 0.1, 0.7, 2, 3.1, 7]) {
      const q = boxCorners(-40, 25, 30, 50, angle);
      expectPoint({ x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 }, -40, 25);
      expect(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y)).toBeCloseTo(30, 9);
      expect(Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y)).toBeCloseTo(50, 9);
      // Clockwise on screen (y down) is a positive shoelace area.
      expect(signedArea(q)).toBeCloseTo(30 * 50, 6);
      const top = { x: (q[0].x + q[1].x) / 2 + 40, y: (q[0].y + q[1].y) / 2 - 25 };
      expectPoint(top, 25 * Math.sin(angle), -25 * Math.cos(angle));
    }
  });
});

describe('boundsOf', () => {
  it('is an unturned box itself', () => {
    expect(boundsOf(boxCorners(10, 20, 4, 6, 0))).toEqual({ x: 8, y: 17, w: 4, h: 6 });
  });

  it('holds a unit square turned 45°', () => {
    const r = boundsOf(boxCorners(0.5, 0.5, 1, 1, Math.PI / 4));
    expect(r.x).toBeCloseTo(0.5 - SQRT1_2, 12);
    expect(r.y).toBeCloseTo(0.5 - SQRT1_2, 12);
    expect(r.w).toBeCloseTo(Math.SQRT2, 12);
    expect(r.h).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe('iou', () => {
  const a = { x: 0, y: 0, w: 2, h: 2 };

  it('is 1 for the same rectangle and 0 for disjoint or touching ones', () => {
    expect(iou(a, { ...a })).toBe(1);
    expect(iou(a, { x: 5, y: 5, w: 2, h: 2 })).toBe(0);
    expect(iou(a, { x: 2, y: 0, w: 2, h: 2 })).toBe(0);
  });

  it('is the intersection over the union', () => {
    // Overlap 1×2 = 2; union 4 + 4 − 2 = 6.
    expect(iou(a, { x: 1, y: 0, w: 2, h: 2 })).toBe(1 / 3);
    // A 2×2 inside a 4×4: 4 / 16.
    expect(iou({ x: 0, y: 0, w: 4, h: 4 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(0.25);
    expect(iou({ x: 1, y: 1, w: 2, h: 2 }, { x: 0, y: 0, w: 4, h: 4 })).toBe(0.25);
  });

  it('is 0 for empty rectangles', () => {
    expect(iou({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
    expect(iou({ x: 1, y: 1, w: 0, h: 1 }, a)).toBe(0);
  });
});

describe('insideShare', () => {
  it("is the share of the first rectangle's area inside the second", () => {
    expect(insideShare({ x: 1, y: 1, w: 2, h: 2 }, { x: 0, y: 0, w: 4, h: 4 })).toBe(1);
    expect(insideShare({ x: 0, y: 0, w: 4, h: 4 }, { x: 1, y: 1, w: 2, h: 2 })).toBe(0.25);
    expect(insideShare({ x: 0, y: 0, w: 2, h: 2 }, { x: 1, y: 0, w: 2, h: 2 })).toBe(0.5);
    expect(insideShare({ x: 0, y: 0, w: 2, h: 2 }, { x: 3, y: 0, w: 2, h: 2 })).toBe(0);
  });

  it('is 0 for an empty rectangle', () => {
    expect(insideShare({ x: 1, y: 1, w: 0, h: 0 }, { x: 0, y: 0, w: 4, h: 4 })).toBe(0);
  });
});

describe('polygonIou', () => {
  const square = (x: number, y: number, side: number): Point[] => [
    { x, y },
    { x: x + side, y },
    { x: x + side, y: y + side },
    { x, y: y + side },
  ];

  it('is 1 for the same rotated box and 0 for disjoint ones', () => {
    const q = boxCorners(50, 60, 30, 44, 0.6);
    expect(polygonIou(q, boxCorners(50, 60, 30, 44, 0.6))).toBeCloseTo(1, 12);
    expect(polygonIou(q, boxCorners(150, 60, 30, 44, 0.6))).toBe(0);
    expect(polygonIou(square(0, 0, 1), square(1, 0, 1))).toBe(0);
  });

  it('is 1/3 for two unit squares half a side apart', () => {
    expect(polygonIou(square(0, 0, 1), square(0.5, 0, 1))).toBeCloseTo(1 / 3, 12);
  });

  it('is 1/√2 for a square and itself turned 45° (an octagon), where their bounds give 1/2', () => {
    // Each of the square's corners loses a right triangle with legs 2 − √2: 4 − 4·(3 − 2√2) = 8√2 − 8.
    const upright = boxCorners(0, 0, 2, 2, 0);
    const turned = boxCorners(0, 0, 2, 2, Math.PI / 4);
    expect(polygonArea(upright)).toBeCloseTo(4, 12);
    expect(polygonIou(upright, turned)).toBeCloseTo(SQRT1_2, 12);
    expect(iou(boundsOf(upright), boundsOf(turned))).toBeCloseTo(0.5, 12);
  });

  it('does not depend on which way the vertices go', () => {
    const a = boxCorners(0, 0, 2, 2, 0);
    const b = boxCorners(0.7, 0.2, 2, 3, 0.4);
    expect(polygonIou([...a].reverse(), b)).toBeCloseTo(polygonIou(a, b), 12);
    expect(polygonIou(a, [...b].reverse())).toBeCloseTo(polygonIou(a, b), 12);
  });
});

describe('nms', () => {
  it('keeps the higher score of two overlapping boxes', () => {
    const weak = card(100, 100, 60, 88, 0.6);
    const strong = card(105, 100, 60, 88, 0.9);
    expect(nms([weak, strong], 0.5)).toEqual([strong]);
  });

  it('keeps boxes that do not overlap, strongest first, as the same objects', () => {
    const a = card(100, 100, 60, 88, 0.5);
    const b = card(300, 100, 60, 88, 0.8);
    const kept = nms([a, b], 0.5);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(b);
    expect(kept[1]).toBe(a);
  });

  it('drops a box only when the overlap is more than the threshold', () => {
    // Offset by half a width: overlap 30×88, union 2·5280 − 2640, IoU exactly 1/3.
    const a = card(100, 100, 60, 88, 0.9);
    const b = card(130, 100, 60, 88, 0.8);
    expect(nms([a, b], 1 / 3)).toEqual([a, b]);
    expect(nms([a, b], 0.3)).toEqual([a]);
  });

  it('lets a box suppressed by a stronger one suppress nothing', () => {
    const a = card(100, 100, 60, 88, 0.9);
    const b = card(130, 100, 60, 88, 0.8);
    const c = card(160, 100, 60, 88, 0.7); // overlaps b, only touches a
    expect(nms([c, b, a], 0.3)).toEqual([a, c]);
  });

  it('keeps the input order among equal confidences', () => {
    const a = card(100, 100, 60, 88, 0.5);
    const b = card(300, 100, 60, 88, 0.5);
    expect(nms([a, b], 0.5)).toEqual([a, b]);
    expect(nms([b, a], 0.5)).toEqual([b, a]);
  });

  it("with 'outline', keeps side-by-side tilted cards that the bounds take for duplicates", () => {
    const angle = Math.PI / 4;
    const a = card(200, 200, 10, 100, 0.9, angle);
    // 15 px along the box's own x axis: a 5 px gap between the two outlines.
    const b = card(200 + 15 * Math.cos(angle), 200 + 15 * Math.sin(angle), 10, 100, 0.8, angle);
    expect(iou(boundsOf(a.corners), boundsOf(b.corners))).toBeGreaterThan(0.5);
    expect(polygonIou(a.corners, b.corners)).toBe(0);
    expect(nms([a, b], 0.5)).toEqual([a]);
    expect(nms([a, b], 0.5, 'outline')).toEqual([a, b]);
  });
});

describe('pickBox', () => {
  // Three cards in a row, 10 px apart: C | A | B.
  const A = card(300, 300);
  const B = card(370, 300);
  const C = card(230, 300);
  const boxAround = (cx: number, cy: number, w: number, h: number) => ({ x: cx - w / 2, y: cy - h / 2, w, h });

  it('uses 0.5 containment, a 0.1 tie and 0.9 for parts by default', () => {
    expect(PICK).toEqual({ minContained: 0.5, tie: 0.1, partOf: 0.9 });
  });

  it('picks the card a tight box holds over a neighbour caught in its margin', () => {
    // B is 15/60 inside, with IoU 1320/12960 ≈ 0.10: it counts, but A is wholly inside.
    const user = { x: 265, y: 250, w: 90, h: 100 };
    expect(insideShare(boundsOf(B.corners), user)).toBeCloseTo(0.25, 12);
    expect(iou(boundsOf(B.corners), user)).toBeGreaterThan(0.1);
    expect(pickBox([B, A, C], user, 0.1)).toBe(A);
  });

  it('picks the card a loose box three times its size was drawn around', () => {
    // The neighbours are 50/60 inside, more than the tie below A's whole.
    expect(pickBox([B, C, A], boxAround(300, 300, 180, 264), 0.1)).toBe(A);
  });

  it('picks the card nearest the centre of a box that holds several whole', () => {
    expect(pickBox([B, C, A], boxAround(305, 300, 240, 352), 0.1)).toBe(A);
    // All three whole; the centre (337.5, 300) is 32.5 px from B and 37.5 px from A.
    expect(pickBox([A, C, B], { x: 200, y: 240, w: 275, h: 120 }, 0.1)).toBe(B);
  });

  it('breaks the tie by distance only within `tie` of the most inside', () => {
    const small = card(240, 270, 40, 58, 0.9); // wholly inside, 42 px from the centre
    const big = card(290, 330, 60, 88, 0.9); // 74/88 inside, 36 px from the centre
    const user = { x: 215, y: 240, w: 110, h: 120 };
    expect(pickBox([small, big], user, 0.1)).toBe(small);
    expect(pickBox([small, big], user, 0.1, { ...PICK, tie: 0.2 })).toBe(big);
  });

  it('picks the card whose art a box was drawn on (IoU at least minIoU)', () => {
    // 30×30 on a 60×88 card: 900/5280 ≈ 0.17 inside and IoU.
    expect(pickBox([A, B], { x: 285, y: 270, w: 30, h: 30 }, 0.1)).toBe(A);
    // 10×10: IoU 100/5280 < 0.1.
    expect(pickBox([A, B], { x: 295, y: 290, w: 10, h: 10 }, 0.1)).toBeNull();
  });

  it('never picks a part of a larger detection, such as its art box', () => {
    const art = card(300, 285, 48, 40, 0.95);
    const user = boundsOf(art.corners);
    expect(pickBox([art, A], user, 0.1)).toBe(A);
    // Without the rule, the art box would win: it is wholly inside, the card only 1920/5280.
    expect(pickBox([art, A], user, 0.1, { ...PICK, partOf: 1.01 })).toBe(art);
  });

  it('gives a tie at equal distances to the more confident card', () => {
    const left = card(240, 300, 60, 88, 0.6);
    const right = card(360, 300, 60, 88, 0.8);
    const user = { x: 200, y: 250, w: 200, h: 100 };
    expect(pickBox([left, right], user, 0.1)).toBe(right);
    expect(pickBox([{ ...left, confidence: 0.85 }, right], user, 0.1)?.cx).toBe(240);
  });

  it('is null when no detection counts', () => {
    expect(pickBox([], { x: 0, y: 0, w: 10, h: 10 }, 0.1)).toBeNull();
    expect(pickBox([A, B, C], { x: 1000, y: 1000, w: 50, h: 50 }, 0.1)).toBeNull();
    // Only B's edge: 10/60 inside and IoU 880/14400.
    expect(pickBox([A, B], { x: 390, y: 250, w: 100, h: 100 }, 0.1)).toBeNull();
  });
});

describe('quadMap', () => {
  const quad: Quad = [
    { x: 10, y: 20 },
    { x: 110, y: 5 },
    { x: 130, y: 160 },
    { x: 0, y: 120 },
  ];

  it("sends the unit square's corners exactly to the quad's", () => {
    const map = quadMap(quad)!;
    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    corners.forEach(([u, v], i) => expectPoint(map(u, v), quad[i].x, quad[i].y, 9));
  });

  it("sends the square's centre to where the quad's diagonals cross, and keeps lines straight", () => {
    const map = quadMap(quad)!;
    // The diagonals q0–q2 and q1–q3 cross at q0 + t·(q2 − q0).
    const [p, q, r, s] = quad;
    const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
    const t = cross(q.x - p.x, q.y - p.y, s.x - q.x, s.y - q.y) / cross(r.x - p.x, r.y - p.y, s.x - q.x, s.y - q.y);
    expectPoint(map(0.5, 0.5), p.x + t * (r.x - p.x), p.y + t * (r.y - p.y), 9);
    const [a, b, c] = [map(0.2, 0.3), map(0.6, 0.3), map(0.9, 0.3)];
    expect(cross(b.x - a.x, b.y - a.y, c.x - a.x, c.y - a.y)).toBeCloseTo(0, 6);
  });

  it('is affine for a parallelogram: the midpoint of a side is the midpoint', () => {
    const map = quadMap(boxCorners(40, 30, 20, 10, 0.3))!;
    const q = boxCorners(40, 30, 20, 10, 0.3);
    expectPoint(map(0.5, 0), (q[0].x + q[1].x) / 2, (q[0].y + q[1].y) / 2);
    expectPoint(map(0.5, 0.5), 40, 30);
  });

  it('is null for degenerate or non-convex quads', () => {
    const P = (x: number, y: number) => ({ x, y });
    expect(quadMap(boxCorners(5, 5, 0, 10, 0.2))).toBeNull();
    expect(quadMap([P(3, 3), P(3, 3), P(3, 3), P(3, 3)])).toBeNull();
    expect(quadMap([P(0, 0), P(5, 0), P(10, 0), P(0, 10)])).toBeNull(); // three corners on a line
    expect(quadMap([P(0, 0), P(10, 10), P(10, 0), P(0, 10)])).toBeNull(); // sides crossing
    expect(quadMap([P(0, 0), P(10, 0), P(3, 3), P(0, 10)])).toBeNull(); // a reflex corner
  });
});

describe('warpQuad', () => {
  it('copies the image exactly when the quad is the whole image', () => {
    const img = noise(13, 7, 5);
    const out = warpQuad(img, boxCorners(6.5, 3.5, 13, 7, 0), 13, 7)!;
    expect(out.width).toBe(13);
    expect(out.height).toBe(7);
    expect(Array.from(out.data)).toEqual(Array.from(img.data));
  });

  it("turns the image when the corners are turned: a quarter turn is rotate90, a half turn rotate180", () => {
    const img = noise(9, 6, 7);
    const [W, H] = [9, 6];
    const P = (x: number, y: number) => ({ x, y });
    expect(Array.from(warpQuad(img, [P(0, H), P(0, 0), P(W, 0), P(W, H)], H, W)!.data)).toEqual(Array.from(rotate90(img, 'cw').data));
    expect(Array.from(warpQuad(img, [P(W, H), P(0, H), P(0, 0), P(W, 0)], W, H)!.data)).toEqual(Array.from(rotate180(img).data));
    // Corners in the other order mirror it.
    const mirrored = warpQuad(img, [P(W, 0), P(0, 0), P(0, H), P(W, H)], W, H)!;
    expect(pixel(mirrored, 0, 0)).toEqual(pixel(img, W - 1, 0));
    expect(pixel(mirrored, 2, 3)).toEqual(pixel(img, W - 3, 3));
  });

  it('samples bilinearly: a linear ramp comes out as the ramp at the mapped points', () => {
    // Bilinear interpolation reproduces a linear function exactly; only the rounding to bytes remains.
    const img = image(64, 48, (x, y) => [3 * x + 20, 4 * y + 10, 128]);
    const quads: Quad[] = [
      boxCorners(30, 22, 30, 20, 0.4),
      [
        { x: 8, y: 6 },
        { x: 50, y: 10 },
        { x: 55, y: 40 },
        { x: 12, y: 35 },
      ],
    ];
    for (const quad of quads) {
      const [outW, outH] = [45, 30];
      const out = warpQuad(img, quad, outW, outH)!;
      const map = quadMap(quad)!;
      for (let j = 0; j < outH; j++) {
        for (let i = 0; i < outW; i++) {
          const p = map((i + 0.5) / outW, (j + 0.5) / outH);
          const [r, g, b, a] = pixel(out, i, j);
          expect(Math.abs(r - (3 * (p.x - 0.5) + 20))).toBeLessThanOrEqual(0.5 + 1e-6);
          expect(Math.abs(g - (4 * (p.y - 0.5) + 10))).toBeLessThanOrEqual(0.5 + 1e-6);
          expect([b, a]).toEqual([128, 255]);
        }
      }
    }
  });

  it('averages neighbouring pixels between their centres and repeats the edge pixel up to the border', () => {
    const img = image(2, 1, (x) => (x === 0 ? [10, 20, 30] : [30, 60, 90]));
    const P = (x: number, y: number) => ({ x, y });
    const whole: Quad = [P(0, 0), P(2, 0), P(2, 1), P(0, 1)];
    expect(Array.from(warpQuad(img, whole, 1, 1)!.data)).toEqual([20, 40, 60, 255]);
    // Samples at x = 0.25, 0.75, 1.25 and 1.75.
    const four = warpQuad(img, whole, 4, 1)!;
    expect([0, 1, 2, 3].map((i) => four.data[i * 4])).toEqual([10, 15, 25, 30]);
  });

  it('fills samples outside the image with opaque black and makes the output opaque', () => {
    const img = image(10, 8, (x, y) => [100 + x, 50 + y, 7], 0);
    // The image plus a 4 px margin, at 1:1.
    const out = warpQuad(img, boxCorners(5, 4, 18, 16, 0), 18, 16)!;
    for (let j = 0; j < 16; j++) {
      for (let i = 0; i < 18; i++) {
        const inside = i >= 4 && i < 14 && j >= 4 && j < 12;
        expect(pixel(out, i, j)).toEqual(inside ? [100 + i - 4, 50 + j - 4, 7, 255] : [0, 0, 0, 255]);
      }
    }
  });

  it('is null for a degenerate or non-convex quad', () => {
    const img = noise(8, 8);
    expect(warpQuad(img, boxCorners(4, 4, 0, 6, 0), 5, 5)).toBeNull();
    expect(warpQuad(img, [{ x: 0, y: 0 }, { x: 8, y: 8 }, { x: 8, y: 0 }, { x: 0, y: 8 }], 5, 5)).toBeNull();
  });
});

describe('letterbox', () => {
  const flat = (w: number, h: number) => image(w, h, () => [51, 102, 204]);
  const at = (lb: { tensor: Float32Array }, size: number, c: number, x: number, y: number) => lb.tensor[c * size * size + y * size + x];

  it('fits a landscape image to the width, centred between bands of the fill grey, as planar RGB in [0, 1]', () => {
    const lb = letterbox(flat(200, 100), 64, 1, 114);
    expect(lb.scale).toBe(0.32);
    expect([lb.padX, lb.padY]).toEqual([0, 16]);
    expect(lb.tensor).toHaveLength(3 * 64 * 64);
    for (let y = 0; y < 64; y++) {
      for (const x of [0, 31, 63]) {
        const content = y >= 16 && y < 48;
        [0.2, 0.4, 0.8].forEach((v, c) => expect(at(lb, 64, c, x, y)).toBeCloseTo(content ? v : 114 / 255, 6));
      }
    }
  });

  it('pads a portrait image left and right', () => {
    const lb = letterbox(flat(100, 200), 64, 1, 0);
    expect(lb.scale).toBe(0.32);
    expect([lb.padX, lb.padY]).toEqual([16, 0]);
    expect(at(lb, 64, 0, 15, 30)).toBe(0);
    expect(at(lb, 64, 0, 16, 30)).toBeCloseTo(0.2, 6);
    expect(at(lb, 64, 0, 47, 30)).toBeCloseTo(0.2, 6);
    expect(at(lb, 64, 0, 48, 30)).toBe(0);
  });

  it('leaves a margin all round when the content covers only a fraction, and grows small images', () => {
    const half = letterbox(flat(100, 100), 64, 0.5, 0);
    expect([half.scale, half.padX, half.padY]).toEqual([0.32, 16, 16]);
    const grown = letterbox(flat(8, 4), 64, 1, 0);
    expect([grown.scale, grown.padX, grown.padY]).toEqual([8, 0, 16]);
  });

  it('rounds each side to whole pixels and puts an odd leftover pixel after the content', () => {
    // 200·0.2848 = 56.96 → 57 wide: 7 px left over, 3 before and 4 after.
    const lb = letterbox(flat(200, 100), 64, 0.89, 0);
    expect([lb.padX, lb.padY]).toEqual([3, 18]);
    expect(at(lb, 64, 0, 2, 30)).toBe(0);
    expect(at(lb, 64, 0, 3, 30)).toBeCloseTo(0.2, 6);
    expect(at(lb, 64, 0, 59, 30)).toBeCloseTo(0.2, 6);
    expect(at(lb, 64, 0, 60, 30)).toBe(0);
  });

  it('holds the shared antialiased resize of the image', () => {
    const img = noise(90, 50, 3);
    const lb = letterbox(img, 48, 1, 114);
    const [w, h] = [48, 27];
    const rgb = resizeToFloatRGB(img, w, h);
    expect(lb.padY).toBe(10);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) expect(at(lb, 48, c, x, y + lb.padY)).toBeCloseTo(rgb[(y * w + x) * 3 + c] / 255, 6);
      }
    }
  });

  it("maps input points back to the image's pixels", () => {
    const lb = letterbox(flat(200, 100), 64, 1, 114);
    expectPoint(fromLetterbox(lb, { x: 0, y: 16 }), 0, 0);
    expectPoint(fromLetterbox(lb, { x: 64, y: 48 }), 200, 100);
    expectPoint(fromLetterbox(lb, { x: 37 * 0.32, y: 81 * 0.32 + 16 }), 37, 81);
  });
});
