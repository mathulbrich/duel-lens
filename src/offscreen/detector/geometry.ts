// Oriented-box geometry for the card detector, in its own [x, y] tuples: a thin layer over the
// extension's clean-room geometry (src/offscreen/geometry.ts), which does the maths (a box's corners,
// shoelace areas, Sutherland–Hodgman clipping). tools/train-detector/targets.py has the same maths.
import { boxCorners as boxCornerPoints, clipToConvex, polygonArea as pointsArea, polygonIou, type Point } from '../geometry';

export type Pt = [number, number];

const point = ([x, y]: Pt): Point => ({ x, y });
const tuple = (p: Point): Pt => [p.x, p.y];

/**
 * Corners of a w×h box centred on (cx, cy) turned `angle` radians clockwise on screen (y down),
 * clockwise from the box's own top-left (geometry.ts's boxCorners).
 */
export function boxCorners(cx: number, cy: number, w: number, h: number, angle: number): Pt[] {
  return boxCornerPoints(cx, cy, w, h, angle).map(tuple);
}

/** Shoelace area (absolute). */
export function polygonArea(p: readonly Pt[]): number {
  return pointsArea(p.map(point));
}

/** The part of polygon `subject` inside convex polygon `clip` (either winding). */
export function clipConvex(subject: readonly Pt[], clip: readonly Pt[]): Pt[] {
  return clipToConvex(subject.map(point), clip.map(point)).map(tuple);
}

/** Intersection over union of two convex polygons. */
export function polygonIoU(a: readonly Pt[], b: readonly Pt[]): number {
  return polygonIou(a.map(point), b.map(point));
}

/** The share of convex polygon `a`'s area inside convex polygon `b`. */
export function insideShare(a: readonly Pt[], b: readonly Pt[]): number {
  return polygonArea(clipConvex(a, b)) / Math.max(1e-9, polygonArea(a));
}

/** An angle modulo π, in (−π/2, π/2]: a card's outline is the same turned 180°. */
export function wrapHalfTurn(a: number): number {
  let x = a % Math.PI;
  if (x <= -Math.PI / 2) x += Math.PI;
  if (x > Math.PI / 2) x -= Math.PI;
  return x;
}
