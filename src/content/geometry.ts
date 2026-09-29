// Pure geometry for the page UI: drag boxes, crop mapping and popover placement.
// All rects are { x, y, w, h }. "Viewport" means CSS pixels relative to the viewport.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PopoverSide = 'right' | 'left' | 'below' | 'above';

export interface Placement {
  x: number;
  y: number;
  side: PopoverSide;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/** The rect spanned by a drag from (x0, y0) to (x1, y1), in any direction. */
export function normalizeDrag(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Grow `r` by `frac` of its width/height on every side, then clip it to `bounds`. */
export function expandRect(r: Rect, frac: number, bounds: Rect): Rect {
  const dx = r.w * frac;
  const dy = r.h * frac;
  const left = clamp(r.x - dx, bounds.x, bounds.x + bounds.w);
  const top = clamp(r.y - dy, bounds.y, bounds.y + bounds.h);
  const right = clamp(r.x + r.w + dx, bounds.x, bounds.x + bounds.w);
  const bottom = clamp(r.y + r.h + dy, bounds.y, bounds.y + bounds.h);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

// ---------- turned boxes (the cards the detector finds) ----------

export type Point = [number, number];

/** A box turned `angle` radians clockwise on screen about its centre (y points down). */
export interface OrientedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

/** Whether (x, y) lies inside the turned box grown by `pad` on every side. */
export function pointInBox(x: number, y: number, box: OrientedBox, pad = 0): boolean {
  const dx = x - box.cx;
  const dy = y - box.cy;
  const cos = Math.cos(box.angle);
  const sin = Math.sin(box.angle);
  // The point in the box's own axes: along its width, then along its height.
  const u = dx * cos + dy * sin;
  const v = -dx * sin + dy * cos;
  return Math.abs(u) <= box.w / 2 + pad && Math.abs(v) <= box.h / 2 + pad;
}

/** The axis-aligned rect around the corners. */
export function polygonBounds(pts: Point[]): Rect {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Centre, size and rotation of a box from its four corners, taken in order around the box:
 * w runs from the first corner to the second, h from the first to the fourth. Any starting
 * corner or direction describes the same box on screen.
 */
export function orientedBox(pts: Point[]): OrientedBox {
  const [p0, p1, , p3] = pts;
  return {
    cx: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    cy: pts.reduce((s, p) => s + p[1], 0) / pts.length,
    w: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
    h: Math.hypot(p3[0] - p0[0], p3[1] - p0[1]),
    angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]),
  };
}

/**
 * Map a viewport rect onto the captureVisibleTab bitmap. The scale is
 * bitmap width / viewport width, which covers devicePixelRatio and page zoom alike.
 */
export function viewportToBitmap(r: Rect, bitmapWidth: number, viewportWidth: number): Rect {
  const s = bitmapWidth / viewportWidth;
  return { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s };
}

/**
 * Where the video picture actually sits inside the element (viewport coordinates),
 * following CSS object-fit with the default centred object-position.
 * An empty value is treated as `contain`, the user-agent default for <video>.
 */
export function videoContentBox(elementRect: Rect, videoWidth: number, videoHeight: number, objectFit: string): Rect {
  const e = elementRect;
  const widthLimited = e.w / videoWidth <= e.h / videoHeight;
  // Size the fitted side from the element directly so it matches exactly (no float drift).
  const fitWidth = () => ({ w: e.w, h: (e.w * videoHeight) / videoWidth });
  const fitHeight = () => ({ w: (e.h * videoWidth) / videoHeight, h: e.h });
  let size: { w: number; h: number };
  switch (objectFit) {
    case 'fill':
      return { ...e };
    case 'cover':
      size = widthLimited ? fitHeight() : fitWidth();
      break;
    case 'none':
      size = { w: videoWidth, h: videoHeight };
      break;
    case 'scale-down':
      size =
        videoWidth <= e.w && videoHeight <= e.h
          ? { w: videoWidth, h: videoHeight }
          : widthLimited
            ? fitWidth()
            : fitHeight();
      break;
    default: // contain
      size = widthLimited ? fitWidth() : fitHeight();
  }
  return { x: e.x + (e.w - size.w) / 2, y: e.y + (e.h - size.h) / 2, w: size.w, h: size.h };
}

/**
 * Map a viewport rect into native video pixels through the content box.
 * Returns null when the centre of `r` is outside the picture (e.g. in a black bar).
 * The result is not clipped; the crop step clips it to the frame.
 */
export function viewportToVideo(r: Rect, contentBox: Rect, videoWidth: number, videoHeight: number): Rect | null {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const b = contentBox;
  if (cx < b.x || cx > b.x + b.w || cy < b.y || cy > b.y + b.h) return null;
  const sx = videoWidth / b.w;
  const sy = videoHeight / b.h;
  return { x: (r.x - b.x) * sx, y: (r.y - b.y) * sy, w: r.w * sx, h: r.h * sy };
}

/**
 * Place a popover of `size` next to `anchor`: right if it fits, else left, else below,
 * else above. When no side fits, it uses the side with the most room. The result is
 * always clamped inside the viewport (minus `margin`).
 */
export function placePopover(
  anchor: Rect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  gap = 12,
  margin = 8,
): Placement {
  const room: Record<PopoverSide, number> = {
    right: viewport.w - margin - (anchor.x + anchor.w + gap),
    left: anchor.x - gap - margin,
    below: viewport.h - margin - (anchor.y + anchor.h + gap),
    above: anchor.y - gap - margin,
  };
  const need: Record<PopoverSide, number> = { right: size.w, left: size.w, below: size.h, above: size.h };
  const order: PopoverSide[] = ['right', 'left', 'below', 'above'];
  let side = order.find((s) => room[s] >= need[s]);
  if (!side) side = order.reduce((best, s) => (room[s] > room[best] ? s : best), order[0]);

  const maxX = viewport.w - size.w - margin;
  const maxY = viewport.h - size.h - margin;
  const centreX = clamp(anchor.x + anchor.w / 2 - size.w / 2, margin, maxX);
  const centreY = clamp(anchor.y + anchor.h / 2 - size.h / 2, margin, maxY);
  switch (side) {
    case 'right':
      return { x: clamp(anchor.x + anchor.w + gap, margin, maxX), y: centreY, side };
    case 'left':
      return { x: clamp(anchor.x - gap - size.w, margin, maxX), y: centreY, side };
    case 'below':
      return { x: centreX, y: clamp(anchor.y + anchor.h + gap, margin, maxY), side };
    case 'above':
      return { x: centreX, y: clamp(anchor.y - gap - size.h, margin, maxY), side };
  }
}

/**
 * Offset of the popover's pointer arrow along its edge, aimed at the anchor's centre and
 * kept `inset` px away from the rounded corners.
 */
export function arrowOffset(anchor: Rect, placement: Placement, size: { w: number; h: number }, inset = 18): number {
  if (placement.side === 'right' || placement.side === 'left') {
    return clamp(anchor.y + anchor.h / 2 - placement.y, inset, size.h - inset);
  }
  return clamp(anchor.x + anchor.w / 2 - placement.x, inset, size.w - inset);
}
