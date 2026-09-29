import { describe, expect, it } from 'vitest';
import { CROP_MARGIN } from '../content/capture';
import { expandRect } from '../content/geometry';
import type { RGBAImage } from '../shared/preprocess';
import { boxCorners, warpQuad, type Quad } from './geometry';
import { SELECTION_MARGIN } from './hypotheses';
import { fillUnseen, frameSides, padSides, sidesReached, warpQuadMasked } from './truncation';

/** A w×h image whose pixels encode their coordinates (red = x, green = y, blue 50). */
function coords(w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([x, y, 50, 255], (y * w + x) * 4);
  return { data, width: w, height: h };
}

/**
 * The content script's crop of `box` from a W×H picture, as capture.ts cuts it at scale 1: the box plus
 * CROP_MARGIN per side, clipped to the picture, in whole pixels; and the box inside the crop (crop.inner).
 */
function contentCrop(box: { x: number; y: number; w: number; h: number }, W: number, H: number) {
  const region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: W, h: H });
  const x = Math.floor(region.x);
  const y = Math.floor(region.y);
  const w = Math.max(1, Math.ceil(region.x + region.w) - x);
  const h = Math.max(1, Math.ceil(region.y + region.h) - y);
  const clip = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const x0 = clip(box.x - x, w);
  const y0 = clip(box.y - y, h);
  const inner = { x: x0, y: y0, w: clip(box.x + box.w - x, w) - x0, h: clip(box.y + box.h - y, h) - y0 };
  return { w, h, inner };
}

describe('frameSides', () => {
  it("assumes the content script's margin (the two constants must agree)", () => {
    expect(SELECTION_MARGIN).toBe(CROP_MARGIN);
  });

  it('finds no picture edge in a crop with its whole margin on every side', () => {
    for (const box of [
      { x: 300, y: 200, w: 100, h: 146 },
      { x: 300.4, y: 200.7, w: 99.3, h: 145.2 }, // fractional boxes: the crop's whole pixels only add margin
      { x: 5, y: 7, w: 100, h: 146 }, // near the picture's corner, but the margin fits
    ]) {
      const c = contentCrop(box, 1920, 1080);
      expect(frameSides(c.w, c.h, c.inner)).toEqual([]);
    }
  });

  it('finds the picture edges the margin was clipped at, and only those', () => {
    const top = contentCrop({ x: 900, y: 0, w: 134, h: 94 }, 1920, 1080); // a card cut by the top edge
    expect(frameSides(top.w, top.h, top.inner)).toEqual(['top']);
    const spill = contentCrop({ x: 1073, y: -30, w: 154, h: 105 }, 1920, 1080); // an outline running past the top
    expect(frameSides(spill.w, spill.h, spill.inner)).toEqual(['top']);
    const corner = contentCrop({ x: 1800, y: 1000, w: 120, h: 80 }, 1920, 1080);
    expect(frameSides(corner.w, corner.h, corner.inner)).toEqual(['right', 'bottom']);
    const near = contentCrop({ x: 2, y: 500, w: 100, h: 146 }, 1920, 1080); // 2 px from the edge: a short margin
    expect(frameSides(near.w, near.h, near.inner)).toEqual(['left']);
  });

  it('cannot tell without the box inside the crop', () => {
    expect(frameSides(200, 300, null)).toEqual([]);
    expect(frameSides(200, 300, { x: Number.NaN, y: 0, w: 10, h: 10 })).toEqual([]);
  });
});

describe('sidesReached', () => {
  const quad = boxCorners(50, 40, 60, 90, 0); // x 20..80, y -5..85 in a 100×100 image
  it('lists the given sides a corner reaches within the tolerance, or passes', () => {
    expect(sidesReached(quad, 100, 100, ['top', 'bottom', 'left', 'right'], 2)).toEqual(['top']);
    expect(sidesReached(quad, 100, 86, ['bottom'], 2)).toEqual(['bottom']); // 1 px short of the edge
    expect(sidesReached(quad, 100, 90, ['bottom'], 2)).toEqual([]);
    expect(sidesReached(quad, 100, 100, ['left', 'right'], 2)).toEqual([]);
  });
});

describe('padSides', () => {
  it('adds flat grey past the given sides and keeps the image where it was, shifted', () => {
    const img = coords(20, 10);
    const { image, dx, dy } = padSides(img, ['left', 'top'], 5, 114);
    expect([image.width, image.height, dx, dy]).toEqual([25, 15, 5, 5]);
    expect(Array.from(image.data.subarray(0, 4))).toEqual([114, 114, 114, 255]);
    const at = (x: number, y: number) => Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
    expect(at(5 + 7, 5 + 3)).toEqual([7, 3, 50]);
    expect(padSides(img, [], 5, 114).image).toEqual(img);
  });
});

describe('warpQuadMasked', () => {
  const img = coords(40, 30);
  it("straightens a quad inside the image exactly as warpQuad does, all of it seen", () => {
    const q: Quad = [
      { x: 4, y: 3 },
      { x: 30, y: 5 },
      { x: 28, y: 27 },
      { x: 6, y: 25 },
    ];
    const w = warpQuadMasked(img, q, 20, 30)!;
    expect(w.image).toEqual(warpQuad(img, q, 20, 30));
    expect(w.seenShare).toBe(1);
  });

  it('marks what falls outside the image: black by default, or the border stretched out (edge)', () => {
    // The top third of this quad is above the image.
    const q: Quad = [
      { x: 10, y: -15 },
      { x: 30, y: -15 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
    ];
    const black = warpQuadMasked(img, q, 20, 45)!;
    expect(black.image).toEqual(warpQuad(img, q, 20, 45));
    expect(black.seenShare).toBeCloseTo(30 / 45, 1);
    const px = (w: typeof black, x: number, y: number) => Array.from(w.image.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 3));
    expect(black.seen[2 * 20 + 5]).toBe(0);
    expect(px(black, 5, 2)).toEqual([0, 0, 0]);
    const edge = warpQuadMasked(img, q, 20, 45, 'edge')!;
    expect(edge.seen).toEqual(black.seen);
    expect(px(edge, 5, 2)[1]).toBe(0); // the image's top row, repeated upwards
    expect(px(edge, 5, 40)).toEqual(px(black, 5, 40)); // what was seen is the same
  });

  it('refuses a degenerate quad', () => {
    expect(warpQuadMasked(img, [{ x: 1, y: 1 }, { x: 5, y: 5 }, { x: 9, y: 9 }, { x: 1, y: 1 }], 10, 10)).toBeNull();
  });
});

describe('fillUnseen', () => {
  it('paints what was not seen in the mean colour of what was', () => {
    const img: RGBAImage = { data: new Uint8ClampedArray(40 * 30 * 4).fill(200), width: 40, height: 30 };
    const q: Quad = [
      { x: 0, y: -30 },
      { x: 40, y: -30 },
      { x: 40, y: 30 },
      { x: 0, y: 30 },
    ];
    const w = warpQuadMasked(img, q, 59, 86)!;
    const filled = fillUnseen(w, 'mean');
    expect(Array.from(filled.data.subarray(0, 4))).toEqual([200, 200, 200, 255]);
    expect(Array.from(fillUnseen(w, 'grey').data.subarray(0, 3))).toEqual([128, 128, 128]);
  });
});
