import { describe, expect, it } from 'vitest';
import type { Schedule } from '../../src/offscreen/detect-cards';
import { boxCorners } from '../../src/offscreen/geometry';
import type { RGBAImage } from '../../src/shared/preprocess';
import type { OwnCardDetector } from '../../src/offscreen/detector/detector';
import { CARD_SEARCH, fromTile, mergeCards, planTiles, tiledCardDetector, tileModelOf, type FoundBox, type OrientedBox, type TileModel } from './tiled-detector';

/** A model's detection: an oriented box in the pixels of the tile it ran on. */
const box = (cx: number, cy: number, w: number, h: number, confidence = 0.95, angle = 0): OrientedBox => ({ cx, cy, w, h, angle, confidence });
const found = (b: OrientedBox, cut = false): FoundBox => ({ ...b, corners: boxCorners(b.cx, b.cy, b.w, b.h, b.angle), cut });
const image = (width: number, height: number): RGBAImage => ({ data: new Uint8ClampedArray(width * height * 4), width, height });

describe('planTiles', () => {
  it('covers a 16:9 screenshot with two squares of its height, overlapping by more than a fifth', () => {
    expect(planTiles(1456, 819)).toEqual([
      { x: 0, y: 0, w: 819, h: 819 },
      { x: 637, y: 0, w: 819, h: 819 },
    ]);
    // A Retina capture of the same view: the same tiles, twice the size (the detector sees the same).
    expect(planTiles(2912, 1638)).toEqual([
      { x: 0, y: 0, w: 1638, h: 1638 },
      { x: 1274, y: 0, w: 1638, h: 1638 },
    ]);
  });

  it('uses the whole screenshot as one tile when it is nearly square', () => {
    expect(planTiles(1000, 900)).toEqual([{ x: 0, y: 0, w: 1000, h: 900 }]);
    expect(planTiles(640, 640)).toEqual([{ x: 0, y: 0, w: 640, h: 640 }]);
  });

  it('adds tiles for wider screenshots and stacks them for tall ones, always inside the image', () => {
    for (const [w, h] of [
      [2560, 1080],
      [3440, 1440],
      [1920, 1200],
      [819, 1456],
      [1300, 1000],
    ]) {
      const tiles = planTiles(w, h);
      const short = Math.min(w, h);
      const along = (t: { x: number; y: number }) => (w >= h ? t.x : t.y);
      expect(along(tiles[0])).toBe(0);
      expect(along(tiles.at(-1)!) + short).toBe(Math.max(w, h));
      for (const t of tiles) {
        expect([t.w, t.h]).toEqual([short, short]);
        expect(t.x >= 0 && t.y >= 0 && t.x + t.w <= w && t.y + t.h <= h).toBe(true);
      }
      for (let i = 1; i < tiles.length; i++) expect(along(tiles[i - 1]) + short - along(tiles[i])).toBeGreaterThanOrEqual(CARD_SEARCH.minOverlap * short);
    }
    expect(planTiles(2560, 1080)).toHaveLength(3);
    expect(planTiles(819, 1456).map((t) => t.y)).toEqual([0, 637]);
  });
});

describe('fromTile', () => {
  const W = 1456;
  const H = 819;
  const right = { x: 637, y: 0, w: 819, h: 819 };

  it("moves a tile's boxes into screenshot pixels", () => {
    const [b] = fromTile([box(100, 200, 60, 88, 0.9, 0.1)], right, W, H);
    expect([b.cx, b.cy, b.w, b.h, b.angle, b.confidence]).toEqual([737, 200, 60, 88, 0.1, 0.9]);
    const want = boxCorners(737, 200, 60, 88, 0.1);
    b.corners.forEach((p, i) => {
      expect(p.x).toBeCloseTo(want[i].x, 9);
      expect(p.y).toBeCloseTo(want[i].y, 9);
    });
    expect(b.cut).toBe(false);
  });

  it('turns a landscape box portrait (w ≤ h, a quarter turn more), keeping its outline', () => {
    const [b] = fromTile([box(100, 200, 88, 60, 0.9, 0.1)], right, W, H);
    expect([b.cx, b.cy, b.w, b.h]).toEqual([737, 200, 60, 88]);
    expect(b.angle).toBeCloseTo(0.1 + Math.PI / 2, 9);
    const key = (p: { x: number; y: number }) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    expect(b.corners.map(key).sort()).toEqual(boxCorners(737, 200, 88, 60, 0.1).map(key).sort());
  });

  it('flags a box an edge shared with another tile cuts, but not one at the screenshot’s own edge', () => {
    // The right tile's left edge (x 637) is shared with the left tile; its right edge is the screenshot's.
    const [atShared, atOwn, inside] = fromTile([box(20, 300, 40, 88), box(800, 300, 40, 88), box(400, 300, 60, 88)], right, W, H);
    expect(atShared.cut).toBe(true);
    expect(atOwn.cut).toBe(false);
    expect(inside.cut).toBe(false);
    // The top and bottom edges are the screenshot's.
    expect(fromTile([box(400, 30, 60, 88)], right, W, H)[0].cut).toBe(false);
  });
});

