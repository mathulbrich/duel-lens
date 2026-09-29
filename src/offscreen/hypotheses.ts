// Art-crop hypotheses: the candidate artwork images cut from one selection (spec §3.3).
// Each is embedded and searched; the best-scoring one wins.
import { ART_BOX, CARD_ASPECT, type CardBox } from '../shared/card-layout';
import { cropRGBA, rotate180, rotate90, type RGBAImage } from '../shared/preprocess';
import type { Rotation } from '../shared/types';

export interface Hypothesis {
  /**
   * quad: art box of the detected, straightened card. whole: the user's box treated as a
   * whole card (its art box). fit: the largest card-shaped rectangle centred in a box that is
   * not card-shaped (its art box). art: the user's box treated as the artwork (centre square).
   */
  id: 'quad' | 'whole' | 'fit' | 'art';
  /**
   * Clockwise degrees the source was turned before cutting. For `quad` it is relative
   * to the straightened card (the engine adds the card's own turn from the selection:
   * StraightenedCard.rotation); otherwise to the selection.
   */
  rotation: Rotation;
  image: RGBAImage;
}

/**
 * The margin (per side, as a fraction of the box) the content script adds around the user's
 * box. Only a fallback: the margin is clipped at the frame's edges, so crop.inner is used
 * whenever the crop carries it.
 */
export const SELECTION_MARGIN = 0.04;
/** How far a selection's aspect ratio may be from CARD_ASPECT and still count as a card. */
export const CARD_ASPECT_TOLERANCE = 0.12;

