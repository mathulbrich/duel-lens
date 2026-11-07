// Live check on pictures (spec D-L15): with the switch on, the pointer resting on a picture (an <img>, a canvas, an
// element's background image, a player in an iframe) shows the card under it. The picture's own pixels are read when
// the page lets us (the sharpest: a deck list's full-size image); otherwise a screenshot of the tab is cut to the
// picture. The cards on a picture are found once (the detector) and kept per element; only the card under the
// pointer is read (recognize), once. Videos are Live's own (arm.ts), so they are left alone here.
import { LIVE } from '../../shared/live';
import type { DetectedCardBox, ResponseFor, ToBackground } from '../../shared/messages';
import { defaultCanvas, encodeFrame, type CanvasFactory, type CanvasLike, type VideoFrameGrab } from '../capture';
import type { Rect } from '../geometry';
import { liveCrop, toNativeBoxes } from './crop';

/** How long the pointer rests before a picture is read; the smallest element that may hold a card (CSS px); the
 *  largest side its pixels are copied at. */
export const PICTURE = { dwellMs: 300, minW: 50, minH: 70, maxSide: 2048 } as const;

export interface PictureHit {
  cardId: number;
  imageId: number;
  /** The card's box in the viewport. */
  anchor: Rect;
}

export interface PictureDeps {
  doc: Document;
  send: <M extends ToBackground>(msg: M) => Promise<ResponseFor<M>>;
  /** The tab's visible area as an image data URL (the background's screenshot), or null. */
  shot: () => Promise<string | null>;
  /** Duel Lens's own elements (its hosts): never read. */
  ours: (el: Element) => boolean;
  show: (hit: PictureHit) => void;
  /** The pointer left the card shown. */
  leave: () => void;
  createCanvas?: CanvasFactory;
  loadImage?: (src: string) => Promise<CanvasImageSource & { width: number; height: number }>;
}

export interface PictureReader {
  setOn(on: boolean): void;
  pointer(x: number, y: number): void;
}

/** A card found on a picture, as fractions of the element's box (so it holds while the page scrolls). */
interface Found {
  box: DetectedCardBox;
  /** Read once: the card, or null when the read was not sure. Absent: not read yet. */
  card?: { cardId: number; imageId: number } | null;
}

/** The picture's pixels: a frame-like grab (crop.ts and encodeFrame take it as a video frame) and how element
 *  fractions map into its pixels (px = fraction * scale + offset). */
