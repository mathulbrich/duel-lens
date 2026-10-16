// Capture and crop: turn the user's box, or the card they clicked, into the pixels the engine matches.
//
// - Over a <video> whose frame can be read, the crop comes from that frame at native
//   resolution (grabbed when the selection starts), mapped through object-fit letterboxing.
// - Otherwise it comes from the captureVisibleTab screenshot: a dragged box is scaled by
//   bitmap width / viewport width (covers devicePixelRatio and page zoom); a clicked card's
//   bounds are already in screenshot pixels (cropDetectedCard).
// - The box gets a 4% margin, clipped to the source, and huge crops are downscaled.
// - A clicked card's corners go with its crop, mapped the same way (CropPayload.outline): the engine
//   straightens the card from them (a card found in the crop replaces them only when it is plainly the same
//   card boxed another way: engine.ts CLICK_REDETECT).
import type { GrabFrameReply } from '../shared/messages';
import type { CropPayload } from '../shared/types';
import { CARD_DETECTOR } from '../offscreen/detector/spec';
import { FRAME_MAX_SIDE } from '../background/frame-detect';
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
  toDataURL(type?: string, quality?: number): string;
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
  /**
   * The video element's own content box then (viewport CSS px). With object-fit: cover the picture reaches past
   * it and is cut off there; with contain it lies inside it. Absent: taken as the picture's box.
   */
  elementBox?: Rect;
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
      grabs.push({ canvas: null, currentTime: video.currentTime, videoWidth: vw, videoHeight: vh, contentBox, elementBox: box, readable: false });
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
    grabs.push({ canvas, currentTime: video.currentTime, videoWidth: vw, videoHeight: vh, contentBox, elementBox: box, readable });
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
 * in the crop's pixels; so does `click`, where the card was clicked (viewport CSS px), as `crop.click`.
 */
export async function cropDetectedCard(
  shotRect: Rect,
  screenshot: HTMLImageElement | ImageBitmap,
  grabs: VideoFrameGrab[],
  opts: CropOptions & { shotWidth?: number; shotPts?: Point[]; click?: Point } = {},
): Promise<CropResult> {
  const { width } = sizeOf(screenshot);
  const shotWidth = opts.shotWidth ?? width;
  const viewportWidth = opts.viewportWidth ?? window.innerWidth;
  const scaled = (s: number): Rect => (s === 1 ? shotRect : { x: shotRect.x * s, y: shotRect.y * s, w: shotRect.w * s, h: shotRect.h * s });
  const scaledPts = (s: number): Point[] | undefined => opts.shotPts?.map(([x, y]): Point => [x * s, y * s]);
  const pts = opts.shotPts ? { view: scaledPts(viewportWidth / shotWidth)!, shot: scaledPts(width / shotWidth)! } : undefined;
  const at = opts.click;
  const click = at ? { view: at, shot: [(at[0] * width) / viewportWidth, (at[1] * width) / viewportWidth] as Point } : undefined;
  return cropBest(scaled(viewportWidth / shotWidth), scaled(width / shotWidth), screenshot, grabs, opts, pts, click);
}

/**
 * The crop itself, for a box given both in viewport CSS px (`view`: to find the video under it)
 * and in screenshot pixels (`shot`: to cut it from the screenshot when no readable video is there);
 * `pts`, a clicked card's corners in both, are mapped into the crop's pixels (crop.outline), and so is
 * `click`, the point clicked (crop.click).
 */
async function cropBest(
  view: Rect,
  shot: Rect,
  screenshot: HTMLImageElement | ImageBitmap,
  grabs: VideoFrameGrab[],
  opts: CropOptions,
  pts?: { view: Point[]; shot: Point[] },
  click?: { view: Point; shot: Point },
): Promise<CropResult> {
  const createCanvas = opts.createCanvas ?? defaultCanvas;
  const maxSide = opts.maxSide ?? MAX_CROP_SIDE;

  const under = grabs.filter((g) => viewportToVideo(view, g.contentBox, g.videoWidth, g.videoHeight) !== null);
  const grab = under.find((g) => g.readable && g.canvas);

  let source: CanvasLike | HTMLImageElement | ImageBitmap;
  let box: Rect; // the user's box in source pixels, before the margin
  let corners: Point[] | undefined; // a clicked card's corners in source pixels
  let clicked: Point | undefined; // where it was clicked, in source pixels
  let region: Rect;
  if (grab) {
    box = viewportToVideo(view, grab.contentBox, grab.videoWidth, grab.videoHeight)!;
    const b = grab.contentBox;
    const toVideo = ([x, y]: Point): Point => [((x - b.x) * grab.videoWidth) / b.w, ((y - b.y) * grab.videoHeight) / b.h];
    corners = pts?.view.map(toVideo);
    clicked = click && toVideo(click.view);
    region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: grab.videoWidth, h: grab.videoHeight });
    source = grab.canvas!;
  } else {
    const { width, height } = sizeOf(screenshot);
    box = shot;
    corners = pts?.shot;
    clicked = click?.shot;
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
  const inCrop = ([x, y]: Point): [number, number] => [r3((x - px.x) * scale), r3((y - px.y) * scale)];
  // Not clipped: a corner outside the crop (a card the picture's edge cuts) tells the engine to look for the card itself.
  if (corners) crop.outline = corners.map(inCrop);
  // Clamped: a click on the hit area's rim (3 px out, more around a small card) can fall past the crop's margin.
  if (clicked) crop.click = inCrop(clicked).map((v, i) => Math.max(0, Math.min(v, i === 0 ? outW : outH))) as [number, number];
  const timed = grab ?? under[0];
  return { crop, videoTime: timed?.currentTime, black, overVideo: under.length > 0, videoReadable: grab !== undefined };
}

