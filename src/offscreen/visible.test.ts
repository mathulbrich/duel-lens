import { describe, expect, it } from 'vitest';
import { ART_BOX, CARD_H, CARD_W } from '../shared/card-layout';
import { resizeRGBA, type RGBAImage } from '../shared/preprocess';
import type { Point, Quad } from './geometry';
import { warpQuadMasked } from './truncation';
import { COVER, coveredCard, frameOf, hideRight } from './visible';

type RGB = [number, number, number];

function solid(w: number, h: number, c: RGB): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([c[0], c[1], c[2], 255], i);
  return { data, width: w, height: h };
}

/** A card as a simulator draws it, W×H: a dark border, the frame's colour, a darker name bar, a patterned art box. */
export function cardImage(W: number, H: number, art: RGB[]): RGBAImage {
  const img = solid(W, H, [190, 110, 60]);
  const set = (x: number, y: number, c: RGB) => img.data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) set(x, y, [40, 38, 45]);
      else if (v >= 0.04 && v < 0.1 && u >= 0.07 && u < 0.93) set(x, y, [120, 80, 50]);
      else if (u >= ART_BOX.x && u < ART_BOX.x + ART_BOX.w && v >= ART_BOX.y && v < ART_BOX.y + ART_BOX.h) {
        const qu = (u - ART_BOX.x) / ART_BOX.w;
        const qv = (v - ART_BOX.y) / ART_BOX.h;
        set(x, y, art[(qv >= 0.5 ? 2 : 0) + (qu >= 0.5 ? 1 : 0)]);
      }
    }
  return img;
}

/** `src` drawn over `dst` at (x, y), clipped to `dst`. */
function draw(dst: RGBAImage, src: RGBAImage, x: number, y: number): RGBAImage {
  for (let r = 0; r < src.height; r++) {
    const py = y + r;
    if (py < 0 || py >= dst.height) continue;
    for (let c = 0; c < src.width; c++) {
      const px = x + c;
      if (px < 0 || px >= dst.width) continue;
      dst.data.set(src.data.subarray((r * src.width + c) * 4, (r * src.width + c) * 4 + 4), (py * dst.width + px) * 4);
    }
  }
  return dst;
}

// A hand as Live's 1280 frame shows a simulator's: cards 117×171 px, each next one 82 px further right, over the
// previous one's right 30%. The picture's height cuts them `cutAt` px below their top (or not at all).
const W = 117;
const H = 171;
const STEP = 82;
const LEFT = 40;
const TOP = 24;
const ARTS: RGB[][] = [
  [[220, 40, 40], [40, 200, 40], [40, 40, 220], [220, 220, 40]],
  [[40, 220, 220], [200, 40, 200], [240, 240, 240], [30, 30, 120]],
  [[90, 160, 30], [160, 30, 90], [30, 90, 160], [200, 200, 200]],
];
function hand(cards: number, pictureH: number): RGBAImage {
  const pic = solid(LEFT + STEP * (cards - 1) + W + 40, pictureH, [12, 14, 20]);
  for (let i = 0; i < cards; i++) draw(pic, cardImage(W, H, ARTS[i % ARTS.length]), LEFT + i * STEP, TOP);
  return pic;
}

