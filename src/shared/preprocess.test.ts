import { describe, expect, it } from 'vitest';
import {
  cropRGBA,
  l2normalize,
  preprocess,
  resizeRGBA,
  rotate180,
  rotate90,
  toTensorCHW,
  type RGBAImage,
} from './preprocess';
import type { EmbeddingModelSpec } from './models';

function img(width: number, height: number, pixels: number[][]): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, i) => data.set([p[0], p[1], p[2], 255], i * 4));
  return { data, width, height };
}
const px = (im: RGBAImage, x: number, y: number) => Array.from(im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 3));

const spec = (inputSize: number): EmbeddingModelSpec => ({
  id: 't', label: 't', file: 't.onnx', sourceUrl: '', license: '', inputSize,
  mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], inputName: 'x', outputName: 'y',
  pooling: 'none', dim: 4, thresholds: { score: 0.5, margin: 0.05, floor: 0.2 },
});

describe('resizeRGBA', () => {
  it('returns identical pixels when the size does not change', () => {
    const a = img(2, 2, [[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]]);
    const b = resizeRGBA(a, 2, 2);
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
  });

  it('averages pixels when downscaling 2x2 to 1x1', () => {
    const a = img(2, 2, [[0, 0, 0], [100, 100, 100], [200, 200, 200], [40, 40, 40]]);
    expect(px(resizeRGBA(a, 1, 1), 0, 0)).toEqual([85, 85, 85]);
  });

  it('keeps a flat colour flat when upscaling', () => {
    const a = img(1, 1, [[12, 34, 56]]);
    const b = resizeRGBA(a, 3, 3);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) expect(px(b, x, y)).toEqual([12, 34, 56]);
  });

  it('is deterministic', () => {
    const a = img(3, 2, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], [16, 17, 18]]);
    expect(Array.from(resizeRGBA(a, 5, 7).data)).toEqual(Array.from(resizeRGBA(a, 5, 7).data));
  });
});

describe('cropRGBA / rotations', () => {
  const a = img(3, 2, [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 5, 5], [6, 6, 6]]);

  it('crops a sub-rectangle', () => {
    const c = cropRGBA(a, 1, 0, 2, 2);
    expect(c.width).toBe(2);
    expect(c.height).toBe(2);
    expect([px(c, 0, 0)[0], px(c, 1, 0)[0], px(c, 0, 1)[0], px(c, 1, 1)[0]]).toEqual([2, 3, 5, 6]);
  });

  it('clamps crops that stick out of the image', () => {
    const c = cropRGBA(a, 2, 1, 5, 5);
    expect([c.width, c.height]).toEqual([1, 1]);
    expect(px(c, 0, 0)[0]).toBe(6);
  });

  it('rotates 180 degrees', () => {
    const r = rotate180(a);
    expect([px(r, 0, 0)[0], px(r, 2, 1)[0]]).toEqual([6, 1]);
  });

  it('rotates 90 degrees clockwise and back', () => {
    const r = rotate90(a, 'cw');
    expect([r.width, r.height]).toEqual([2, 3]);
    // top-left of a cw rotation is the bottom-left of the source
    expect(px(r, 0, 0)[0]).toBe(4);
    expect(px(r, 1, 0)[0]).toBe(1);
    const back = rotate90(r, 'ccw');
    expect(Array.from(back.data)).toEqual(Array.from(a.data));
  });
});

describe('toTensorCHW / preprocess', () => {
  it('normalises into channel-first floats', () => {
    const rgb = new Float32Array([255, 0, 127.5]); // one pixel, HWC
    const t = toTensorCHW(rgb, 1, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(Array.from(t)).toEqual([1, -1, 0]);
  });

  it('produces a 3 x S x S tensor', () => {
    const a = img(2, 2, [[255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0]]);
    const t = preprocess(a, spec(4));
    expect(t.length).toBe(3 * 4 * 4);
    expect(t[0]).toBeCloseTo(1, 5); // top row is white
    expect(t[4 * 4 - 1]).toBeCloseTo(-1, 5); // bottom-right of channel 0 is black
  });
});

describe('l2normalize', () => {
  it('scales to unit length', () => {
    const v = l2normalize(new Float32Array([3, 4]));
    expect(v[0]).toBeCloseTo(0.6, 6);
    expect(v[1]).toBeCloseTo(0.8, 6);
  });
  it('leaves a zero vector at zero instead of NaN', () => {
    expect(Array.from(l2normalize(new Float32Array([0, 0])))).toEqual([0, 0]);
  });
});