// ---------- Full resolution: the video frame click to scan also detects on (background/frame-detect.ts) ----------

/** The frame goes to the detector only when it shows it the picture this many times wider than the screenshot does. */
export const FRAME_GAIN = 1.2;
/** JPEG quality of the frame handed to the detector (q92 outlines the same cards as the lossless frame: features4-fullres.md). */
export const FRAME_JPEG_QUALITY = 0.92;
/** The intersection of two rectangles; null when they don't overlap. */
function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * The part of `g`'s picture the page shows, in viewport CSS px: its content box, cut to the video element's own box
 * (object-fit: cover crops the picture there; contain letterboxes it inside) and to the `w` x `h` viewport. Null
 * when none of it is in view.
 */
export function visiblePicture(g: VideoFrameGrab, view: { w: number; h: number }): Rect | null {
  const shown = intersect(g.contentBox, g.elementBox ?? g.contentBox);
  return shown && intersect(shown, { x: 0, y: 0, w: view.w, h: view.h });
}

/** The whole video pixels showing `vis` (a part of `g`'s picture), snapped inwards so they never show more. */
function sourceRect(g: VideoFrameGrab, vis: Rect): Rect {
  const b = g.contentBox;
  const kx = g.videoWidth / b.w;
  const ky = g.videoHeight / b.h;
  const eps = 1e-6; // a picture shown whole maps to exactly 0..videoWidth, give or take float error
  const x0 = Math.max(0, Math.ceil((vis.x - b.x) * kx - eps));
  const y0 = Math.max(0, Math.ceil((vis.y - b.y) * ky - eps));
  const x1 = Math.min(g.videoWidth, Math.floor((vis.x + vis.w - b.x) * kx + eps));
  const y1 = Math.min(g.videoHeight, Math.floor((vis.y + vis.h - b.y) * ky + eps));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The grab whose frame the detector should also see, if any: the readable video with the most picture in view,
 * when its frame shows the detector that picture at least FRAME_GAIN times wider than the screenshot does. The
 * screenshot (viewport `w` x `h` CSS px at `dpr` device px each) is shrunk to CARD_DETECTOR.longSide, the frame's
 * visible part to CARD_DETECTOR.frameLongSide (never enlarged). A 1080p video in a 1205-px player on a 1728x1000
 * page gains 1.8x; a 480p one gains nothing and is left out (the screenshot already has its pixels).
 */
export function frameForDetection(grabs: VideoFrameGrab[], view: { w: number; h: number; dpr: number }): VideoFrameGrab | undefined {
  let best: VideoFrameGrab | undefined;
  let bestVis: Rect | null = null;
  for (const g of grabs) {
    if (!g?.readable || !g.canvas || !(g.videoWidth > 0 && g.videoHeight > 0)) continue;
    const vis = visiblePicture(g, view);
    if (vis && (!bestVis || vis.w * vis.h > bestVis.w * bestVis.h)) [best, bestVis] = [g, vis];
  }
  if (!best || !bestVis) return undefined;
  const src = sourceRect(best, bestVis);
  if (!(src.w > 0 && src.h > 0)) return undefined;
  const dpr = view.dpr > 0 ? view.dpr : 1;
  const shotScale = Math.min(1, CARD_DETECTOR.longSide / (Math.max(view.w, view.h) * dpr));
  const onShot = bestVis.w * dpr * shotScale;
  const onFrame = src.w * Math.min(1, CARD_DETECTOR.frameLongSide / Math.max(src.w, src.h));
  return onFrame >= FRAME_GAIN * onShot ? best : undefined;
}

/**
 * `grab`'s frame as the detector gets it (GrabFrameReply.frame): a JPEG of the native pixels of the picture's visible
 * part (visiblePicture: the part object-fit: cover or the viewport cuts off is left out), scaled down to
 * FRAME_MAX_SIDE when longer; its size; that part's box on the page and the viewport's width, in the CSS px the
 * screenshot was taken at (the background maps the frame's cards into the screenshot with them). Throws when none
 * of the picture is in view or the frame can't be read.
 */
export function encodeFrame(grab: VideoFrameGrab, view: { w: number; h: number }, createCanvas: CanvasFactory = defaultCanvas): NonNullable<GrabFrameReply['frame']> {
  if (!grab.canvas) throw new Error('The video frame could not be read');
  const vis = visiblePicture(grab, view);
  const src = vis && sourceRect(grab, vis);
  if (!src || !(src.w > 0 && src.h > 0)) throw new Error('None of the video is in view');
  const k = Math.min(1, FRAME_MAX_SIDE / Math.max(src.w, src.h));
  const whole = k === 1 && src.x === 0 && src.y === 0 && src.w === grab.videoWidth && src.h === grab.videoHeight;
  let source = grab.canvas;
  if (!whole) {
    source = createCanvas(Math.max(1, Math.round(src.w * k)), Math.max(1, Math.round(src.h * k)));
    const ctx = source.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available on this page');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(grab.canvas, src.x, src.y, src.w, src.h, 0, 0, source.width, source.height);
  }
  try {
    const b = grab.contentBox;
    const box = { x: b.x + (src.x * b.w) / grab.videoWidth, y: b.y + (src.y * b.h) / grab.videoHeight, w: (src.w * b.w) / grab.videoWidth, h: (src.h * b.h) / grab.videoHeight };
    return { dataUrl: source.toDataURL('image/jpeg', FRAME_JPEG_QUALITY), width: source.width, height: source.height, box, viewportWidth: view.w };
  } finally {
    if (source !== grab.canvas) source.width = 0; // free the copy's pixels
  }
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
