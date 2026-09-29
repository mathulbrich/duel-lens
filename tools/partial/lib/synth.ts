// Synthetic partial cards from real footage: a real frame is cut so that a labelled card (or a
// non-card box) loses `fraction` of its extent on one `side` at the new frame's edge, the way a
// broadcast layout or the picture's edge cuts a card. The card keeps its tilt: the cut runs along the
// frame's axes through the card's axis-aligned extent (its labelled userBox, which hugs the card:
// tools/realset/README.md), so a tilted card loses a corner more than the rest, as on screen.
import { cropRGBA, type RGBAImage } from '../../../src/shared/preprocess';
import type { AxisBox } from '../../realset/lib/types';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right'];
export const FRACTIONS: readonly number[] = [0.25, 0.4, 0.55];

/** An integer window of a frame. */
export interface Window {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The window of a W×H frame that leaves `card` cut by `fraction` of its extent on `side` (the rest of
 * the frame kept whole), or null when nothing of the card would remain.
 */
export function cutWindow(W: number, H: number, card: AxisBox, side: Side, fraction: number): Window | null {
  let win: Window;
  switch (side) {
    case 'top': {
      const y0 = Math.max(0, Math.ceil(card.y + fraction * card.h));
      win = { x: 0, y: y0, w: W, h: H - y0 };
      break;
    }
    case 'bottom': {
      const y1 = Math.min(H, Math.floor(card.y + (1 - fraction) * card.h));
      win = { x: 0, y: 0, w: W, h: y1 };
      break;
    }
    case 'left': {
      const x0 = Math.max(0, Math.ceil(card.x + fraction * card.w));
      win = { x: x0, y: 0, w: W - x0, h: H };
      break;
    }
    case 'right': {
      const x1 = Math.min(W, Math.floor(card.x + (1 - fraction) * card.w));
      win = { x: 0, y: 0, w: x1, h: H };
      break;
    }
  }
  return win.w >= 8 && win.h >= 8 ? win : null;
}

/** `box` in the window's pixels, clipped to it: the part a user would draw around (up to the new edge). */
export function boxInWindow(box: AxisBox, win: Window): AxisBox | null {
  const x0 = Math.max(0, box.x - win.x);
  const y0 = Math.max(0, box.y - win.y);
  const x1 = Math.min(win.w, box.x + box.w - win.x);
  const y1 = Math.min(win.h, box.y + box.h - win.y);
  return x1 - x0 >= 2 && y1 - y0 >= 2 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function cutFrame(frame: RGBAImage, win: Window): RGBAImage {
  return cropRGBA(frame, win.x, win.y, win.w, win.h);
}
