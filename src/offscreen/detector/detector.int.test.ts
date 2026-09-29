// Integration: the real card detector (extension/models/detector/card-detector.onnx) on real duel
// footage, through the same TypeScript module the offscreen page runs, on onnxruntime-node. Skips when
// the model (tools/train-detector/README.md rebuilds it) or the labelled frames
// (data/debug/fullview, data/train-detector/eval/fullview-quads*.json, data/realset; gitignored) are missing.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRGBA } from '../../../tools/lib/image';
import { buildCrop } from '../../../tools/realset/lib/crop';
import type { RealsetEntry } from '../../../tools/realset/lib/types';
import type { RGBAImage } from '../../shared/preprocess';
import { refined, type DetectedCard, type OwnCardDetector } from './detector';
import { insideShare, polygonIoU, type Pt } from './geometry';
import { createNodeCardDetector, haveCardDetector } from './node';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const FULLVIEW = path.join(ROOT, 'data/debug/fullview');
const QUADS = path.join(ROOT, 'data/train-detector/eval/fullview-quads.json');
const QUADS_NEW = path.join(ROOT, 'data/train-detector/eval/fullview-quads-new.json');
const SET = path.join(ROOT, 'data/realset/set.json');
const ready = haveCardDetector() && existsSync(QUADS) && existsSync(SET) && existsSync(FULLVIEW);

interface Label {
  cls: 'face-up' | 'face-down' | 'ignore';
  pts: Pt[];
}

const labels = (): Record<string, Label[]> => {
  const all = { ...JSON.parse(readFileSync(QUADS, 'utf8')), ...(existsSync(QUADS_NEW) ? JSON.parse(readFileSync(QUADS_NEW, 'utf8')) : {}) } as Record<string, Label[]>;
  delete (all as Record<string, unknown>)._format;
  return all;
};

/** Mean corner distance over the best cyclic order. */
const cornerError = (a: Pt[], b: Pt[]) => {
  let best = Infinity;
  for (let s = 0; s < 4; s++) {
    let e = 0;
    for (let k = 0; k < 4; k++) e += Math.hypot(a[(k + s) % 4][0] - b[k][0], a[(k + s) % 4][1] - b[k][1]);
    best = Math.min(best, e / 4);
  }
  return best;
};

describe.skipIf(!ready)('card detector on real frames (data-gated)', () => {
  let det: OwnCardDetector;
  const frames = new Map<string, { img: RGBAImage; cards: DetectedCard[] }>();
  beforeAll(async () => {
    det = await createNodeCardDetector();
    for (const name of Object.keys(labels())) {
      const img = await loadRGBA(path.join(FULLVIEW, name));
      frames.set(name, { img, cards: (await det.findCards(img)).filter((c) => c.conf >= 0.4) });
    }
  }, 120_000);
  afterAll(async () => {
    await det?.release();
  });

  it('outlines the face-up cards of the labelled full-view frames at IoU >= 0.5, with few false outlines', () => {
    let found = 0;
    let total = 0;
    let falseOutlines = 0;
    for (const [name, rows] of Object.entries(labels())) {
      const { cards } = frames.get(name)!;
      const up = rows.filter((r) => r.cls === 'face-up');
      total += up.length;
      found += up.filter((r) => cards.some((c) => polygonIoU(c.pts as Pt[], r.pts) >= 0.5)).length;
      // a detection on no label, and not inside a region labelled ignore (hands of cards, cut piles...)
      falseOutlines += cards.filter(
        (c) => !rows.some((r) => (r.cls === 'ignore' ? insideShare(c.pts as Pt[], r.pts) >= 0.5 : false) || polygonIoU(c.pts as Pt[], r.pts) >= 0.3),
      ).length;
    }
    expect(total).toBeGreaterThan(100);
    expect(found / total).toBeGreaterThanOrEqual(0.9);
    expect(falseOutlines).toBeLessThanOrEqual(5);
  });

  it('fitting the outline to the image (refined) keeps overhead cards close and improves the perspective close-ups', () => {
    const before: number[] = [];
    const after: number[] = [];
    const dpBefore: number[] = [];
    const dpAfter: number[] = [];
    for (const [name, rows] of Object.entries(labels())) {
      const { img, cards } = frames.get(name)!;
      for (const r of rows.filter((x) => x.cls === 'face-up')) {
        const c = cards.find((x) => polygonIoU(x.pts as Pt[], r.pts) >= 0.5);
        if (!c) continue;
        const [b, a] = [cornerError(c.pts as Pt[], r.pts), cornerError(refined(img, c).pts as Pt[], r.pts)];
        (name.startsWith('fv-dp-') ? dpBefore : before).push(b);
        (name.startsWith('fv-dp-') ? dpAfter : after).push(a);
      }
    }
    const mean = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length;
    expect(before.length).toBeGreaterThan(90);
    // against labels drawn mostly from an earlier detector's (sleeve-edge) proposals (tools/train-detector/label_fullview.py) the fit is about neutral overhead...
    expect(mean(after)).toBeLessThan(1.2 * mean(before));
    // ...and pulls keystoned cards toward their true corners
    expect(dpBefore.length).toBeGreaterThan(0);
    expect(mean(dpAfter)).toBeLessThan(mean(dpBefore));
  });

  it("finds the card in the content script's crop of a user's box (the drag case)", async () => {
    // The human-verified rows with a labelled box (capture-C's rows, merged later, have none).
    const set = (JSON.parse(readFileSync(SET, 'utf8')) as RealsetEntry[]).filter((e) => e.source === 'human' && e.rotatedBox);
    let good = 0;
    for (const e of set) {
      const img = await loadRGBA(path.join(ROOT, 'data/debug/frames', `${e.frame}.png`));
      const crop = buildCrop(img, e.userBox);
      const s = crop.outW / crop.px.w;
      const truth = e.rotatedBox!.pts.map(([x, y]) => [(x - crop.px.x) * s, (y - crop.px.y) * s] as Pt);
      const [pick] = await det.findInCrop(crop.cropImg);
      if (pick && pick.kind === 'face-up' && polygonIoU(pick.pts as Pt[], truth) >= 0.5) good++;
    }
    expect(set.length).toBeGreaterThan(10);
    expect(good / set.length).toBeGreaterThanOrEqual(0.9);
  }, 60_000);
});
