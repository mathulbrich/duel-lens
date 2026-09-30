import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ART_BOX, CARD_H, CARD_W } from '../shared/card-layout';
import { decodeIndex, encodeIndexBinary, quantizeInt8, type IndexMeta, type LoadedIndex } from '../shared/index-format';
import type { DetectedCardBox } from '../shared/messages';
import { getModel, type EmbeddingModelSpec } from '../shared/models';
import { cropRGBA, l2normalize, resizeRGBA, rotate180, rotate90, type RGBAImage } from '../shared/preprocess';
import { topKByCard } from '../shared/search';
import { CARD_BACK_ID } from '../shared/types';
import type { CardDetector } from './detect-cards';
import { CLICK_REDETECT, clickRedetectPick, COVERED, coveredBy, createEngine, STRAIGHTEN, type Embedder } from './engine';
import { boxCorners, warpQuad, type Rect } from './geometry';

type RGB = [number, number, number];

/** Same size and same pixels. */
const sameImage = (a: RGBAImage, b: RGBAImage) =>
  a.width === b.width && a.height === b.height && Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength).equals(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength));

// The engine warns when card detection fails (several tests make it fail): keep the output quiet.
// Tests about a warning read this spy (a test's own vi.spyOn(console, 'warn') returns the same one).
beforeEach(() => void vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

/** A w×h image made of four coloured quadrants (TL, TR, BL, BR). */
function quadrants(colours: [RGB, RGB, RGB, RGB], w = 64, h = 64): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = colours[(y >= h / 2 ? 2 : 0) + (x >= w / 2 ? 1 : 0)];
      data.set([c[0], c[1], c[2], 255], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

function solid(w: number, h: number, c: RGB): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set([c[0], c[1], c[2], 255], i);
  return { data, width: w, height: h };
}

/** Paste `src` into `dst` at (x, y). */
function paste(dst: RGBAImage, src: RGBAImage, x: number, y: number): RGBAImage {
  for (let row = 0; row < src.height; row++) {
    dst.data.set(src.data.subarray(row * src.width * 4, (row + 1) * src.width * 4), ((y + row) * dst.width + x) * 4);
  }
  return dst;
}

const ARTWORKS: { imageId: number; cardId: number; art: RGBAImage }[] = [
  { imageId: 101, cardId: 101, art: quadrants([[220, 40, 40], [40, 200, 40], [40, 40, 220], [220, 220, 40]]) },
  { imageId: 102, cardId: 102, art: quadrants([[40, 220, 220], [200, 40, 200], [240, 240, 240], [30, 30, 120]]) },
  // A very dark artwork: what a black frame would wrongly match.
  { imageId: 103, cardId: 103, art: quadrants([[5, 5, 5], [6, 4, 5], [4, 6, 5], [5, 5, 7]]) },
  { imageId: 9001, cardId: CARD_BACK_ID, art: quadrants([[120, 70, 30], [90, 50, 20], [60, 40, 20], [130, 80, 40]]) },
];
const art = (cardId: number) => ARTWORKS.find((a) => a.cardId === cardId)!.art;

/**
 * Fake model: a constant plus the mean colour of each quadrant, L2-normalised. Like a
 * real model, it gives a black image a non-zero vector (close to dark artworks).
 */
function fakeVector(img: RGBAImage): Float32Array {
  const sums = new Float64Array(12);
  const counts = new Float64Array(4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const q = (y >= img.height / 2 ? 2 : 0) + (x >= img.width / 2 ? 1 : 0);
      const i = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) sums[q * 3 + c] += img.data[i + c];
      counts[q]++;
    }
  }
  const v = new Float32Array(13);
  v[0] = 0.3;
  for (let k = 0; k < 12; k++) v[k + 1] = counts[k / 3 | 0] ? sums[k] / counts[k / 3 | 0] / 255 : 0;
  return l2normalize(v);
}

const SPEC: EmbeddingModelSpec = { ...getModel(), id: 'fake-quadrants', dim: 13, thresholds: { score: 0.9, margin: 0.02, floor: 0.5 } };

function fakeEmbedder(log: RGBAImage[][] = []): Embedder {
  return {
    modelId: SPEC.id,
    async embed(images) {
      log.push(images);
      return images.map(fakeVector);
    },
  };
}

function fakeIndex(spec = SPEC): LoadedIndex {
  const vectors = new Int8Array(ARTWORKS.length * spec.dim);
  ARTWORKS.forEach((a, i) => vectors.set(quantizeInt8(fakeVector(a.art)), i * spec.dim));
  const meta: IndexMeta = {
    modelId: spec.id,
    dim: spec.dim,
    count: ARTWORKS.length,
    quant: 'int8',
    builtAt: '2026-09-28T00:00:00Z',
    entries: ARTWORKS.map(({ imageId, cardId }) => ({ imageId, cardId })),
  };
  const bin = encodeIndexBinary(spec.dim, ARTWORKS.length, 'int8', vectors);
  return decodeIndex(bin.buffer, meta);
}

/** A whole 590×860 card with `artwork` in its art box, plus the 4% selection margin. */
function cardSelection(artwork: RGBAImage): RGBAImage {
  const card = solid(590, 860, [150, 140, 120]);
  const x0 = Math.round(ART_BOX.x * 590);
  const y0 = Math.round(ART_BOX.y * 860);
  paste(card, resizeRGBA(artwork, Math.round((ART_BOX.x + ART_BOX.w) * 590) - x0, Math.round((ART_BOX.y + ART_BOX.h) * 860) - y0), x0, y0);
  const mx = Math.round(590 * 0.04);
  const my = Math.round(860 * 0.04);
  return paste(solid(590 + 2 * mx, 860 + 2 * my, [20, 20, 20]), card, mx, my);
}

