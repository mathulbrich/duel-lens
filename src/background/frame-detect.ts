// Click to scan on the native video frame (features4-fullres.md). The detector sees a tab screenshot shrunk to
// its long side (1280 px), so on a page the player is only part of, a small card is too small for it. When the
// tab has a readable video whose frame gives the detector more pixels of the picture (content/capture.ts
// frameForDetection), the frame is detected too, at the detector's frame scale (spec.ts frameLongSide), and
// its cards are added to the screenshot's:
// - the screenshot's boxes stay exactly as they are (so every card outlined today is outlined the same way);
// - a frame box is added when it is a card the screenshot didn't find (neither box's centre inside the other)
//   and its centre is on the screenshot;
// - frame boxes are mapped frame px -> viewport CSS px (the picture's box) -> screenshot px (screenshot width /
//   viewport width, the scale the content script crops by), so a click on one crops exactly the card the frame
//   showed (capture.ts cropDetectedCard maps it back into the same frame).
// Without a frame, or when its run fails, the screenshot's detection is the answer, unchanged.
import type { CardDetection, DetectedCardBox, GrabFrameReply } from '../shared/messages';

export type DetectFrame = NonNullable<GrabFrameReply['frame']>;

/**
 * The frame's longest side as the content script hands it over (content/capture.ts encodeFrame scales a longer one
 * down): the detector shrinks it to its frameLongSide anyway. A reply claiming more is refused (frameOf).
 */
export const FRAME_MAX_SIDE = 1920;
/** CardDetection.error of a frame run the offscreen document skipped on WASM (detect-cards.ts). */
export { FRAME_SKIPPED_ON_WASM } from '../offscreen/detect-cards';
/** The longest frame data URL taken (a 1920x1080 JPEG at q 0.92 is about 0.5 MB). */
export const FRAME_MAX_DATA_URL = 8 * 1024 * 1024;
/** The JPEG data URL a frame must be. */
const JPEG_DATA_URL = 'data:image/jpeg;base64,';
/** The widest viewport taken, in CSS px. */
const MAX_VIEWPORT = 32768;
/** Rounding slack (CSS px) when checking that the picture's box lies on the page. */
const SLACK = 0.5;

type Pt = [number, number];

/** True when (x, y) lies inside polygon `p` (even-odd rule). */
function inPolygon(x: number, y: number, p: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const centre = (p: readonly Pt[]): Pt => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

/** Two outlines of the same card: either's centre lies inside the other. */
export function sameCard(a: readonly Pt[], b: readonly Pt[]): boolean {
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  return inPolygon(ax, ay, b) || inPolygon(bx, by, a);
}

const usable = (b: DetectedCardBox | undefined): b is DetectedCardBox =>
  Array.isArray(b?.pts) && b.pts.length === 4 && b.pts.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));

/**
 * A box the detector found on `frame` (frame px), in the pixels of a screenshot `shotWidth` px wide: through the
 * picture's box on the page (viewport CSS px), then screenshot px per CSS px (shotWidth / viewportWidth).
 */
export function frameBoxToShot(b: DetectedCardBox, frame: DetectFrame, shotWidth: number): DetectedCardBox {
  const s = shotWidth / frame.viewportWidth;
  const kx = (frame.box.w / frame.width) * s;
  const ky = (frame.box.h / frame.height) * s;
  const x = (v: number) => (frame.box.x * s) + v * kx;
  const y = (v: number) => (frame.box.y * s) + v * ky;
  const k = Math.sqrt(kx * ky);
  return {
    cx: x(b.cx),
    cy: y(b.cy),
    w: b.w * k,
    h: b.h * k,
    angle: b.angle,
    conf: b.conf,
    ...(b.kind ? { kind: b.kind } : {}),
    pts: b.pts.map(([px, py]): Pt => [x(px), y(py)]),
  };
}

