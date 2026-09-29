// Capture and crop: turn the user's box, or the card they clicked, into the pixels the engine matches.
//
// - Over a <video> whose frame can be read, the crop comes from that frame at native
//   resolution (grabbed when the selection starts), mapped through object-fit letterboxing.
// - Otherwise it comes from the captureVisibleTab screenshot: a dragged box is scaled by
//   bitmap width / viewport width (covers devicePixelRatio and page zoom); a clicked card's
//   bounds are already in screenshot pixels (cropDetectedCard).
// - The box gets a 4% margin, clipped to the source, and huge crops are downscaled.
// - A clicked card's corners go with its crop, mapped the same way (CropPayload.outline): the engine
//   straightens the card from them instead of looking for it in the crop again.
import type { CropPayload } from '../shared/types';
import { expandRect, videoContentBox, viewportToBitmap, viewportToVideo, type Point, type Rect } from './geometry';

/** Margin added around the box on every side, as a fraction of its size. */
export const CROP_MARGIN = 0.04;
/** Longest side of a crop; the engine never looks at more than this. */
export const MAX_CROP_SIDE = 1600;

/** The part of CanvasRenderingContext2D the crop uses (a seam for tests). */
export interface Ctx2DLike {
  drawImage(...args: any[]): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray; width: number; height: number };
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: ImageSmoothingQuality;
}

/** The part of HTMLCanvasElement the crop uses. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: '2d', options?: CanvasRenderingContext2DSettings): Ctx2DLike | null;
  toDataURL(type?: string): string;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

export interface VideoFrameGrab {
  /** The frame at native size; null when the video can't be read (cross-origin or DRM). */
  canvas: CanvasLike | null;
  currentTime: number;
  videoWidth: number;
  videoHeight: number;
  /** Where the picture sits in the viewport when the frame was grabbed. */
  contentBox: Rect;
  /** False when reading the frame's pixels throws (tainted canvas). */
  readable: boolean;
}

export interface CropResult {
  crop: CropPayload;
  /** Seconds into the video under the box, when the box is over a video. */
  videoTime?: number;
  /** The crop is essentially all black (e.g. a DRM-protected frame). */
  black: boolean;
  /** The centre of the box is over a video picture (readable or not). */
  overVideo: boolean;
  /**
   * True when the crop came from a video frame that could actually be read (not
   * DRM/cross-origin-tainted); false when every video under the box was unreadable, so
   * `crop` fell back to the screenshot instead. Together with `black` and `overVideo`,
   * tells a genuine DRM block (video present, unreadable, screenshot fallback is black)
   * from a real dark moment in a readable video (fade-to-black).
   */
  videoReadable: boolean;
}

const defaultCanvas: CanvasFactory = (width, height) => {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c as unknown as CanvasLike;
};

/** An element's content box (inside border and padding) in viewport coordinates. */
function contentRect(el: Element, view: Window): Rect {
  const r = el.getBoundingClientRect();
  const cs = view.getComputedStyle(el);
  const n = (v: string) => parseFloat(v) || 0;
  const left = n(cs.borderLeftWidth) + n(cs.paddingLeft);
  const top = n(cs.borderTopWidth) + n(cs.paddingTop);
  const right = n(cs.borderRightWidth) + n(cs.paddingRight);
  const bottom = n(cs.borderBottomWidth) + n(cs.paddingBottom);
  return { x: r.left + left, y: r.top + top, w: r.width - left - right, h: r.height - top - bottom };
}

/**
 * Draw the current frame of every visible <video> into a canvas at native size.
 * Call it as soon as the selection starts, so the frame matches the frozen screenshot.
 */
