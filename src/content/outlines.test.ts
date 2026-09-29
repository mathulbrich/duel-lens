import { describe, expect, it } from 'vitest';
import type { CardDetection, DetectedCardBox } from '../shared/messages';
import { viewportToBitmap, type Point } from './geometry';
import { cardAt, outlinesFrom } from './outlines';

/** An upright w x h card with its top-left corner at (x, y), in screenshot pixels. */
function upright(x: number, y: number, w: number, h: number, conf = 0.9): DetectedCardBox {
  return {
    cx: x + w / 2,
    cy: y + h / 2,
    w,
    h,
    angle: 0,
    conf,
    pts: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  };
}

function detection(boxes: DetectedCardBox[], width = 1500, height = 1000, extra: Partial<CardDetection> = {}): CardDetection {
  return { boxes, width, height, ms: 120, ...extra };
}

// Live check m4: on YouTube the detector also outlined the card art in the recommendation thumbnails.
describe('outlinesFrom: around a video', () => {
  const view = { w: 1500, h: 1000 };
  // Two cards on the video (left), one in a thumbnail at the right edge.
  const onVideo = [upright(100, 100, 100, 140), upright(600, 400, 100, 140)];
  const thumbnail = upright(1300, 100, 60, 84);

  it('keeps only the cards whose centre is inside a video covering a quarter of the viewport or more', () => {
    const video = { x: 0, y: 50, w: 1100, h: 620 }; // 45% of the viewport
    const cards = outlinesFrom(detection([...onVideo, thumbnail]), view, [video]);
    expect(cards.map((c) => c.rect.x)).toEqual([100, 600]);
    expect(cards.map((c) => c.label)).toEqual(['Card 1 of 2', 'Card 2 of 2']); // counted after the filter
  });

  it('keeps every card when the videos are small, or there is none', () => {
    const small = { x: 0, y: 50, w: 600, h: 400 }; // 16%
    expect(outlinesFrom(detection([...onVideo, thumbnail]), view, [small])).toHaveLength(3);
    expect(outlinesFrom(detection([...onVideo, thumbnail]), view, [])).toHaveLength(3);
    expect(outlinesFrom(detection([...onVideo, thumbnail]), view)).toHaveLength(3);
  });

  it('counts only the part of a video inside the viewport', () => {
    const mostlyOff = { x: -1200, y: 0, w: 1500, h: 1000 }; // 20% of it on screen
    expect(outlinesFrom(detection([...onVideo, thumbnail]), view, [mostlyOff])).toHaveLength(3);
  });

  it('keeps the cards inside any of the big videos', () => {
    const left = { x: 0, y: 0, w: 750, h: 1000 };
    const right = { x: 1250, y: 0, w: 250, h: 1000 }; // too small on its own
    expect(outlinesFrom(detection([...onVideo, thumbnail]), view, [left, right]).map((c) => c.rect.x)).toEqual([100, 600]);
  });
});

