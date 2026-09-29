import { describe, expect, it } from 'vitest';
import {
  arrowOffset,
  expandRect,
  normalizeDrag,
  orientedBox,
  placePopover,
  pointInBox,
  polygonBounds,
  videoContentBox,
  viewportToBitmap,
  viewportToVideo,
  type Point,
} from './geometry';

// A card-shaped 10x20 box centred on the origin, turned atan2(3, 4) ≈ 36.87° clockwise on screen
// (cos 0.8, sin 0.6), corners worked out by hand: top-left, top-right, bottom-right, bottom-left.
const TILTED: Point[] = [
  [2, -11],
  [10, -5],
  [-2, 11],
  [-10, 5],
];
// A 100x100 square turned 45°: a diamond centred on (100, 100).
const DIAMOND: Point[] = [
  [100, 50],
  [150, 100],
  [100, 150],
  [50, 100],
];
const TILTED_BOX = { cx: 0, cy: 0, w: 10, h: 20, angle: Math.atan2(3, 4) };
const DIAMOND_BOX = { cx: 100, cy: 100, w: Math.SQRT2 * 50, h: Math.SQRT2 * 50, angle: Math.PI / 4 };

describe('pointInBox', () => {
  it('is true inside a turned box and false in the corners of its bounding box', () => {
    expect(pointInBox(1, 2, TILTED_BOX)).toBe(true);
    expect(pointInBox(0, 0, TILTED_BOX)).toBe(true);
    // (9, 9) is inside the axis-aligned bounds (-10..10, -11..11) but outside the turned box.
    expect(pointInBox(9, 9, TILTED_BOX)).toBe(false);
    expect(pointInBox(-9, -9, TILTED_BOX)).toBe(false);
  });

  it('follows a diamond exactly', () => {
    expect(pointInBox(120, 110, DIAMOND_BOX)).toBe(true); // |20| + |10| < 50
    expect(pointInBox(140, 60, DIAMOND_BOX)).toBe(false); // |40| + |40| > 50
    expect(pointInBox(300, 100, DIAMOND_BOX)).toBe(false);
  });

  it('grows the box by `pad` on every side (the outline is drawn just outside the card)', () => {
    // 6 px from the centre along the box's width axis (cos 0.8, sin 0.6): 1 px beyond its edge.
    expect(pointInBox(4.8, 3.6, TILTED_BOX)).toBe(false);
    expect(pointInBox(4.8, 3.6, TILTED_BOX, 0.5)).toBe(false);
    expect(pointInBox(4.8, 3.6, TILTED_BOX, 3)).toBe(true);
    // And along its height axis (-sin, cos): 12 px out is 2 px beyond the edge.
    expect(pointInBox(-7.2, 9.6, TILTED_BOX, 1)).toBe(false);
    expect(pointInBox(-7.2, 9.6, TILTED_BOX, 3)).toBe(true);
  });
});

describe('polygonBounds', () => {
  it('is the axis-aligned rect around the corners', () => {
    expect(polygonBounds(TILTED)).toEqual({ x: -10, y: -11, w: 20, h: 22 });
    expect(polygonBounds(DIAMOND)).toEqual({ x: 50, y: 50, w: 100, h: 100 });
  });
});

describe('orientedBox', () => {
  it('recovers centre, size and clockwise angle from the corners', () => {
    const b = orientedBox(TILTED);
    expect(b.cx).toBeCloseTo(0, 9);
    expect(b.cy).toBeCloseTo(0, 9);
    expect(b.w).toBeCloseTo(10, 9);
    expect(b.h).toBeCloseTo(20, 9);
    expect(b.angle).toBeCloseTo(Math.atan2(3, 4), 9);
  });

  it('reads a sideways card (the detector keeps w ≤ h and turns it a quarter)', () => {
    // A 60x100 box centred on (200, 120), turned 90° clockwise: corners by hand.
    const b = orientedBox([
      [250, 90],
      [250, 150],
      [150, 150],
      [150, 90],
    ]);
    expect(b).toEqual({ cx: 200, cy: 120, w: 60, h: 100, angle: Math.PI / 2 });
  });
});

describe('normalizeDrag', () => {
  it('turns a drag up and to the left into a positive rect', () => {
    expect(normalizeDrag(100, 50, 40, 20)).toEqual({ x: 40, y: 20, w: 60, h: 30 });
  });

  it('keeps a drag down and to the right as is', () => {
    expect(normalizeDrag(10, 10, 30, 50)).toEqual({ x: 10, y: 10, w: 20, h: 40 });
  });
});

