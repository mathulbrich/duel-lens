import { describe, expect, it, vi } from 'vitest';
import type { SessionLike, TensorCtor } from '../../shared/embed-core';
import type { RGBAImage } from '../../shared/preprocess';
import type { Schedule } from '../detect-cards';
import { createCardDetector } from './detector';

class FakeTensor {
  constructor(
    public type: string,
    public data: Float32Array,
    public dims: number[],
  ) {}
}

/**
 * A fake model: for an input [1,3,H,W] it answers maps of H/4 x W/4 with one face-up card at `up`
 * and one face-down card at `down` (input pixels), 60x88 px, upright.
 */
function fakeSession(up: [number, number], down: [number, number], seen: number[][] = []): SessionLike {
  return {
    async run(feeds) {
      const t = feeds.image as FakeTensor;
      seen.push(t.dims);
      const [, , H, W] = t.dims;
      const gh = H / 4;
      const gw = W / 4;
      const plane = gh * gw;
      const heat = new Float32Array(2 * plane);
      const box = new Float32Array(6 * plane);
      const put = (k: number, [x, y]: [number, number], score: number) => {
        const j = Math.floor(x / 4);
        const i = Math.floor(y / 4);
        if (i < 0 || j < 0 || i >= gh || j >= gw) return;
        heat[k * plane + i * gw + j] = score;
        box[0 * plane + i * gw + j] = x / 4 - (j + 0.5);
        box[1 * plane + i * gw + j] = y / 4 - (i + 0.5);
        box[2 * plane + i * gw + j] = Math.log(60 / 4);
        box[3 * plane + i * gw + j] = Math.log(88 / 4);
        box[5 * plane + i * gw + j] = 1;
      };
      put(0, up, 0.9);
      put(1, down, 0.8);
      const dims = [1, 2, gh, gw];
      return { heat: { data: heat, dims }, box: { data: box, dims: [1, 6, gh, gw] }, peak: { data: heat, dims } };
    },
  };
}

const blank = (w: number, h: number): RGBAImage => ({ data: new Uint8ClampedArray(w * h * 4).fill(40), width: w, height: h });
const deps = (session: SessionLike) => ({ session, Tensor: FakeTensor as unknown as TensorCtor });

describe('createCardDetector', () => {
  it('runs once on the whole screenshot and maps boxes back to screenshot pixels', async () => {
    const seen: number[][] = [];
    const det = createCardDetector(deps(fakeSession([320, 200], [900, 500], seen)));
    const cards = await det.findCards(blank(1456, 819));
    expect(seen).toEqual([[1, 3, 736, 1280]]);
    expect(cards.map((c) => c.kind)).toEqual(['face-up', 'face-down']);
    const [up] = cards;
    expect(up.cx).toBeCloseTo(320 / (1280 / 1456), 0);
    expect(up.cy).toBeCloseTo(200 / (720 / 819), 0);
    expect(up.w).toBeCloseTo(60 / (1280 / 1456), 0);
    expect(up.h).toBeCloseTo(88 / (1280 / 1456), 0);
    expect(up.conf).toBe(0.9);
    expect(up.pts).toHaveLength(4);
    expect(up.scores).toEqual({ 'face-up': 0.9, 'face-down': 0 });
    expect(det.last?.runMs).toBeGreaterThanOrEqual(0);
  });

  it('as a CardDetector: one run through the schedule, face-up cards only by default', async () => {
    const det = createCardDetector(deps(fakeSession([320, 200], [900, 500])));
    const calls = vi.fn();
    const schedule: Schedule = <T>(run: () => Promise<T>) => {
      calls();
      return run();
    };
    const boxes = await det.asCardDetector().detect(blank(1456, 819), schedule);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ kind: 'face-up', conf: 0.9 });
    const both = await det.asCardDetector({ kinds: ['face-up', 'face-down'] }).detect(blank(1456, 819));
    expect(both).toHaveLength(2);
  });

  it('as a CardDetector: sends the message contract alone (its kind, no class scores), at its confidence or above', async () => {
    const det = createCardDetector(deps(fakeSession([320, 200], [900, 500])));
    const [up] = await det.asCardDetector().detect(blank(1456, 819));
    expect(Object.keys(up).sort()).toEqual(['angle', 'conf', 'cx', 'cy', 'h', 'kind', 'pts', 'w']);
    expect(await det.asCardDetector({ minConfidence: 0.95 }).detect(blank(1456, 819))).toEqual([]);
  });

  it("as a CardDetector for a scan's crop (detectInCrop): findInCrop's cards of both kinds, outlines fitted, at its confidence or above", async () => {
    const seen: number[][] = [];
    const det = createCardDetector(deps(fakeSession([30, 30], [224, 150], seen)));
    const cards = await det.asCardDetector({ minConfidence: 0.4 }).detectInCrop!(blank(200, 134));
    // One run on the crop, enlarged to cropLongSide like findInCrop; no schedule (the scan holds the queue).
    expect(seen).toEqual([[1, 3, 320, 448]]);
    expect(cards.map((c) => c.kind)).toEqual(['face-down', 'face-up']);
    expect(cards.every((c) => Object.keys(c).sort().join() === 'angle,conf,cx,cy,h,kind,pts,w')).toBe(true);
    expect((await det.asCardDetector({ minConfidence: 0.85 }).detectInCrop!(blank(200, 134))).map((c) => c.kind)).toEqual(['face-up']);
  });

  it("as a CardDetector for a dragged box (detectInCropWithWeak): detectInCrop's cards, and from the same run those under its confidence", async () => {
    const seen: number[][] = [];
    const det = createCardDetector(deps(fakeSession([30, 30], [224, 150], seen)));
    const { cards, weak } = await det.asCardDetector({ minConfidence: 0.85 }).detectInCropWithWeak!(blank(200, 134));
    // One run on the crop, as detectInCrop's.
    expect(seen).toEqual([[1, 3, 320, 448]]);
    expect(cards.map((c) => [c.kind, c.conf])).toEqual([['face-up', 0.9]]);
    expect(weak.map((c) => [c.kind, c.conf])).toEqual([['face-down', 0.8]]);
    expect([...cards, ...weak].every((c) => Object.keys(c).sort().join() === 'angle,conf,cx,cy,h,kind,pts,w')).toBe(true);
    // The cards are detectInCrop's own.
    expect(cards).toEqual(await det.asCardDetector({ minConfidence: 0.85 }).detectInCrop!(blank(200, 134)));
  });

  it('drops a card centred in the padding', async () => {
    const det = createCardDetector(deps(fakeSession([100, 728], [600, 20])));
    // 1456x819 -> 1280x720 content inside 1280x736: y = 728 is padding
    const cards = await det.findCards(blank(1456, 819));
    expect(cards.map((c) => c.kind)).toEqual(['face-down']);
  });

  it('finds the card in a crop (the drag case): enlarged to cropLongSide, the central one first', async () => {
    const seen: number[][] = [];
    const det = createCardDetector(deps(fakeSession([30, 30], [224, 150], seen)));
    const cards = await det.findInCrop(blank(200, 134));
    expect(seen).toEqual([[1, 3, 320, 448]]);
    expect(cards[0].kind).toBe('face-down'); // central beats a corner card of higher score
  });

  it('rejects outputs that do not match the spec', async () => {
    const bad: SessionLike = { run: async () => ({ heat: { data: new Float32Array(4), dims: [1, 3, 1, 1] }, box: { data: new Float32Array(6), dims: [1, 6, 1, 1] } }) };
    await expect(createCardDetector(deps(bad)).findCards(blank(64, 64))).rejects.toThrow(/don't match/);
  });
});
