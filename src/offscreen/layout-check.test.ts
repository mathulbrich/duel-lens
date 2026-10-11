import { describe, expect, it } from 'vitest';
import { rotate180, type RGBAImage } from '../shared/preprocess';
import { GRID_H, GRID_W, layoutGrid, ORIENTATION_MIN, orientationOf } from './layout-check';

type RGB = [number, number, number];

/**
 * A 590×860 card as a video shows one: `frame` around a busy art window (ART_BOX), a light name bar and a cream text
 * box at the bottom.
 */
function card(frame: RGB, w = 590, h = 860): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = x / w;
      const fy = y / h;
      let c: number[] = frame;
      if (fx > 0.118 && fx < 0.883 && fy > 0.181 && fy < 0.706) c = [(x * 7) % 256, (y * 5) % 256, ((x + y) * 3) % 256];
      else if (fx > 0.07 && fx < 0.93 && fy > 0.76 && fy < 0.93) c = [225, 215, 190];
      else if (fx > 0.06 && fx < 0.8 && fy > 0.035 && fy < 0.095) c = [200, 190, 170];
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

/** Art all over (a sleeve printed with art), with no text box: seeded noise. */
function artAllOver(w = 590, h = 860): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < w * h; i++) data.set([rnd() * 255, rnd() * 255, rnd() * 255, 255], i * 4);
  return { data, width: w, height: h };
}

describe('layoutGrid', () => {
  it('averages the pixels each cell covers, at any size', () => {
    for (const [w, h] of [
      [590, 860],
      [59, 86],
    ]) {
      const img = card([40, 140, 120], w, h);
      // Left half red, right half blue.
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(x < w / 2 ? [255, 0, 0] : [0, 0, 255], (y * w + x) * 4);
      const g = layoutGrid(img);
      expect(g.r).toHaveLength(GRID_W * GRID_H);
      expect([g.r[0], g.b[0]]).toEqual([255, 0]);
      expect([g.r[GRID_W - 1], g.b[GRID_W - 1]]).toEqual([0, 255]);
    }
  });
});

describe('orientationOf', () => {
  it("calls a card upright by its text box at the bottom, upside down turned 180°, and makes no call on a card with no text box", () => {
    const up = orientationOf(card([40, 140, 120]));
    expect(up.orientation).toBe('upright');
    expect(up.orientationEvidence).toBeGreaterThanOrEqual(ORIENTATION_MIN);
    const down = orientationOf(rotate180(card([40, 140, 120])));
    expect(down.orientation).toBe('upside-down');
    expect(down.orientationEvidence).toBeCloseTo(-up.orientationEvidence, 6);
    expect(orientationOf(artAllOver()).orientation).toBeNull();
  });

  it('calls a card whatever its frame colour (Spell green, Trap magenta, Effect orange, Xyz black)', () => {
    for (const frame of [
      [40, 140, 120],
      [170, 60, 120],
      [190, 110, 60],
      [30, 30, 35],
    ] as RGB[]) {
      expect(orientationOf(card(frame)).orientation).toBe('upright');
      expect(orientationOf(rotate180(card(frame))).orientation).toBe('upside-down');
    }
  });

  it('takes a few milliseconds on a straightened card', () => {
    const img = card([40, 140, 120]);
    orientationOf(img);
    const t = performance.now();
    for (let i = 0; i < 10; i++) orientationOf(img);
    expect((performance.now() - t) / 10).toBeLessThan(20);
  });
});