describe('expandRect', () => {
  const big = { x: 0, y: 0, w: 1000, h: 1000 };

  it('adds the fraction of each dimension on every side', () => {
    expect(expandRect({ x: 100, y: 100, w: 50, h: 100 }, 0.04, big)).toEqual({ x: 98, y: 96, w: 54, h: 108 });
  });

  it('clamps the margin at the top-left edge of the bounds', () => {
    expect(expandRect({ x: 1, y: 2, w: 50, h: 100 }, 0.04, big)).toEqual({ x: 0, y: 0, w: 53, h: 106 });
  });

  it('clamps the margin at the bottom-right edge of the bounds', () => {
    const bounds = { x: 0, y: 0, w: 200, h: 200 };
    expect(expandRect({ x: 180, y: 150, w: 20, h: 50 }, 0.1, bounds)).toEqual({ x: 178, y: 145, w: 22, h: 55 });
  });

  it('gives an empty rect when the rect lies outside the bounds', () => {
    const r = expandRect({ x: 500, y: 500, w: 10, h: 10 }, 0.04, { x: 0, y: 0, w: 100, h: 100 });
    expect(r.w).toBe(0);
    expect(r.h).toBe(0);
  });
});

describe('viewportToBitmap', () => {
  it('maps CSS pixels to device pixels at devicePixelRatio 2', () => {
    // 1280 CSS px wide viewport captured as a 2560 px bitmap.
    expect(viewportToBitmap({ x: 100, y: 50, w: 40, h: 60 }, 2560, 1280)).toEqual({ x: 200, y: 100, w: 80, h: 120 });
  });

  it('covers page zoom too (125% zoom at DPR 1: 1024 CSS px in a 1280 px bitmap)', () => {
    expect(viewportToBitmap({ x: 100, y: 50, w: 40, h: 60 }, 1280, 1024)).toEqual({ x: 125, y: 62.5, w: 50, h: 75 });
  });
});

describe('videoContentBox', () => {
  it('letterboxes a 16:9 video in a taller element with contain', () => {
    expect(videoContentBox({ x: 0, y: 0, w: 1000, h: 800 }, 1920, 1080, 'contain')).toEqual({
      x: 0,
      y: 118.75,
      w: 1000,
      h: 562.5,
    });
  });

  it('offsets the content box by the element position', () => {
    expect(videoContentBox({ x: 50, y: 20, w: 1000, h: 800 }, 1920, 1080, 'contain')).toEqual({
      x: 50,
      y: 138.75,
      w: 1000,
      h: 562.5,
    });
  });

  it('pillarboxes a 4:3 video in a wide element with contain', () => {
    expect(videoContentBox({ x: 0, y: 0, w: 1000, h: 450 }, 800, 600, 'contain')).toEqual({
      x: 200,
      y: 0,
      w: 600,
      h: 450,
    });
  });

  it('treats an empty object-fit as contain (the video default)', () => {
    expect(videoContentBox({ x: 0, y: 0, w: 1000, h: 450 }, 800, 600, '')).toEqual({ x: 200, y: 0, w: 600, h: 450 });
  });

  it('overflows the element with cover', () => {
    expect(videoContentBox({ x: 0, y: 0, w: 400, h: 400 }, 1000, 500, 'cover')).toEqual({
      x: -200,
      y: 0,
      w: 800,
      h: 400,
    });
  });

  it('stretches to the element with fill', () => {
    expect(videoContentBox({ x: 10, y: 20, w: 300, h: 200 }, 1920, 1080, 'fill')).toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 200,
    });
  });

  it('centres the natural size with none', () => {
    expect(videoContentBox({ x: 0, y: 0, w: 400, h: 400 }, 200, 100, 'none')).toEqual({ x: 100, y: 150, w: 200, h: 100 });
  });

  it('uses the smaller of none and contain with scale-down', () => {
    expect(videoContentBox({ x: 0, y: 0, w: 400, h: 400 }, 200, 100, 'scale-down')).toEqual({
      x: 100,
      y: 150,
      w: 200,
      h: 100,
    });
    expect(videoContentBox({ x: 0, y: 0, w: 1000, h: 800 }, 1920, 1080, 'scale-down')).toEqual({
      x: 0,
      y: 118.75,
      w: 1000,
      h: 562.5,
    });
  });
});