/**
 * The screenshot's detection plus the cards only the frame's found (mapped into screenshot px), best first.
 * `ms` is the longer of the two (the frame's run is timed from the scan's own detection start by the caller).
 * Any missing piece (no frame, a frame run that failed or found nothing, a screenshot of unknown size) gives
 * the screenshot's detection unchanged; so does a frame the offscreen document decoded at another size than the
 * tab claimed, or whose picture box doesn't lie on the screenshot.
 */
export function mergeFrameDetection(shot: CardDetection, frameDetection: CardDetection | undefined, frame: DetectFrame | undefined): CardDetection {
  if (!frame || !frameDetection || frameDetection.error || !Array.isArray(frameDetection.boxes) || frameDetection.boxes.length === 0) return shot;
  if (shot.error || !(shot.width > 0 && shot.height > 0) || !(frame.width > 0 && frame.height > 0 && frame.viewportWidth > 0)) return shot;
  if (!(frame.box.w > 0 && frame.box.h > 0)) return shot;
  // The mapping uses the frame's size: it must be the size the detector saw.
  if (frameDetection.width !== frame.width || frameDetection.height !== frame.height) return shot;
  // The picture's box (viewport CSS px) must lie on the screenshot, down to its bottom edge.
  const s = shot.width / frame.viewportWidth;
  if (frame.box.y < -SLACK || (frame.box.y + frame.box.h) * s > shot.height + SLACK * s) return shot;
  const kept = Array.isArray(shot.boxes) ? shot.boxes : [];
  const known = kept.filter(usable).map((b) => b.pts);
  const added = frameDetection.boxes
    .filter(usable)
    .map((b) => frameBoxToShot(b, frame, shot.width))
    // a card of the picture's part scrolled out of view isn't on the screenshot
    .filter((b) => b.cx >= 0 && b.cy >= 0 && b.cx <= shot.width && b.cy <= shot.height)
    .filter((b) => !known.some((pts) => sameCard(b.pts, pts)));
  if (added.length === 0) return { ...shot, ms: Math.max(shot.ms, frameDetection.ms) };
  // A stable sort: the screenshot's boxes keep their order among themselves.
  const boxes = [...kept, ...added].sort((a, b) => b.conf - a.conf);
  return { ...shot, boxes, ms: Math.max(shot.ms, frameDetection.ms) };
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const side = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= FRAME_MAX_SIDE;

/**
 * The frame in a tab's answer to grab-frame (GrabFrameReply), when it is a usable one: a base64 JPEG data URL of at
 * most FRAME_MAX_DATA_URL characters, whole-pixel sides of at most FRAME_MAX_SIDE, a bounded viewport width, and a
 * picture box with an area that lies across the viewport's width (the content script sends the picture's visible
 * part only); the box's bottom is checked against the screenshot (mergeFrameDetection).
 */
export function frameOf(reply: unknown): DetectFrame | undefined {
  const f = (reply as Partial<GrabFrameReply> | undefined)?.frame;
  if (!f || typeof f !== 'object') return undefined;
  if (typeof f.dataUrl !== 'string' || !f.dataUrl.startsWith(JPEG_DATA_URL) || f.dataUrl.length > FRAME_MAX_DATA_URL) return undefined;
  if (f.dataUrl.length <= JPEG_DATA_URL.length) return undefined;
  if (!side(f.width) || !side(f.height)) return undefined;
  if (!positive(f.viewportWidth) || f.viewportWidth > MAX_VIEWPORT) return undefined;
  const b = f.box;
  if (!b || typeof b !== 'object' || !finite(b.x) || !finite(b.y) || !positive(b.w) || !positive(b.h)) return undefined;
  if (b.x < -SLACK || b.y < -SLACK || b.x + b.w > f.viewportWidth + SLACK || b.h > MAX_VIEWPORT) return undefined;
  return { dataUrl: f.dataUrl, width: f.width, height: f.height, box: { x: b.x, y: b.y, w: b.w, h: b.h }, viewportWidth: f.viewportWidth };
}