export function grabVideoFrames(opts: { doc?: Document; createCanvas?: CanvasFactory } = {}): VideoFrameGrab[] {
  const doc = opts.doc ?? document;
  const view = doc.defaultView ?? window;
  const createCanvas = opts.createCanvas ?? defaultCanvas;
  const grabs: VideoFrameGrab[] = [];
  for (const video of Array.from(doc.querySelectorAll('video'))) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) continue;
    const box = contentRect(video, view);
    const visible =
      box.w > 0 && box.h > 0 && box.x < view.innerWidth && box.y < view.innerHeight && box.x + box.w > 0 && box.y + box.h > 0;
    if (!visible) continue;

    const contentBox = videoContentBox(box, vw, vh, view.getComputedStyle(video).objectFit);
    // Metadata but no decoded frame yet (HAVE_CURRENT_DATA = 2): drawing it would give a
    // blank frame that looks like a DRM block. Use the screenshot instead.
    if (video.readyState < 2) {
      grabs.push({ canvas: null, currentTime: video.currentTime, videoWidth: vw, videoHeight: vh, contentBox, readable: false });
      continue;
    }

    let canvas: CanvasLike | null = createCanvas(vw, vh);
    let readable = false;
    try {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, vw, vh);
        ctx.getImageData(0, 0, 1, 1); // throws SecurityError when tainted
        readable = true;
      }
    } catch {
      readable = false;
    }
    if (!readable) {
      canvas.width = 0; // free the pixels; a tainted frame is useless
      canvas = null;
    }
    grabs.push({ canvas, currentTime: video.currentTime, videoWidth: vw, videoHeight: vh, contentBox, readable });
  }
  return grabs;
}

/**
 * True when (nearly) every pixel is black: fewer than `maxBrightFraction` of the pixels
 * have a channel above `threshold` (which allows for compression noise).
 */
export function isEssentiallyBlack(data: Uint8ClampedArray, threshold = 24, maxBrightFraction = 0.01): boolean {
  const n = data.length / 4;
  if (n === 0) return true;
  const stride = Math.max(1, Math.floor(n / 65536)); // sample big crops
  let bright = 0;
  let seen = 0;
  for (let i = 0; i < n; i += stride) {
    const o = i * 4;
    if (data[o] > threshold || data[o + 1] > threshold || data[o + 2] > threshold) bright++;
    seen++;
  }
  return bright / seen < maxBrightFraction;
}

function sizeOf(img: HTMLImageElement | ImageBitmap): { width: number; height: number } {
  if ('naturalWidth' in img && img.naturalWidth) return { width: img.naturalWidth, height: img.naturalHeight };
  return { width: img.width, height: img.height };
}

/** To a thousandth of a pixel (what the crop reports carry). */
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Where the user's box sits inside the crop, in crop pixels. The margin is clipped at the
 * frame edges, so it isn't always 4% on every side; consumers use this instead. A box that
 * spills past the frame (into a letterbox bar) is clipped to the crop.
 */
function innerBox(box: Rect, px: Rect, scale: number, outW: number, outH: number): Rect {
  const clip = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const x0 = clip((box.x - px.x) * scale, outW);
  const y0 = clip((box.y - px.y) * scale, outH);
  const x1 = clip((box.x + box.w - px.x) * scale, outW);
  const y1 = clip((box.y + box.h - px.y) * scale, outH);
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}