describe('viewportToVideo', () => {
  // 1920x1080 video letterboxed in a 1000x800 element: 1.92 video px per CSS px.
  const box = { x: 0, y: 118.75, w: 1000, h: 562.5 };

  it('maps a rect over the picture to native video pixels', () => {
    expect(viewportToVideo({ x: 100, y: 218.75, w: 50, h: 75 }, box, 1920, 1080)).toEqual({ x: 192, y: 192, w: 96, h: 144 });
  });

  it('returns null for a rect in the black bar', () => {
    expect(viewportToVideo({ x: 100, y: 20, w: 50, h: 60 }, box, 1920, 1080)).toBeNull();
  });

  it('keeps the part of a rect that spills past the picture (the crop clamps it later)', () => {
    expect(viewportToVideo({ x: 0, y: 100, w: 100, h: 100 }, box, 1920, 1080)).toEqual({ x: 0, y: -36, w: 192, h: 192 });
  });
});

describe('placePopover', () => {
  const vp = { w: 1280, h: 720 };
  const size = { w: 372, h: 400 };

  it('goes right of the box when there is room, centred on it vertically', () => {
    expect(placePopover({ x: 100, y: 200, w: 100, h: 150 }, size, vp)).toEqual({ x: 212, y: 75, side: 'right' });
  });

  it('goes left when the right side is too narrow', () => {
    expect(placePopover({ x: 1000, y: 200, w: 100, h: 150 }, size, vp)).toEqual({ x: 616, y: 75, side: 'left' });
  });

  it('goes below when neither side fits', () => {
    expect(placePopover({ x: 300, y: 50, w: 700, h: 100 }, size, vp)).toEqual({ x: 464, y: 162, side: 'below' });
  });

  it('goes above when below does not fit either', () => {
    expect(placePopover({ x: 300, y: 500, w: 700, h: 150 }, size, vp)).toEqual({ x: 464, y: 88, side: 'above' });
  });

  it('clamps vertically inside the viewport', () => {
    expect(placePopover({ x: 100, y: 600, w: 100, h: 100 }, size, vp)).toEqual({ x: 212, y: 312, side: 'right' });
  });

  it('uses the roomiest side and clamps inside the viewport when nothing fits', () => {
    const r = placePopover({ x: 200, y: 100, w: 700, h: 500 }, size, { w: 1000, h: 700 });
    expect(r).toEqual({ x: 8, y: 150, side: 'left' });
  });

  it('stays inside the viewport for a full-screen box', () => {
    const r = placePopover({ x: 0, y: 0, w: 1280, h: 720 }, size, vp);
    expect(r.x).toBeGreaterThanOrEqual(8);
    expect(r.x + size.w).toBeLessThanOrEqual(1280 - 8);
    expect(r.y).toBeGreaterThanOrEqual(8);
    expect(r.y + size.h).toBeLessThanOrEqual(720 - 8);
  });

  it('pins a popover taller than the viewport to the top margin', () => {
    expect(placePopover({ x: 100, y: 200, w: 100, h: 150 }, { w: 372, h: 800 }, vp).y).toBe(8);
  });
});

describe('arrowOffset', () => {
  it('points at the vertical centre of the box for side placements', () => {
    // Box centre y = 275; popover top 75 -> 200 px down the popover.
    expect(arrowOffset({ x: 100, y: 200, w: 100, h: 150 }, { x: 212, y: 75, side: 'right' }, { w: 372, h: 400 })).toBe(200);
  });

  it('points at the horizontal centre of the box for below/above placements', () => {
    // Box centre x = 650; popover left 464 -> 186 px along the popover.
    expect(arrowOffset({ x: 300, y: 50, w: 700, h: 100 }, { x: 464, y: 162, side: 'below' }, { w: 372, h: 400 })).toBe(186);
  });

  it('keeps the arrow off the rounded corners', () => {
    expect(arrowOffset({ x: 100, y: 690, w: 20, h: 20 }, { x: 132, y: 312, side: 'right' }, { w: 372, h: 400 })).toBe(382);
    expect(arrowOffset({ x: 100, y: 0, w: 20, h: 4 }, { x: 132, y: 8, side: 'right' }, { w: 372, h: 400 })).toBe(18);
  });
});
