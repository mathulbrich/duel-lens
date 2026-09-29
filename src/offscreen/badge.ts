// A simulator's pile-count badge over a card's art (diag-t950-report.md): DuelingBook draws the size of a pile
// (the GY, the banished cards) as a big white number over the art of its top card. The matcher has never
// learned to look past it: a white "1" over the art's centre costs about 0.2 of the right card's score (Kewl
// Tune Reco reads 0.733, under the floor; 0.918 with the "1" painted out). The engine looks for such a badge in
// a straightened card only when nothing else matched (engine.ts, BADGE_READING), paints it out and reads again.
// Ported from the t950 prototype (tools/diag-t950/lib-badge.ts), whose settings these are.
import type { RGBAImage } from '../shared/preprocess';

export const BADGE = {
  /** A badge's pixels are near-white: every channel at least this... */
  white: 190,
  /** ...and unsaturated: the channels within this of each other. */
  chroma: 45,
  /** Each digit is this tall (a share of the card's height)... */
  hMin: 0.13,
  hMax: 0.26,
  /** ...this wide (a share of its width)... */
  wMin: 0.04,
  wMax: 0.28,
  /** ...and a stroke: its pixels fill this share of its bounding box (not a speck of glare, not a white block). */
  fillMin: 0.25,
  fillMax: 0.8,
  /** Its centre lies in this central window of the card (shares of its width and height)... */
  cx: [0.25, 0.75] as const,
  cy: [0.33, 0.67] as const,
  /** ...and every digit of the number shares the top and height of the tallest within this (a share of the card's height). */
  align: 0.04,
  /** The mask reaches this far past the digits (a share of the card's width): their anti-aliased edge goes too. */
  grow: 0.025,
};

/** One digit: its bounding box (shares of the card), its area in pixels and how much of its box it fills. */
export interface Glyph {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  fill: number;
}

export interface Badge {
  /** 1 where the badge is (the digits, grown by BADGE.grow): what inpaint() paints out. */
  mask: Uint8Array;
  glyphs: Glyph[];
}

/**
 * The count badge in a straightened card (upright or upside down: the badge is at its centre either way), or
 * null. Only the card's middle is searched (x 0.1–0.9, y 0.2–0.8): its frame, name and text box can't hold one.
 */
export function findBadge(card: RGBAImage): Badge | null {
  const { width: W, height: H, data } = card;
  const white = new Uint8Array(W * H);
  const x0 = Math.floor(0.1 * W);
  const x1 = Math.ceil(0.9 * W);
  const y0 = Math.floor(0.2 * H);
  const y1 = Math.ceil(0.8 * H);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      const mn = Math.min(data[i], data[i + 1], data[i + 2]);
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      if (mn >= BADGE.white && mx - mn <= BADGE.chroma) white[y * W + x] = 1;
    }
  }
  // The white pixels' connected parts (8-neighbours).
  const seen = new Uint8Array(W * H);
  const parts: (Glyph & { pixels: number[] })[] = [];
  const stack: number[] = [];
  for (let p = 0; p < W * H; p++) {
    if (!white[p] || seen[p]) continue;
    seen[p] = 1;
    stack.push(p);
    const pixels: number[] = [];
    let minX = W;
    let minY = H;
    let maxX = 0;
    let maxY = 0;
    while (stack.length) {
      const q = stack.pop()!;
      pixels.push(q);
      const qx = q % W;
      const qy = (q - qx) / W;
      if (qx < minX) minX = qx;
      if (qx > maxX) maxX = qx;
      if (qy < minY) minY = qy;
      if (qy > maxY) maxY = qy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const n = ny * W + nx;
          if (white[n] && !seen[n]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    parts.push({ x: minX / W, y: minY / H, w: w / W, h: h / H, area: pixels.length, fill: pixels.length / (w * h), pixels });
  }
  const digits = parts.filter((c) => {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    return (
      c.h >= BADGE.hMin &&
      c.h <= BADGE.hMax &&
      c.w >= BADGE.wMin &&
      c.w <= BADGE.wMax &&
      c.fill >= BADGE.fillMin &&
      c.fill <= BADGE.fillMax &&
      cx >= BADGE.cx[0] &&
      cx <= BADGE.cx[1] &&
      cy >= BADGE.cy[0] &&
      cy <= BADGE.cy[1]
    );
  });
  if (digits.length === 0) return null;
  // The number: the tallest digit, and every other of about its top and height ("10" is two).
  const tallest = digits.reduce((a, b) => (b.h > a.h ? b : a));
  const number = digits.filter((c) => Math.abs(c.y - tallest.y) <= BADGE.align && Math.abs(c.h - tallest.h) <= BADGE.align);
  const mask = new Uint8Array(W * H);
  const r = Math.max(1, Math.round(BADGE.grow * W));
  for (const g of number) {
    for (const p of g.pixels) {
      const px = p % W;
      const py = (p - px) / W;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) mask[ny * W + nx] = 1;
        }
      }
    }
  }
  return { mask, glyphs: number.map(({ pixels: _pixels, ...g }) => g) };
}

/**
 * `img` with its masked pixels painted out (onion peel): each takes the mean of its known 8-neighbours, from the
 * mask's edge inwards, until none is left. A new image; `img` is left as it was.
 */
export function inpaint(img: RGBAImage, mask: Uint8Array): RGBAImage {
  const { width: W, height: H } = img;
  const data = new Uint8ClampedArray(img.data);
  const known = new Uint8Array(W * H);
  // Only the mask's bounding box (and a pixel around it) can change: the peel works there alone.
  let bx0 = W;
  let by0 = H;
  let bx1 = -1;
  let by1 = -1;
  let left = 0;
  for (let p = 0; p < W * H; p++) {
    if (mask[p]) {
      left++;
      const x = p % W;
      const y = (p - x) / W;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
    } else known[p] = 1;
  }
  bx0 = Math.max(0, bx0 - 1);
  by0 = Math.max(0, by0 - 1);
  bx1 = Math.min(W - 1, bx1 + 1);
  by1 = Math.min(H - 1, by1 + 1);
  while (left > 0) {
    const fill: number[] = [];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const p = y * W + x;
        if (known[p]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const q = ny * W + nx;
            if (!known[q]) continue;
            r += data[q * 4];
            g += data[q * 4 + 1];
            b += data[q * 4 + 2];
            n++;
          }
        }
        if (n > 0) fill.push(p, r / n, g / n, b / n);
      }
    }
    if (fill.length === 0) break; // a mask covering the whole image: nothing to fill from
    for (let k = 0; k < fill.length; k += 4) {
      const p = fill[k];
      data[p * 4] = fill[k + 1];
      data[p * 4 + 1] = fill[k + 2];
      data[p * 4 + 2] = fill[k + 3];
      known[p] = 1;
    }
    left -= fill.length / 4;
  }
  return { data, width: W, height: H };
}
