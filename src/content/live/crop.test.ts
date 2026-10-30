// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { DetectedCardBox } from '../../shared/messages';
import { CROP_MARGIN, type CanvasLike, type VideoFrameGrab } from '../capture';
import { liveCrop, toNativeBoxes } from './crop';

function fakeCanvas(w: number, h: number) {
  const draws: unknown[][] = [];
  const canvas = {
    width: w,
    height: h,
    draws,
    getContext: () => ({ drawImage: (...a: unknown[]) => void draws.push(a), getImageData: () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }) }),
    toDataURL: vi.fn((type = 'image/png') => `data:${type};base64,FAKE-${canvas.width}x${canvas.height}`),
  };
  return canvas as typeof canvas & CanvasLike;
}

/** 1920x1080 video shown whole at 960x540 CSS px, top left at (100, 50). */
const grab: VideoFrameGrab = {
  canvas: fakeCanvas(1920, 1080),
  currentTime: 4,
  videoWidth: 1920,
  videoHeight: 1080,
  contentBox: { x: 100, y: 50, w: 960, h: 540 },
  readable: true,
};

/** A card centred on (cx, cy), w x h, upright. */
const card = (cx: number, cy: number, w: number, h: number): DetectedCardBox => ({
  cx,
  cy,
  w,
  h,
  angle: 0,
  conf: 0.9,
  kind: 'face-up',
  pts: [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ],
});

describe('toNativeBoxes', () => {
  it('maps frame px to native px', () => {
    // A 1280x720 frame of the whole picture: 1.5 native px per frame px.
    const frame = { dataUrl: '', width: 1280, height: 720, box: { x: 100, y: 50, w: 960, h: 540 }, viewportWidth: 1200 };
    const [n] = toNativeBoxes(grab, frame, [card(400, 300, 100, 140)]);
    expect(n.cx).toBeCloseTo(600);
    expect(n.cy).toBeCloseTo(450);
    expect(n.w).toBeCloseTo(150);
    expect(n.h).toBeCloseTo(210);
    expect(n.pts[0][0]).toBeCloseTo(525);
    expect(n.pts[0][1]).toBeCloseTo(345);
    expect(n.pts[2][0]).toBeCloseTo(675);
    expect(n.pts[2][1]).toBeCloseTo(555);
    expect([n.angle, n.conf, n.kind]).toEqual([0, 0.9, 'face-up']);
  });

  it('accounts for a video partly scrolled out of view', () => {
    // Only the lower half of the picture is in view: the frame starts 540 native px (270 CSS px) down.
    const frame = { dataUrl: '', width: 1280, height: 360, box: { x: 100, y: 320, w: 960, h: 270 }, viewportWidth: 1200 };
    const [n] = toNativeBoxes(grab, frame, [card(400, 100, 100, 140)]);
    expect(n.cx).toBeCloseTo(600);
    expect(n.cy).toBeCloseTo(540 + 150);
    expect(n.pts[0][1]).toBeCloseTo(540 + 150 - 105);
  });

  it('leaves the input boxes alone', () => {
    const input = card(400, 300, 100, 140);
    const frame = { dataUrl: '', width: 1280, height: 720, box: { x: 100, y: 50, w: 960, h: 540 }, viewportWidth: 1200 };
    toNativeBoxes(grab, frame, [input]);
    expect(input.cx).toBe(400);
  });
});

describe('liveCrop', () => {
  it('crops native px with CROP_MARGIN and puts the outline in crop px', () => {
    const made: ReturnType<typeof fakeCanvas>[] = [];
    const createCanvas = (w: number, h: number) => (made[made.push(fakeCanvas(w, h)) - 1]);
    const crop = liveCrop(grab, card(600, 450, 150, 210), createCanvas);
    const mx = 150 * CROP_MARGIN;
    const my = 210 * CROP_MARGIN;
    expect(made[0].draws[0].slice(1, 5)).toEqual([Math.floor(525 - mx), Math.floor(345 - my), Math.ceil(675 + mx) - Math.floor(525 - mx), Math.ceil(555 + my) - Math.floor(345 - my)]);
    expect(crop.source).toBe('video');
    expect(crop.videoHeight).toBe(1080);
    expect(crop.dataUrl).toBe(`data:image/png;base64,FAKE-${crop.width}x${crop.height}`);
    expect(crop.outline).toHaveLength(4);
    for (const [x, y] of crop.outline!) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(crop.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(crop.height);
    }
    // The first corner (525, 345) sits at the margin from the crop's origin.
    expect(crop.outline![0][0]).toBeCloseTo(525 - Math.floor(525 - mx), 2);
    expect(crop.outline![0][1]).toBeCloseTo(345 - Math.floor(345 - my), 2);
    expect(crop.inner!.w).toBeCloseTo(150, 2);
  });

  it('clamps to the frame and shrinks a huge crop, scaling the outline with it', () => {
    const big: VideoFrameGrab = { ...grab, canvas: fakeCanvas(7680, 4320), videoWidth: 7680, videoHeight: 4320 };
    const crop = liveCrop(big, card(3840, 2160, 4000, 4300), (w, h) => fakeCanvas(w, h));
    expect(Math.max(crop.width, crop.height)).toBe(1600);
    // Bounds x 1840..5840 and y 10..4310 grow by 160 and 172, the y range clamped to 0..4320: a 4320 px square, shrunk to 1600.
    const k = 1600 / 4320;
    expect(crop.outline![0][0]).toBeCloseTo(160 * k, 1);
    expect(crop.outline![0][1]).toBeCloseTo(10 * k, 1);
  });

  it('throws when the frame was not readable', () => {
    expect(() => liveCrop({ ...grab, canvas: null }, card(10, 10, 5, 7))).toThrow();
  });
});
