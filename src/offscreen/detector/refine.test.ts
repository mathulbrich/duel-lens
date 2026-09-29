import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../shared/preprocess';
import { boxCorners, polygonIoU, type Pt } from './geometry';
import { estimateTilt, refineCard } from './refine';

/** A W×H image with a filled quad (a bright card with an inner "art box" line) on a dark mat. */
function scene(W: number, H: number, quad: Pt[], opts: { inner?: boolean; noise?: number } = {}): RGBAImage {
  const data = new Uint8ClampedArray(W * H * 4);
  const inside = (q: Pt[], x: number, y: number) => {
    let s = 0;
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = q[k];
      const [bx, by] = q[(k + 1) % 4];
      const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (c !== 0) {
        if (s === 0) s = Math.sign(c);
        else if (Math.sign(c) !== s) return false;
      }
    }
    return true;
  };
  // the art box: the card's quad shrunk to its middle (bilinear in the quad)
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const at = (u: number, v: number): Pt => lerp(lerp(quad[0], quad[1], u), lerp(quad[3], quad[2], u), v);
  const art: Pt[] = [at(0.12, 0.18), at(0.88, 0.18), at(0.88, 0.7), at(0.12, 0.7)];
  let seed = 3;
  const shade = (x: number, y: number) => (inside(quad, x, y) ? (opts.inner && inside(art, x, y) ? 120 : 200) : 40);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      // anti-aliased like a camera image: 3×3 samples per pixel
      let v = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) v += shade(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
      v /= 9;
      seed = (seed * 16807) % 2147483647;
      v += ((seed / 2147483647) - 0.5) * (opts.noise ?? 0);
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  return { data, width: W, height: H };
}

const cornerError = (a: Pt[], b: Pt[]) => {
  let best = Infinity;
  for (let s = 0; s < 4; s++) {
    let e = 0;
    for (let k = 0; k < 4; k++) e += Math.hypot(a[(k + s) % 4][0] - b[k][0], a[(k + s) % 4][1] - b[k][1]);
    best = Math.min(best, e / 4);
  }
  return best;
};

describe('estimateTilt', () => {
  it('finds a card tilt from the gradient orientations, modulo 90 degrees, near the guess', () => {
    for (const deg of [0, 4, -7, 12, 25, -28]) {
      const t = (deg * Math.PI) / 180;
      const img = scene(320, 320, boxCorners(160, 160, 110, 160, t), { inner: true, noise: 12 });
      const est = estimateTilt(img, { cx: 160, cy: 160, w: 110, h: 160, angle: 0 });
      expect(est).not.toBeNull();
      expect(Math.abs(((est! - t + Math.PI / 4) % (Math.PI / 2)) - Math.PI / 4)).toBeLessThan((1.2 * Math.PI) / 180);
    }
  }, 60_000);
});

describe('refineCard', () => {
  it('turns an axis-aligned detection of a tilted card into its tilted outline', () => {
    const t = (14 * Math.PI) / 180;
    const truth = boxCorners(200, 170, 100, 146, t);
    const img = scene(400, 340, truth, { inner: true, noise: 10 });
    const det = { cx: 201, cy: 169, w: 96, h: 140, angle: 0, pts: boxCorners(201, 169, 96, 140, 0) };
    const out = refineCard(img, det);
    expect(cornerError(out.pts, truth)).toBeLessThan(3);
    expect(cornerError(det.pts, truth)).toBeGreaterThan(8);
    expect(out.refined).toBe('quad');
  }, 60_000);

  it('follows a keystone quad (far edge narrower)', () => {
    const truth: Pt[] = [
      [140, 60],
      [250, 64],
      [268, 250],
      [118, 244],
    ];
    const img = scene(400, 320, truth, { inner: true, noise: 10 });
    const det = { cx: 194, cy: 155, w: 128, h: 180, angle: 0, pts: boxCorners(194, 155, 128, 180, 0) };
    const out = refineCard(img, det);
    expect(cornerError(out.pts, truth)).toBeLessThan(4);
    expect(polygonIoU(out.pts, truth)).toBeGreaterThan(0.93);
  }, 60_000);

  it('keeps the detection when the image has no card edges there', () => {
    const flat = scene(200, 200, boxCorners(-500, -500, 1, 1, 0));
    const det = { cx: 100, cy: 100, w: 60, h: 88, angle: 0.1, pts: boxCorners(100, 100, 60, 88, 0.1) };
    const out = refineCard(flat, det);
    expect(out.refined).toBe('none');
    expect(out.pts).toEqual(det.pts);
  });
});
