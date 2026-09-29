import { describe, expect, it } from 'vitest';
import { boxCorners, clipConvex, insideShare, polygonArea, polygonIoU, wrapHalfTurn, type Pt } from './geometry';

const rect = (x: number, y: number, w: number, h: number): Pt[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

describe('boxCorners', () => {
  it('goes clockwise from the top-left, turned clockwise on screen (src/offscreen/geometry.ts)', () => {
    expect(boxCorners(10, 20, 4, 6, 0)).toEqual([
      [8, 17],
      [12, 17],
      [12, 23],
      [8, 23],
    ]);
    // a quarter turn clockwise: the box's top edge now faces +x (right)
    const q = boxCorners(0, 0, 4, 6, Math.PI / 2).map(([x, y]) => [Math.round(x), Math.round(y)]);
    expect(q).toEqual([
      [3, -2],
      [3, 2],
      [-3, 2],
      [-3, -2],
    ]);
  });
});

describe('polygonIoU', () => {
  it('is 1 for identical polygons (coincident edges) and 0 for disjoint ones', () => {
    const a = boxCorners(50, 50, 30, 44, 0.3);
    expect(polygonIoU(a, a)).toBeCloseTo(1, 9);
    expect(polygonIoU(rect(0, 0, 10, 10), rect(20, 0, 10, 10))).toBe(0);
  });

  it('measures partial overlap, whatever the winding', () => {
    expect(polygonIoU(rect(0, 0, 30, 40), rect(15, 0, 30, 40))).toBeCloseTo(1 / 3, 9);
    expect(polygonIoU(rect(0, 0, 30, 40), [...rect(15, 0, 30, 40)].reverse())).toBeCloseTo(1 / 3, 9);
  });

  it('handles rotated boxes: a square and itself turned 45 degrees', () => {
    const sq = boxCorners(0, 0, 2, 2, 0);
    const diamond = boxCorners(0, 0, 2, 2, Math.PI / 4);
    // the intersection is a regular octagon of area 8(sqrt2 - 1)
    const inter = 8 * (Math.SQRT2 - 1);
    expect(polygonArea(clipConvex(sq, diamond))).toBeCloseTo(inter, 9);
    expect(polygonIoU(sq, diamond)).toBeCloseTo(inter / (8 - inter), 9);
  });

  it('insideShare is the share of the first polygon inside the second', () => {
    expect(insideShare(rect(0, 0, 10, 10), rect(5, 0, 100, 100))).toBeCloseTo(0.5, 9);
    expect(insideShare(rect(5, 5, 2, 2), rect(0, 0, 10, 10))).toBe(1);
  });
});

describe('wrapHalfTurn', () => {
  it('maps any angle into (-pi/2, pi/2], modulo pi', () => {
    expect(wrapHalfTurn(0)).toBe(0);
    expect(wrapHalfTurn(Math.PI)).toBeCloseTo(0, 12);
    expect(wrapHalfTurn(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapHalfTurn(-Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(wrapHalfTurn(3.5 * Math.PI)).toBeCloseTo(Math.PI / 2, 9);
    expect(wrapHalfTurn(-0.25 - 2 * Math.PI)).toBeCloseTo(-0.25, 9);
  });
});