describe('createEngine().recognize', () => {
  it('matches a crop of an artwork, confidently', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(resizeRGBA(art(102), 200, 200));
    expect(res.error).toBeUndefined();
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.candidates[0].imageId).toBe(102);
    expect(res.confident).toBe(true);
    expect(res.faceDown).toBe(false);
    expect(res.modelId).toBe(SPEC.id);
    expect(res.best).toEqual({ hypothesis: 'art', rotation: 0 });
  });

  it('matches the same crop upside down via stage 2, and says it was turned 180°', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(rotate180(resizeRGBA(art(102), 200, 200)));
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.confident).toBe(true);
    expect(res.best?.rotation).toBe(180);
    // Stage 1 (upright only) wasn't confident on an upside-down crop, so stage 2 ran.
    expect(res.timings.stage2).toBeGreaterThan(0);
  });

  it('matches a whole card lying sideways (defense position)', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(rotate90(cardSelection(art(102)), 'ccw'));
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.confident).toBe(true);
    expect(res.best).toEqual({ hypothesis: 'whole', rotation: 90 });
  });

  it('finds nothing in an all-black crop, never a confident match', async () => {
    const log: RGBAImage[][] = [];
    const engine = createEngine({ embedder: fakeEmbedder(log), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(solid(300, 400, [0, 0, 0]));
    expect(res.confident).toBe(false);
    expect(res.candidates.every((c) => c.score < SPEC.thresholds.floor)).toBe(true);
    expect(res.candidates).toEqual([]);
    expect(res.faceDown).toBe(false);
    expect(res.best).toBeUndefined();
    expect(res.error).toBeUndefined();
  });

  it('finds nothing when every score is below the floor', async () => {
    // Pure grey quadrants embed far from every artwork in the index.
    const engine = createEngine({
      embedder: fakeEmbedder(),
      index: fakeIndex(),
      spec: { ...SPEC, thresholds: { score: 0.9999, margin: 0.02, floor: 0.9999 } },
    });
    const res = await engine.recognize(quadrants([[128, 128, 128], [90, 90, 90], [160, 160, 160], [60, 60, 60]], 200, 200));
    expect(res.candidates).toEqual([]);
    expect(res.confident).toBe(false);
    // Not confident at stage 1, so the 180° hypotheses were tried too, for nothing.
    expect(res.timings.stage2).toBeGreaterThan(0);
  });

  it('copes with a 20×30 crop and a 3000×2000 crop, shrinking the big one before detection', async () => {
    const seen: [number, number][] = [];
    const spy: CardDetector = { detect: async (img) => (seen.push([img.width, img.height]), []) };
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC, detector: spy });
    const small = await engine.recognize(resizeRGBA(art(101), 20, 30));
    expect(small.error).toBeUndefined();
    const big = await engine.recognize(resizeRGBA(art(101), 3000, 2000));
    expect(big.error).toBeUndefined();
    expect(seen[0]).toEqual([20, 30]);
    expect(Math.max(...seen[1])).toBeLessThanOrEqual(1600);
    expect(Math.max(...seen[1])).toBeGreaterThanOrEqual(1590);
  });

  it('reports a face-down card when the card back wins', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(resizeRGBA(art(CARD_BACK_ID), 180, 180));
    expect(res.candidates[0].cardId).toBe(CARD_BACK_ID);
    expect(res.faceDown).toBe(true);
  });

  it('keeps the card back out of the alternatives (it has no card record)', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(resizeRGBA(art(102), 200, 200));
    expect(res.candidates.length).toBeGreaterThan(1);
    expect(res.candidates.some((c) => c.cardId === CARD_BACK_ID)).toBe(false);
  });

  it('embeds only the stage-1 (upright) hypotheses for a confident upright crop', async () => {
    const log: RGBAImage[][] = [];
    const engine = createEngine({ embedder: fakeEmbedder(log), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(cardSelection(art(101)));
    expect(res.confident).toBe(true);
    expect(log).toHaveLength(1); // one embed call: stage 2 was skipped
    expect(log[0]).toHaveLength(2); // whole + centre square, upright only (180° deferred)
    for (const key of ['embed', 'search', 'total']) {
      expect(res.timings[key]).toBeGreaterThanOrEqual(0);
    }
    expect(res.timings.stage2).toBe(0);
    expect(res.timings.total).toBeGreaterThanOrEqual(res.timings.embed);
  });

  it("cuts the whole-card crop from crop.inner, scaled with the image", async () => {
    // A big crop (shrunk twice inside the engine) whose margin was clipped on the left and
    // top: the user's box starts at (0, 0), with 8% of margin on the right and bottom only.
    const boxW = 1180;
    const boxH = 1720;
    const img = solid(boxW + 94, boxH + 138, [20, 20, 20]);
    paste(img, solid(boxW, boxH, [150, 140, 120]), 0, 0); // the card's frame
    const ax = Math.round(ART_BOX.x * boxW);
    const ay = Math.round(ART_BOX.y * boxH);
    const ARTWORK: RGB = [40, 200, 90];
    paste(img, solid(Math.round((ART_BOX.x + ART_BOX.w) * boxW) - ax, Math.round((ART_BOX.y + ART_BOX.h) * boxH) - ay, ARTWORK), ax, ay);
    const log: RGBAImage[][] = [];
    const engine = createEngine({ embedder: fakeEmbedder(log), index: fakeIndex(), spec: SPEC });
    await engine.recognize(img, { x: 0, y: 0, w: boxW, h: boxH });
    // With the right box, the whole-card crop is the artwork alone. Assuming a 4% margin
    // would shift it into the frame; an unscaled box would miss it entirely.
    const artworkShare = (im: RGBAImage) => {
      let hits = 0;
      for (let i = 0; i < im.data.length; i += 4) {
        if (ARTWORK.every((c, k) => Math.abs(im.data[i + k] - c) <= 12)) hits++;
      }
      return hits / (im.width * im.height);
    };
    expect(Math.max(...log[0].map(artworkShare))).toBeGreaterThanOrEqual(0.97);
  });

  it('returns an error result instead of throwing when embedding fails', async () => {
    const embedder: Embedder = {
      modelId: SPEC.id,
      embed: async () => {
        throw new Error('ORT run failed: out of memory');
      },
    };
    const engine = createEngine({ embedder, index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize(resizeRGBA(art(102), 200, 200));
    expect(res.error).toMatch(/out of memory/);
    expect(res.candidates).toEqual([]);
    expect(res.confident).toBe(false);
    expect(res.faceDown).toBe(false);
    expect(res.timings.total).toBeGreaterThanOrEqual(0);
  });

  it('returns an error result for an empty image', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const res = await engine.recognize({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    expect(res.error).toBeTruthy();
    expect(res.candidates).toEqual([]);
  });

  it('refuses an index or embedder built for another model', () => {
    const index = fakeIndex();
    expect(() =>
      createEngine({ embedder: fakeEmbedder(), index: { ...index, meta: { ...index.meta, modelId: 'other' } }, spec: SPEC }),
    ).toThrow(/index/i);
    expect(() => createEngine({ embedder: { ...fakeEmbedder(), modelId: 'other' }, index, spec: SPEC })).toThrow(/model/i);
  });
});

/** A dark 420×320 scene with the card turned `deg` degrees clockwise about its centre (the card is 150×219). */
function sceneWith(cardImg: RGBAImage, deg: number): RGBAImage {
  const small = resizeRGBA(cardImg, 150, 219);
  const w = 420;
  const h = 320;
  const data = new Uint8ClampedArray(w * h * 4);
  const a = (deg * Math.PI) / 180;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - w / 2;
      const dy = y + 0.5 - h / 2;
      const u = Math.floor(dx * Math.cos(a) + dy * Math.sin(a) + 75);
      const v = Math.floor(-dx * Math.sin(a) + dy * Math.cos(a) + 109.5);
      const i = (y * w + x) * 4;
      if (u >= 0 && u < 150 && v >= 0 && v < 219) data.set(small.data.subarray((v * 150 + u) * 4, (v * 150 + u) * 4 + 4), i);
      else data.set([15, 60, 30, 255], i);
    }
  }
  return { data, width: w, height: h };
}
const card102 = () => {
  const sel = cardSelection(art(102));
  // Drop the margin: the scene supplies the background.
  const mx = Math.round(590 * 0.04);
  const my = Math.round(860 * 0.04);
  const out = solid(590, 860, [0, 0, 0]);
  for (let y = 0; y < 860; y++) out.data.set(sel.data.subarray(((y + my) * sel.width + mx) * 4, ((y + my) * sel.width + mx + 590) * 4), y * 590 * 4);
  return out;
};

/** The projective map taking the points `from` to the points `to` (4 each): the 8 unknowns of its 3×3 matrix, solved. */
function homography(from: [number, number][], to: [number, number][]): (x: number, y: number) => [number, number] {
  const rows: number[][] = [];
  from.forEach(([x, y], i) => {
    const [X, Y] = to[i];
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X], [0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  });
  // Gauss–Jordan elimination with partial pivoting on the augmented 8×9 matrix.
  for (let c = 0; c < 8; c++) {
    const p = rows.reduce((best, r, i) => (i >= c && Math.abs(r[c]) > Math.abs(rows[best][c]) ? i : best), c);
    [rows[c], rows[p]] = [rows[p], rows[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = rows[r][c] / rows[c][c];
      for (let k = c; k < 9; k++) rows[r][k] -= f * rows[c][k];
    }
  }
  const m = rows.map((r, i) => r[8] / r[i]);
  return (x, y) => {
    const w = m[6] * x + m[7] * y + 1;
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  };
}

/** A dark 420×340 scene with `card` seen through a tilted camera: its corners (TL, TR, BR, BL) at `quad`. */
function keystoneScene(card: RGBAImage, quad: [number, number][]): RGBAImage {
  const out = solid(420, 340, [15, 60, 30]);
  const toCard = homography(quad, [
    [0, 0],
    [card.width, 0],
    [card.width, card.height],
    [0, card.height],
  ]);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const [u, v] = toCard(x + 0.5, y + 0.5);
      if (!(u >= 0 && u < card.width && v >= 0 && v < card.height)) continue;
      const i = (Math.floor(v) * card.width + Math.floor(u)) * 4;
      out.data.set(card.data.subarray(i, i + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

describe('recognize with a card detector (drags and clicks)', () => {
  /** A card as the detector reports it: an oriented box and its 4 corners, clockwise from its own top-left (crop pixels). */
  const found = (cx: number, cy: number, w: number, h: number, angle = 0, conf = 0.95, pts?: [number, number][], kind?: DetectedCardBox['kind']): DetectedCardBox => ({
    cx,
    cy,
    w,
    h,
    angle,
    conf,
    ...(kind ? { kind } : {}),
    pts: pts ?? boxCorners(cx, cy, w, h, angle).map((p) => [p.x, p.y] as [number, number]),
  });
  const rad = (deg: number) => (deg * Math.PI) / 180;

  /** A detector that answers every crop with `boxes` through detect(), recording the crops it saw. */
  function fakeDetector(boxes: DetectedCardBox[]) {
    const seen: RGBAImage[] = [];
    const detector: CardDetector = { detect: async (img, schedule) => (seen.push(img), expect(schedule).toBeUndefined(), boxes) };
    return { detector, seen };
  }
  const engineWith = (detector: CardDetector, log: RGBAImage[][] = []) => createEngine({ embedder: fakeEmbedder(log), index: fakeIndex(), spec: SPEC, detector });

  /** The art box of a CARD_W×CARD_H card, as the quad hypothesis cuts it upright. */
  const artBoxOf = (card: RGBAImage) => {
    const x0 = Math.round(ART_BOX.x * card.width);
    const y0 = Math.round(ART_BOX.y * card.height);
    return cropRGBA(card, x0, y0, Math.round((ART_BOX.x + ART_BOX.w) * card.width) - x0, Math.round((ART_BOX.y + ART_BOX.h) * card.height) - y0);
  };
  /** Mean absolute RGB difference of two images of the same size. */
  const meanDiff = (a: RGBAImage, b: RGBAImage) => {
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    let sum = 0;
    for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c] - b.data[i + c]);
    return sum / ((a.data.length / 4) * 3);
  };
  /** The corners of a w×h box turned `deg`, as [x, y] pairs. */
  const cornersOf = (cx: number, cy: number, w: number, h: number, deg: number) => boxCorners(cx, cy, w, h, rad(deg)).map((p) => [p.x, p.y] as [number, number]);
  /** `pts` grown by `k` about their centroid. */
  const grownBy = (pts: [number, number][], k: number) => {
    const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
    const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
    return pts.map(([x, y]) => ({ x: cx + (x - cx) * k, y: cy + (y - cy) * k }));
  };

  it("straightens the card it found around the user's box from its corners", async () => {
    // The card, turned 12°, in the middle of the scene; a neighbour at the right edge, outside the user's box.
    const { detector, seen } = fakeDetector([found(400, 160, 60, 88, 0, 0.97), found(210, 160, 150, 219, rad(12))]);
    const log: RGBAImage[][] = [];
    const scene = sceneWith(card102(), 12);
    const res = await engineWith(detector, log).recognize(scene, { x: 100, y: 20, w: 220, h: 280 });
    expect(res.error).toBeUndefined();
    expect(res.recognizer).toBe('embedding');
    expect(res.confident).toBe(true);
    expect(res.candidates[0]).toMatchObject({ cardId: 102, source: 'embedding' });
    expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    expect(seen).toEqual([scene]);
    // Stage 1 embedded the straightened card's art box first (then its other views).
    expect(meanDiff(log[0][0], artBoxOf(card102()))).toBeLessThan(12);
    expect(res.timings.cardDetect).toBeGreaterThanOrEqual(0);
    expect(res.timings.straighten).toBeGreaterThanOrEqual(0);
  });

  it('reads every view of the pick, and only them: its corners, its box and its box grown (the same view once)', async () => {
    // A keystone card: its corners are a trapezoid, its box the upright rectangle around it.
    const quad: [number, number][] = [
      [160, 40],
      [260, 40],
      [310, 300],
      [110, 300],
    ];
    const scene = keystoneScene(card102(), quad);
    const log: RGBAImage[][] = [];
    await engineWith(fakeDetector([found(210, 170, 200, 260, 0, 0.95, quad)]).detector, log).recognize(scene, { x: 100, y: 30, w: 220, h: 280 });
    expect(STRAIGHTEN.views).toEqual(['corners', 'box', 'grown']);
    const box = cornersOf(210, 170, 200, 260, 0);
    const want = [quad.map(([x, y]) => ({ x, y })), box.map(([x, y]) => ({ x, y })), grownBy(box, STRAIGHTEN.grow)];
    // Stage 1: the three views' art boxes, and no crop of the user's box (it reads the same card less well).
    expect(log[0]).toHaveLength(3);
    want.forEach((q, i) => expect(meanDiff(log[0][i], artBoxOf(warpQuad(scene, q as never, CARD_W, CARD_H)!))).toBeLessThan(1));
    // A detection whose corners are its own box: that view once, and the grown box.
    const plain: RGBAImage[][] = [];
    await engineWith(fakeDetector([found(210, 160, 150, 219, rad(12))]).detector, plain).recognize(sceneWith(card102(), 12), { x: 100, y: 20, w: 220, h: 280 });
    expect(plain[0]).toHaveLength(2);
  });

  it('turns from the selection to the card as its corners say: sideways, and upside down', async () => {
    // Turned 90° clockwise: the selection must turn 270° clockwise to show it upright.
    const sideways = await engineWith(fakeDetector([found(210, 160, 150, 219, rad(90))]).detector).recognize(sceneWith(card102(), 90));
    expect(sideways.candidates[0].cardId).toBe(102);
    expect(sideways.confident).toBe(true);
    expect(sideways.best).toEqual({ hypothesis: 'quad', rotation: 270 });
    // Upside down, but boxed with its own top at the card's bottom (a box can't tell): the 180° quad reads it.
    const upsideDown = await engineWith(fakeDetector([found(210, 160, 150, 219, rad(3))]).detector).recognize(sceneWith(card102(), 183));
    expect(upsideDown.candidates[0].cardId).toBe(102);
    expect(upsideDown.confident).toBe(true);
    expect(upsideDown.best).toEqual({ hypothesis: 'quad', rotation: 180 });
    expect(upsideDown.timings.stage2).toBeGreaterThan(0);
  });

  it('takes the corners clockwise from a short side, however the detector lists them', async () => {
    const scene = sceneWith(card102(), 12);
    const [tl, tr, br, bl] = found(210, 160, 150, 219, rad(12)).pts;
    for (const pts of [
      [tl, bl, br, tr], // counter-clockwise
      [tr, br, bl, tl], // from a long side
      [br, bl, tl, tr], // from the bottom: an upside-down reading, which the 180° quad turns back
    ]) {
      const res = await engineWith(fakeDetector([found(210, 160, 150, 219, rad(12), 0.95, pts)]).detector).recognize(scene);
      expect(res.candidates[0].cardId).toBe(102);
      expect(res.confident).toBe(true);
      expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    }
  });

  it('straightens a keystone card (a tilted camera) by its 4 corners, not by its oriented box', async () => {
    // The card seen from below its top edge: its corners make a trapezoid (top 100 px wide, bottom 200).
    const quad: [number, number][] = [
      [160, 40],
      [260, 40],
      [310, 300],
      [110, 300],
    ];
    const scene = keystoneScene(card102(), quad);
    // The detector's box is the trapezoid's upright bounds; its corners are the card's own.
    const { detector } = fakeDetector([found(210, 170, 200, 260, 0, 0.95, quad)]);
    const log: RGBAImage[][] = [];
    const res = await engineWith(detector, log).recognize(scene, { x: 100, y: 30, w: 220, h: 280 });
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.confident).toBe(true);
    expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    // The corners' view is the card's own art box again; straightening the box instead would not be.
    const truth = artBoxOf(card102());
    const byCorners = meanDiff(log[0][0], truth);
    const byBox = meanDiff(artBoxOf(warpQuad(scene, boxCorners(210, 170, 200, 260, 0), CARD_W, CARD_H)!), truth);
    expect(byCorners).toBeLessThan(12);
    expect(byBox).toBeGreaterThan(3 * byCorners);
  });

  it('picks a face-up card over a face-down detection the box also holds (a card lying on a pile)', async () => {
    // The pile's box holds the card's: in one list the card would be a part of the pile and never picked.
    const scene = sceneWith(card102(), 0);
    const log: RGBAImage[][] = [];
    const detector = fakeDetector([found(210, 160, 190, 250, 0, 0.9, undefined, 'face-down'), found(210, 160, 150, 219, 0, 0.8, undefined, 'face-up')]).detector;
    const res = await engineWith(detector, log).recognize(scene, { x: 100, y: 20, w: 220, h: 280 });
    expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    expect(meanDiff(log[0][0], artBoxOf(card102()))).toBeLessThan(12);
  });

  it('straightens a face-down detection when it is the only card for the box, and reads the box as drawn too: the model decides', async () => {
    // The detector took the card for a face-down one (it misreads a few): it is still straightened and read.
    const scene = sceneWith(card102(), 12);
    const log: RGBAImage[][] = [];
    const res = await engineWith(fakeDetector([found(210, 160, 150, 219, rad(12), 0.7, undefined, 'face-down')]).detector, log).recognize(scene, { x: 100, y: 20, w: 220, h: 280 });
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.confident).toBe(true);
    expect(res.faceDown).toBe(false);
    expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    // Its two views (corners = box here, and the grown box), then the user's box as a whole card.
    expect(log[0]).toHaveLength(3);
  });

  it("matches the user's box as drawn when the detector finds nothing the user drew around, or can't straighten it", async () => {
    for (const boxes of [
      [],
      [found(185, 12, 30, 44)], // a card at the crop's edge, mostly outside the user's box
      [found(100, 100, 120, 170, 0, 0.95, [[40, 40], [160, 40], [160, 40], [40, 40]])], // a degenerate quad
    ]) {
      const res = await engineWith(fakeDetector(boxes).detector).recognize(resizeRGBA(art(102), 200, 200));
      expect(res.candidates[0].cardId).toBe(102);
      expect(res.confident).toBe(true);
      expect(res.best?.hypothesis).not.toBe('quad');
      expect(res.timings.cardDetect).toBeGreaterThanOrEqual(0);
    }
  });

  it('reads a card-shaped box it found no card in as a whole card only: no art-only reading', async () => {
    // A card-shaped box of sleeve art: the whole-card reading, never the centre square as an artwork.
    const box = cardSelection(art(101));
    const looked: RGBAImage[][] = [];
    await engineWith(fakeDetector([]).detector, looked).recognize(box);
    expect(looked[0]).toHaveLength(1); // whole@0 alone
    // Without a detector, or when it fails, the centre square is tried too, as before.
    const without: RGBAImage[][] = [];
    await createEngine({ embedder: fakeEmbedder(without), index: fakeIndex(), spec: SPEC }).recognize(box);
    expect(without[0]).toHaveLength(2);
    const failing: RGBAImage[][] = [];
    await engineWith({ detect: () => Promise.reject(new Error('ORT run failed')) }, failing).recognize(box);
    expect(failing[0]).toHaveLength(2);
    // A box that isn't card-shaped keeps its centre square whatever the detector said.
    const square: RGBAImage[][] = [];
    await engineWith(fakeDetector([]).detector, square).recognize(resizeRGBA(art(102), 200, 200));
    expect(square[0].length).toBeGreaterThan(1);
  });

  it("matches the user's box as drawn when the detector fails, and says so", async () => {
    const warn = vi.mocked(console.warn);
    const detector: CardDetector = { detect: () => Promise.reject(new Error('ORT run failed')) };
    const res = await engineWith(detector).recognize(resizeRGBA(art(102), 200, 200));
    expect(res.error).toBeUndefined();
    expect(res.candidates[0].cardId).toBe(102);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/card detector failed/);
  });

  it("uses the detector's own look at a crop (detectInCrop) when it has one", async () => {
    const inCrop: RGBAImage[] = [];
    const detector: CardDetector = {
      detect: () => Promise.reject(new Error('a whole-screenshot search, not for a crop')),
      detectInCrop: async (crop) => (inCrop.push(crop), [found(210, 160, 150, 219, rad(12))]),
    };
    const scene = sceneWith(card102(), 12);
    const res = await engineWith(detector).recognize(scene);
    expect(inCrop).toEqual([scene]);
    expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('shows the detector the crop shrunk for detection, and a blank crop not at all', async () => {
    const { detector, seen } = fakeDetector([]);
    const engine = engineWith(detector);
    await engine.recognize(resizeRGBA(art(101), 3000, 2000));
    expect(seen.map((img) => Math.max(img.width, img.height))).toEqual([1600]);
    expect((await engine.recognize(solid(300, 400, [0, 0, 0]))).candidates).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  describe("a clicked card: its outline (crop.outline) is the pick (click-regression-report.md)", () => {
    // In a crop cut tight around the card, the detector can take a card-like rectangle inside it for the card
    // (the artwork and text box of a small card on a dark mat, t=27673): here, a box through the card's middle.
    const inside = () => fakeDetector([found(210, 150, 120, 150, rad(12), 0.9)]);
    const USER = { x: 100, y: 20, w: 220, h: 280 };

    it('straightens the card from the outline it is sent; the card found in the crop again is set aside when tilted as the outline', async () => {
      const { detector, seen } = inside();
      const log: RGBAImage[][] = [];
      const scene = sceneWith(card102(), 12);
      const res = await engineWith(detector, log).recognize(scene, USER, cornersOf(210, 160, 150, 219, 12));
      // The click re-detect looked once (CLICK_REDETECT), and kept the outline: the box it found is tilted as the outline is.
      expect(seen).toEqual([scene]);
      expect(res.error).toBeUndefined();
      expect(res.candidates[0]).toMatchObject({ cardId: 102, source: 'embedding' });
      expect(res.confident).toBe(true);
      expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
      // Its views only (its corners are its box here, then the box grown): the box as drawn isn't read.
      expect(log[0]).toHaveLength(2);
      const byOutline = meanDiff(log[0][0], artBoxOf(card102()));
      expect(byOutline).toBeLessThan(3);
      expect(res.timings.cardDetect).toBeGreaterThanOrEqual(0);
      expect(res.timings.straighten).toBeGreaterThanOrEqual(0);
      // Without the outline, the crop's own detection is the pick, and its art box is cut from the wrong place.
      const redetected: RGBAImage[][] = [];
      await engineWith(inside().detector, redetected).recognize(scene, USER);
      expect(meanDiff(redetected[0][0], artBoxOf(card102()))).toBeGreaterThan(3 * byOutline);
    });

    it('reads every view of it (corners, box, grown) and turns as its corners say, in whatever order they come', async () => {
      const quad: [number, number][] = [
        [160, 40],
        [260, 40],
        [310, 300],
        [110, 300],
      ];
      const scene = keystoneScene(card102(), quad);
      const log: RGBAImage[][] = [];
      const res = await engineWith(inside().detector, log).recognize(scene, { x: 100, y: 30, w: 220, h: 280 }, quad);
      expect(res.candidates[0].cardId).toBe(102);
      // Its box: its mean sides (top 100 and bottom 200 wide, both sides 264.8 long), about its centroid.
      const box = cornersOf(210, 170, 150, Math.hypot(50, 260), 0);
      const want = [quad.map(([x, y]) => ({ x, y })), box.map(([x, y]) => ({ x, y })), grownBy(box, STRAIGHTEN.grow)];
      expect(log[0]).toHaveLength(3);
      want.forEach((q, i) => expect(meanDiff(log[0][i], artBoxOf(warpQuad(scene, q as never, CARD_W, CARD_H)!))).toBeLessThan(1));
      // Upside down, and sideways: the outline's corners, listed from anywhere, say how the card lies.
      const upside = await engineWith(inside().detector).recognize(sceneWith(card102(), 183), USER, cornersOf(210, 160, 150, 219, 3).reverse());
      expect(upside).toMatchObject({ confident: true, best: { hypothesis: 'quad', rotation: 180 } });
      expect(upside.candidates[0].cardId).toBe(102);
      const [a, b, c, d] = cornersOf(210, 160, 150, 219, 90);
      const sideways = await engineWith(inside().detector).recognize(sceneWith(card102(), 90), USER, [b, c, d, a]);
      expect(sideways).toMatchObject({ confident: true, best: { hypothesis: 'quad', rotation: 270 } });
    });

    it("scales the outline with the crop when it is shrunk (a crop's long side over MAX_SIDE)", async () => {
      const { detector, seen } = inside();
      const log: RGBAImage[][] = [];
      // The scene at 5×: 2100×1600, shrunk to 1600×1219 before anything is read.
      const res = await engineWith(detector, log).recognize(
        resizeRGBA(sceneWith(card102(), 12), 2100, 1600),
        { x: 500, y: 100, w: 1100, h: 1400 },
        cornersOf(1050, 800, 750, 1095, 12),
      );
      // The crop is searched again shrunk, as for a drag; the box found there doesn't hold the outline's centre.
      expect(seen.map((s) => [s.width, s.height])).toEqual([[1600, 1219]]);
      expect(res.confident).toBe(true);
      expect(res.candidates[0].cardId).toBe(102);
      expect(meanDiff(log[0][0], artBoxOf(card102()))).toBeLessThan(12);
    });

    it("reads a clicked card lying sideways turned 180° too when its first reading is sure only by the second rule (either short side may be the outline's top)", async () => {
      // A scripted model: the upright readings (stage 1) lean to card 101 with a big lead, the turned ones to 102, higher.
      const v101 = fakeVector(art(101));
      const v102 = fakeVector(art(102));
      const blend = (a: Float32Array, b: Float32Array, t: number) => l2normalize(a.map((x, i) => x + t * b[i]));
      let calls = 0;
      const scripted: Embedder = {
        modelId: SPEC.id,
        async embed(images) {
          calls++;
          return images.map(() => (calls === 1 ? blend(v101, v102, 0.45) : blend(v102, v101, 0.05)));
        },
      };
      const index = fakeIndex();
      const s = (v: Float32Array, id: number) => topKByCard(v, index, 4).find((c) => c.cardId === id)!.score;
      const up = blend(v101, v102, 0.45);
      const turned = blend(v102, v101, 0.05);
      const [first, next] = topKByCard(up, index, 4);
      expect(first.cardId).toBe(101);
      // Stage 1 is sure only by the second rule (under the main score, a lead over its margin); stage 2 reads 102 higher.
      const spec: EmbeddingModelSpec = {
        ...SPEC,
        thresholds: { score: s(turned, 102) + 0.001, margin: 0.001, floor: 0.1, second: { score: first.score - 0.001, margin: first.score - next.score - 0.001 } },
      };
      expect(s(turned, 102)).toBeGreaterThan(s(up, 101));
      const engine = () => createEngine({ embedder: scripted, index: fakeIndex(spec), spec, detector: inside().detector });
      const sideways = await engine().recognize(sceneWith(card102(), 90), USER, cornersOf(210, 160, 150, 219, 90));
      expect(calls).toBe(2);
      expect(sideways.candidates[0].cardId).toBe(102);
      // A clicked card standing upright (its top is the detector's, as in the crop), and a drag, keep the stages as
      // they were: the first reading, sure, answers.
      calls = 0;
      const upright = await engine().recognize(sceneWith(card102(), 12), USER, cornersOf(210, 160, 150, 219, 12));
      expect(calls).toBe(1);
      expect(upright.confident).toBe(true);
      expect(upright.candidates[0].cardId).toBe(101);
      calls = 0;
      const dragged = await createEngine({ embedder: scripted, index: fakeIndex(spec), spec, detector: fakeDetector([found(210, 160, 150, 219, rad(90))]).detector }).recognize(sceneWith(card102(), 90), USER);
      expect(calls).toBe(1);
      expect(dragged.candidates[0].cardId).toBe(101);
      expect(dragged.confident).toBe(true);
    });

    it('looks for the card in the crop, as for a drag, when the outline is unusable or runs off the crop', async () => {
      const scene = sceneWith(card102(), 12);
      const plain = await engineWith(fakeDetector([found(210, 160, 150, 219, rad(12))]).detector).recognize(scene, USER);
      const good = cornersOf(210, 160, 150, 219, 12);
      for (const outline of [
        good.slice(0, 3), // three corners
        [...good.slice(0, 3), [Number.NaN, 40]], // a corner that isn't a number
        [[200, 150], [200, 150], [200, 150], [200, 150]], // no area
        good.map(([x, y]) => [x, y - 60]), // past the crop's top: a card the picture's edge cuts
        'not an outline',
      ] as unknown as [number, number][][]) {
        const { detector, seen } = fakeDetector([found(210, 160, 150, 219, rad(12))]);
        const res = await engineWith(detector).recognize(scene, USER, outline);
        expect(seen).toEqual([scene]);
        expect({ ...res, timings: {} }).toEqual({ ...plain, timings: {} });
      }
    });

    describe('the click re-detect: the card found in the crop again, when it is plainly the clicked card boxed another way (click-stack-report.md)', () => {
      // The card lies at 12°; the click sends an outline tilted the wrong way (−20°, a little too big), as the top card
      // of the stack at t=7770 got. The detector finds the card itself in the click's crop.
      const wrongWay = () => cornersOf(210, 160, 160, 230, -20);
      const card = () => found(210, 160, 150, 219, rad(12), 0.8);
      const withoutIt = (detector: CardDetector, log: RGBAImage[][] = []) =>
        createEngine({ embedder: fakeEmbedder(log), index: fakeIndex(), spec: SPEC, detector, clickRedetect: false });

      it("reads the card found instead of the outline when it holds the outline's centre, overlaps it and is tilted more than minTilt apart", async () => {
        const { detector, seen } = fakeDetector([card()]);
        const log: RGBAImage[][] = [];
        const scene = sceneWith(card102(), 12);
        const res = await engineWith(detector, log).recognize(scene, USER, wrongWay());
        expect(seen).toEqual([scene]);
        expect(res).toMatchObject({ confident: true, best: { hypothesis: 'quad', rotation: 0 } });
        expect(res.candidates[0].cardId).toBe(102);
        // Straightened from the card found (its views: its box, then the box grown), not from the wrong-way outline.
        expect(log[0]).toHaveLength(2);
        const byCard = meanDiff(log[0][0], artBoxOf(card102()));
        expect(byCard).toBeLessThan(3);
        const byOutline: RGBAImage[][] = [];
        await withoutIt(fakeDetector([card()]).detector, byOutline).recognize(scene, USER, wrongWay());
        expect(meanDiff(byOutline[0][0], artBoxOf(card102()))).toBeGreaterThan(3 * byCard);
      });

      it("takes the card found even when a corner of it runs past the crop, which is cut around the outline (8 of the stack's 11 frames)", async () => {
        // The crop ends at x = 300, around the wrong-way outline; the card's top-right corner lies at x = 306.
        const scene = cropRGBA(sceneWith(card102(), 12), 0, 0, 300, 320);
        const outline = cornersOf(200, 160, 136, 206, -20);
        const inner = { x: 101, y: 40, w: 198, h: 240 };
        expect(Math.max(...card().pts.map(([x]) => x))).toBeGreaterThan(301);
        const log: RGBAImage[][] = [];
        const res = await engineWith(fakeDetector([card()]).detector, log).recognize(scene, inner, outline);
        expect(res).toMatchObject({ confident: true, best: { hypothesis: 'quad', rotation: 0 } });
        expect(res.candidates[0].cardId).toBe(102);
        // Straightened from the card found (the sliver past the crop black, as for a drag's pick), not from the outline.
        const byCard = meanDiff(log[0][0], artBoxOf(card102()));
        expect(byCard).toBeLessThan(3);
        const byOutline: RGBAImage[][] = [];
        await withoutIt(fakeDetector([card()]).detector, byOutline).recognize(scene, inner, outline);
        expect(meanDiff(byOutline[0][0], artBoxOf(card102()))).toBeGreaterThan(3 * byCard);
      });

      it('keeps the outline when the card found is tilted within minTilt of it, misses its centre, overlaps it too little or is face-down, and when the detector fails', async () => {
        const scene = sceneWith(card102(), 12);
        const outline = wrongWay();
        const asOutline = await withoutIt(fakeDetector([]).detector).recognize(scene, USER, outline);
        for (const boxes of [
          [found(210, 160, 150, 219, rad(-0.5), 0.8)], // 19.5° from the outline's −20°: within minTilt (20.5°: below)
          [found(210, 60, 60, 88, rad(40), 0.8)], // a small card above it: misses the outline's centre
          [found(210, 160, 40, 60, rad(40), 0.8)], // on its centre, but overlapping it by 0.07
          [found(210, 160, 150, 219, rad(12), 0.8, undefined, 'face-down')],
        ]) {
          const { detector, seen } = fakeDetector(boxes);
          const res = await engineWith(detector).recognize(scene, USER, outline);
          expect(seen).toEqual([scene]);
          expect({ ...res, timings: {} }).toEqual({ ...asOutline, timings: {} });
        }
        const warn = vi.mocked(console.warn);
        const failing = await engineWith({ detect: () => Promise.reject(new Error('ORT run failed')) }).recognize(scene, USER, outline);
        expect({ ...failing, timings: {} }).toEqual({ ...asOutline, timings: {} });
        expect(JSON.stringify(warn.mock.calls)).toMatch(/failed on a click's crop/);
      });

      it('keeps a right outline when the crop also shows its card: a tilted card lying under it (an Xyz material) is not taken', async () => {
        // The outline is right (12°, the card's own), and the crop shows that card; under it lies another, turned 40°,
        // which holds the click and overlaps the outline by more than minIoU (click-stack-review.md M2).
        const scene = sceneWith(card102(), 12);
        const outline = cornersOf(210, 160, 150, 219, 12);
        const own = found(210, 160, 150, 219, rad(12), 0.9);
        const material = found(210, 160, 150, 219, rad(40), 0.45);
        const asOutline = await withoutIt(fakeDetector([]).detector).recognize(scene, USER, outline, [210, 160]);
        for (const boxes of [
          [own, material],
          [material, own], // whatever the detector's order
        ]) {
          const res = await engineWith(fakeDetector(boxes).detector).recognize(scene, USER, outline, [210, 160]);
          expect({ ...res, timings: {} }).toEqual({ ...asOutline, timings: {} });
          expect(clickRedetectPick(found(210, 160, 150, 219, rad(12), 1, outline), boxes, CLICK_REDETECT, { x: 210, y: 160 })).toBeNull();
        }
        // Alone, the material would be taken: it holds the click, overlaps the outline and is 28° apart.
        expect(clickRedetectPick(found(210, 160, 150, 219, rad(12), 1, outline), [material], CLICK_REDETECT, { x: 210, y: 160 })).toBe(material);
      });

      describe("with the click's own point (crop.click): the card found must hold it, not the outline's centre", () => {
        // (210, 160): on the card found. (110, 90): inside the wrong-way outline but off the card found, as a click on
        // the covered card's art beside the top card (t=7770: a click on B's art, inside C's outline).
        const readByCard = (log: RGBAImage[][]) => meanDiff(log[0][0], artBoxOf(card102())) < 3;

        it('takes the card found when it holds the click, and keeps the outline when it does not', async () => {
          const scene = sceneWith(card102(), 12);
          const on: RGBAImage[][] = [];
          const onCard = await engineWith(fakeDetector([card()]).detector, on).recognize(scene, USER, wrongWay(), [210, 160]);
          expect(readByCard(on)).toBe(true);
          expect([onCard.confident, onCard.candidates[0]?.cardId]).toEqual([true, 102]);
          const beside: RGBAImage[][] = [];
          const offCard = await engineWith(fakeDetector([card()]).detector, beside).recognize(scene, USER, wrongWay(), [110, 90]);
          expect(readByCard(beside)).toBe(false);
          const asOutline = await withoutIt(fakeDetector([card()]).detector).recognize(scene, USER, wrongWay());
          expect({ ...offCard, timings: {} }).toEqual({ ...asOutline, timings: {} });
          // Without the point, the outline's centre decides, as before: the card found holds it.
          const centre: RGBAImage[][] = [];
          await engineWith(fakeDetector([card()]).detector, centre).recognize(scene, USER, wrongWay());
          expect(readByCard(centre)).toBe(true);
        });

        it("drops a point that isn't 2 finite numbers inside the crop: the outline's centre decides", async () => {
          const scene = sceneWith(card102(), 12); // 420×320
          for (const click of [[Number.NaN, 90], [110, Number.POSITIVE_INFINITY], [-1, 90], [110, 321], [421, 90], [110], [110, 90, 1], ['110', '90'], 'here', null]) {
            const log: RGBAImage[][] = [];
            await engineWith(fakeDetector([card()]).detector, log).recognize(scene, USER, wrongWay(), click as never);
            expect(readByCard(log)).toBe(true);
          }
        });

        it('scales the point with the crop when it is shrunk (a long side over MAX_SIDE)', async () => {
          // The scene at 5×, shrunk to 1600×1219 before anything is read: the detector sees the card there.
          const big = resizeRGBA(sceneWith(card102(), 12), 2100, 1600);
          const s = 1600 / 2100;
          const shrunkCard = () => found(1050 * s, 800 * s, 750 * s, 1095 * s, rad(12), 0.8);
          const run = async (click?: [number, number]) => {
            const log: RGBAImage[][] = [];
            await engineWith(fakeDetector([shrunkCard()]).detector, log).recognize(big, { x: 500, y: 100, w: 1100, h: 1400 }, cornersOf(1050, 800, 800, 1150, -20), click);
            return meanDiff(log[0][0], artBoxOf(card102())) < 12;
          };
          expect(await run()).toBe(true);
          // (550, 450) in the crop's pixels is (419, 343) once shrunk: off the card found. Unscaled, it would be on it.
          expect(await run([550, 450])).toBe(false);
          expect(await run([1050, 800])).toBe(true);
        });
      });

      it('is left out on request (clickRedetect: false): a click reads its outline and never looks in the crop again', async () => {
        const { detector, seen } = fakeDetector([card()]);
        const res = await withoutIt(detector).recognize(sceneWith(card102(), 12), USER, wrongWay());
        expect(seen).toEqual([]);
        expect(res.timings.cardDetect).toBeUndefined();
      });

      it('takes the first card that qualifies, in the order the detector gives them, and tells tilts apart modulo a half turn (clickRedetectPick)', () => {
        const outline = found(210, 160, 160, 230, rad(-20), 1);
        const [a, b] = [found(210, 160, 150, 219, rad(12)), found(210, 160, 150, 219, rad(16))];
        expect(clickRedetectPick(outline, [a, b], CLICK_REDETECT)).toBe(a);
        expect(clickRedetectPick(outline, [b, a], CLICK_REDETECT)).toBe(b);
        // A box turned a half turn is the same box; −85° and +85° are 10° apart.
        const loose = { minIoU: 0, minTilt: 5 };
        expect(clickRedetectPick(found(210, 160, 150, 219, rad(12)), [found(210, 160, 150, 219, rad(192))], loose)).toBeNull();
        const nearlySideways = found(210, 160, 150, 219, rad(-85));
        expect(clickRedetectPick(nearlySideways, [found(210, 160, 150, 219, rad(85))], { minIoU: 0, minTilt: 11 })).toBeNull();
        expect(clickRedetectPick(nearlySideways, [found(210, 160, 150, 219, rad(85))], { minIoU: 0, minTilt: 9 })).not.toBeNull();
        // An outline listed landscape (its long side first, 175°) is the same card as a portrait box at −95°, 360° round.
        expect(clickRedetectPick(found(210, 160, 219, 150, rad(175)), [found(210, 160, 150, 219, rad(-95))], CLICK_REDETECT)).toBeNull();
        // minTilt 20 is the line: 20.5° apart is taken, 19.5° apart is the outline's own card (the outline stays).
        const past = found(210, 160, 150, 219, rad(0.5));
        expect(clickRedetectPick(outline, [past], CLICK_REDETECT)).toBe(past);
        expect(clickRedetectPick(outline, [found(210, 160, 150, 219, rad(-0.5))], CLICK_REDETECT)).toBeNull();
      });
    });
  });

  describe('a box dragged around a covered card: the card on top of it is never a sure answer (click-stack-report.md)', () => {
    // The card lies at 12°; the user's box is drawn to its left, around a card mostly hidden under it, which the
    // detector sees only under its confidence cut (a weak detection).
    const BOX = { x: 20, y: 40, w: 150, h: 230 };
    const top = (kind?: DetectedCardBox['kind']) => found(210, 160, 150, 219, rad(12), 0.75, undefined, kind);
    const under = (kind?: DetectedCardBox['kind']) => found(95, 155, 140, 215, rad(8), 0.35, undefined, kind);
    /** A detector giving `cards` at or over its cut and `weak` under it, from one run (detectInCropWithWeak), recording those runs. */
    function weakDetector(cards: DetectedCardBox[], weak: DetectedCardBox[]) {
      const runs: RGBAImage[] = [];
      const detector: CardDetector = {
        detect: () => Promise.reject(new Error('a scan uses detectInCrop')),
        detectInCrop: async () => cards,
        detectInCropWithWeak: async (crop) => (runs.push(crop), { cards, weak }),
      };
      return { detector, runs };
    }
    const asBefore = (cards: DetectedCardBox[], weak: DetectedCardBox[]) =>
      createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC, detector: weakDetector(cards, weak).detector, covered: false });

    it('answers "Not sure", with the same cards, when a weak detection fits the box much better than the pick and holds little of it', async () => {
      const scene = sceneWith(card102(), 12);
      const { detector, runs } = weakDetector([top()], [under()]);
      const res = await engineWith(detector).recognize(scene, BOX);
      expect(runs).toEqual([scene]);
      const before = await asBefore([top()], [under()]).recognize(scene, BOX);
      expect(before).toMatchObject({ confident: true, best: { hypothesis: 'quad', rotation: 0 } });
      expect(before.candidates[0].cardId).toBe(102);
      expect(res.confident).toBe(false);
      expect({ ...res, confident: true, timings: {} }).toEqual({ ...before, timings: {} });
    });

    it("leaves the pick's answer as it was: a loose box around it, a weak box around the card itself, a face-down weak detection, none, a face-down pick", async () => {
      const scene = sceneWith(card102(), 12);
      for (const [box, cards, weak] of [
        [{ x: 40, y: 10, w: 340, h: 300 }, [top()], [under()]], // the card fits a loose box better than the weak detection does
        [{ x: 89, y: 8, w: 242, h: 304 }, [top()], [found(210, 160, 190, 270, rad(12), 0.3)]], // a weak box round the card itself (its sleeve)
        [BOX, [top()], [under('face-down')]],
        [BOX, [top()], []],
        [BOX, [top('face-down')], [under()]],
      ] as [Rect, DetectedCardBox[], DetectedCardBox[]][]) {
        const res = await engineWith(weakDetector(cards, weak).detector).recognize(scene, box);
        expect({ ...res, timings: {} }).toEqual({ ...(await asBefore(cards, weak).recognize(scene, box)), timings: {} });
        // The face-up card, sure, each time (the face-down pick is read with the box as drawn: the model decides).
        if (cards[0].kind !== 'face-down') expect([res.confident, res.candidates[0]?.cardId]).toEqual([true, 102]);
      }
    });

    it('keeps to its thresholds (coveredBy): the weak fit, its lead over the pick, the share of the pick inside it', () => {
      const pick = top();
      const weak = under();
      // Here the weak detection fits the box by 0.881, the pick by 0.188, and holds 0.322 of the pick.
      expect(coveredBy(pick, [weak], BOX, COVERED)).toBe(weak);
      expect(coveredBy(pick, [weak], BOX, { ...COVERED, minFit: 0.89 })).toBeNull();
      expect(coveredBy(pick, [weak], BOX, { ...COVERED, lead: 0.7 })).toBeNull();
      expect(coveredBy(pick, [weak], BOX, { ...COVERED, maxPickInside: 0.3 })).toBeNull();
    });

    it('is left out on request (covered: false), with a detector that gives no weak detections, and for a click', async () => {
      const scene = sceneWith(card102(), 12);
      expect((await asBefore([top()], [under()]).recognize(scene, BOX)).confident).toBe(true);
      const plain: CardDetector = { detect: () => Promise.reject(new Error('a scan uses detectInCrop')), detectInCrop: async () => [top()] };
      expect((await engineWith(plain).recognize(scene, BOX)).confident).toBe(true);
      // A click reads its outline: the crop is searched only by the click re-detect (detectInCrop).
      const { detector, runs } = weakDetector([top()], [under()]);
      const clicked = await engineWith(detector).recognize(scene, BOX, cornersOf(210, 160, 150, 219, 12));
      expect(runs).toEqual([]);
      expect(clicked.confident).toBe(true);
    });
  });
});

describe('the rescue path: a card cut by the edge of the picture (partial-report.md)', () => {
  // The picture: a 420×300 dark frame whose top edge cuts the card (150×219) 88 px down: 40% is outside.
  // The crop is the user's box around what shows, plus the content script's 4% margin, clipped at the
  // picture's top: so its top side is the picture's edge.
  const CARD = { x: 135, y: -88, w: 150, h: 219 };
  function picture(artwork: RGBAImage): RGBAImage {
    const pic = solid(420, 300, [15, 60, 30]);
    const small = resizeRGBA(artwork, CARD.w, CARD.h);
    for (let y = 0; y < CARD.h; y++) {
      const py = CARD.y + y;
      if (py < 0 || py >= pic.height) continue;
      pic.data.set(small.data.subarray(y * CARD.w * 4, (y + 1) * CARD.w * 4), (py * pic.width + CARD.x) * 4);
    }
    return pic;
  }
  const whole = (cardId: number) => {
    const sel = cardSelection(art(cardId));
    return cropRGBA(sel, Math.round(590 * 0.04), Math.round(860 * 0.04), 590, 860);
  };
  const seenH = CARD.y + CARD.h; // 131 px of the card show
  const CROP = { x: 129, y: 0, w: 162, h: 137 }; // the box (135, 0, 150×131) plus its margin, clipped at the top
  const INNER = { x: 6, y: 0, w: 150, h: seenH };
  const box = (cx: number, cy: number, w: number, h: number, kind: DetectedCardBox['kind'] = 'face-up'): DetectedCardBox => ({
    cx,
    cy,
    w,
    h,
    angle: 0,
    conf: 0.9,
    kind,
    pts: boxCorners(cx, cy, w, h, 0).map((p) => [p.x, p.y] as [number, number]),
  });
  /** The card detector: the part that shows in the crop; the whole card in the crop padded past the top. */
  function cutDetector(padded: DetectedCardBox['kind'] = 'face-up') {
    const seen: RGBAImage[] = [];
    const detector: CardDetector = {
      detect: () => Promise.reject(new Error('a scan uses detectInCrop')),
      detectInCrop: async (img) => {
        seen.push(img);
        if (img.height === CROP.h) return [box(6 + 75, seenH / 2, 150, seenH)];
        // Padded by the crop's long side (162) past its top: the card's top is at 162 - 88.
        return [box(6 + 75, CROP.w - 88 + CARD.h / 2, CARD.w, CARD.h, padded)];
      },
    };
    return { detector, seen };
  }
  // No normal reading clears this floor; the rescue's readings of the whole card clear its own.
  const STRICT: EmbeddingModelSpec = { ...SPEC, thresholds: { score: 0.9, margin: 0.02, floor: 0.9999 } };
  // The rescue path alone: the suggestions that follow it when it finds nothing are tested at the end.
  const engineWith = (detector: CardDetector, rescue?: { floor: number } | false, log: RGBAImage[][] = [], suggest: false | { floor: number } = false) =>
    createEngine({ embedder: fakeEmbedder(log), index: fakeIndex(STRICT), spec: STRICT, detector, rescue: rescue ?? { floor: 0.95 }, suggest });
  const cropOf = (artwork: RGBAImage) => cropRGBA(picture(artwork), CROP.x, CROP.y, CROP.w, CROP.h);

  it('reads the whole card: the crop padded past the edge, the detector run there, the part outside the picture filled', async () => {
    const { detector, seen } = cutDetector();
    const log: RGBAImage[][] = [];
    const res = await engineWith(detector, undefined, log).recognize(cropOf(whole(102)), INNER);
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.candidates[0].score).toBeGreaterThanOrEqual(0.95);
    // Never confident: a rescue answers "Not sure".
    expect(res.confident).toBe(false);
    expect(res.truncated).toBe(true);
    expect(res.best).toEqual({ hypothesis: 'quad', rotation: 0 });
    expect(res.timings.rescue).toBeGreaterThanOrEqual(0);
    // The detector saw the crop, then the crop with grey (its own padding) past the picture's top edge.
    expect(seen.map((i) => [i.width, i.height])).toEqual([
      [CROP.w, CROP.h],
      [CROP.w, CROP.h + CROP.w],
    ]);
    expect(Array.from(seen[1].data.subarray(0, 4))).toEqual([114, 114, 114, 255]);
    // The normal path's two stages, then the rescue's upright readings (the corners view; the box view is
    // the same here), filled two ways: that answered, so no 180° readings.
    expect(log.map((batch) => batch.length)).toEqual([2, 2, 2]);
  });

  it('answers with its own readings alone: a normal reading just under the model floor never heads it', async () => {
    // A scripted model: the normal readings (the first two batches) lean to card 101, the rescue's to 102,
    // both under the model's floor (0.99) and over the rescue's (0.9); 101's lean is the stronger.
    const v101 = fakeVector(art(101));
    const v102 = fakeVector(art(102));
    const blend = (a: Float32Array, b: Float32Array, t: number) => l2normalize(a.map((x, i) => x + t * b[i]));
    let calls = 0;
    const scripted: Embedder = {
      modelId: SPEC.id,
      async embed(images) {
        calls++;
        return images.map(() => (calls <= 2 ? blend(v101, v102, 0.2) : blend(v102, v101, 0.3)));
      },
    };
    const spec: EmbeddingModelSpec = { ...SPEC, thresholds: { score: 0.999, margin: 0.02, floor: 0.99 } };
    const res = await createEngine({ embedder: scripted, index: fakeIndex(spec), spec, detector: cutDetector().detector, rescue: { floor: 0.9 }, suggest: false }).recognize(
      cropOf(whole(102)),
      INNER,
    );
    expect(calls).toBe(3);
    expect(res.candidates[0].cardId).toBe(102);
    expect(res.confident).toBe(false);
    // Its readings must also lead the next card by RESCUE.lead: a near-tie is a guess, so nothing.
    calls = 0;
    const tie = await createEngine({ embedder: scripted, index: fakeIndex(spec), spec, detector: cutDetector().detector, rescue: { floor: 0.9, lead: 0.5 }, suggest: false }).recognize(
      cropOf(whole(102)),
      INNER,
    );
    expect(tie.candidates).toEqual([]);
    expect(tie.truncated).toBe(true);
  });

  it('is left out on request (rescue: false): the scan is as it was, nothing', async () => {
    const { detector, seen } = cutDetector();
    const res = await engineWith(detector, false).recognize(cropOf(whole(102)), INNER);
    expect(res.candidates).toEqual([]);
    expect('truncated' in res).toBe(false);
    expect(res.timings.rescue).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("never runs for a card the picture doesn't cut: a crop with its whole margin on every side", async () => {
    const { detector, seen } = cutDetector();
    // The same pixels, but the box drawn inside them: every side has its margin, so none is the picture's edge.
    const res = await engineWith(detector).recognize(cropOf(whole(102)), { x: 6, y: 6, w: 150, h: 125 });
    expect(res.candidates).toEqual([]);
    expect('truncated' in res).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('never runs for a scan with an answer, sure or not: same readings, same result', async () => {
    const withRescue: RGBAImage[][] = [];
    const without: RGBAImage[][] = [];
    const scene = sceneWith(card102(), 12);
    const detector = (): CardDetector => ({ detect: async () => [found102] });
    const found102: DetectedCardBox = {
      cx: 210,
      cy: 160,
      w: 150,
      h: 219,
      angle: (12 * Math.PI) / 180,
      conf: 0.95,
      pts: boxCorners(210, 160, 150, 219, (12 * Math.PI) / 180).map((p) => [p.x, p.y] as [number, number]),
    };
    const a = await createEngine({ embedder: fakeEmbedder(withRescue), index: fakeIndex(), spec: SPEC, detector: detector() }).recognize(scene, { x: 0, y: 0, w: 420, h: 320 });
    const b = await createEngine({ embedder: fakeEmbedder(without), index: fakeIndex(), spec: SPEC, detector: detector(), rescue: false }).recognize(scene, { x: 0, y: 0, w: 420, h: 320 });
    expect({ ...a, timings: {} }).toEqual({ ...b, timings: {} });
    expect(withRescue).toEqual(without);
    expect(a.timings.rescue).toBeUndefined();
  });

  it('reads nothing more when the padded crop shows no face-up card, and says the card is cut only when one was found', async () => {
    const faceDown = cutDetector('face-down');
    const log: RGBAImage[][] = [];
    const res = await engineWith(faceDown.detector, undefined, log).recognize(cropOf(whole(102)), INNER);
    expect(res.candidates).toEqual([]);
    expect(faceDown.seen).toHaveLength(2);
    // The part that shows was a face-up card reaching the edge: the card is cut, whatever the rest.
    expect(res.truncated).toBe(true);
    expect(log).toHaveLength(2); // the normal path's two stages only
  });

  it('never answers the card back, and answers nothing when its readings stay under its floor', async () => {
    const back = cardSelection(art(CARD_BACK_ID));
    const backCard = cropRGBA(back, Math.round(590 * 0.04), Math.round(860 * 0.04), 590, 860);
    // The whole card read shows the card back's artwork best; with a floor every reading clears, the
    // answer is the next card, never the back.
    const res = await engineWith(cutDetector().detector, { floor: 0.5 }).recognize(cropOf(backCard), INNER);
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res.candidates.map((c) => c.cardId)).not.toContain(CARD_BACK_ID);
    expect(res.faceDown).toBe(false);
    const high = await engineWith(cutDetector().detector, { floor: 1.01 }).recognize(cropOf(whole(102)), INNER);
    expect(high.candidates).toEqual([]);
    expect(high.truncated).toBe(true);
  });

  it('when it finds nothing, the face-up card that shows gets suggestions from the normal readings, and is still said to be cut', async () => {
    const log: RGBAImage[][] = [];
    const res = await engineWith(cutDetector().detector, { floor: 1.01 }, log, { floor: 0.5 }).recognize(cropOf(whole(102)), INNER);
    expect(res.candidates.length).toBeGreaterThan(0);
    expect(res).toMatchObject({ confident: false, suggested: true, truncated: true });
    expect(res.candidates.every((c) => c.score < STRICT.thresholds.floor)).toBe(true);
    // The rescue's readings were made (and found nothing): the offer comes from the normal ones, no new reading.
    expect(log.length).toBeGreaterThan(2);
    expect(res.timings.rescue).toBeGreaterThanOrEqual(0);
  });
});

describe('suggestions: a card is there, but no reading clears the model floor (click-regression-report.md)', () => {
  // A floor no reading of the fake model reaches (its int8 index scores a perfect reading a hair over 1): every scan would be "nothing".
  const HIGH: EmbeddingModelSpec = { ...SPEC, thresholds: { score: 1.02, margin: 0.02, floor: 1.01 } };
  const pts = (cx: number, cy: number, w: number, h: number, deg: number) => boxCorners(cx, cy, w, h, (deg * Math.PI) / 180).map((p) => [p.x, p.y] as [number, number]);
  const box = (kind: DetectedCardBox['kind'], conf = 0.9): DetectedCardBox => ({ cx: 210, cy: 160, w: 150, h: 219, angle: (12 * Math.PI) / 180, conf, kind, pts: pts(210, 160, 150, 219, 12) });
  const detecting = (boxes: DetectedCardBox[]): CardDetector => ({ detect: async () => boxes });
  const USER = { x: 100, y: 20, w: 220, h: 280 };
  const SUGGESTING = { floor: 0.9, margin: 0.08, max: 4, pickConf: 0.75 };
  const engineWith = (opts: { detector?: CardDetector; suggest?: Partial<typeof SUGGESTING> | false; embedder?: Embedder; spec?: EmbeddingModelSpec }) =>
    createEngine({
      embedder: opts.embedder ?? fakeEmbedder(),
      index: fakeIndex(opts.spec ?? HIGH),
      spec: opts.spec ?? HIGH,
      detector: opts.detector,
      suggest: opts.suggest === undefined ? SUGGESTING : opts.suggest,
    });
  /** An embedder that reads every image as the same blend of the index's artworks (card id → weight). */
  const blending = (weights: Record<number, number>): Embedder => ({
    modelId: SPEC.id,
    async embed(images) {
      const v = new Float32Array(SPEC.dim);
      for (const [id, w] of Object.entries(weights)) fakeVector(art(Number(id))).forEach((x, i) => (v[i] += w * x));
      return images.map(() => l2normalize(v.slice()));
    },
  });

  it('offers the closest cards as "Not sure", marked suggested, for the face-up card the detector picked', async () => {
    const res = await engineWith({ detector: detecting([box('face-up')]) }).recognize(sceneWith(card102(), 12), USER);
    expect(res.error).toBeUndefined();
    expect(res.candidates[0]).toMatchObject({ cardId: 102, source: 'embedding' });
    expect(res).toMatchObject({ confident: false, faceDown: false, suggested: true, recognizer: 'embedding', best: { hypothesis: 'quad', rotation: 0 } });
    const top = res.candidates[0].score;
    expect(top).toBeLessThan(HIGH.thresholds.floor);
    for (const c of res.candidates) expect(c.score).toBeGreaterThanOrEqual(Math.max(SUGGESTING.floor, top - SUGGESTING.margin));
  });

  it("offers them for a clicked card too: its outline is a face-up card's", async () => {
    const never: CardDetector = { detect: () => Promise.reject(new Error('a click is not searched for again')) };
    const res = await engineWith({ detector: never }).recognize(sceneWith(card102(), 12), USER, pts(210, 160, 150, 219, 12));
    expect(res).toMatchObject({ confident: false, suggested: true });
    expect(res.candidates[0].cardId).toBe(102);
  });

  it('keeps to its floor, its margin under the first card and its number, and never offers the card back', async () => {
    const detector = detecting([box('face-up')]);
    const embedder = blending({ 101: 1, 102: 0.8, 103: 0.35 });
    const scene = sceneWith(card102(), 12);
    const all = await engineWith({ detector, embedder, suggest: { floor: 0, margin: 1, max: 10 } }).recognize(scene, USER);
    expect(all.candidates.map((c) => c.cardId)).toEqual([101, 102, 103]); // the card back is never offered
    const [s101, s102, s103] = all.candidates.map((c) => c.score);
    expect(s101).toBeGreaterThan(s102);
    expect(s102).toBeGreaterThan(s103);
    const ids = async (suggest: Partial<typeof SUGGESTING>) => (await engineWith({ detector, embedder, suggest }).recognize(scene, USER)).candidates.map((c) => c.cardId);
    expect(await ids({ floor: 0, margin: 1, max: 2 })).toEqual([101, 102]);
    expect(await ids({ floor: 0, margin: (s101 - s102 + s101 - s103) / 2, max: 10 })).toEqual([101, 102]);
    expect(await ids({ floor: (s102 + s103) / 2, margin: 1, max: 10 })).toEqual([101, 102]);
    // Nothing when the first card itself is under the floor, or when the card back reads best.
    expect(await ids({ floor: s101 + 0.001, margin: 1, max: 10 })).toEqual([]);
    const back = await engineWith({ detector, embedder: blending({ [CARD_BACK_ID]: 1, 102: 0.5 }), suggest: { floor: 0, margin: 1, max: 10 } }).recognize(scene, USER);
    expect(back.candidates).toEqual([]);
    expect(back.suggested).toBeUndefined();
  });

  it("needs the detector to be sure a card is in the box (pickConf), and takes a clicked card's outline as the user's own pick", async () => {
    const scene = sceneWith(card102(), 12);
    const unsure = await engineWith({ detector: detecting([box('face-up', 0.6)]) }).recognize(scene, USER);
    expect(unsure.candidates).toEqual([]);
    expect('suggested' in unsure).toBe(false);
    const sure = await engineWith({ detector: detecting([box('face-up', 0.8)]) }).recognize(scene, USER);
    expect(sure.suggested).toBe(true);
    // A click: the detector outlined it (at any confidence it outlines), and the user picked it.
    const clicked = await engineWith({ detector: detecting([]) }).recognize(scene, USER, pts(210, 160, 150, 219, 12));
    expect(clicked.suggested).toBe(true);
  });

  it('reads nothing when no face-up card was picked: a face-down pick, no card in the box, or no detector', async () => {
    const scene = sceneWith(card102(), 12);
    for (const detector of [detecting([box('face-down')]), detecting([]), undefined]) {
      const res = await engineWith({ detector }).recognize(scene, USER);
      expect(res.candidates).toEqual([]);
      expect('suggested' in res).toBe(false);
    }
  });

  it("keeps to the model's own floor (spec.suggestFloor) instead of SUGGEST's; an explicit suggest.floor still wins", async () => {
    const detector = detecting([box('face-up')]);
    const embedder = blending({ 101: 1, 102: 0.8, 103: 0.35 });
    const scene = sceneWith(card102(), 12);
    const all = await engineWith({ detector, embedder, suggest: { floor: 0, margin: 1, max: 10 } }).recognize(scene, USER);
    const [s101, s102, s103] = all.candidates.map((c) => c.score);
    const ids = async (suggestFloor: number, suggest: Partial<typeof SUGGESTING>) =>
      (await engineWith({ detector, embedder, spec: { ...HIGH, suggestFloor }, suggest }).recognize(scene, USER)).candidates.map((c) => c.cardId);
    expect(await ids((s102 + s103) / 2, { margin: 1, max: 10 })).toEqual([101, 102]);
    expect(await ids(s101 + 0.001, { margin: 1, max: 10 })).toEqual([]);
    expect(await ids(s101 + 0.001, { floor: 0, margin: 1, max: 10 })).toEqual([101, 102, 103]);
  });

  it('is left out on request (suggest: false): the scan is as it was, nothing', async () => {
    const res = await engineWith({ detector: detecting([box('face-up')]), suggest: false }).recognize(sceneWith(card102(), 12), USER);
    expect(res.candidates).toEqual([]);
    expect('suggested' in res).toBe(false);
  });

  it('never changes a scan with an answer, sure or not: same readings, same result', async () => {
    const scene = sceneWith(card102(), 12);
    // One card far ahead: confident; two cards within the margin: "Not sure". Both clear SPEC's floor.
    for (const [weights, confident] of [
      [{ 102: 1 }, true],
      [{ 101: 1, 102: 0.97 }, false],
    ] as const) {
      const on: number[] = [];
      const off: number[] = [];
      const counted = (log: number[]): Embedder => {
        const inner = blending(weights);
        return { modelId: SPEC.id, embed: async (images) => (log.push(images.length), inner.embed(images)) };
      };
      const a = await engineWith({ detector: detecting([box('face-up')]), spec: SPEC, embedder: counted(on), suggest: { floor: 0, margin: 1, max: 10 } }).recognize(scene, USER);
      const b = await engineWith({ detector: detecting([box('face-up')]), spec: SPEC, embedder: counted(off), suggest: false }).recognize(scene, USER);
      expect(a.confident).toBe(confident);
      expect(a.candidates.length).toBeGreaterThan(0);
      expect({ ...a, timings: {} }).toEqual({ ...b, timings: {} });
      expect('suggested' in a).toBe(false);
      expect(on).toEqual(off);
    }
  });
});

describe('a low match: a "Not sure" read from the user\'s box alone, its first card barely ahead (diag-overframe-report.md)', () => {
  // SPEC: floor 0.5, score 0.9, margin 0.02. The card lies in a 420×320 scene; the user's box is card-shaped.
  const pts = (cx: number, cy: number, w: number, h: number, deg: number) => boxCorners(cx, cy, w, h, (deg * Math.PI) / 180).map((p) => [p.x, p.y] as [number, number]);
  const box = (kind: DetectedCardBox['kind']): DetectedCardBox => ({ cx: 210, cy: 160, w: 150, h: 219, angle: (12 * Math.PI) / 180, conf: 0.9, kind, pts: pts(210, 160, 150, 219, 12) });
  const detecting = (boxes: DetectedCardBox[]): CardDetector => ({ detect: async () => boxes });
  const USER = { x: 100, y: 20, w: 220, h: 280 };
  const scene = () => sceneWith(card102(), 12);
  const blend = (weights: Record<number, number>) => {
    const v = new Float32Array(SPEC.dim);
    for (const [id, w] of Object.entries(weights)) fakeVector(art(Number(id))).forEach((x, i) => (v[i] += w * x));
    return l2normalize(v);
  };
  /**
   * An embedder that reads every image as one blend of the index's artworks (card id → weight), or with `own`, the
   * straightened card's art cuts (451 px wide) as `card` and the user's box's own readings (much smaller here) as `own`.
   */
  const reading = (card: Record<number, number>, own = card): Embedder => ({
    modelId: SPEC.id,
    embed: async (images) => images.map((img) => blend(img.width > 300 ? card : own)),
  });
  const engineWith = (embedder: Embedder, opts: { detector?: CardDetector; spec?: EmbeddingModelSpec; lowMatch?: false } = {}) =>
    createEngine({ embedder, index: fakeIndex(opts.spec ?? SPEC), spec: opts.spec ?? SPEC, detector: opts.detector, ...(opts.lowMatch === false ? { lowMatch: false } : {}) });
  /** The first shown card's lead over the next one shown. */
  const leadOf = (res: { candidates: { score: number }[] }) => res.candidates[0].score - (res.candidates[1]?.score ?? 0);
  // 101 first, 0.069 ahead of 102 (the card back between them is no alternative); and 0.076 ahead. Both "Not sure".
  const CLOSE = { 101: 1, 102: 0.8 };
  const CLEAR = { 101: 1, 102: 0.78 };
  const BOX_READINGS = ['whole', 'fit', 'art'];

  it('labels it suggested (the popover\'s "Low match") when the lead is under 0.07, and changes nothing else', async () => {
    // No detector: the box as drawn, whole and art-only; a detector that finds no card: the box as a whole card.
    for (const detector of [undefined, detecting([])]) {
      const on = await engineWith(reading(CLOSE), { detector }).recognize(scene(), USER);
      const off = await engineWith(reading(CLOSE), { detector, lowMatch: false }).recognize(scene(), USER);
      expect(on.error).toBeUndefined();
      expect(on.candidates[0].cardId).toBe(101);
      expect(on.confident).toBe(false);
      expect(BOX_READINGS).toContain(on.best?.hypothesis);
      expect(leadOf(on)).toBeLessThan(0.07);
      expect(on.suggested).toBe(true);
      expect('suggested' in off).toBe(false);
      expect({ ...on, suggested: undefined, timings: {} }).toEqual({ ...off, timings: {} });
    }
  });

  it('leaves it as it is from a lead of 0.07 on', async () => {
    const on = await engineWith(reading(CLEAR), { detector: detecting([]) }).recognize(scene(), USER);
    const off = await engineWith(reading(CLEAR), { detector: detecting([]), lowMatch: false }).recognize(scene(), USER);
    expect(on.confident).toBe(false);
    expect(on.candidates[0].cardId).toBe(101);
    expect(BOX_READINGS).toContain(on.best?.hypothesis);
    expect(leadOf(on)).toBeGreaterThanOrEqual(0.07);
    expect('suggested' in on).toBe(false);
    expect({ ...on, timings: {} }).toEqual({ ...off, timings: {} });
  });

  it('never touches a confident answer, however small its lead', async () => {
    const lower: EmbeddingModelSpec = { ...SPEC, thresholds: { ...SPEC.thresholds, score: 0.85 } };
    const res = await engineWith(reading({ 101: 1, 102: 0.9 }), { detector: detecting([]), spec: lower }).recognize(scene(), USER);
    expect(res.confident).toBe(true);
    expect(res.candidates[0].cardId).toBe(101);
    expect(BOX_READINGS).toContain(res.best?.hypothesis);
    expect(leadOf(res)).toBeLessThan(0.07);
    expect('suggested' in res).toBe(false);
  });

  it("never touches a picked card's reading: a face-up card the detector picked, or a clicked card's outline", async () => {
    const picked = await engineWith(reading(CLOSE), { detector: detecting([box('face-up')]) }).recognize(scene(), USER);
    const clicked = await engineWith(reading(CLOSE), { detector: detecting([]) }).recognize(scene(), USER, pts(210, 160, 150, 219, 12));
    for (const res of [picked, clicked]) {
      expect(res.confident).toBe(false);
      expect(res.candidates[0].cardId).toBe(101);
      expect(res.best?.hypothesis).toBe('quad');
      expect(leadOf(res)).toBeLessThan(0.07);
      expect('suggested' in res).toBe(false);
    }
  });

  it("reads a face-down pick by where its first card's best score came from: the box's own reading is labelled, the straightened card's is not", async () => {
    // WEAK reads 101 and 103 at about 0.81; CLOSER reads 101 at 0.875 and 102 at 0.842 (lead 0.033).
    const WEAK = { 101: 1, 103: 1 };
    const CLOSER = { 101: 1, 102: 0.9 };
    const fromBox = await engineWith(reading(WEAK, CLOSER), { detector: detecting([box('face-down')]) }).recognize(scene(), USER);
    expect(fromBox.best?.hypothesis).toBe('whole');
    expect(fromBox.suggested).toBe(true);
    const fromCard = await engineWith(reading(CLOSER, WEAK), { detector: detecting([box('face-down')]) }).recognize(scene(), USER);
    expect(fromCard.best?.hypothesis).toBe('quad');
    expect('suggested' in fromCard).toBe(false);
    for (const res of [fromBox, fromCard]) {
      expect(res.confident).toBe(false);
      expect(res.candidates[0].cardId).toBe(101);
      expect(leadOf(res)).toBeLessThan(0.07);
    }
  });

  it('never labels the card back (suggestions never offer it either)', async () => {
    const res = await engineWith(reading({ 101: 1, 102: 0.5, 103: 1 }), { detector: detecting([]) }).recognize(scene(), USER);
    expect(res.faceDown).toBe(true);
    expect(res.confident).toBe(false);
    expect(res.candidates[0].cardId).toBe(CARD_BACK_ID);
    expect(leadOf(res)).toBeLessThan(0.07);
    expect('suggested' in res).toBe(false);
  });
});

describe("the count-badge reading: a simulator's pile count over the art (diag-t950-report.md)", () => {
  const FLOOR: EmbeddingModelSpec = { ...SPEC, thresholds: { score: 0.97, margin: 0.02, floor: 0.95 } };
  const USER = { x: 100, y: 20, w: 220, h: 280 };
  /** Card 101 whole (590x860), with a white "1" over the middle of its art when `badge`. */
  const card101 = (badge: boolean) => {
    const sel = cardSelection(art(101));
    const c = cropRGBA(sel, Math.round(590 * 0.04), Math.round(860 * 0.04), 590, 860);
    if (!badge) return c;
    const paint = (x: number, y: number, w: number, h: number) => {
      for (let py = Math.round(y * 860); py < Math.round((y + h) * 860); py++)
        for (let px = Math.round(x * 590); px < Math.round((x + w) * 590); px++) c.data.set([250, 250, 246, 255], (py * 590 + px) * 4);
    };
    paint(0.48, 0.41, 0.04, 0.18); // the stem
    paint(0.44, 0.41, 0.04, 0.03); // the flag
    paint(0.44, 0.565, 0.12, 0.025); // the foot
    return c;
  };
  const faceUp = (kind: DetectedCardBox['kind'] = 'face-up'): CardDetector => ({
    detect: async () => [{ cx: 210, cy: 160, w: 150, h: 219, angle: 0, conf: 0.95, kind, pts: boxCorners(210, 160, 150, 219, 0).map((p) => [p.x, p.y] as [number, number]) }],
  });
  /** The fake model, except that an image with a white badge in it reads as a blend of cards 101 and 102 (the badge costs the right card its lead). */
  const badgeBlind = (log: RGBAImage[][] = []): Embedder => ({
    modelId: SPEC.id,
    async embed(images) {
      log.push(images);
      return images.map((img) => {
        let white = 0;
        for (let i = 0; i < img.data.length; i += 4) if (Math.min(img.data[i], img.data[i + 1], img.data[i + 2]) >= 235) white++;
        if (white / (img.width * img.height) < 0.01) return fakeVector(img);
        const a = fakeVector(art(101));
        const b = fakeVector(art(102));
        return l2normalize(a.map((x, k) => x + 0.9 * b[k]));
      });
    },
  });
  const engineWith = (opts: { detector?: CardDetector; badge?: false; suggest?: false | { floor: number }; log?: RGBAImage[][] } = {}) =>
    createEngine({
      embedder: badgeBlind(opts.log),
      index: fakeIndex(FLOOR),
      spec: FLOOR,
      detector: opts.detector ?? faceUp(),
      ...(opts.badge === false ? { badge: false } : {}),
      suggest: opts.suggest ?? false,
    });

  it('reads the card again with the badge painted out, as "Not sure", flagged countBadge', async () => {
    const log: RGBAImage[][] = [];
    const res = await engineWith({ log }).recognize(sceneWith(card101(true), 0), USER);
    expect(res.error).toBeUndefined();
    expect(res.candidates[0]).toMatchObject({ cardId: 101, source: 'embedding' });
    expect(res.candidates[0].score).toBeGreaterThanOrEqual(FLOOR.thresholds.floor);
    expect(res).toMatchObject({ confident: false, countBadge: true, faceDown: false, best: { hypothesis: 'quad', rotation: 0 } });
    expect(res.suggested).toBeUndefined();
    expect(res.timings.badge).toBeGreaterThanOrEqual(0);
    // The normal readings (upright, then turned), then the painted-out card's upright readings: those answered.
    expect(log).toHaveLength(3);
    expect(res.candidates.map((c) => c.cardId)).not.toContain(CARD_BACK_ID);
  });

  it('reads nothing more for a card with no badge, a face-down pick, no pick, or a scan with an answer', async () => {
    // No badge: the normal readings (under the floor here) are all there is.
    const plain = await createEngine({ embedder: badgeBlind(), index: fakeIndex(FLOOR), spec: { ...FLOOR, thresholds: { score: 2, margin: 0, floor: 1.5 } }, detector: faceUp(), suggest: false }).recognize(
      sceneWith(card101(false), 0),
      USER,
    );
    expect(plain.candidates).toEqual([]);
    expect(plain.timings.badge).toBeGreaterThanOrEqual(0);
    // No face-up card picked: the badge is never looked for (the box as drawn may still read something).
    for (const detector of [faceUp('face-down'), { detect: async () => [] } as CardDetector]) {
      const res = await engineWith({ detector }).recognize(sceneWith(card101(true), 0), USER);
      expect(res.countBadge).toBeUndefined();
      expect(res.timings.badge).toBeUndefined();
    }
    // An answer today (the normal floor cleared): the badge is never looked for.
    const answered = await createEngine({ embedder: badgeBlind(), index: fakeIndex(SPEC), spec: SPEC, detector: faceUp(), suggest: false }).recognize(sceneWith(card101(true), 0), USER);
    expect(answered.candidates.length).toBeGreaterThan(0);
    expect(answered.countBadge).toBeUndefined();
    expect(answered.timings.badge).toBeUndefined();
  });

  it('answers nothing when the painted-out reading stays under the floor; the suggestions come after it', async () => {
    const unreachable: EmbeddingModelSpec = { ...FLOOR, thresholds: { score: 2, margin: 0, floor: 1.5 } };
    const make = (suggest: false | { floor: number }) =>
      createEngine({ embedder: badgeBlind(), index: fakeIndex(unreachable), spec: unreachable, detector: faceUp(), suggest });
    const none = await make(false).recognize(sceneWith(card101(true), 0), USER);
    expect(none.candidates).toEqual([]);
    const suggested = await make({ floor: 0.5 }).recognize(sceneWith(card101(true), 0), USER);
    expect(suggested).toMatchObject({ suggested: true, confident: false });
    expect(suggested.countBadge).toBeUndefined();
  });

  it('is left out on request (badge: false)', async () => {
    const res = await engineWith({ badge: false }).recognize(sceneWith(card101(true), 0), USER);
    expect(res.candidates).toEqual([]);
    expect(res.timings.badge).toBeUndefined();
  });
});

describe('createEngine().primeSteps', () => {
  it('has one step, the embedding model, run once (the handler loads and runs the card detector)', async () => {
    const embedded: RGBAImage[][] = [];
    const engine = createEngine({ embedder: fakeEmbedder(embedded), index: fakeIndex(), spec: SPEC, detector: { detect: async () => [] } });
    const steps = engine.primeSteps();
    expect(steps).toHaveLength(1);
    await steps[0]();
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toHaveLength(1);
    expect(engine.primeSteps()).toHaveLength(0);
  });

  it('skips the embedding model once a scan ran it', async () => {
    const embedded: RGBAImage[][] = [];
    const engine = createEngine({ embedder: fakeEmbedder(embedded), index: fakeIndex(), spec: SPEC });
    const steps = engine.primeSteps();
    await engine.recognize(resizeRGBA(art(102), 200, 200));
    expect(engine.primeSteps()).toHaveLength(0);
    // A step taken before the scan finds the model warm and does nothing.
    const scans = embedded.length;
    await steps[0]();
    expect(embedded).toHaveLength(scans);
  });

  it('never throws: a failed priming run is only logged', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const embedder: Embedder = {
      modelId: SPEC.id,
      embed: async () => {
        throw new Error('priming boom');
      },
    };
    const engine = createEngine({ embedder, index: fakeIndex(), spec: SPEC });
    const steps = engine.primeSteps();
    expect(steps).toHaveLength(1);
    await expect(steps[0]()).resolves.toBeUndefined();
    expect(JSON.stringify(debug.mock.calls)).toMatch(/priming boom/);
    debug.mockRestore();
  });
});

describe('createEngine() index access, for the self-updating index', () => {
  it('searches the index set by setIndex from the next scan on', async () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const before = await engine.recognize(resizeRGBA(art(102), 200, 200));
    expect(before.candidates[0].cardId).toBe(102);
    // A new artwork (card 555) identical to 102's joins the index; the bundled 102 is dropped.
    const index = engine.getIndex();
    const keep = index.meta.entries.map((e, i) => [e, i] as const).filter(([e]) => e.cardId !== 102);
    const vectors = new Int8Array((keep.length + 1) * SPEC.dim);
    keep.forEach(([, i], k) => vectors.set(index.vectors.subarray(i * SPEC.dim, (i + 1) * SPEC.dim), k * SPEC.dim));
    vectors.set(quantizeInt8(fakeVector(art(102))), keep.length * SPEC.dim);
    const entries = [...keep.map(([e]) => e), { imageId: 555, cardId: 555 }];
    engine.setIndex({ meta: { ...index.meta, count: entries.length, entries }, vectors });
    const after = await engine.recognize(resizeRGBA(art(102), 200, 200));
    expect(after.candidates[0].cardId).toBe(555);
    expect(engine.getIndex().meta.count).toBe(entries.length);
  });

  it('refuses an index for another model', () => {
    const engine = createEngine({ embedder: fakeEmbedder(), index: fakeIndex(), spec: SPEC });
    const index = engine.getIndex();
    expect(() => engine.setIndex({ ...index, meta: { ...index.meta, modelId: 'other' } })).toThrow(/other/);
  });
});