describe('outlinesFrom: screenshot pixels to the page', () => {
  it('maps a card on a devicePixelRatio 2 screenshot to CSS pixels, and keeps its screenshot bounds for the crop', () => {
    // A 1500x1000 CSS px viewport captured as a 3000x2000 screenshot.
    const [card] = outlinesFrom(detection([upright(200, 100, 200, 300)], 3000, 2000), { w: 1500, h: 1000 });
    expect(card.shape).toEqual({ cx: 150, cy: 125, w: 100, h: 150, angle: 0 });
    expect(card.rect).toEqual({ x: 100, y: 50, w: 100, h: 150 });
    expect(card.shotRect).toEqual({ x: 200, y: 100, w: 200, h: 300 });
    expect(card.shotWidth).toBe(3000);
    // And back again the way a drag is cropped (viewportToBitmap): the same screenshot pixels.
    expect(viewportToBitmap(card.rect, 3000, 1500)).toEqual(card.shotRect);
  });

  it('maps one to one at devicePixelRatio 1', () => {
    const [card] = outlinesFrom(detection([upright(200, 100, 200, 300)]), { w: 1500, h: 1000 });
    expect(card.rect).toEqual({ x: 200, y: 100, w: 200, h: 300 });
    expect(card.shotRect).toEqual({ x: 200, y: 100, w: 200, h: 300 });
    expect(viewportToBitmap(card.rect, 1500, 1500)).toEqual(card.shotRect);
  });

  it('covers page zoom too (125% at devicePixelRatio 1: 1024 CSS px across a 1280 px screenshot)', () => {
    const [card] = outlinesFrom(detection([upright(100, 50, 100, 150)], 1280, 800), { w: 1024, h: 640 });
    expect(card.rect).toEqual({ x: 80, y: 40, w: 80, h: 120 });
  });

  it('follows the frozen frame on each axis (it is stretched to the viewport width and height)', () => {
    // A screenshot whose height doesn't scale like its width (fractional devicePixelRatio rounding, exaggerated).
    const [card] = outlinesFrom(detection([upright(200, 100, 200, 300)], 3000, 2000), { w: 1500, h: 800 });
    expect(card.rect).toEqual({ x: 100, y: 40, w: 100, h: 120 });
  });

  it('describes a turned card by its corners: outline, turned box and bounds', () => {
    // 10x20 card centred on (500, 400) turned atan2(3, 4) clockwise, scaled up 10x (corners by hand), at DPR 2.
    const pts: Point[] = [
      [520, 290],
      [600, 350],
      [480, 510],
      [400, 450],
    ];
    const box: DetectedCardBox = { cx: 500, cy: 400, w: 100, h: 200, angle: Math.atan2(3, 4), conf: 0.8, pts };
    const [card] = outlinesFrom(detection([box], 3000, 2000), { w: 1500, h: 1000 });
    expect(card.rect).toEqual({ x: 200, y: 145, w: 100, h: 110 });
    expect(card.shotRect).toEqual({ x: 400, y: 290, w: 200, h: 220 });
    // Its corners too, in the screenshot's pixels and the detector's order: what a click sends the engine.
    expect(card.shotPts).toEqual(pts);
    expect(card.shotPts).not.toBe(pts);
    expect(card.shape.cx).toBeCloseTo(250, 9);
    expect(card.shape.cy).toBeCloseTo(200, 9);
    expect(card.shape.w).toBeCloseTo(50, 9);
    expect(card.shape.h).toBeCloseTo(100, 9);
    expect(card.shape.angle).toBeCloseTo(Math.atan2(3, 4), 9);
    expect(card.area).toBeCloseTo(5000, 6);
  });
});

describe('outlinesFrom: order and labels', () => {
  it('numbers the cards in reading order (rows top to bottom, each left to right), not by confidence', () => {
    // Detector order is best first: A, C, B, D. On screen: B A on the top row, D C below.
    const a = upright(250, 30, 100, 140, 0.99);
    const c = upright(150, 330, 100, 140, 0.95);
    const b = upright(50, 40, 100, 140, 0.9);
    const d = upright(0, 320, 100, 140, 0.8);
    const cards = outlinesFrom(detection([a, c, b, d]), { w: 1500, h: 1000 });
    expect(cards.map((o) => o.rect.x)).toEqual([50, 250, 0, 150]);
    expect(cards.map((o) => o.label)).toEqual(['Card 1 of 4', 'Card 2 of 4', 'Card 3 of 4', 'Card 4 of 4']);
  });
});

