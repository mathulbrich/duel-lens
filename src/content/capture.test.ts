// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cropDetectedCard,
  cropSelection,
  decodeScreenshot,
  grabVideoFrames,
  isEssentiallyBlack,
  type CanvasLike,
  type VideoFrameGrab,
} from './capture';

// ---------- fakes ----------
interface FakeCanvas extends CanvasLike {
  draws: unknown[][];
}

/** A canvas double: records drawImage calls; getImageData returns `fill` or throws when tainted. */
function fakeCanvas(w: number, h: number, opts: { tainted?: boolean; fill?: number } = {}): FakeCanvas {
  const draws: unknown[][] = [];
  const canvas: FakeCanvas = {
    width: w,
    height: h,
    draws,
    getContext: () => ({
      drawImage: (...args: unknown[]) => {
        draws.push(args);
      },
      getImageData: (_x: number, _y: number, gw: number, gh: number) => {
        if (opts.tainted) throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError');
        return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4).fill(opts.fill ?? 128) };
      },
    }),
    toDataURL: (type = 'image/png') => `data:${type};base64,FAKE-${canvas.width}x${canvas.height}`,
  };
  return canvas;
}

function cropFactory(fill = 128) {
  const made: FakeCanvas[] = [];
  const createCanvas = (w: number, h: number) => {
    const c = fakeCanvas(w, h, { fill });
    made.push(c);
    return c;
  };
  return { made, createCanvas };
}

/** 1920x1080 video letterboxed in a 1000x800 element at the viewport origin. */
function videoGrab(readable: boolean): VideoFrameGrab & { canvas: FakeCanvas } {
  return {
    canvas: fakeCanvas(1920, 1080),
    currentTime: 12.5,
    videoWidth: 1920,
    videoHeight: 1080,
    contentBox: { x: 0, y: 118.75, w: 1000, h: 562.5 },
    readable,
  };
}

// A 1000x800 CSS px viewport captured at devicePixelRatio 2.
const SHOT = { width: 2000, height: 1600 } as unknown as ImageBitmap;

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

