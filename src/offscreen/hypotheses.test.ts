import { describe, expect, it } from 'vitest';
import { ART_BOX, CARD_ASPECT } from '../shared/card-layout';
import type { RGBAImage } from '../shared/preprocess';
import { buildHypotheses, type Hypothesis } from './hypotheses';

// Every pixel encodes its own coordinates, so any output pixel tells where it came from.
function coordImage(width: number, height: number): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x & 255;
      data[i + 1] = y & 255;
      data[i + 2] = ((x >> 8) & 15) | (((y >> 8) & 15) << 4);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Source coordinates of pixel (x, y) of an image cut out of a coordImage. */
function sourceOf(img: RGBAImage, x: number, y: number): [number, number] {
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i] | ((d[i + 2] & 15) << 8), d[i + 1] | ((d[i + 2] >> 4) << 8)];
}

/**
 * A coordImage card of w×h with a margin of another colour around it: 4% per side, as the
 * content script adds, unless a side is given (a margin clipped at the frame's edge).
 */
function selectionAround(
  cardW: number,
  cardH: number,
  sides: { left?: number; right?: number; top?: number; bottom?: number } = {},
): { img: RGBAImage; mx: number; my: number } {
  const mx = sides.left ?? Math.round(cardW * 0.04);
  const my = sides.top ?? Math.round(cardH * 0.04);
  const card = coordImage(cardW, cardH);
  const width = cardW + mx + (sides.right ?? Math.round(cardW * 0.04));
  const height = cardH + my + (sides.bottom ?? Math.round(cardH * 0.04));
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < cardH; y++) {
    data.set(card.data.subarray(y * cardW * 4, (y + 1) * cardW * 4), ((y + my) * width + mx) * 4);
  }
  return { img: { data, width, height }, mx, my };
}

const find = (hs: Hypothesis[], id: Hypothesis['id'], rotation: number) =>
  hs.find((h) => h.id === id && h.rotation === rotation);

function expectNear(actual: [number, number], expected: [number, number], tol: number) {
  expect(Math.abs(actual[0] - expected[0])).toBeLessThanOrEqual(tol);
  expect(Math.abs(actual[1] - expected[1])).toBeLessThanOrEqual(tol);
}