describe('outlinesFrom: nothing to outline', () => {
  it('gives no outlines when detection failed or found nothing', () => {
    expect(outlinesFrom(detection([], 1500, 1000, { error: 'no detector in this build' }), { w: 1500, h: 1000 })).toEqual([]);
    expect(outlinesFrom(detection([]), { w: 1500, h: 1000 })).toEqual([]);
  });

  it('gives no outlines when the screenshot size is unknown', () => {
    expect(outlinesFrom(detection([upright(10, 10, 100, 140)], 0, 0), { w: 1500, h: 1000 })).toEqual([]);
  });

  it('outlines face-up cards only: a face-down detection (a pile, a sleeve) is never a card to click', () => {
    const up = { ...upright(100, 100, 60, 88), kind: 'face-up' as const };
    const down = { ...upright(300, 100, 60, 88), kind: 'face-down' as const };
    const unknown = upright(500, 100, 60, 88); // a detector that doesn't tell them apart
    const cards = outlinesFrom(detection([up, down, unknown]), { w: 1500, h: 1000 });
    expect(cards.map((c) => c.shotRect.x)).toEqual([100, 500]);
    expect(cards.map((c) => c.label)).toEqual(['Card 1 of 2', 'Card 2 of 2']);
  });

  it('skips boxes without four usable corners, or with no area', () => {
    const good = upright(10, 10, 100, 140);
    const three = { ...upright(300, 10, 100, 140), pts: upright(300, 10, 100, 140).pts.slice(0, 3) };
    const nan = { ...upright(500, 10, 100, 140), pts: [[NaN, 1], [2, 3], [4, 5], [6, 7]] as Point[] };
    const flat = upright(700, 10, 100, 0);
    const cards = outlinesFrom(detection([three, good, nan, flat]), { w: 1500, h: 1000 });
    expect(cards.map((o) => o.rect)).toEqual([{ x: 10, y: 10, w: 100, h: 140 }]);
    expect(cards[0].label).toBe('Card 1 of 1');
  });
});

