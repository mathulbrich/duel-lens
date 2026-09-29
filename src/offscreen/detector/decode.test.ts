import { describe, expect, it } from 'vitest';
import { alignCorners, decodeCards, type OutputMaps } from './decode';
import { boxCorners, type Pt } from './geometry';

const CLASSES = ['face-up', 'face-down'] as const;
const OPTS = { stride: 4, minScore: 0.2, nmsIoU: 0.5, maxDetections: 100 };

/** Output maps for a gh x gw grid with the given peaks. */
function maps(gh: number, gw: number, peaks: { k: number; i: number; j: number; score: number; box: number[] }[], withPeak = true): OutputMaps {
  const plane = gh * gw;
  const heat = new Float32Array(2 * plane);
  const box = new Float32Array(6 * plane);
  for (const p of peaks) {
    heat[p.k * plane + p.i * gw + p.j] = p.score;
    // a weaker shoulder next to the peak (never a peak itself)
    if (p.j + 1 < gw) heat[p.k * plane + p.i * gw + p.j + 1] = Math.max(heat[p.k * plane + p.i * gw + p.j + 1], p.score * 0.6);
    p.box.forEach((v, c) => (box[c * plane + p.i * gw + p.j] = v));
  }
  let peak: Float32Array | null = null;
  if (withPeak) {
    peak = new Float32Array(2 * plane);
    for (let k = 0; k < 2; k++)
      for (let i = 0; i < gh; i++)
        for (let j = 0; j < gw; j++) {
          let m = 0;
          for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (i + a >= 0 && i + a < gh && j + b >= 0 && j + b < gw) m = Math.max(m, heat[k * plane + (i + a) * gw + j + b]);
          peak[k * plane + i * gw + j] = m;
        }
  }
  return { heat, box, peak, classes: CLASSES, gh, gw };
}

// a 60x88 px card (15x22 cells) centred a quarter cell right/down of cell (10, 20)
const upright = [0.25, 0.25, Math.log(15), Math.log(22), 0, 1];