// ---------- cropSelection ----------
describe('cropSelection', () => {
  it('crops native video pixels when the box is over a readable video', async () => {
    const grab = videoGrab(true);
    const { made, createCanvas } = cropFactory();
    // (100,218.75,50,75) -> x1.92 -> (192,192,96,144) -> +4% -> (188.16,186.24,103.68,155.52) -> whole px
    const out = await cropSelection({ x: 100, y: 218.75, w: 50, h: 75 }, SHOT, [grab], { viewportWidth: 1000, createCanvas });

    expect(made).toHaveLength(1);
    expect(made[0].draws[0]).toEqual([grab.canvas, 188, 186, 104, 156, 0, 0, 104, 156]);
    expect(out.crop).toEqual({
      dataUrl: 'data:image/png;base64,FAKE-104x156',
      width: 104,
      height: 156,
      source: 'video',
      videoHeight: 1080,
      inner: { x: 4, y: 6, w: 96, h: 144 }, // the box itself: (192,192) minus the crop origin (188,186)
    });
    expect(out.videoTime).toBe(12.5);
    expect(out.overVideo).toBe(true);
    expect(out.videoReadable).toBe(true);
  });

  it('falls back to the screenshot when the video frame is tainted', async () => {
    const grab = videoGrab(false);
    const { made, createCanvas } = cropFactory();
    // (100,218.75,50,75) -> x2 -> (200,437.5,100,150) -> +4% -> (196,431.5,108,162) -> whole px
    const out = await cropSelection({ x: 100, y: 218.75, w: 50, h: 75 }, SHOT, [grab], { viewportWidth: 1000, createCanvas });

    expect(made[0].draws[0]).toEqual([SHOT, 196, 431, 108, 163, 0, 0, 108, 163]);
    expect(out.crop.inner).toEqual({ x: 4, y: 6.5, w: 100, h: 150 }); // box (200,437.5) - origin (196,431)
    expect(out.crop.source).toBe('screenshot');
    expect(out.crop.videoHeight).toBeUndefined();
    expect([out.crop.width, out.crop.height]).toEqual([108, 163]);
    // Still over the video, so the moment in the video is kept for the history link.
    expect(out.overVideo).toBe(true);
    expect(out.videoTime).toBe(12.5);
    // The video itself could not be read (DRM/cross-origin taint): a black result here
    // is a real block, not a dark moment in playback.
    expect(out.videoReadable).toBe(false);
  });

  it('falls back to the screenshot when the box is outside the video picture (black bar)', async () => {
    const grab = videoGrab(true);
    const { made, createCanvas } = cropFactory();
    // (100,20,50,60) -> x2 -> (200,40,100,120) -> +4% -> (196,35.2,108,129.6) -> whole px
    const out = await cropSelection({ x: 100, y: 20, w: 50, h: 60 }, SHOT, [grab], { viewportWidth: 1000, createCanvas });

    expect(made[0].draws[0]).toEqual([SHOT, 196, 35, 108, 130, 0, 0, 108, 130]);
    expect(out.crop.source).toBe('screenshot');
    expect(out.overVideo).toBe(false);
    expect(out.videoTime).toBeUndefined();
  });

  it('clamps the 4% margin at the frame edge and reports where the box sits (screenshot)', async () => {
    const { made, createCanvas } = cropFactory();
    const out = await cropSelection({ x: 0, y: 0, w: 50, h: 50 }, SHOT, [], { viewportWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([SHOT, 0, 0, 104, 104, 0, 0, 104, 104]);
    // No margin above or left of the box: it starts at the crop's corner.
    expect(out.crop.inner).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('reports the box inside a crop clamped at the video frame edges', async () => {
    const grab = videoGrab(true);
    // Top-left corner of the picture: (0,118.75) -> video (0,0); the margin is clipped above and left.
    const tl = cropFactory();
    const a = await cropSelection({ x: 0, y: 118.75, w: 50, h: 75 }, SHOT, [grab], { viewportWidth: 1000, createCanvas: tl.createCanvas });
    expect(tl.made[0].draws[0]).toEqual([grab.canvas, 0, 0, 100, 150, 0, 0, 100, 150]);
    expect(a.crop.inner).toEqual({ x: 0, y: 0, w: 96, h: 144 });
    // Bottom-right corner: video (1824,936)-(1920,1080); the margin is clipped below and right.
    const br = cropFactory();
    const b = await cropSelection({ x: 950, y: 606.25, w: 50, h: 75 }, SHOT, [grab], { viewportWidth: 1000, createCanvas: br.createCanvas });
    expect(br.made[0].draws[0]).toEqual([grab.canvas, 1820, 930, 100, 150, 0, 0, 100, 150]);
    expect(b.crop.inner).toEqual({ x: 4, y: 6, w: 96, h: 144 });
  });

  it('clips the reported box to the crop when it spills into the letterbox bar', async () => {
    const grab = videoGrab(true);
    // (100,100,50,75): centre inside the picture, top 18.75 px above it -> video y -36.
    const { made, createCanvas } = cropFactory();
    const out = await cropSelection({ x: 100, y: 100, w: 50, h: 75 }, SHOT, [grab], { viewportWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([grab.canvas, 188, 0, 104, 114, 0, 0, 104, 114]);
    expect(out.crop.inner).toEqual({ x: 4, y: 0, w: 96, h: 108 });
  });

  it('downscales a huge box so its long side is at most 1600 px', async () => {
    const shot = { width: 3840, height: 2160 } as unknown as ImageBitmap;
    const { made, createCanvas } = cropFactory();
    const out = await cropSelection({ x: 0, y: 0, w: 1920, h: 1080 }, shot, [], { viewportWidth: 1920, createCanvas });
    expect(made[0].draws[0]).toEqual([shot, 0, 0, 3840, 2160, 0, 0, 1600, 900]);
    expect([out.crop.width, out.crop.height]).toEqual([1600, 900]);
    expect(out.crop.inner).toEqual({ x: 0, y: 0, w: 1600, h: 900 }); // in crop pixels, after scaling
  });

  it('flags a crop that is essentially all black (DRM video)', async () => {
    const black = cropFactory(0);
    const out = await cropSelection({ x: 100, y: 218.75, w: 50, h: 75 }, SHOT, [videoGrab(false)], {
      viewportWidth: 1000,
      createCanvas: black.createCanvas,
    });
    expect(out.black).toBe(true);
    expect(out.videoReadable).toBe(false); // the unreadable video is why this is a DRM block, not a dark frame

    const normal = cropFactory(128);
    const ok = await cropSelection({ x: 100, y: 218.75, w: 50, h: 75 }, SHOT, [videoGrab(false)], {
      viewportWidth: 1000,
      createCanvas: normal.createCanvas,
    });
    expect(ok.black).toBe(false);
  });

  // Review (content copy): a real fade-to-black moment in a readable video is not DRM -
  // it must go through normal recognition ("nothing found"), not "blocks screenshots".
  it('flags a black crop from a READABLE video as such, distinct from an unreadable one', async () => {
    const black = cropFactory(0);
    const out = await cropSelection({ x: 100, y: 218.75, w: 50, h: 75 }, SHOT, [videoGrab(true)], {
      viewportWidth: 1000,
      createCanvas: black.createCanvas,
    });
    expect(out.black).toBe(true);
    expect(out.overVideo).toBe(true);
    expect(out.videoReadable).toBe(true);
  });
});

// ---------- cropDetectedCard (click to scan) ----------
// The detector's box comes in screenshot pixels, so it is cropped from the screenshot directly
// (no round trip through CSS pixels); a readable video under it still wins, as for a drag.
describe('cropDetectedCard', () => {
  it("crops the card's bounds plus the 4% margin straight from the screenshot, and reports the card inside the crop", async () => {
    const { made, createCanvas } = cropFactory();
    // (400,300,200,300) +4% -> (392,288,216,324), whole pixels already.
    const out = await cropDetectedCard({ x: 400, y: 300, w: 200, h: 300 }, SHOT, [], { viewportWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([SHOT, 392, 288, 216, 324, 0, 0, 216, 324]);
    expect(out.crop).toEqual({
      dataUrl: 'data:image/png;base64,FAKE-216x324',
      width: 216,
      height: 324,
      source: 'screenshot',
      inner: { x: 8, y: 12, w: 200, h: 300 },
    });
    expect(out.overVideo).toBe(false);
    expect(out.videoTime).toBeUndefined();
  });

  it('clips the margin at the screenshot edges', async () => {
    const br = cropFactory();
    // Bottom-right corner of the 2000x1600 screenshot: no margin below or right of the card.
    const a = await cropDetectedCard({ x: 1900, y: 1500, w: 100, h: 100 }, SHOT, [], { viewportWidth: 1000, createCanvas: br.createCanvas });
    expect(br.made[0].draws[0]).toEqual([SHOT, 1896, 1496, 104, 104, 0, 0, 104, 104]);
    expect(a.crop.inner).toEqual({ x: 4, y: 4, w: 100, h: 100 });

    const tl = cropFactory();
    const b = await cropDetectedCard({ x: 0, y: 0, w: 100, h: 150 }, SHOT, [], { viewportWidth: 1000, createCanvas: tl.createCanvas });
    expect(tl.made[0].draws[0]).toEqual([SHOT, 0, 0, 104, 156, 0, 0, 104, 156]);
    expect(b.crop.inner).toEqual({ x: 0, y: 0, w: 100, h: 150 });
  });

  it('clips a card that runs off the screenshot, and the reported card with it', async () => {
    const { made, createCanvas } = cropFactory();
    // x -20..80: the part left of the screenshot is gone. y 100..240 +4% -> 94.4..245.6 -> whole px 94..246.
    const out = await cropDetectedCard({ x: -20, y: 100, w: 100, h: 140 }, SHOT, [], { viewportWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([SHOT, 0, 94, 84, 152, 0, 0, 84, 152]);
    expect(out.crop.inner).toEqual({ x: 0, y: 6, w: 80, h: 140 });
  });

  it("reads the box in the detection's pixels when that image isn't the decoded screenshot's size", async () => {
    const { made, createCanvas } = cropFactory();
    // Measured on a 1000 px wide image; the decoded screenshot is 2000 px wide: x2 -> (400,300,200,300).
    const out = await cropDetectedCard({ x: 200, y: 150, w: 100, h: 150 }, SHOT, [], { viewportWidth: 1000, shotWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([SHOT, 392, 288, 216, 324, 0, 0, 216, 324]);
    expect(out.crop.inner).toEqual({ x: 8, y: 12, w: 200, h: 300 });
  });

  it('crops native video pixels when the card is over a readable video, like a drag', async () => {
    const grab = videoGrab(true);
    const { made, createCanvas } = cropFactory();
    // Screenshot (200,437.5,100,150) = CSS (100,218.75,50,75) -> x1.92 video px -> (192,192,96,144) -> +4% -> whole px.
    const out = await cropDetectedCard({ x: 200, y: 437.5, w: 100, h: 150 }, SHOT, [grab], { viewportWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([grab.canvas, 188, 186, 104, 156, 0, 0, 104, 156]);
    expect(out.crop).toMatchObject({ source: 'video', videoHeight: 1080, inner: { x: 4, y: 6, w: 96, h: 144 } });
    expect(out.videoTime).toBe(12.5);
    expect(out.overVideo).toBe(true);
    expect(out.videoReadable).toBe(true);
  });

  it("falls back to the screenshot's own pixels when the video under the card can't be read", async () => {
    const grab = videoGrab(false);
    const { made, createCanvas } = cropFactory();
    // (200,437.5,100,150) +4% -> (196,431.5,108,162) -> whole px (196,431,108,163).
    const out = await cropDetectedCard({ x: 200, y: 437.5, w: 100, h: 150 }, SHOT, [grab], { viewportWidth: 1000, createCanvas });
    expect(made[0].draws[0]).toEqual([SHOT, 196, 431, 108, 163, 0, 0, 108, 163]);
    expect(out.crop.source).toBe('screenshot');
    expect(out.crop.inner).toEqual({ x: 4, y: 6.5, w: 100, h: 150 });
    expect(out.overVideo).toBe(true);
    expect(out.videoTime).toBe(12.5);
    expect(out.videoReadable).toBe(false);
  });

  describe("the card's outline, for the engine to straighten the card from (click-regression-report.md)", () => {
    it('sends its corners in the crop\'s pixels, in their order, with a crop cut from the screenshot', async () => {
      const { createCanvas } = cropFactory();
      // A turned card: its bounds are (400,300,200,300), cut from (392,288).
      const shotPts: [number, number][] = [
        [450, 300],
        [600, 350],
        [550, 600],
        [400, 550],
      ];
      const out = await cropDetectedCard({ x: 400, y: 300, w: 200, h: 300 }, SHOT, [], { viewportWidth: 1000, createCanvas, shotPts });
      expect(out.crop.outline).toEqual([
        [58, 12],
        [208, 62],
        [158, 312],
        [8, 262],
      ]);
    });

    it('maps them as the crop is: into native video pixels over a readable video, and scaled with a shrunk crop', async () => {
      const grab = videoGrab(true);
      const video = await cropDetectedCard({ x: 200, y: 437.5, w: 100, h: 150 }, SHOT, [grab], {
        viewportWidth: 1000,
        createCanvas: cropFactory().createCanvas,
        shotPts: [
          [200, 437.5],
          [300, 437.5],
          [300, 587.5],
          [200, 587.5],
        ],
      });
      // CSS (100,218.75)..(150,293.75) -> video px (192,192)..(288,336), cut from (188,186).
      expect(video.crop.outline).toEqual([
        [4, 6],
        [100, 6],
        [100, 150],
        [4, 150],
      ]);
      // Measured on a 1000 px wide image (x2 on the decoded screenshot), then a crop over 1600 px shrunk by 1600/1664.
      const big = await cropDetectedCard({ x: 100, y: 0, w: 800, h: 780 }, SHOT, [], {
        viewportWidth: 1000,
        shotWidth: 1000,
        createCanvas: cropFactory().createCanvas,
        shotPts: [
          [100, 0],
          [900, 0],
          [900, 780],
          [100, 780],
        ],
      });
      // (200,0,1600,1560) +4%, clipped to the screenshot -> cut from (136,0), 1728x1600, its long side shrunk to 1600.
      const s = 1600 / 1728;
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      expect(big.crop.outline).toEqual([
        [r3(64 * s), 0],
        [r3(1664 * s), 0],
        [r3(1664 * s), r3(1560 * s)],
        [r3(64 * s), r3(1560 * s)],
      ]);
    });

    it('sends none for a drag, nor for a click without corners', async () => {
      const drag = await cropSelection({ x: 200, y: 150, w: 100, h: 150 }, SHOT, [], { viewportWidth: 1000, createCanvas: cropFactory().createCanvas });
      expect('outline' in drag.crop).toBe(false);
      const click = await cropDetectedCard({ x: 400, y: 300, w: 200, h: 300 }, SHOT, [], { viewportWidth: 1000, createCanvas: cropFactory().createCanvas });
      expect('outline' in click.crop).toBe(false);
    });
  });
});

// ---------- isEssentiallyBlack ----------
describe('isEssentiallyBlack', () => {
  const px = (n: number, rgb: [number, number, number]) => {
    const d = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) d.set([...rgb, 255], i * 4);
    return d;
  };

  it('is true for pure black and for black with compression noise', () => {
    expect(isEssentiallyBlack(px(1000, [0, 0, 0]))).toBe(true);
    expect(isEssentiallyBlack(px(1000, [14, 9, 18]))).toBe(true);
  });

  it('is false for a dark but real image or a mid-grey one', () => {
    const d = px(1000, [0, 0, 0]);
    for (let i = 0; i < 50; i++) d.set([200, 180, 90, 255], i * 4); // 5% bright pixels
    expect(isEssentiallyBlack(d)).toBe(false);
    expect(isEssentiallyBlack(px(1000, [128, 128, 128]))).toBe(false);
  });
});

// ---------- grabVideoFrames ----------
describe('grabVideoFrames', () => {
  function addVideo(o: { w: number; h: number; t: number; rect: [number, number, number, number]; readyState?: number }) {
    const v = document.createElement('video');
    Object.defineProperty(v, 'readyState', { value: o.readyState ?? 4 });
    Object.defineProperty(v, 'videoWidth', { value: o.w });
    Object.defineProperty(v, 'videoHeight', { value: o.h });
    Object.defineProperty(v, 'currentTime', { value: o.t });
    const [x, y, w, h] = o.rect;
    v.getBoundingClientRect = () =>
      ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
    document.body.append(v);
    return v;
  }

  it('draws every visible video with a frame at native size and notes whether it is readable', () => {
    const main = addVideo({ w: 1920, h: 1080, t: 12.5, rect: [0, 0, 1000, 800] });
    addVideo({ w: 1280, h: 720, t: 3, rect: [0, window.innerHeight + 100, 640, 360] }); // scrolled out of view
    addVideo({ w: 0, h: 0, t: 0, rect: [0, 0, 300, 200] }); // no frame yet
    const crossOrigin = addVideo({ w: 640, h: 360, t: 7, rect: [100, 100, 320, 180] });

    const made: FakeCanvas[] = [];
    const grabs = grabVideoFrames({
      createCanvas: (w, h) => {
        const c = fakeCanvas(w, h, { tainted: w === 640 });
        made.push(c);
        return c;
      },
    });

    expect(grabs).toHaveLength(2);
    expect(grabs[0]).toMatchObject({
      currentTime: 12.5,
      videoWidth: 1920,
      videoHeight: 1080,
      contentBox: { x: 0, y: 118.75, w: 1000, h: 562.5 },
      readable: true,
    });
    expect(made[0].draws[0]).toEqual([main, 0, 0, 1920, 1080]);
    expect(grabs[1]).toMatchObject({ videoWidth: 640, readable: false, contentBox: { x: 100, y: 100, w: 320, h: 180 } });
    expect(made[1].draws[0][0]).toBe(crossOrigin);
  });
});

describe('grabVideoFrames without a decoded frame', () => {
  it('treats a video that has metadata but no current frame as unreadable (no false "blocks screenshots")', () => {
    const v = document.createElement('video');
    Object.defineProperty(v, 'readyState', { value: 1 }); // HAVE_METADATA
    Object.defineProperty(v, 'videoWidth', { value: 1920 });
    Object.defineProperty(v, 'videoHeight', { value: 1080 });
    v.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, width: 1000, height: 800, right: 1000, bottom: 800, toJSON() {} }) as DOMRect;
    document.body.append(v);
    const made: FakeCanvas[] = [];
    const grabs = grabVideoFrames({ createCanvas: (w, h) => (made.push(fakeCanvas(w, h)), made[made.length - 1]) });
    expect(grabs).toHaveLength(1);
    expect(grabs[0].readable).toBe(false);
    expect(grabs[0].canvas).toBeNull();
    expect(made).toHaveLength(0); // nothing drawn
  });
});

// ---------- decodeScreenshot ----------
describe('decodeScreenshot', () => {
  it('decodes the data URL locally (no fetch, so no page CSP applies)', async () => {
    const seen: Blob[] = [];
    vi.stubGlobal('createImageBitmap', async (b: Blob) => {
      seen.push(b);
      return { width: 1, height: 1 };
    });
    await decodeScreenshot('data:image/png;base64,AAEC');
    expect(seen[0].type).toBe('image/png');
    expect([...new Uint8Array(await seen[0].arrayBuffer())]).toEqual([0, 1, 2]);
  });
});