/** Whole source pixels covering `r` (at least 1x1). */
function toPixels(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

export interface CropOptions {
  /** The viewport the screenshot covers, in CSS px (default: the current innerWidth). */
  viewportWidth?: number;
  createCanvas?: CanvasFactory;
  maxSide?: number;
}

/**
 * Cut the user's box (viewport coordinates) out of the best source: the first readable
 * video frame under the centre of the box, otherwise the screenshot. Returns a PNG crop.
 */
export async function cropSelection(
  rect: Rect,
  screenshot: HTMLImageElement | ImageBitmap,
  grabs: VideoFrameGrab[],
  opts: CropOptions = {},
): Promise<CropResult> {
  const viewportWidth = opts.viewportWidth ?? window.innerWidth;
  return cropBest(rect, viewportToBitmap(rect, sizeOf(screenshot).width, viewportWidth), screenshot, grabs, opts);
}

/**
 * Click to scan: cut a card the detector found out of the best source, as a drag would.
 * `shotRect` is the card's axis-aligned bounds in the pixels of the screenshot the detector saw
 * (`shotWidth` wide, by default the decoded screenshot's own width), so the screenshot crop uses
 * it as is; it is mapped to CSS px only to find a readable video under the card. `shotPts`, the
 * card's 4 corners in the same pixels (CardOutline.shotPts), go with the crop as `crop.outline`,
 * in the crop's pixels.
 */
export async function cropDetectedCard(
  shotRect: Rect,
  screenshot: HTMLImageElement | ImageBitmap,
  grabs: VideoFrameGrab[],
  opts: CropOptions & { shotWidth?: number; shotPts?: Point[] } = {},
): Promise<CropResult> {
  const { width } = sizeOf(screenshot);
  const shotWidth = opts.shotWidth ?? width;
  const viewportWidth = opts.viewportWidth ?? window.innerWidth;
  const scaled = (s: number): Rect => (s === 1 ? shotRect : { x: shotRect.x * s, y: shotRect.y * s, w: shotRect.w * s, h: shotRect.h * s });
  const scaledPts = (s: number): Point[] | undefined => opts.shotPts?.map(([x, y]): Point => [x * s, y * s]);
  const pts = opts.shotPts ? { view: scaledPts(viewportWidth / shotWidth)!, shot: scaledPts(width / shotWidth)! } : undefined;
  return cropBest(scaled(viewportWidth / shotWidth), scaled(width / shotWidth), screenshot, grabs, opts, pts);
}

/**
 * The crop itself, for a box given both in viewport CSS px (`view`: to find the video under it)
 * and in screenshot pixels (`shot`: to cut it from the screenshot when no readable video is there);
 * `pts`, a clicked card's corners in both, are mapped into the crop's pixels (crop.outline).
 */
async function cropBest(
  view: Rect,
  shot: Rect,
  screenshot: HTMLImageElement | ImageBitmap,
  grabs: VideoFrameGrab[],
  opts: CropOptions,
  pts?: { view: Point[]; shot: Point[] },
): Promise<CropResult> {
  const createCanvas = opts.createCanvas ?? defaultCanvas;
  const maxSide = opts.maxSide ?? MAX_CROP_SIDE;

  const under = grabs.filter((g) => viewportToVideo(view, g.contentBox, g.videoWidth, g.videoHeight) !== null);
  const grab = under.find((g) => g.readable && g.canvas);

  let source: CanvasLike | HTMLImageElement | ImageBitmap;
  let box: Rect; // the user's box in source pixels, before the margin
  let corners: Point[] | undefined; // a clicked card's corners in source pixels
  let region: Rect;
  if (grab) {
    box = viewportToVideo(view, grab.contentBox, grab.videoWidth, grab.videoHeight)!;
    const b = grab.contentBox;
    corners = pts?.view.map(([x, y]): Point => [((x - b.x) * grab.videoWidth) / b.w, ((y - b.y) * grab.videoHeight) / b.h]);
    region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: grab.videoWidth, h: grab.videoHeight });
    source = grab.canvas!;
  } else {
    const { width, height } = sizeOf(screenshot);
    box = shot;
    corners = pts?.shot;
    region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: width, h: height });
    source = screenshot;
  }

  const px = toPixels(region);
  const scale = Math.min(1, maxSide / Math.max(px.w, px.h));
  const outW = Math.max(1, Math.round(px.w * scale));
  const outH = Math.max(1, Math.round(px.h * scale));
  const canvas = createCanvas(outW, outH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available on this page');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, px.x, px.y, px.w, px.h, 0, 0, outW, outH);
  const black = isEssentiallyBlack(ctx.getImageData(0, 0, outW, outH).data);

  const crop: CropPayload = {
    dataUrl: canvas.toDataURL('image/png'),
    width: outW,
    height: outH,
    source: grab ? 'video' : 'screenshot',
    inner: innerBox(box, px, scale, outW, outH),
  };
  if (grab) crop.videoHeight = grab.videoHeight;
  // Not clipped: a corner outside the crop (a card the picture's edge cuts) tells the engine to look for the card itself.
  if (corners) crop.outline = corners.map(([x, y]): [number, number] => [r3((x - px.x) * scale), r3((y - px.y) * scale)]);
  const timed = grab ?? under[0];
  return { crop, videoTime: timed?.currentTime, black, overVideo: under.length > 0, videoReadable: grab !== undefined };
}

/** Turn a data URL into a Blob without fetching it (no page CSP applies). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(5, comma); // after "data:"
  const mime = header.split(';')[0] || 'application/octet-stream';
  const body = dataUrl.slice(comma + 1);
  if (!header.includes(';base64')) return new Blob([decodeURIComponent(body)], { type: mime });
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Decode the captureVisibleTab PNG into a bitmap to crop from. */
export function decodeScreenshot(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(dataUrlToBlob(dataUrl));
}