describe('mergeCards', () => {
  it("drops detections below the full-screen threshold and answers in the message's format, best first", () => {
    expect(CARD_SEARCH.minConfidence).toBe(0.7);
    const cards = mergeCards([found(box(100, 100, 60, 88, 0.72)), found(box(300, 100, 60, 88, 0.69)), found(box(500, 100, 60, 88, 0.9123, Math.PI / 2))]);
    expect(cards.map((c) => c.conf)).toEqual([0.912, 0.72]);
    const [c] = cards;
    expect([c.cx, c.cy, c.w, c.h, c.angle]).toEqual([500, 100, 60, 88, 1.5708]);
    expect(c.pts).toHaveLength(4);
    expect(c.pts[0]).toEqual([544, 70]); // the box's own top-left corner, turned a quarter
  });

  it('keeps one outline for a card found whole in two overlapping tiles', () => {
    const cards = mergeCards([found(box(700, 300, 60, 88, 0.93)), found(box(701, 301, 59, 87, 0.95))]);
    expect(cards).toHaveLength(1);
    expect(cards[0].conf).toBe(0.95);
  });

  it('prefers the whole card to the part of it that a tile edge cuts, however confident', () => {
    const whole = found(box(640, 300, 60, 88, 0.9));
    const half = found(box(625, 300, 30, 88, 0.97), true);
    expect(mergeCards([half, whole]).map((c) => [c.cx, c.w])).toEqual([[640, 60]]);
    // With no whole version (a card larger than the overlap), the cut box is still an outline.
    expect(mergeCards([half])).toHaveLength(1);
  });

  it('drops a detection inside a larger one: part of a card (a featured panel’s art box), not a card', () => {
    const panel = found(box(1325, 650, 195, 285, 0.93));
    const art = found(box(1325, 610, 160, 120, 0.96));
    expect(mergeCards([art, panel]).map((c) => c.w)).toEqual([195]);
  });

  it('keeps cards that overlap without one holding the other (an XYZ on its material, a fanned pair)', () => {
    const xyz = found(box(700, 245, 72, 101, 0.94));
    const material = found(box(735, 245, 72, 101, 0.91));
    expect(mergeCards([xyz, material])).toHaveLength(2);
  });
});

