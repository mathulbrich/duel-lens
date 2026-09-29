import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../../shared/preprocess';
import { resizeToFloatRGB } from '../../shared/preprocess';
import { toModelInput } from './preprocess';

function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return { data, width: w, height: h };
}

const OPTS = { longSide: 1280, align: 32, fill: 114 };

describe('toModelInput', () => {
  it('shrinks a screenshot to the long side, pads to /32 with the fill grey, CHW in [0, 1]', () => {
    const img = image(1456, 819, () => [255, 0, 51]);
    const t = toModelInput(img, OPTS);
    expect([t.contentWidth, t.contentHeight, t.width, t.height]).toEqual([1280, 720, 1280, 736]);
    expect(t.scaleX).toBeCloseTo(1280 / 1456, 9);
    expect(t.scaleY).toBeCloseTo(720 / 819, 9);
    const plane = t.width * t.height;
    expect(t.data.length).toBe(3 * plane);
    // content: the flat colour survives the resize
    expect(t.data[0]).toBeCloseTo(1, 5);
    expect(t.data[plane]).toBeCloseTo(0, 5);
    expect(t.data[2 * plane]).toBeCloseTo(0.2, 5);
    // padding rows below the content
    expect(t.data[725 * t.width + 3]).toBeCloseTo(114 / 255, 6);
  });

  it('never enlarges unless asked', () => {
    const small = image(300, 200, () => [10, 20, 30]);
    const t = toModelInput(small, OPTS);
    expect([t.contentWidth, t.contentHeight, t.width, t.height, t.scaleX]).toEqual([300, 200, 320, 224, 1]);
    const big = toModelInput(small, { ...OPTS, longSide: 448, enlarge: true });
    expect([big.contentWidth, big.contentHeight, big.width, big.height]).toEqual([448, 299, 448, 320]);
  });

  it('copies pixels exactly when no resize is needed', () => {
    const img = image(64, 32, (x, y) => [x * 4, y * 8, 7]);
    const t = toModelInput(img, OPTS);
    expect(t.data[5 * t.width + 9]).toBeCloseTo(36 / 255, 6);
    expect(t.data[t.width * t.height + 5 * t.width + 9]).toBeCloseTo(40 / 255, 6);
  });

  it('matches the shared antialiased resize (Pillow bilinear) on a gradient', () => {
    const img = image(1000, 500, (x, y) => [(x * 7 + y) % 256, (y * 3) % 256, (x + y * 5) % 256]);
    const t = toModelInput(img, { ...OPTS, longSide: 700 });
    const ref = resizeToFloatRGB(img, t.contentWidth, t.contentHeight);
    let worst = 0;
    for (let y = 0; y < t.contentHeight; y += 7)
      for (let x = 0; x < t.contentWidth; x += 5)
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(t.data[c * t.width * t.height + y * t.width + x] * 255 - ref[(y * t.contentWidth + x) * 3 + c]));
    expect(worst).toBeLessThan(0.01);
  });

  it('halves a Retina capture first and still lands on the same size', () => {
    const img = image(2912, 1638, (x) => [x % 256, 128, 0]);
    const t = toModelInput(img, OPTS);
    expect([t.contentWidth, t.contentHeight, t.width, t.height]).toEqual([1280, 720, 1280, 736]);
    expect(t.data[t.width * t.height + 100 * t.width + 100]).toBeCloseTo(128 / 255, 5);
  });
});