describe('decodeCards', () => {
  it('reads the box at each peak: centre, size and angle in input pixels', () => {
    const [card] = decodeCards(maps(40, 60, [{ k: 0, i: 10, j: 20, score: 0.9, box: upright }]), OPTS);
    expect(card.kind).toBe('face-up');
    expect(card.conf).toBeCloseTo(0.9, 6);
    expect(card.cx).toBeCloseTo((20 + 0.5 + 0.25) * 4, 5);
    expect(card.cy).toBeCloseTo((10 + 0.5 + 0.25) * 4, 5);
    expect(card.w).toBeCloseTo(60, 4);
    expect(card.h).toBeCloseTo(88, 4);
    expect(card.angle).toBeCloseTo(0, 6);
    expect(card.pts).toHaveLength(4);
    expect(card.scores['face-up']).toBeCloseTo(0.9, 6);
  });

  it('gives the same result when it has to max-pool the heatmap itself', () => {
    const peaks = [
      { k: 0, i: 10, j: 20, score: 0.9, box: upright },
      { k: 1, i: 25, j: 40, score: 0.7, box: upright },
    ];
    expect(decodeCards(maps(40, 60, peaks, false), OPTS)).toEqual(decodeCards(maps(40, 60, peaks, true), OPTS));
  });

  it('decodes the angle from (sin 2t, cos 2t) and keeps boxes portrait', () => {
    const t = 0.3;
    const [a] = decodeCards(maps(40, 60, [{ k: 0, i: 10, j: 20, score: 0.9, box: [0, 0, Math.log(15), Math.log(22), Math.sin(2 * t), Math.cos(2 * t)] }]), OPTS);
    expect(a.angle).toBeCloseTo(t, 6);
    // a landscape reading (w > h) becomes portrait turned a quarter
    const [b] = decodeCards(maps(40, 60, [{ k: 0, i: 10, j: 20, score: 0.9, box: [0, 0, Math.log(22), Math.log(15), 0, 1] }]), OPTS);
    expect(b.w).toBeCloseTo(60, 4);
    expect(b.h).toBeCloseTo(88, 4);
    expect(Math.abs(b.angle)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('drops weak peaks and the shoulders next to a peak', () => {
    const cards = decodeCards(
      maps(40, 60, [
        { k: 0, i: 10, j: 20, score: 0.9, box: upright },
        { k: 0, i: 30, j: 50, score: 0.1, box: upright },
      ]),
      OPTS,
    );
    expect(cards).toHaveLength(1);
  });

  it('keeps the stronger class when both classes peak on one card, and separate cards apart', () => {
    const cards = decodeCards(
      maps(40, 60, [
        { k: 0, i: 10, j: 20, score: 0.55, box: upright },
        { k: 1, i: 10, j: 21, score: 0.8, box: [-0.75, 0.25, Math.log(15), Math.log(22), 0, 1] },
        { k: 0, i: 10, j: 40, score: 0.6, box: upright },
      ]),
      OPTS,
    );
    expect(cards.map((c) => [c.kind, Math.round(c.cx)])).toEqual([
      ['face-down', 83],
      ['face-up', 163],
    ]);
    // the face-up score at the winning cell is the face-up peak's shoulder
    expect(cards[0].scores['face-up']).toBeCloseTo(0.33, 5);
  });

  it('stops at maxDetections', () => {
    const peaks = Array.from({ length: 8 }, (_, n) => ({ k: 0, i: 5 + (n % 2) * 25, j: 5 + n * 7, score: 0.5 + n / 100, box: [0, 0, Math.log(2), Math.log(3), 0, 1] }));
    expect(decodeCards(maps(40, 60, peaks), { ...OPTS, maxDetections: 3 }).map((c) => c.conf)).toEqual([0.57, 0.56, 0.55].map((v) => Math.fround(v)));
  });

  it('reads the 4 corners of a 14-channel model: a keystone quad, cycled to start nearest the box top-left', () => {
    // a trapezoid (far edge narrower) around (84, 43): box frame upright, w = 60, h = 88
    const quad: Pt[] = [
      [60, 0],
      [108, 0],
      [114, 88],
      [54, 88],
    ];
    const gh = 40;
    const gw = 60;
    const plane = gh * gw;
    const heat = new Float32Array(2 * plane);
    const box = new Float32Array(14 * plane);
    const cell = 10 * gw + 20; // (i, j) = (10, 20): centre (82, 42) + offset (2, 1) px
    heat[cell] = 0.9;
    const [cx, cy, w, h] = [84, 43, 60, 88];
    const vals = [(cx / 4 - 20.5), (cy / 4 - 10.5), Math.log(w / 4), Math.log(h / 4), 0, 1];
    vals.forEach((v, c) => (box[c * plane + cell] = v));
    const rect = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    quad.forEach(([x, y], k) => {
      box[(6 + 2 * k) * plane + cell] = (x - cx) / (w / 2) - rect[k][0];
      box[(7 + 2 * k) * plane + cell] = (y - cy) / (h / 2) - rect[k][1];
    });
    const maps: OutputMaps = { heat, box, boxChannels: 14, peak: null, classes: CLASSES, gh, gw };
    const [card] = decodeCards(maps, OPTS);
    card.pts.forEach(([x, y], k) => {
      expect(x).toBeCloseTo(quad[k][0], 4);
      expect(y).toBeCloseTo(quad[k][1], 4);
    });
    expect(card.box).toEqual(boxCorners(card.cx, card.cy, card.w, card.h, card.angle));
    // the same card read from a model without corners is its rectangle
    const [plain] = decodeCards({ ...maps, box: box.slice(0, 6 * plane), boxChannels: 6 }, OPTS);
    expect(plain.pts).toEqual(plain.box);
  });

  it('a landscape card turned into the frame range keeps its corners, cycled to the portrait box', () => {
    // a card lying sideways (its own vertical axis at 90 degrees): w = 60 across it, h = 88 along it
    const gh = 40;
    const gw = 60;
    const plane = gh * gw;
    const heat = new Float32Array(2 * plane);
    const box = new Float32Array(14 * plane);
    const cell = 10 * gw + 20;
    heat[plane + cell] = 0.8; // face-down
    const t = Math.PI / 2;
    [0, 0, Math.log(60 / 4), Math.log(88 / 4), Math.sin(2 * t), Math.cos(2 * t)].forEach((v, c) => (box[c * plane + cell] = v));
    const [card] = decodeCards({ heat, box, boxChannels: 14, peak: null, classes: CLASSES, gh, gw }, OPTS);
    expect(card.kind).toBe('face-down');
    expect([card.w, card.h].map((v) => Math.round(v))).toEqual([60, 88]);
    // the corners (a rectangle here) are the box's own, in its order
    card.pts.forEach(([x, y], k) => {
      expect(x).toBeCloseTo(card.box[k][0], 4);
      expect(y).toBeCloseTo(card.box[k][1], 4);
    });
  });

  it('alignCorners keeps the clockwise order and starts at the corner nearest the box top-left', () => {
    const b = boxCorners(0, 0, 2, 4, 0);
    const q: Pt[] = [b[2], b[3], b[0], b[1]];
    expect(alignCorners(q, b)).toEqual(b);
  });
});