describe('tiledCardDetector', () => {
  /** A tile model that answers each tile with the boxes `answer` gives, and records the tiles. */
  const model = (answer: (tile: RGBAImage, i: number) => Promise<OrientedBox[]>) => {
    const tiles: RGBAImage[] = [];
    const m: TileModel = { detectTile: (tile) => answer(tile, tiles.push(tile) - 1) };
    return { m, tiles };
  };

  it("runs the model on every tile, each run through the caller's schedule, and merges them into screenshot pixels", async () => {
    const img = image(1456, 819);
    const answers: ((boxes: OrientedBox[]) => void)[] = [];
    const { m, tiles } = model(() => new Promise((resolve) => answers.push(resolve)));
    const scheduled: number[] = [];
    const schedule: Schedule = (run) => (scheduled.push(scheduled.length), run());
    const search = tiledCardDetector(m).detect(img, schedule);
    // Both tiles were scheduled before either answered: their runs queue together.
    await Promise.resolve();
    expect(scheduled).toEqual([0, 1]);
    expect(tiles.map((t) => [t.width, t.height])).toEqual([
      [819, 819],
      [819, 819],
    ]);
    // A card in the overlap (screenshot x 700), seen by both tiles; one more in each.
    answers[0]([box(100, 400, 60, 88, 0.95), box(700, 300, 60, 88, 0.94)]);
    answers[1]([box(63, 300, 60, 88, 0.96), box(700, 400, 60, 88, 0.9)]);
    const cards = await search;
    expect(cards.map((c) => [c.cx, c.cy]).sort((a, b) => a[0] - b[0])).toEqual([
      [100, 400],
      [700, 300],
      [1337, 400],
    ]);
    expect(cards.find((c) => c.cx === 700)!.conf).toBe(0.96);
    expect(cards[0].pts).toHaveLength(4);
  });

  it('runs the tiles one after another without a schedule (Node tools)', async () => {
    let running = 0;
    let overlapped = false;
    const { m, tiles } = model(async () => {
      overlapped ||= running > 0;
      running++;
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return [];
    });
    await tiledCardDetector(m).detect(image(1456, 819));
    expect(tiles).toHaveLength(2);
    expect(overlapped).toBe(false);
  });

  it('crops each tile from the screenshot', async () => {
    const img = image(1456, 819);
    for (let y = 0; y < 819; y++) img.data.set([200, 10, 10, 255], (y * 1456 + 1000) * 4); // a red column at x 1000
    const red: number[] = [];
    const { m } = model(async (tile) => {
      for (let x = 0; x < tile.width; x++) if (tile.data[x * 4] === 200) red.push(x);
      return [];
    });
    await tiledCardDetector(m).detect(img);
    expect(red).toEqual([1000 - 637]); // only in the right tile, at its own x
  });

  it("takes the model's own threshold and tiling, since they depend on the model", async () => {
    // One card at tile x 100 in each tile: screenshot x 100 and 737.
    const { m, tiles } = model(async () => [box(100, 400, 60, 88, 0.55)]);
    expect(await tiledCardDetector(m).detect(image(1456, 819))).toHaveLength(0);
    expect((await tiledCardDetector(m, { minConfidence: 0.5 }).detect(image(1456, 819))).map((c) => c.cx)).toEqual([100, 737]);
    tiles.length = 0;
    await tiledCardDetector(m, { singleTileAspect: 2 }).detect(image(1456, 819));
    expect(tiles).toHaveLength(1);
  });

  it("sees a drag's crop whole: one run on the crop, however tall, merged in the crop's pixels", async () => {
    // A portrait crop around one card (plus a margin): detect() would cut it into two square tiles.
    const crop = image(300, 440);
    const { m, tiles } = model(async () => [
      box(150, 220, 250, 370, 0.93), // the card, a little tilted below
      box(150, 150, 200, 150, 0.95), // its art box: part of the card, not a card
      box(20, 20, 30, 44, 0.4), // a sliver of a neighbour, below the threshold
    ]);
    const cards = await tiledCardDetector(m).detectInCrop!(crop);
    expect(tiles.map((t) => [t.width, t.height])).toEqual([[300, 440]]);
    expect(tiles[0]).toBe(crop);
    expect(cards.map((c) => [c.cx, c.cy, c.w, c.h, c.conf])).toEqual([[150, 220, 250, 370, 0.93]]);
    expect(cards[0].pts).toEqual([
      [25, 35],
      [275, 35],
      [275, 405],
      [25, 405],
    ]);
    // The model's own threshold applies here too.
    expect(await tiledCardDetector(m, { minConfidence: 0.96 }).detectInCrop!(crop)).toEqual([]);
  });

  it('passes on a failed run, and frees the model on release', async () => {
    let released = 0;
    const failing: TileModel = { detectTile: async () => Promise.reject(new Error('ORT run failed')), release: async () => void released++ };
    const detector = tiledCardDetector(failing);
    await expect(detector.detect(image(1456, 819))).rejects.toThrow('ORT run failed');
    await detector.release?.();
    expect(released).toBe(1);
  });
});

describe('tileModelOf (our detector through the tiles, for tools/train-detector/evaluate.ts --path tiles)', () => {
  it('shrinks each tile like a whole 16:9 screenshot and keeps face-up cards only', async () => {
    const seen: RGBAImage[] = [];
    const card = { cx: 50, cy: 60, w: 40, h: 58, angle: 0, conf: 0.9, pts: [], scores: { 'face-up': 0.9, 'face-down': 0 } };
    const findCards = async (img: RGBAImage, opts?: { longSide?: number }) => {
      seen.push(img);
      expect(opts?.longSide).toBe(720); // the 819 px tile of a 1456x819 screenshot, as the screenshot would shrink to 1280
      return [
        { ...card, kind: 'face-up' as const },
        { ...card, cx: 150, kind: 'face-down' as const },
      ];
    };
    const det = { findCards, release: async () => {} } as unknown as OwnCardDetector;
    const cards = await tiledCardDetector(tileModelOf(det), { minConfidence: 0.5 }).detect(image(1456, 819));
    expect(seen.map((t) => [t.width, t.height])).toEqual([
      [819, 819],
      [819, 819],
    ]);
    expect(cards.map((c) => c.cx)).toEqual([50, 687]);
  });
});
