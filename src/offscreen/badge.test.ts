import { describe, expect, it } from 'vitest';
import type { RGBAImage } from '../shared/preprocess';
import { BADGE, findBadge, inpaint } from './badge';

// A straightened card is CARD_W x CARD_H; the tests use a smaller card of the same shape (the finder works in
// shares of the card's size).
const W = 295;
const H = 430;
type RGB = [number, number, number];

function card(fill: RGB = [120, 90, 70]): RGBAImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...fill, 255], i * 4);
  return { data, width: W, height: H };
}

/** Paints the rectangle (shares of the card) in `c`. */
function rect(img: RGBAImage, x: number, y: number, w: number, h: number, c: RGB): RGBAImage {
  for (let py = Math.round(y * H); py < Math.round((y + h) * H); py++) {
    for (let px = Math.round(x * W); px < Math.round((x + w) * W); px++) img.data.set([...c, 255], (py * W + px) * 4);
  }
  return img;
}

const WHITE: RGB = [245, 245, 240];

/** A simulator's "1": a white upright stroke with a flag and a foot (stroke-like, not a filled block), `h` of the card tall. */
function one(img: RGBAImage, cx: number, top: number, h = 0.18): RGBAImage {
  rect(img, cx - 0.02, top, 0.04, h, WHITE); // the stem
  rect(img, cx - 0.06, top, 0.04, 0.03, WHITE); // the flag
  return rect(img, cx - 0.06, top + h - 0.025, 0.12, 0.025, WHITE); // the foot
}

/** A "0": a white ring, `h` of the card tall. */
function zero(img: RGBAImage, cx: number, top: number, h = 0.18): RGBAImage {
  const w = 0.1;
  rect(img, cx - w / 2, top, w, 0.025, WHITE);
  rect(img, cx - w / 2, top + h - 0.025, w, 0.025, WHITE);
  rect(img, cx - w / 2, top, 0.03, h, WHITE);
  return rect(img, cx + w / 2 - 0.03, top, 0.03, h, WHITE);
}

const whitePixels = (img: RGBAImage) => {
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) if (Math.min(img.data[i], img.data[i + 1], img.data[i + 2]) >= BADGE.white) n++;
  return n;
};

describe('findBadge: a simulator\'s pile-count badge over the art (diag-t950-report.md)', () => {
  it('finds a "1" at the card\'s centre, and masks it with a margin', () => {
    const img = one(card(), 0.5, 0.41);
    const badge = findBadge(img);
    expect(badge).not.toBeNull();
    expect(badge!.glyphs).toHaveLength(1);
    const [g] = badge!.glyphs;
    expect(g.h).toBeCloseTo(0.18, 1);
    // Every white pixel is under the mask, and the mask reaches a little past them.
    let masked = 0;
    for (let p = 0; p < W * H; p++) {
      if (Math.min(img.data[p * 4], img.data[p * 4 + 1], img.data[p * 4 + 2]) >= BADGE.white) expect(badge!.mask[p]).toBe(1);
      masked += badge!.mask[p];
    }
    expect(masked).toBeGreaterThan(whitePixels(img));
  });

  it('finds both digits of a "10"', () => {
    const img = zero(one(card(), 0.44, 0.41), 0.56, 0.41);
    expect(findBadge(img)?.glyphs).toHaveLength(2);
  });

  it('finds nothing in white artwork that is no number: a big white shape, small highlights, a solid block', () => {
    // White hair or a white dragon: far taller and wider than a digit.
    expect(findBadge(rect(card(), 0.2, 0.25, 0.6, 0.45, WHITE))).toBeNull();
    // Specular highlights: specks far smaller than a digit.
    const specks = card();
    for (let i = 0; i < 12; i++) rect(specks, 0.3 + (i % 4) * 0.1, 0.35 + Math.floor(i / 4) * 0.1, 0.02, 0.02, WHITE);
    expect(findBadge(specks)).toBeNull();
    // A digit-sized block filled solid (a white box, a window): no stroke.
    expect(findBadge(rect(card(), 0.45, 0.41, 0.1, 0.18, WHITE))).toBeNull();
  });

  it("finds nothing in a white card frame, or a digit off the card's centre (the level stars, the text box)", () => {
    // A white (Synchro) frame: a border all round the card.
    const frame = card();
    rect(frame, 0, 0, 1, 0.04, WHITE);
    rect(frame, 0, 0.96, 1, 0.04, WHITE);
    rect(frame, 0, 0, 0.05, 1, WHITE);
    rect(frame, 0.95, 0, 0.05, 1, WHITE);
    expect(findBadge(frame)).toBeNull();
    // A "1" in the text box (low on the card) or at its side.
    expect(findBadge(one(card(), 0.5, 0.72))).toBeNull();
    expect(findBadge(one(card(), 0.16, 0.41))).toBeNull();
  });

  it('finds nothing in a coloured or grey glyph (only near-white, unsaturated strokes count)', () => {
    const img = card();
    rect(img, 0.48, 0.41, 0.04, 0.18, [250, 200, 60]); // yellow
    expect(findBadge(img)).toBeNull();
    const grey = card();
    rect(grey, 0.48, 0.41, 0.04, 0.18, [170, 170, 170]);
    expect(findBadge(grey)).toBeNull();
  });
});

describe('inpaint', () => {
  it('fills the masked pixels from their surroundings, inwards, and leaves the rest as it was', () => {
    const base = card([100, 140, 60]);
    const img = one(card([100, 140, 60]), 0.5, 0.41);
    const badge = findBadge(img)!;
    const out = inpaint(img, badge.mask);
    expect(whitePixels(out)).toBe(0);
    for (let p = 0; p < W * H; p++) {
      const i = p * 4;
      if (badge.mask[p]) {
        // Filled from the flat colour around it.
        expect(Math.abs(out.data[i] - 100) + Math.abs(out.data[i + 1] - 140) + Math.abs(out.data[i + 2] - 60)).toBeLessThanOrEqual(3);
      } else {
        expect([out.data[i], out.data[i + 1], out.data[i + 2]]).toEqual([img.data[i], img.data[i + 1], img.data[i + 2]]);
      }
    }
    expect(out.data).not.toBe(img.data); // a new image
    expect(whitePixels(img)).toBeGreaterThan(0); // the input is left as it was
    expect(base.width).toBe(out.width);
  });
});
