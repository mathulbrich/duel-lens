import { describe, expect, it } from 'vitest';
import type { CardDetection, DetectedCardBox } from '../shared/messages';
import { FRAME_MAX_DATA_URL, FRAME_MAX_SIDE, frameBoxToShot, frameOf, mergeFrameDetection, sameCard, type DetectFrame } from './frame-detect';

type Pt = [number, number];

/** An upright card box from its top-left corner and size. */
function card(x: number, y: number, w: number, h: number, conf: number): DetectedCardBox {
  return {
    cx: x + w / 2,
    cy: y + h / 2,
    w,
    h,
    angle: 0,
    conf,
    kind: 'face-up',
    pts: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  };
}

// The user's page (overnight-p6-T3.md): a 1728x1000 CSS px viewport at devicePixelRatio 2 (a 3456x2000
// screenshot), a 1080p video whose picture is at (16, 68), 1205x678 CSS px.
const FRAME: DetectFrame = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1920, height: 1080, box: { x: 16, y: 68, w: 1205, h: 678 }, viewportWidth: 1728 };
const K = (1205 / 1920) * 2; // screenshot px per frame px, across
const KY = (678 / 1080) * 2; // and down (the player rounds the picture to whole CSS px)

const shotDetection = (boxes: DetectedCardBox[]): CardDetection => ({ boxes, width: 3456, height: 2000, ms: 160 });
const frameDetection = (boxes: DetectedCardBox[]): CardDetection => ({ boxes, width: 1920, height: 1080, ms: 90 });

describe('frameBoxToShot', () => {
  it("maps a frame box through the picture's place on the page into screenshot pixels", () => {
    const b = frameBoxToShot(card(960, 540, 40, 56, 0.6), FRAME, 3456);
    const x = (v: number) => 32 + v * K;
    const y = (v: number) => 136 + v * KY;
    expect(b.cx).toBeCloseTo(x(980), 9);
    expect(b.cy).toBeCloseTo(y(568), 9);
    expect(b.w).toBeCloseTo(40 * Math.sqrt(K * KY), 9);
    expect(b.h).toBeCloseTo(56 * Math.sqrt(K * KY), 9);
    expect(b.angle).toBe(0);
    expect(b.conf).toBe(0.6);
    expect(b.kind).toBe('face-up');
    b.pts.forEach(([px, py], i) => {
      const [fx, fy] = card(960, 540, 40, 56, 0.6).pts[i];
      expect(px).toBeCloseTo(x(fx), 9);
      expect(py).toBeCloseTo(y(fy), 9);
    });
  });

  it('follows the screenshot scale (a page zoomed or at devicePixelRatio 1)', () => {
    const at1 = frameBoxToShot(card(0, 0, 1920, 1080, 0.5), FRAME, 1728);
    expect(at1.pts[0]).toEqual([16, 68]);
    expect(at1.pts[2][0]).toBeCloseTo(16 + 1205, 9);
    expect(at1.pts[2][1]).toBeCloseTo(68 + 678, 9);
  });
});

describe('sameCard', () => {
  const a: Pt[] = card(100, 100, 60, 88, 1).pts;
  it('is true for two outlines of one card, also when one is a little off or bigger', () => {
    expect(sameCard(a, card(104, 97, 58, 90, 1).pts)).toBe(true);
    expect(sameCard(a, card(80, 70, 100, 150, 1).pts)).toBe(true);
  });
  it('is false for neighbouring cards', () => {
    expect(sameCard(a, card(170, 100, 60, 88, 1).pts)).toBe(false);
    expect(sameCard(a, card(100, 200, 60, 88, 1).pts)).toBe(false);
  });
});

