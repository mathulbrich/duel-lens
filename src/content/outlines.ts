// Click to scan: the cards the detector found on the frozen screenshot, as outlines on the page.
// The detector works in the screenshot's own pixels; the frozen frame shows that screenshot
// stretched over the captured viewport, so a point maps by viewport size / screenshot size on
// each axis (covers devicePixelRatio and page zoom, like viewportToBitmap the other way).
import type { CardDetection } from '../shared/messages';
import { orientedBox, pointInBox, polygonBounds, type OrientedBox, type Point, type Rect } from './geometry';

export interface CardOutline {
  /** "Card 3 of 12": the card's place in reading order, for screen readers. */
  label: string;
  /** The turned box on the page (CSS px): what is outlined, lit and clicked. */
  shape: OrientedBox;
  /** Axis-aligned bounds on the page (CSS px): what the popover sits beside. */
  rect: Rect;
  /** Area on the page (CSS px²): the smallest of overlapping cards wins a click. */
  area: number;
  /** Axis-aligned bounds in the screenshot's pixels: what gets cropped. */
  shotRect: Rect;
  /** The detector's 4 corners in the screenshot's pixels, in its order: sent with the crop, for the engine to straighten the card from. */
  shotPts: Point[];
  /** Width of the screenshot `shotRect` is measured in (the detection's `width`). */
  shotWidth: number;
}

const finitePoint = (p: unknown): p is Point =>
  Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * Cards in reading order: rows from the top (a card joins a row when its centre is within half a
 * card's height of the row's first card), each row from the left.
 */
function readingOrder<T extends { shape: OrientedBox; rect: Rect }>(cards: T[]): T[] {
  const rows: T[][] = [];
  for (const card of [...cards].sort((a, b) => a.shape.cy - b.shape.cy)) {
    const row = rows[rows.length - 1];
    if (row && card.shape.cy - row[0].shape.cy < Math.min(row[0].rect.h, card.rect.h) / 2) row.push(card);
    else rows.push([card]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.shape.cx - b.shape.cx));
}

/** A video showing at least this share of the viewport is what the user scans (live check m4). */
export const MAIN_VIDEO_SHARE = 0.25;

/** The part of `r` inside the viewport, as a share of the viewport's area. */
function viewportShare(r: Rect, viewport: { w: number; h: number }): number {
  const w = Math.min(r.x + r.w, viewport.w) - Math.max(r.x, 0);
  const h = Math.min(r.y + r.h, viewport.h) - Math.max(r.y, 0);
  return w > 0 && h > 0 ? (w * h) / (viewport.w * viewport.h) : 0;
}

const inside = (x: number, y: number, r: Rect) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * The outlines to draw for a detection, in reading order: face-up cards only (a face-down detection,
 * a pile or a sleeve, has no card to read; the detector's class is never an answer by itself). Boxes
 * without four usable corners or with no area are left out; a failed detection or an unknown
 * screenshot size gives none.
 * `videos`: the visible videos' pictures on the page (CSS px). When one shows MAIN_VIDEO_SHARE of the
 * viewport or more, only the cards whose centre is on such a video are kept: the page's thumbnails
 * and other card art around the player are not what the user scans (live check m4).
 */
export function outlinesFrom(detection: CardDetection, viewport: { w: number; h: number }, videos: Rect[] = []): CardOutline[] {
  const { width, height } = detection;
  if (!(width > 0 && height > 0) || !Array.isArray(detection.boxes)) return [];
  const sx = viewport.w / width;
  const sy = viewport.h / height;
  const main = videos.filter((v) => viewportShare(v, viewport) >= MAIN_VIDEO_SHARE);
  const cards: Omit<CardOutline, 'label'>[] = [];
  for (const box of detection.boxes) {
    if (box?.kind === 'face-down') continue;
    const pts = box?.pts;
    if (!Array.isArray(pts) || pts.length !== 4 || !pts.every(finitePoint)) continue;
    const points = pts.map(([x, y]): Point => [x * sx, y * sy]);
    const shape = orientedBox(points);
    const area = shape.w * shape.h;
    if (!(area > 0)) continue;
    if (main.length && !main.some((v) => inside(shape.cx, shape.cy, v))) continue;
    cards.push({ shape, rect: polygonBounds(points), area, shotRect: polygonBounds(pts), shotPts: pts.map(([x, y]): Point => [x, y]), shotWidth: width });
  }
  return readingOrder(cards).map((c, i, all) => ({ ...c, label: `Card ${i + 1} of ${all.length}` }));
}

/** Cards within this ratio of the smallest card's area under a click count as the same size. */
const SAME_SIZE = 1.1;

/**
 * How far (x, y) lies from the box's centre towards its edge, in the box's own axes: 0 at the centre,
 * 1 on the edge (the larger of the two axes' shares).
 */
function depth(x: number, y: number, box: OrientedBox): number {
  const dx = x - box.cx;
  const dy = y - box.cy;
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  return Math.max(Math.abs(dx * cos + dy * sin) / (box.w / 2), Math.abs(-dx * sin + dy * cos) / (box.h / 2));
}

/** WCAG 2.5.8 (a11y review M3): every card is a target of at least this many CSS px each way, however small it is drawn. */
export const MIN_TARGET = 24;

/** The card's box grown to its hit area: `pad` px around it, and at least MIN_TARGET px each way. */
const hitBox = (s: OrientedBox, pad: number): OrientedBox => ({
  ...s,
  w: Math.max(s.w + 2 * pad, MIN_TARGET),
  h: Math.max(s.h + 2 * pad, MIN_TARGET),
});

/**
 * Index of the card under (x, y) (CSS px), counting `pad` px around each card (its outline is drawn
 * that far out). Where cards overlap, the smallest wins (a card on a pile, the pile's box around
 * it); among cards of about the same size (an Xyz monster on its material, a fanned pair), the one
 * whose centre the click is nearest, for its size (review M4: not the detector's noise in their
 * areas). A card drawn smaller than MIN_TARGET px is also hit up to half that from its centre, but
 * only where no card's outline is (it never takes a click from a card under the pointer). Null when none.
 */
export function cardAt(cards: CardOutline[], x: number, y: number, pad = 0): number | null {
  return (
    nearest(cards, x, y, (card) => pointInBox(x, y, card.shape, pad)) ??
    nearest(cards, x, y, (card) => pointInBox(x, y, hitBox(card.shape, pad)))
  );
}

/** Among the cards `hit` takes, the one a click at (x, y) means (see cardAt). */
function nearest(cards: CardOutline[], x: number, y: number, hit: (card: CardOutline) => boolean): number | null {
  const hits = cards.map((card, i) => ({ card, i })).filter(({ card }) => hit(card));
  if (hits.length === 0) return null;
  const smallest = Math.min(...hits.map(({ card }) => card.area));
  let best: { i: number; depth: number } | null = null;
  for (const { card, i } of hits) {
    if (card.area > smallest * SAME_SIZE) continue;
    const d = depth(x, y, card.shape);
    if (best === null || d < best.depth) best = { i, depth: d };
  }
  return best!.i;
}