describe('cardAt', () => {
  const view = { w: 1500, h: 1000 };

  it('finds the card under the point, and nothing between cards', () => {
    const cards = outlinesFrom(detection([upright(100, 100, 100, 140), upright(300, 100, 100, 140)]), view);
    expect(cardAt(cards, 150, 170)).toBe(0);
    expect(cardAt(cards, 399, 239)).toBe(1);
    expect(cardAt(cards, 250, 170)).toBeNull();
    expect(cardAt([], 150, 170)).toBeNull();
  });

  it('follows the turned outline, not its bounding box', () => {
    // A diamond (a card turned 45°) around (500, 500), 100 px from the centre to each corner.
    const diamond: DetectedCardBox = {
      cx: 500,
      cy: 500,
      w: 141.4,
      h: 141.4,
      angle: Math.PI / 4,
      conf: 0.9,
      pts: [
        [500, 400],
        [600, 500],
        [500, 600],
        [400, 500],
      ],
    };
    const cards = outlinesFrom(detection([diamond]), view);
    expect(cardAt(cards, 540, 530)).toBe(0);
    expect(cardAt(cards, 580, 420)).toBeNull(); // inside the bounds (400..600), outside the card
  });

  it('counts a click on the outline drawn just outside the card when given that padding', () => {
    const cards = outlinesFrom(detection([upright(100, 100, 100, 140)]), view);
    expect(cardAt(cards, 202, 170)).toBeNull(); // 2 px right of the card's edge
    expect(cardAt(cards, 202, 170, 3)).toBe(0);
    expect(cardAt(cards, 204, 170, 3)).toBeNull();
  });

  // Review M4: an Xyz monster on its material, a fanned pair. Their areas differ only by the
  // detector's noise, which must not decide the pick: where the click landed does.
  it('between overlapping cards of about the same size, picks the one whose centre the click is nearest', () => {
    const under = upright(100, 100, 100.3, 140.2); // a hair bigger than the other
    const over = upright(130, 120, 100, 140);
    const cards = outlinesFrom(detection([under, over]), view);
    const a = cards.findIndex((o) => o.rect.x === 100);
    const b = cards.findIndex((o) => o.rect.x === 130);
    expect(cardAt(cards, 150, 170)).toBe(a); // the centre of the first, inside the second too
    expect(cardAt(cards, 185, 195)).toBe(b); // near the centre of the second, inside the first too
    expect(cardAt(cards, 90, 250)).toBeNull();
  });

  it('measures "nearest the centre" in each card\'s own size and turn', () => {
    // A card turned 90° (landscape on screen) over an upright one of the same size, crossing it.
    const upright1 = upright(200, 100, 100, 140); // centre (250, 170)
    const turned: DetectedCardBox = {
      cx: 250,
      cy: 200,
      w: 100,
      h: 140,
      angle: Math.PI / 2,
      conf: 0.9,
      pts: [
        [320, 150],
        [320, 250],
        [180, 250],
        [180, 150],
      ],
    };
    const cards = outlinesFrom(detection([upright1, turned]), view);
    const up = cards.findIndex((o) => o.rect.w === 100);
    const side = cards.findIndex((o) => o.rect.w === 140);
    // The upright card reaches 50 px across and 70 px down from its centre (250, 170); the turned
    // one 70 across and 50 down from (250, 200). (295, 180) is nearer the upright card's centre
    // (46 px against 49) but 5 px from its right edge, and 25 px inside the turned one's: the turned card.
    expect(cardAt(cards, 295, 180)).toBe(side);
    // (250, 186) is nearer the turned card's centre (14 px against 16), but 16/70 of the way to the
    // upright card's edge and 14/50 to the turned one's: the upright card.
    expect(cardAt(cards, 250, 186)).toBe(up);
  });

  // a11y review M3 (WCAG 2.5.8): a card drawn small (a whole field at a small embed size) is still a
  // target of 24x24 CSS px at least. Only the hit area grows: the outline and the crop don't.
  it('gives a card drawn under 24x24 px a hit area of 24x24 px around its centre', () => {
    const cards = outlinesFrom(detection([upright(100, 100, 10, 14)]), view); // centre (105, 107)
    expect(cardAt(cards, 105 + 11.9, 107)).toBe(0);
    expect(cardAt(cards, 105, 107 - 11.9, 3)).toBe(0);
    expect(cardAt(cards, 105 + 12.5, 107, 3)).toBeNull();
    expect(cardAt(cards, 105, 107 + 12.5)).toBeNull();
    // Its own geometry (what is outlined and cropped) is unchanged.
    expect(cards[0].shape).toMatchObject({ w: 10, h: 14 });
    expect(cards[0].shotRect).toEqual({ x: 100, y: 100, w: 10, h: 14 });
  });

  it('grows a small side only: a card 30 px wide and 10 px tall is hit 12 px up and down, 3 px beside', () => {
    const cards = outlinesFrom(detection([upright(100, 100, 30, 10)]), view); // centre (115, 105)
    expect(cardAt(cards, 115, 105 + 11.9, 3)).toBe(0);
    expect(cardAt(cards, 130 + 2.9, 105, 3)).toBe(0);
    expect(cardAt(cards, 130 + 3.5, 105, 3)).toBeNull();
  });

  it("never lets a small card's wider hit area take a click from a card whose outline is under it", () => {
    // A 10x14 card 4 px left of a 100x140 one: 4 px into the big card is within 12 px of the small card's centre.
    const cards = outlinesFrom(detection([upright(100, 100, 10, 14), upright(114, 100, 100, 140)]), view);
    const small = cards.findIndex((o) => o.rect.w === 10);
    const big = cards.findIndex((o) => o.rect.w === 100);
    expect(cardAt(cards, 116, 107, 3)).toBe(big);
    expect(cardAt(cards, 112, 107, 3)).toBe(small); // in the gap, on the small card's (padded) outline
    expect(cardAt(cards, 105, 118, 3)).toBe(small); // below it, only in its wider hit area
  });

  it('picks the smallest card when outlines overlap (a card lying on another, or a box around a pile)', () => {
    const pile = upright(100, 100, 400, 400);
    const card = upright(200, 200, 100, 140);
    const cards = outlinesFrom(detection([pile, card]), view);
    const small = cards.findIndex((o) => o.rect.w === 100);
    const big = cards.findIndex((o) => o.rect.w === 400);
    expect(cardAt(cards, 250, 270)).toBe(small);
    expect(cardAt(cards, 450, 450)).toBe(big);
  });
});
