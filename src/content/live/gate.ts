// Live's gate: is the table still? A 64x36 grey thumbnail of the video is split into 8x4 zones; a zone is moving
// while its picture changes and quiet after it has held still. Hands move almost all the time on a real table, so
// the loop asks about the zones under a card, not the whole frame.
import { isEssentiallyBlack, type CanvasFactory, type CanvasLike } from '../capture';

export const GATE = {
  w: 64,
  h: 36,
  cols: 8,
  rows: 4,
  sampleMs: 200,
  /** A zone diff below this is quiet, at or above `moving` is moving, in between keeps the state. */
  quiet: 3,
  moving: 6,
  /** Quiet samples in a row after moving before a zone counts as settled. */
  settleSamples: 2,
  /** A whole-frame mean diff at or above this is a cut (new scene, seek). */
  cut: 40,
  /** Read again after this long without a read even if nothing settled. */
  refreshMs: 10_000,
} as const;

/** A box in 0-1 of the video. */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 64x36 RGBA to 64x36 luma (BT.601). Any length that is a multiple of 4 works. */
export function greyThumb(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
  }
  return out;
}

const defaultCanvas: CanvasFactory = (width, height) => {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c as unknown as CanvasLike;
};

/** One sample of the picture: the grey thumbnail, and whether the frame is (nearly) black (a DRM video draws black). */
export interface ThumbSample {
  grey: Uint8Array;
  black: boolean;
}

/**
 * Reads the whole video frame as a grey thumbnail, again and again on one canvas (a new canvas every 200 ms is
 * garbage the page has to collect). Throws when the frame can't be read (tainted canvas).
 */
export function createThumbSampler(createCanvas: CanvasFactory = defaultCanvas): (source: CanvasImageSource) => ThumbSample {
  let canvas: CanvasLike | null = null;
  return (source) => {
    canvas ??= createCanvas(GATE.w, GATE.h);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(source, 0, 0, GATE.w, GATE.h);
    const { data } = ctx.getImageData(0, 0, GATE.w, GATE.h);
    return { grey: greyThumb(data), black: isEssentiallyBlack(data) };
  };
}

/** Mean absolute difference, 0-255. */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** The mean difference of each of the 32 zones (8 cols x 4 rows of 8x9 px), row-major. */
export function zoneDiffs(a: Uint8Array, b: Uint8Array): number[] {
  const zw = GATE.w / GATE.cols;
  const zh = GATE.h / GATE.rows;
  const out: number[] = [];
  for (let row = 0; row < GATE.rows; row++) {
    for (let col = 0; col < GATE.cols; col++) {
      let sum = 0;
      for (let y = row * zh; y < (row + 1) * zh; y++) {
        for (let x = col * zw; x < (col + 1) * zw; x++) sum += Math.abs(a[y * GATE.w + x] - b[y * GATE.w + x]);
      }
      out.push(sum / (zw * zh));
    }
  }
  return out;
}

export interface Zones {
  /** Diff against the previous sample; a cut marks every zone moving. */
  sample(thumb: Uint8Array): 'cut' | 'ok';
  /** A cut from outside (seek, new source, media-time jump). */
  cut(): void;
  /** The next sample compares nothing (after a pause). */
  rebase(): void;
  /** True once per settle since the last call, for any zone. */
  takeSettled(): boolean;
  /** Every zone the box overlaps is quiet. */
  quiet(box: NormBox): boolean;
}

const EPS = 1e-9;

/**
 * First and last zone index along one axis for the span [start, start + size] in 0-1. A zone counts when the span
 * reaches into its area; touching only its boundary does not (an edge at 0.25 stays out of the zone that starts at
 * 0.25), and EPS absorbs float error such as 0.1 + 0.15. Clamped to the video.
 */
function zoneSpan(start: number, size: number, count: number): [number, number] {
  const first = Math.floor(start * count + EPS);
  const last = Math.ceil((start + size) * count - EPS) - 1;
  return [Math.max(0, first), Math.min(count - 1, Math.max(first, last))];
}

export function createZones(): Zones {
  const n = GATE.cols * GATE.rows;
  const moving: boolean[] = new Array(n).fill(false);
  const quietRun: number[] = new Array(n).fill(0);
  let prev: Uint8Array | null = null;
  let settled = false;

  const cut = () => {
    moving.fill(true);
    quietRun.fill(0);
  };

  return {
    sample(thumb) {
      const before = prev;
      prev = thumb;
      if (!before) return 'ok';
      if (frameDiff(before, thumb) >= GATE.cut) {
        cut();
        return 'cut';
      }
      zoneDiffs(before, thumb).forEach((d, i) => {
        if (d >= GATE.moving) {
          moving[i] = true;
          quietRun[i] = 0;
        } else if (d < GATE.quiet) {
          if (!moving[i]) return;
          if (++quietRun[i] >= GATE.settleSamples) {
            moving[i] = false;
            quietRun[i] = 0;
            settled = true;
          }
        } else {
          quietRun[i] = 0;
        }
      });
      return 'ok';
    },
    cut,
    rebase() {
      prev = null;
    },
    takeSettled() {
      const was = settled;
      settled = false;
      return was;
    },
    quiet(box) {
      const [c0, c1] = zoneSpan(box.x, box.w, GATE.cols);
      const [r0, r1] = zoneSpan(box.y, box.h, GATE.rows);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (moving[r * GATE.cols + c]) return false;
      return true;
    },
  };
}

/** Why to read the frame now: the first read, a settle, or a refresh after refreshMs; null to wait. */
export function detectReason(x: { first: boolean; settled: boolean; sinceDetectMs: number }): 'first' | 'settled' | 'refresh' | null {
  if (x.first) return 'first';
  if (x.settled) return 'settled';
  return x.sinceDetectMs >= GATE.refreshMs ? 'refresh' : null;
}