describe('buildHypotheses', () => {
  it('cuts the art box of a warped card, upright and upside down', () => {
    const card = coordImage(590, 860);
    const hs = buildHypotheses(coordImage(300, 300), card);

    const up = find(hs, 'quad', 0)!;
    expect(up).toBeDefined();
    expect(Math.abs(up.image.width - ART_BOX.w * 590)).toBeLessThanOrEqual(1);
    expect(Math.abs(up.image.height - ART_BOX.h * 860)).toBeLessThanOrEqual(1);
    // Top-left and bottom-right pixels are the art box corners of the card.
    expectNear(sourceOf(up.image, 0, 0), [ART_BOX.x * 590, ART_BOX.y * 860], 1);
    expectNear(
      sourceOf(up.image, up.image.width - 1, up.image.height - 1),
      [(ART_BOX.x + ART_BOX.w) * 590 - 1, (ART_BOX.y + ART_BOX.h) * 860 - 1],
      1,
    );

    // Upside down: the art box of the card turned 180°, which starts near the card's
    // bottom-right corner (the art box is not vertically centred on the card).
    const down = find(hs, 'quad', 180)!;
    expect(down).toBeDefined();
    expect([down.image.width, down.image.height]).toEqual([up.image.width, up.image.height]);
    expectNear(sourceOf(down.image, 0, 0), [589 - ART_BOX.x * 590, 859 - ART_BOX.y * 860], 1);
  });

  it('cuts every straightened view of the card, upright and upside down, in order', () => {
    const views = [coordImage(590, 860), coordImage(590, 860), coordImage(590, 860)];
    const quads = buildHypotheses(coordImage(300, 300), views).filter((h) => h.id === 'quad');
    expect(quads.map((h) => h.rotation)).toEqual([0, 0, 0, 180, 180, 180]);
  });

  it('reads only the straightened card with userBoxWithCard false; the box as drawn when there is none', () => {
    const card = coordImage(590, 860);
    const ids = (hs: Hypothesis[]) => [...new Set(hs.map((h) => h.id))];
    expect(ids(buildHypotheses(coordImage(300, 300), card, null, { userBoxWithCard: false }))).toEqual(['quad']);
    expect(ids(buildHypotheses(coordImage(300, 300), null, null, { userBoxWithCard: false })).sort()).toEqual(['art', 'fit']);
    expect(ids(buildHypotheses(coordImage(300, 300), card)).sort()).toEqual(['art', 'fit', 'quad']);
  });

  it('reads a card-shaped box with no card as a whole card only when artOfCardShapedBox is false', () => {
    const portrait = coordImage(590 + 48, 860 + 70);
    const ids = (hs: Hypothesis[]) => [...new Set(hs.map((h) => h.id))].sort();
    expect(ids(buildHypotheses(portrait, null, null, { artOfCardShapedBox: false }))).toEqual(['whole']);
    expect(ids(buildHypotheses(portrait))).toEqual(['art', 'whole']);
    // A box that isn't card-shaped keeps its centre square.
    expect(ids(buildHypotheses(coordImage(300, 300), null, null, { artOfCardShapedBox: false }))).toEqual(['art', 'fit']);
  });

  it('has no quad hypotheses without a warped card', () => {
    expect(buildHypotheses(coordImage(300, 300), null).some((h) => h.id === 'quad')).toBe(false);
    expect(buildHypotheses(coordImage(300, 300)).some((h) => h.id === 'quad')).toBe(false);
  });

  it('treats a card-shaped selection as a whole card, inside the 4% margin', () => {
    const cardW = 200;
    const cardH = Math.round(cardW / CARD_ASPECT);
    const { img, mx, my } = selectionAround(cardW, cardH);
    const hs = buildHypotheses(img);

    const whole = find(hs, 'whole', 0)!;
    expect(whole).toBeDefined();
    // Card coordinates of the art box corner (the margin is white, never a coordinate).
    expectNear(sourceOf(whole.image, 0, 0), [ART_BOX.x * cardW, ART_BOX.y * cardH], 2);
    expect(Math.abs(whole.image.width - ART_BOX.w * cardW)).toBeLessThanOrEqual(2);
    expect(Math.abs(whole.image.height - ART_BOX.h * cardH)).toBeLessThanOrEqual(2);

    // Upside down: cut from the selection turned 180°.
    const wholeDown = find(hs, 'whole', 180)!;
    expect(wholeDown).toBeDefined();
    expectNear(sourceOf(wholeDown.image, 0, 0), [cardW - 1 - ART_BOX.x * cardW, cardH - 1 - ART_BOX.y * cardH], 2);
    expect(mx).toBeGreaterThan(0);
    expect(my).toBeGreaterThan(0);
  });

  it('accepts card shapes within ±0.12 of the card aspect, and not beyond', () => {
    const hasWhole = (w: number, h: number) => buildHypotheses(coordImage(w, h)).some((x) => x.id === 'whole');
    expect(hasWhole(Math.round(300 * (CARD_ASPECT - 0.11)), 300)).toBe(true);
    expect(hasWhole(Math.round(300 * (CARD_ASPECT + 0.11)), 300)).toBe(true);
    expect(hasWhole(Math.round(300 * (CARD_ASPECT - 0.14)), 300)).toBe(false);
    expect(hasWhole(Math.round(300 * (CARD_ASPECT + 0.14)), 300)).toBe(false);
  });

  it('fits a card-shaped rectangle inside a box that is too wide to be a card (a tilted card), upright and upside down', () => {
    // The user's real case: a card tilted ~5° inside a 162×197 box (aspect 0.82, beyond the tolerance).
    const img = coordImage(176, 213);
    const inner = { x: 7, y: 8, w: 162, h: 197 };
    const hs = buildHypotheses(img, null, inner);
    const fit = find(hs, 'fit', 0)!;
    expect(fit).toBeDefined();
    // The largest card-shaped rectangle in the box: full height, width h × CARD_ASPECT, centred.
    const ch = 197;
    const cw = ch * CARD_ASPECT;
    const x0 = inner.x + (inner.w - cw) / 2;
    expectNear(sourceOf(fit.image, 0, 0), [x0 + ART_BOX.x * cw, inner.y + ART_BOX.y * ch], 2);
    expect(Math.abs(fit.image.width - ART_BOX.w * cw)).toBeLessThanOrEqual(2);
    expect(Math.abs(fit.image.height - ART_BOX.h * ch)).toBeLessThanOrEqual(2);
    const down = find(hs, 'fit', 180)!;
    expect(down).toBeDefined();
    expectNear(sourceOf(down.image, 0, 0), [175 - (x0 + ART_BOX.x * cw), 212 - (inner.y + ART_BOX.y * ch)], 2);
    // The centre square is still tried too.
    expect(find(hs, 'art', 0)).toBeDefined();
  });

  it('fits a sideways card in a box much wider than a card, turned both ways', () => {
    const img = coordImage(440, 200); // aspect 2.2: beyond the landscape tolerance
    const hs = buildHypotheses(img, null, { x: 0, y: 0, w: 440, h: 200 });
    const fits = hs.filter((h) => h.id === 'fit');
    expect(fits.map((h) => h.rotation).sort()).toEqual([270, 90]);
    // Sideways card: its long side (card height) lies along x, limited by the box height.
    const fit = find(hs, 'fit', 90)!;
    expect(Math.abs(fit.image.width - ART_BOX.w * 200)).toBeLessThanOrEqual(2);
  });

  it('fits both orientations in a near-square box, where a tilted card could lie either way', () => {
    const hs = buildHypotheses(coordImage(300, 300), null, { x: 0, y: 0, w: 300, h: 300 });
    expect(hs.filter((h) => h.id === 'fit').map((h) => h.rotation).sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
  });

  it('treats a squarish selection as artwork: the centre square, upright and upside down', () => {
    const img = coordImage(300, 260);
    const hs = buildHypotheses(img);
    const art = find(hs, 'art', 0)!;
    expect(art).toBeDefined();
    expect(art.image.width).toBe(art.image.height);
    // Inside the 4% margin: the inner box is about 278×241, so the square is ~241 wide.
    const inner = 260 / 1.08;
    expect(Math.abs(art.image.width - inner)).toBeLessThanOrEqual(2);
    expectNear(sourceOf(art.image, 0, 0), [(300 - inner) / 2, (260 - inner) / 2], 2);

    const down = find(hs, 'art', 180)!;
    expect(down).toBeDefined();
    expectNear(sourceOf(down.image, 0, 0), [299 - (300 - inner) / 2, 259 - (260 - inner) / 2], 2);
    expect(hs.some((h) => h.id === 'whole')).toBe(false);
  });

  it('turns a landscape card-shaped selection 90° cw and ccw before the whole crops', () => {
    const cardH = 200; // the card's short side, lying sideways
    const cardW = Math.round(cardH / CARD_ASPECT);
    const { img } = selectionAround(cardW, cardH);
    const hs = buildHypotheses(img);
    const wholes = hs.filter((h) => h.id === 'whole');
    expect(wholes.length).toBeGreaterThan(0);
    for (const h of wholes) expect([90, 270]).toContain(h.rotation);

    // Turned clockwise, the upright card's top-left is the sideways card's bottom-left:
    // the art box corner comes from x ≈ art-box top offset, y ≈ bottom minus left offset.
    const cw = find(hs, 'whole', 90)!;
    expect(cw).toBeDefined();
    expectNear(sourceOf(cw.image, 0, 0), [ART_BOX.y * cardW, cardH - 1 - ART_BOX.x * cardH], 2);
    // Portrait-card art box: square in pixels once upright.
    expect(Math.abs(cw.image.width - ART_BOX.w * cardH)).toBeLessThanOrEqual(2);

    // Turned counter-clockwise, the upright card's top-left is the sideways card's top-right.
    const ccw = find(hs, 'whole', 270)!;
    expect(ccw).toBeDefined();
    expectNear(sourceOf(ccw.image, 0, 0), [cardW - 1 - ART_BOX.y * cardW, ART_BOX.x * cardH], 2);
  });

  it('cuts the card or the centre square, plus whole-card crops for card shapes and fitted card crops otherwise', () => {
    const set = (hs: Hypothesis[]) => hs.map((h) => `${h.id}@${h.rotation}`).sort();
    const card = coordImage(590, 860);
    const portrait = coordImage(216, 316); // card-shaped
    const fourByThree = coordImage(400, 300); // a sideways card, or an artwork
    const square = coordImage(300, 300);
    expect(set(buildHypotheses(portrait, card))).toEqual(['quad@0', 'quad@180', 'whole@0', 'whole@180']);
    expect(set(buildHypotheses(portrait))).toEqual(['art@0', 'art@180', 'whole@0', 'whole@180']);
    expect(set(buildHypotheses(fourByThree))).toEqual(['art@0', 'art@180', 'whole@270', 'whole@90']);
    expect(set(buildHypotheses(square, card))).toEqual(['art@0', 'art@180', 'fit@0', 'fit@180', 'fit@270', 'fit@90', 'quad@0', 'quad@180']);
    expect(set(buildHypotheses(square))).toEqual(['art@0', 'art@180', 'fit@0', 'fit@180', 'fit@270', 'fit@90']);
  });

  it('always tries the centre square when no card was found, even for a card-like 4:3 box', () => {
    // A 4:3 box drawn around an artwork has a sideways card's aspect.
    const hs = buildHypotheses(coordImage(400, 300));
    const art = find(hs, 'art', 0)!;
    expect(art).toBeDefined();
    expect(art.image.width).toBe(art.image.height);
    const side = 300 / 1.08; // the user's box is the crop minus its 4% margins
    expect(Math.abs(art.image.width - side)).toBeLessThanOrEqual(2);
    expectNear(sourceOf(art.image, 0, 0), [(400 - side) / 2, (300 - side) / 2], 2);
    const down = find(hs, 'art', 180)!;
    expect(down).toBeDefined();
    expectNear(sourceOf(down.image, 0, 0), [399 - (400 - side) / 2, 299 - (300 - side) / 2], 2);
  });

  it("uses the user's box (crop.inner) when the margin was clipped on one side", () => {
    // The card touched the frame's left edge, so the crop has no margin there.
    const cardW = 200;
    const cardH = Math.round(cardW / CARD_ASPECT);
    const { img, my } = selectionAround(cardW, cardH, { left: 0 });
    const inner = { x: 0, y: my, w: cardW, h: cardH };
    const hs = buildHypotheses(img, null, inner);

    const whole = find(hs, 'whole', 0)!;
    expectNear(sourceOf(whole.image, 0, 0), [ART_BOX.x * cardW, ART_BOX.y * cardH], 1);
    expect(Math.abs(whole.image.width - ART_BOX.w * cardW)).toBeLessThanOrEqual(1);
    const down = find(hs, 'whole', 180)!;
    expectNear(sourceOf(down.image, 0, 0), [cardW - 1 - ART_BOX.x * cardW, cardH - 1 - ART_BOX.y * cardH], 1);
    // The centre square is centred on the user's box, not on the crop.
    const art = find(hs, 'art', 0)!;
    expectNear(sourceOf(art.image, 0, 0), [0, (cardH - cardW) / 2], 1);
  });

  it("turns the user's box with the selection for a sideways card", () => {
    const cardH = 200;
    const cardW = Math.round(cardH / CARD_ASPECT);
    const { img, mx, my } = selectionAround(cardW, cardH, { right: 0, top: 0 });
    const hs = buildHypotheses(img, null, { x: mx, y: my, w: cardW, h: cardH });
    expectNear(sourceOf(find(hs, 'whole', 90)!.image, 0, 0), [ART_BOX.y * cardW, cardH - 1 - ART_BOX.x * cardH], 1);
    expectNear(sourceOf(find(hs, 'whole', 270)!.image, 0, 0), [cardW - 1 - ART_BOX.y * cardW, ART_BOX.x * cardH], 1);
  });

  it('falls back to the 4% margin when crop.inner is unusable', () => {
    const { img } = selectionAround(200, 292);
    const corner = (inner?: { x: number; y: number; w: number; h: number }) =>
      sourceOf(find(buildHypotheses(img, null, inner), 'whole', 0)!.image, 0, 0);
    const expected = corner();
    expect(corner({ x: 0, y: 0, w: 0, h: 0 })).toEqual(expected);
    expect(corner({ x: Number.NaN, y: 0, w: 10, h: 10 })).toEqual(expected);
    expect(corner({ x: 5000, y: 5000, w: 10, h: 10 })).toEqual(expected);
  });

  it('never returns an empty image, whatever the selection size', () => {
    for (const [w, h] of [[1, 1], [2, 3], [3, 2], [20, 30], [30, 20], [7, 7], [900, 40], [40, 900]]) {
      const hs = buildHypotheses(coordImage(w, h), coordImage(59, 86));
      expect(hs.length).toBeGreaterThan(0);
      for (const hyp of hs) {
        expect(hyp.image.width).toBeGreaterThan(0);
        expect(hyp.image.height).toBeGreaterThan(0);
        expect(hyp.image.data.length).toBe(hyp.image.width * hyp.image.height * 4);
      }
    }
  });

  it('refuses an empty selection', () => {
    expect(() => buildHypotheses({ data: new Uint8ClampedArray(0), width: 0, height: 0 })).toThrow(/empty/i);
  });
});