const quad = (x: number, y: number, w: number, h: number): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const near = (a: Point, b: Point, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

/**
 * The frame detector's outline of a covered card, as it boxes it (visible.ts): the card shrunk COVER.grow times about
 * the point of its left side COVER.pivot of the outline's height down, so that coveredCard's grown card is the card.
 */
function shrunk(x: number, y: number, w: number, h: number): Quad {
  const s = COVER.grow[0];
  const wo = w / s;
  const ho = h / s;
  return quad(x, y + COVER.pivot * ho * (s - 1), wo, ho);
}

describe('coveredCard', () => {
  it('a hand card cut by the picture and covered by the next: where it lies whole, and the share the next card leaves', () => {
    const pic = hand(3, TOP + 116); // the picture's bottom edge cuts every card 116 px down (68% shows)
    const seen = coveredCard(pic, shrunk(LEFT, TOP, W, H), null);
    expect(seen).not.toBeNull();
    expect(seen!.quads).toHaveLength(1);
    const want = quad(LEFT, TOP, W, H);
    seen!.quads[0].forEach((p, k) => expect(near(p, want[k], 1.5)).toBe(true));
    // The next card's left edge is 82 px in (70% of the card), less COVER.inset of the outline's width.
    expect(seen!.visible[0]).toBeGreaterThan((STEP - 2 - COVER.inset * (W / 1.3)) / W);
    expect(seen!.visible[0]).toBeLessThan((STEP + 3) / W);
  });

  it('a covered card the picture shows whole: the same', () => {
    const seen = coveredCard(hand(3, TOP + H + 30), shrunk(LEFT + STEP, TOP, W, H), null);
    expect(seen).not.toBeNull();
    seen!.quads[0].forEach((p, k) => expect(near(p, quad(LEFT + STEP, TOP, W, H)[k], 1.5)).toBe(true));
    expect(seen!.visible[0]).toBeCloseTo(STEP / W, 1);
  });

  it('a card cut by the picture that no card covers (the last of the hand): null', () => {
    expect(coveredCard(hand(3, TOP + 116), quad(LEFT + 2 * STEP, TOP, W, H), null)).toBeNull();
    // ...even boxed a little small, as a frame detector at a small look boxes it
    expect(coveredCard(hand(3, TOP + 116), quad(LEFT + 2 * STEP + 4, TOP + 6, W * 0.94, H * 0.94), null)).toBeNull();
  });

  it('a whole card, alone: null', () => {
    expect(coveredCard(hand(1, TOP + H + 30), quad(LEFT, TOP, W, H), null)).toBeNull();
  });

  it('a card whose top band is outside the picture (cut at its top): null, nothing to tell a cover edge by', () => {
    const pic = hand(3, TOP + H + 30);
    const below = { ...pic, data: pic.data.slice((TOP + 60) * pic.width * 4), height: pic.height - (TOP + 60) };
    expect(coveredCard(below, shrunk(LEFT, -60, W, H), null)).toBeNull();
  });

  it('a card cut on its right side by the picture (its top edge leaves the crop): null, even with the next card in sight', () => {
    const pic = hand(3, TOP + 116);
    const cutRight = LEFT + STEP + 60; // the picture's right edge, through the second card
    const narrow: RGBAImage = { width: cutRight, height: pic.height, data: new Uint8ClampedArray(cutRight * pic.height * 4) };
    for (let y = 0; y < pic.height; y++) narrow.data.set(pic.data.subarray(y * pic.width * 4, (y * pic.width + cutRight) * 4), y * cutRight * 4);
    expect(coveredCard(narrow, shrunk(LEFT + STEP, TOP, W, H), null)).toBeNull();
    // the first card, whose top edge the crop holds, is still found covered
    expect(coveredCard(narrow, shrunk(LEFT, TOP, W, H), null)).not.toBeNull();
  });

  it("follows the image's tilt, not the outline's: an outline turned 5° reads the upright card", () => {
    const pic = hand(3, TOP + 116);
    const o = shrunk(LEFT, TOP, W, H);
    const c = { x: (o[0].x + o[2].x) / 2, y: (o[0].y + o[2].y) / 2 };
    const a = (5 * Math.PI) / 180;
    const turned = o.map((p) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) })) as Quad;
    const f = frameOf(turned, 0);
    expect(f.ex.x).toBeCloseTo(1, 6);
    expect(f.ex.y).toBeCloseTo(0, 6);
    expect(frameOf(turned).ex.y).toBeCloseTo(Math.sin(a), 6);
    expect(coveredCard(pic, turned, 0)).not.toBeNull();
  });
});

describe('hideRight', () => {
  it('marks every column from the share on unseen, and nothing else', () => {
    const card = resizeRGBA(cardImage(W, H, ARTS[0]), CARD_W, CARD_H);
    const w = warpQuadMasked(card, quad(0, 0, CARD_W, CARD_H), CARD_W, CARD_H)!;
    expect(w.seenShare).toBe(1);
    const hidden = hideRight(w, 0.7);
    const from = Math.floor(0.7 * CARD_W);
    for (const y of [0, 400, CARD_H - 1]) {
      expect(hidden.seen[y * CARD_W + from - 1]).toBe(1);
      expect(hidden.seen[y * CARD_W + from]).toBe(0);
      expect(hidden.seen[y * CARD_W + CARD_W - 1]).toBe(0);
    }
    expect(hidden.seenShare).toBeCloseTo(from / CARD_W, 6);
    expect(w.seen.every((s) => s === 1)).toBe(true); // the warp itself is left as it was
    expect(hideRight(w, 1)).toBe(w);
  });
});