/** A rectangle in pixels (may be fractional until rounded). */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Round to whole pixels inside a width×height image, keeping at least one pixel. */
function toPixels(r: Rect, width: number, height: number): Rect {
  const span = (start: number, size: number, limit: number): [number, number] => {
    const a = Math.min(limit - 1, Math.max(0, Math.round(start)));
    const b = Math.min(limit, Math.max(a + 1, Math.round(start + size)));
    return [a, b];
  };
  const [x0, x1] = span(r.x, r.w, width);
  const [y0, y1] = span(r.y, r.h, height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The pixels of `rect` in the image turned `rotation` degrees clockwise. Cuts first and
 * turns only the cut-out, which is much cheaper than turning the whole image.
 */
function cropRotated(img: RGBAImage, rotation: Rotation, rect: Rect): RGBAImage {
  const { width: W, height: H } = img;
  const r = rect;
  switch (rotation) {
    case 0:
      return cropRGBA(img, r.x, r.y, r.w, r.h);
    case 180:
      return rotate180(cropRGBA(img, W - r.x - r.w, H - r.y - r.h, r.w, r.h));
    case 90: // turned (u, v) comes from (v, H - 1 - u)
      return rotate90(cropRGBA(img, r.y, H - r.x - r.w, r.h, r.w), 'cw');
    case 270: // turned (u, v) comes from (W - 1 - v, u)
      return rotate90(cropRGBA(img, W - r.y - r.h, r.x, r.h, r.w), 'ccw');
  }
}

/** Size of the image once turned by `rotation`. */
const turnedSize = (img: RGBAImage, rotation: Rotation) =>
  rotation === 90 || rotation === 270 ? { w: img.height, h: img.width } : { w: img.width, h: img.height };

/** `r` (a rectangle of a W×H image) where it lies once the image is turned `rotation`° clockwise. */
function turnRect(r: Rect, W: number, H: number, rotation: Rotation): Rect {
  switch (rotation) {
    case 0:
      return r;
    case 180:
      return { x: W - r.x - r.w, y: H - r.y - r.h, w: r.w, h: r.h };
    case 90: // (x, y) goes to (H - 1 - y, x)
      return { x: H - r.y - r.h, y: r.x, w: r.h, h: r.w };
    case 270: // (x, y) goes to (y, W - 1 - x)
      return { x: r.y, y: W - r.x - r.w, w: r.h, h: r.w };
  }
}

/**
 * The user's box inside the selection: `inner` (crop.inner) clipped to the image when it is
 * usable, otherwise the selection minus the content script's nominal margin.
 */
export function userBox(sel: RGBAImage, inner?: Rect | null): Rect {
  if (inner && [inner.x, inner.y, inner.w, inner.h].every(Number.isFinite)) {
    const x0 = Math.max(0, inner.x);
    const y0 = Math.max(0, inner.y);
    const x1 = Math.min(sel.width, inner.x + inner.w);
    const y1 = Math.min(sel.height, inner.y + inner.h);
    if (x1 - x0 >= 1 && y1 - y0 >= 1) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const t = SELECTION_MARGIN / (1 + 2 * SELECTION_MARGIN);
  return { x: sel.width * t, y: sel.height * t, w: sel.width * (1 - 2 * t), h: sel.height * (1 - 2 * t) };
}

/** Cut `box` (fractions of a card) from `card` (a pixel rectangle of the image turned by `rotation`). */
function cutBox(img: RGBAImage, rotation: Rotation, card: Rect, box: CardBox): RGBAImage {
  const { w, h } = turnedSize(img, rotation);
  const rect = { x: card.x + box.x * card.w, y: card.y + box.y * card.h, w: box.w * card.w, h: box.h * card.h };
  return cropRotated(img, rotation, toPixels(rect, w, h));
}

/**
 * The largest card-shaped rectangle centred in `box`: upright (portrait) or lying sideways
 * (landscape, for a card in defense position).
 */
function fitCard(box: Rect, orientation: 'portrait' | 'landscape'): Rect {
  const aspect = orientation === 'portrait' ? CARD_ASPECT : 1 / CARD_ASPECT; // width / height
  const w = Math.min(box.w, box.h * aspect);
  const h = w / aspect;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/**
 * Which way a card most likely lies in a box that isn't card-shaped: a tilted card's bounding
 * box is wider than the card, so a taller box holds an upright card, a wider one a sideways card,
 * and a near-square one (a strong tilt, or a loose drag) either.
 */
function fitOrientations(box: Rect): ('portrait' | 'landscape')[] {
  const aspect = box.w / box.h;
  if (aspect < 0.9) return ['portrait'];
  if (aspect > 1.1) return ['landscape'];
  return ['portrait', 'landscape'];
}

function boxShape(box: Rect): 'portrait-card' | 'landscape-card' | 'other' {
  const near = (aspect: number) => Math.abs(aspect - CARD_ASPECT) <= CARD_ASPECT_TOLERANCE;
  if (near(box.w / box.h)) return 'portrait-card';
  if (near(box.h / box.w)) return 'landscape-card';
  return 'other';
}

export interface HypothesisOptions {
  /**
   * Whether a card-shaped box with no card found in it is also read as the artwork alone (H3; default
   * true). The engine turns it off once the card detector has looked at the crop and found no card
   * there: such a box most likely holds a sleeve, a pile or the mat, whose own art is exactly what
   * that reading would match (an art-sleeved deck pile read confidently as a card: a4-report.md). It
   * is read as a whole card then (H2), as a card-shaped box always is.
   */
  artOfCardShapedBox?: boolean;
  /**
   * Whether the user's box is read too (H2, H2', H3) when a card was straightened (default true). The
   * engine turns it off when the card detector picked a face-up card: the box's own crops read that
   * card less well and only add competing scores, each at the cost of an embedding run (on the real
   * set, 115 confident answers instead of 114, and an empty zone no longer read as a card back). It
   * keeps it for a face-down pick, which may be a false detection inside an artwork the user boxed:
   * alone, its straightened view read one such box confidently as the card back (a4-report.md).
   */
  userBoxWithCard?: boolean;
}

/**
 * Candidate artwork crops (spec §3.3) for a selection and, if one was found, the
 * straightened card (590×860 portrait; several views of it, straightened from its corners and
 * from its box, each give their own crops):
 * - H1 `quad`: the card's art box, when a card was detected.
 * - H2 `whole`: the user's box as a whole card, when it has a card's shape (sideways boxes
 *   are turned both ways, for defense position).
 * - H2' `fit`: when the box isn't card-shaped (a tilted card's bounding box is wider than the
 *   card; a loose drag), the largest card-shaped rectangle centred in it, as a whole card. On
 *   a real 5°-tilted card this lifted the right card from 0.65 (below the floor) to 0.80.
 * - H3 `art`: the centre square of the user's box, for boxes that are not card-shaped, and for
 *   a card-shaped box when no card was detected (unless `artOfCardShapedBox` is false).
 * Every crop is also tried upside down, since the opponent's cards face the other way.
 * That is at most eight crops (a near-square box: the centre square plus fits both ways),
 * plus two per straightened view (or those alone, with `userBoxWithCard` false).
 *
 * `inner` is the user's box inside the selection, in selection pixels (crop.inner).
 */
export function buildHypotheses(
  selection: RGBAImage,
  warped?: RGBAImage | readonly RGBAImage[] | null,
  inner?: Rect | null,
  opts: HypothesisOptions = {},
): Hypothesis[] {
  if (selection.width < 1 || selection.height < 1) throw new Error('Cannot build hypotheses from an empty selection');
  const { width: W, height: H } = selection;
  const out: Hypothesis[] = [];

  const cards = (warped ? (Array.isArray(warped) ? warped : [warped]) : []).filter((c: RGBAImage) => c.width > 0 && c.height > 0);
  const quad = cards.length > 0;
  for (const rotation of [0, 180] as const) {
    for (const warpedCard of cards) {
      const card = { x: 0, y: 0, w: warpedCard.width, h: warpedCard.height };
      out.push({ id: 'quad', rotation, image: cutBox(warpedCard, rotation, card, ART_BOX) });
    }
  }

  if (quad && opts.userBoxWithCard === false) return out;
  const box = userBox(selection, inner);
  const shape = boxShape(box);
  if (shape !== 'other') {
    for (const rotation of shape === 'portrait-card' ? ([0, 180] as const) : ([90, 270] as const)) {
      out.push({ id: 'whole', rotation, image: cutBox(selection, rotation, turnRect(box, W, H, rotation), ART_BOX) });
    }
  } else {
    for (const orientation of fitOrientations(box)) {
      const fit = fitCard(box, orientation);
      for (const rotation of orientation === 'portrait' ? ([0, 180] as const) : ([90, 270] as const)) {
        out.push({ id: 'fit', rotation, image: cutBox(selection, rotation, turnRect(fit, W, H, rotation), ART_BOX) });
      }
    }
  }
  if ((!quad && opts.artOfCardShapedBox !== false) || shape === 'other') {
    for (const rotation of [0, 180] as const) {
      const b = turnRect(box, W, H, rotation);
      const side = Math.min(b.w, b.h);
      const square = { x: b.x + (b.w - side) / 2, y: b.y + (b.h - side) / 2, w: side, h: side };
      out.push({ id: 'art', rotation, image: cropRotated(selection, rotation, toPixels(square, W, H)) });
    }
  }
  return out;
}