interface Surface {
  grab: VideoFrameGrab;
  scale: { x: number; y: number };
  offset: { x: number; y: number };
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

/** What identifies an element's picture: its source and size (a new src or a resize finds the cards again). */
function keyOf(el: Element, r: Rect): string {
  const src = el instanceof HTMLImageElement ? el.currentSrc || el.src : getComputedStyle(el).backgroundImage;
  return `${src}|${Math.round(r.w)}x${Math.round(r.h)}`;
}

function hasBackground(el: Element): boolean {
  return /url\(/.test(getComputedStyle(el).backgroundImage);
}

export function createPictureReader(deps: PictureDeps): PictureReader {
  const createCanvas: CanvasFactory = (w, h) => (deps.createCanvas ?? defaultCanvas)(w, h); // looked up when used
  const loadImage =
    deps.loadImage ??
    ((src: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The screenshot could not be decoded'));
        img.src = src;
      }));
  const found = new WeakMap<Element, { key: string; cards: Found[] }>();
  let on = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = { x: 0, y: 0 };
  let busy = false;
  let shown: Rect | null = null;
  let seq = 0;

  /** The topmost element under the point that can hold a card picture (not a video: Live reads those). */
  function pictureAt(x: number, y: number): Element | null {
    for (const el of deps.doc.elementsFromPoint(x, y)) {
      if (deps.ours(el) || el instanceof HTMLVideoElement) return null;
      const r = el.getBoundingClientRect();
      if (r.width < PICTURE.minW || r.height < PICTURE.minH) continue;
      if (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLIFrameElement || hasBackground(el)) return el;
    }
    return null;
  }

  /** The element's own pixels, when the page allows reading them (same origin, or served for any). */
  function ownPixels(el: Element, r: Rect): Surface | null {
    let source: (CanvasImageSource & { width: number; height: number }) | null = null;
    if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0) source = Object.assign(el, { width: el.naturalWidth, height: el.naturalHeight });
    else if (el instanceof HTMLCanvasElement) source = el;
    if (!source) return null;
    const k = Math.min(1, PICTURE.maxSide / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * k));
    const h = Math.max(1, Math.round(source.height * k));
    const canvas = createCanvas(w, h);
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
      ctx.getImageData(0, 0, 1, 1); // throws on a tainted canvas: then the screenshot
    } catch {
      canvas.width = canvas.height = 0;
      return null;
    }
    return { grab: grabOf(canvas), scale: { x: w, y: h }, offset: { x: 0, y: 0 } };
  }

  /** The element's visible part, cut from a screenshot of the tab. */
  async function shotPixels(r: Rect): Promise<Surface | null> {
    const view = deps.doc.defaultView ?? window;
    const vis = { x: Math.max(0, r.x), y: Math.max(0, r.y), w: 0, h: 0 };
    vis.w = Math.min(view.innerWidth, r.x + r.w) - vis.x;
    vis.h = Math.min(view.innerHeight, r.y + r.h) - vis.y;
    if (vis.w < PICTURE.minW || vis.h < PICTURE.minH) return null;
    const dataUrl = await deps.shot().catch(() => null);
    if (!dataUrl) return null;
    const img = await loadImage(dataUrl).catch(() => null);
    if (!img) return null;
    const k = img.width / view.innerWidth; // screenshot px per CSS px (the device pixel ratio)
    const w = Math.max(1, Math.round(vis.w * k));
    const h = Math.max(1, Math.round(vis.h * k));
    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, vis.x * k, vis.y * k, w, h, 0, 0, w, h);
    // fraction f of the element -> viewport r.x + f * r.w -> pixels (that - vis.x) * k
    return { grab: grabOf(canvas), scale: { x: r.w * k, y: r.h * k }, offset: { x: (r.x - vis.x) * k, y: (r.y - vis.y) * k } };
  }

  /** The surface as a video frame shown at its own size at the origin: encodeFrame and toNativeBoxes then work in
   *  its pixels throughout, nothing cut off by the viewport. */
  function grabOf(canvas: CanvasLike): VideoFrameGrab {
    return { canvas, currentTime: 0, videoWidth: canvas.width, videoHeight: canvas.height, contentBox: { x: 0, y: 0, w: canvas.width, h: canvas.height }, readable: true };
  }

  /** A box between element fractions and a surface's pixels, either way. */
  function mapBox(b: DetectedCardBox, s: Surface, toPixels: boolean): DetectedCardBox {
    const f = toPixels
      ? ([x, y]: [number, number]): [number, number] => [x * s.scale.x + s.offset.x, y * s.scale.y + s.offset.y]
      : ([x, y]: [number, number]): [number, number] => [(x - s.offset.x) / s.scale.x, (y - s.offset.y) / s.scale.y];
    const [cx, cy] = f([b.cx, b.cy]);
    const kx = toPixels ? s.scale.x : 1 / s.scale.x;
    const ky = toPixels ? s.scale.y : 1 / s.scale.y;
    return { ...b, cx, cy, w: b.w * kx, h: b.h * ky, pts: b.pts.map(f) };
  }

  const inside = (b: DetectedCardBox, fx: number, fy: number) => {
    const xs = b.pts.map((p) => p[0]);
    const ys = b.pts.map((p) => p[1]);
    return fx >= Math.min(...xs) && fx <= Math.max(...xs) && fy >= Math.min(...ys) && fy <= Math.max(...ys);
  };

  async function read(el: Element, x: number, y: number) {
    const r = rectOf(el);
    const key = keyOf(el, r);
    const fx = (x - r.x) / r.w;
    const fy = (y - r.y) / r.h;
    let held = found.get(el);
    let surface: Surface | null = null;
    try {
      if (!held || held.key !== key) {
        surface = ownPixels(el, r) ?? (await shotPixels(r));
        if (!surface) return;
        const frame = encodeFrame(surface.grab, { w: surface.grab.videoWidth, h: surface.grab.videoHeight }, createCanvas, {
          maxSide: LIVE.frameMaxSide,
          quality: LIVE.frameQuality,
        });
        const res = await deps.send({ type: 'live-detect', dataUrl: frame.dataUrl });
        if (res.detection.error) return;
        const boxes = toNativeBoxes(surface.grab, frame, res.detection.boxes);
        held = { key, cards: boxes.filter((b) => b.kind === 'face-up').map((b) => ({ box: mapBox(b, surface!, false) })) };
        found.set(el, held);
      }
      const hit = held.cards.filter((c) => inside(c.box, fx, fy)).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0];
      if (!hit) return;
      if (hit.card === undefined) {
        surface ??= ownPixels(el, r) ?? (await shotPixels(r));
        if (!surface) return;
        const crop = liveCrop(surface.grab, mapBox(hit.box, surface, true), createCanvas);
        const answer = await deps.send({ type: 'recognize', crop, context: { pageUrl: deps.doc.location.href, pageTitle: deps.doc.title }, record: false });
        const res = 'result' in answer ? answer.result : null;
        const top = res?.candidates[0];
        hit.card = res && res.confident && !res.faceDown && top ? { cardId: top.cardId, imageId: top.imageId } : null;
      }
      if (!hit.card) return;
      const xs = hit.box.pts.map((p) => r.x + p[0] * r.w);
      const ys = hit.box.pts.map((p) => r.y + p[1] * r.h);
      const anchor = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      // Still there? The pointer may have moved on while the card was read.
      if (last.x < anchor.x || last.x > anchor.x + anchor.w || last.y < anchor.y || last.y > anchor.y + anchor.h) return;
      shown = anchor;
      deps.show({ ...hit.card, anchor });
    } finally {
      if (surface?.grab.canvas) surface.grab.canvas.width = surface.grab.canvas.height = 0;
    }
  }

  function rested(token: number) {
    timer = undefined;
    if (!on || busy || token !== seq) return;
    const el = pictureAt(last.x, last.y);
    if (!el) return;
    busy = true;
    void read(el, last.x, last.y)
      .catch((e) => console.warn('Duel Lens: Live check could not read the picture', e))
      .finally(() => (busy = false));
  }

  return {
    setOn(next) {
      on = next;
      if (!next) clearTimeout(timer);
    },
    pointer(x, y) {
      last = { x, y };
      if (!on) return;
      if (shown && (x < shown.x || x > shown.x + shown.w || y < shown.y || y > shown.y + shown.h)) {
        shown = null;
        deps.leave();
      }
      clearTimeout(timer);
      const token = ++seq;
      timer = setTimeout(() => rested(token), PICTURE.dwellMs);
    },
  };
}
