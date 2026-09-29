// Geometry the partial-card experiments tried and the engine does not use (partial-report.md §3):
// completing a cut card's quad from the card's aspect and its whole side, and the share of the art box seen.
// Moved here from src/offscreen/truncation.ts once the measurements ruled them out of the engine.
import { ART_BOX, CARD_ASPECT } from '../../../src/shared/card-layout';
import type { Point, Quad } from '../../../src/offscreen/geometry';
import { inset, type MaskedWarp, type Side } from '../../../src/offscreen/truncation';

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
const len = (a: Point) => Math.hypot(a.x, a.y);

/**
 * The whole card, from the uncut part of a card cut by the picture's edge. `corners` are the card's
 * top-left, top-right, bottom-right and bottom-left (a portrait card: its first and third sides are the
 * short ones); a corner within `tol` px of one of `sides` (or beyond it) is cut. When the corners of
 * exactly one side of the card are cut and the opposite side is whole, that side's length gives the card's
 * other dimension (a card is CARD_ASPECT wide for its height), and the cut side is put back that far away,
 * parallel to it. `orientation` 'as-found' trusts which sides are short; 'turned' reads the card the other
 * way round (the uncut part of a card cut across its middle can look like a sideways card). Null when the
 * card isn't cut that way (no side cut, or more than one), or the completion would not reach past the part
 * that is seen.
 */
export function completeQuad(
  corners: Quad,
  width: number,
  height: number,
  sides: readonly Side[],
  tol: number,
  orientation: 'as-found' | 'turned' = 'as-found',
): Quad | null {
  const cut = corners.map((p) => sides.some((s) => inset(p, s, width, height) <= tol));
  const cutEdges = [0, 1, 2, 3].filter((k) => cut[k] && cut[(k + 1) % 4]);
  if (cutEdges.length !== 1) return null;
  const k = cutEdges[0];
  const [a, b] = [corners[k], corners[(k + 1) % 4]]; // the cut side
  const [c, d] = [corners[(k + 2) % 4], corners[(k + 3) % 4]]; // the whole side opposite: c is across from b, d from a
  if (cut[(k + 2) % 4] || cut[(k + 3) % 4]) return null;
  const whole = len(sub(c, d));
  if (!(whole > 2)) return null;
  // The first and third sides (0, 2) are the card's short ones in its own frame.
  const shortSide = k % 2 === 0;
  const across = (orientation === 'as-found') === shortSide ? whole / CARD_ASPECT : whole * CARD_ASPECT;
  // Towards the cut side along the card's sides: from d to a and from c to b, averaged.
  const dir = add(sub(a, d), sub(b, c));
  const n = len(dir);
  if (!(n > 1e-6)) return null;
  const u = scale(dir, 1 / n);
  // The part seen must fit: the cut side goes back no nearer than where the card is seen to end.
  const seen = Math.max(len(sub(a, d)), len(sub(b, c)));
  if (across < seen - tol) return null;
  const a2 = add(d, scale(u, across));
  const b2 = add(c, scale(u, across));
  const out = [...corners] as Quad;
  out[k] = a2;
  out[(k + 1) % 4] = b2;
  return out;
}

/** The share of the card's art box (ART_BOX) seen in a masked warp. */
export function artSeenShare(w: MaskedWarp): number {
  const { width: W, height: H } = w.image;
  const x0 = Math.round(ART_BOX.x * W);
  const x1 = Math.round((ART_BOX.x + ART_BOX.w) * W);
  const y0 = Math.round(ART_BOX.y * H);
  const y1 = Math.round((ART_BOX.y + ART_BOX.h) * H);
  let n = 0;
  let s = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) s += w.seen[y * W + x];
  return n ? s / n : 0;
}