describe('mergeFrameDetection', () => {
  const big = card(1000, 600, 150, 220, 0.9); // a card the screenshot found (screenshot px)
  const shot = shotDetection([big]);

  it("adds the cards only the frame found, mapped into screenshot pixels, and keeps the screenshot's boxes exactly", () => {
    const small = card(200, 100, 40, 56, 0.55); // frame px: nowhere near `big`
    const merged = mergeFrameDetection(shot, frameDetection([small]), FRAME);
    expect(merged.width).toBe(3456);
    expect(merged.height).toBe(2000);
    expect(merged.boxes).toHaveLength(2);
    expect(merged.boxes[0]).toBe(big); // the same object, untouched, and first (stronger)
    expect(merged.boxes[1]).toEqual(frameBoxToShot(small, FRAME, 3456));
    expect(merged.error).toBeUndefined();
  });

  it("leaves out the frame's outline of a card the screenshot already outlined", () => {
    // `big` in frame px: (1000-32)/K .. ; a frame box around the same place
    const fx = (1000 + 75 - 32) / K;
    const fy = (600 + 110 - 136) / KY;
    const same = card(fx - 45, fy - 66, 90, 132, 0.95);
    const merged = mergeFrameDetection(shot, frameDetection([same]), FRAME);
    expect(merged.boxes).toEqual([big]);
  });

  it('puts the cards best first; the screenshot keeps its own order among its boxes', () => {
    const a = card(100, 1500, 150, 220, 0.8);
    const b = card(400, 1500, 150, 220, 0.5);
    const strong = card(200, 100, 40, 56, 0.7);
    const merged = mergeFrameDetection(shotDetection([a, b]), frameDetection([strong]), FRAME);
    expect(merged.boxes.map((x) => x.conf)).toEqual([0.8, 0.7, 0.5]);
    expect(merged.boxes[0]).toBe(a);
    expect(merged.boxes[2]).toBe(b);
  });

  it("takes nothing from a frame whose picture box doesn't lie on the screenshot (the page sends only the visible part)", () => {
    const below = { ...FRAME, box: { x: 16, y: 800, w: 1205, h: 678 } }; // its lower part would be under the viewport
    expect(mergeFrameDetection(shot, frameDetection([card(900, 100, 40, 56, 0.6)]), below)).toBe(shot);
    const above = { ...FRAME, box: { x: 16, y: -20, w: 1205, h: 678 } };
    expect(mergeFrameDetection(shot, frameDetection([card(900, 100, 40, 56, 0.6)]), above)).toBe(shot);
  });

  it('takes nothing when the offscreen document decoded the frame at another size than the tab claimed', () => {
    const small = card(200, 100, 40, 56, 0.55);
    expect(mergeFrameDetection(shot, { ...frameDetection([small]), width: 1280, height: 720 }, FRAME)).toBe(shot);
  });

  it("gives the screenshot's detection unchanged without a frame, or with a failed, empty or unusable frame run", () => {
    const small = card(200, 100, 40, 56, 0.55);
    expect(mergeFrameDetection(shot, undefined, undefined)).toBe(shot);
    expect(mergeFrameDetection(shot, frameDetection([small]), undefined)).toBe(shot);
    expect(mergeFrameDetection(shot, { ...frameDetection([]), error: 'the model failed' }, FRAME)).toBe(shot);
    expect(mergeFrameDetection(shot, frameDetection([]), FRAME)).toBe(shot);
    expect(mergeFrameDetection(shot, frameDetection([{ ...small, pts: [] as unknown as Pt[] }]), FRAME).boxes).toEqual([big]);
  });

  it('never adds to a failed screenshot detection, or one of unknown size (nothing to map into)', () => {
    const small = card(200, 100, 40, 56, 0.55);
    const failed: CardDetection = { boxes: [], width: 0, height: 0, ms: 0, error: 'no answer' };
    expect(mergeFrameDetection(failed, frameDetection([small]), FRAME)).toBe(failed);
    const unsized: CardDetection = { boxes: [], width: 0, height: 0, ms: 5 };
    expect(mergeFrameDetection(unsized, frameDetection([small]), FRAME)).toBe(unsized);
  });

  it('times the merged detection by the longer run', () => {
    const merged = mergeFrameDetection(shot, { ...frameDetection([card(200, 100, 40, 56, 0.55)]), ms: 400 }, FRAME);
    expect(merged.ms).toBe(400);
  });
});

describe('frameOf', () => {
  it("takes a well-formed frame from the tab's answer", () => {
    expect(frameOf({ ok: true, frame: FRAME })).toEqual(FRAME);
  });
  it('takes none from an answer without one, an error, or a malformed one', () => {
    expect(frameOf({ ok: true })).toBeUndefined();
    expect(frameOf(undefined)).toBeUndefined();
    expect(frameOf({ ok: false, error: 'x' })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, dataUrl: 'https://example.com/x.jpg' } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, width: 0 } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, viewportWidth: Number.NaN } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, box: { x: 0, y: 0, w: 0, h: 10 } } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, box: undefined } })).toBeUndefined();
  });
  it('takes only a base64 JPEG data URL under the length cap', () => {
    expect(frameOf({ ok: true, frame: { ...FRAME, dataUrl: 'data:image/png;base64,AAAA' } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, dataUrl: 'data:image/jpeg;base64,' } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(FRAME_MAX_DATA_URL) } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, dataUrl: 12 } })).toBeUndefined();
  });
  it('takes only whole-pixel sides up to FRAME_MAX_SIDE and a bounded viewport', () => {
    expect(frameOf({ ok: true, frame: { ...FRAME, width: FRAME_MAX_SIDE + 1 } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, height: 1080.5 } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, width: Number.POSITIVE_INFINITY } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, viewportWidth: 1e9 } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, width: 1080, height: 1920 } })).toBeDefined(); // a portrait video
  });
  it('takes only a picture box across the viewport\'s width, and copies just the contract\'s fields', () => {
    expect(frameOf({ ok: true, frame: { ...FRAME, box: { x: -10, y: 68, w: 1205, h: 678 } } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, box: { x: 600, y: 68, w: 1205, h: 678 } } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, box: { x: 16, y: -5, w: 1205, h: 678 } } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, box: { x: 16, y: 68, w: Number.NaN, h: 678 } } })).toBeUndefined();
    expect(frameOf({ ok: true, frame: { ...FRAME, extra: 'x', box: { ...FRAME.box, more: 1 } } })).toEqual(FRAME);
  });
});
