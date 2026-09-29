// Partly visible cards: a card cut by the edge of the picture (the video frame, or the screenshot) is
// straightened as a WHOLE card, with the part outside the picture filled neutrally, instead of the
// visible part being stretched, or the missing part left black (partial-report.md).
//
// Only the crop's sides that are the picture's own edge count. The content script adds a margin of
// SELECTION_MARGIN around the user's box and clips it to the picture (src/content/capture.ts), so a side
// whose margin is short of that is the picture's edge; a crop side with the whole margin is not (the
// card continues past it: a box drawn on part of a card is not a cut card).
import { ART_BOX } from '../shared/card-layout';
import type { RGBAImage } from '../shared/preprocess';
import type { Point, Quad, Rect } from './geometry';
import { quadMap } from './geometry';
import { SELECTION_MARGIN } from './hypotheses';

export type Side = 'left' | 'top' | 'right' | 'bottom';
export const SIDES: readonly Side[] = ['left', 'top', 'right', 'bottom'];

/**
 * The sides of a width×height crop that are the picture's edge: where the margin around the user's box
 * (`inner`, crop pixels) is short of the content script's SELECTION_MARGIN by more than `slack` px. With
 * no usable `inner` there is no telling: none.
 */
export function frameSides(width: number, height: number, inner: Rect | null | undefined, margin = SELECTION_MARGIN, slack = 0.5): Side[] {
  if (!inner || ![inner.x, inner.y, inner.w, inner.h].every(Number.isFinite) || inner.w < 1 || inner.h < 1) return [];
  const short = (have: number, want: number) => have < want - slack;
  const out: Side[] = [];
  if (short(inner.x, margin * inner.w)) out.push('left');
  if (short(inner.y, margin * inner.h)) out.push('top');
  if (short(width - (inner.x + inner.w), margin * inner.w)) out.push('right');
  if (short(height - (inner.y + inner.h), margin * inner.h)) out.push('bottom');
  return out;
}

/** How far `p` lies inside the width×height image from `side` (negative: beyond it). */
export function inset(p: Point, side: Side, width: number, height: number): number {
  switch (side) {
    case 'left':
      return p.x;
    case 'top':
      return p.y;
    case 'right':
      return width - p.x;
    case 'bottom':
      return height - p.y;
  }
}

/** The `sides` a quad reaches: one of its corners within `tol` px of that side of the image, or beyond it. */
export function sidesReached(quad: readonly Point[], width: number, height: number, sides: readonly Side[], tol: number): Side[] {
  return sides.filter((s) => quad.some((p) => inset(p, s, width, height) <= tol));
}

/** A card straightened from a quad that may reach past the picture: which output pixels were seen. */
export interface MaskedWarp {
  image: RGBAImage;
  /** 1 where the output pixel's sample fell inside the source image, 0 where it fell outside. */
  seen: Uint8Array;
  /** The share of output pixels seen (0–1). */
  seenShare: number;
}

/**
 * geometry.warpQuad's straightening (the same projective map, bilinear samples, the border's nearest
 * pixels repeating within half a pixel), also telling which output pixels come from inside the image.
 * Samples outside it are filled as `outside` says: 'black' (warpQuad's own), or 'edge', the nearest pixel
 * of the image (its border stretched outwards).
 */
export function warpQuadMasked(img: RGBAImage, quad: Quad, outW: number, outH: number, outside: 'black' | 'edge' = 'black'): MaskedWarp | null {
  const map = quadMap(quad);
  if (!map) return null;
  const { width, height, data: src } = img;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const seen = new Uint8Array(outW * outH);
  const lastX = width - 1;
  const lastY = height - 1;
  let seenCount = 0;
  for (let j = 0, o = 0, i4 = 0; j < outH; j++) {
    const v = (j + 0.5) / outH;
    for (let i = 0; i < outW; i++, o++, i4 += 4) {
      const p = map((i + 0.5) / outW, v);
      let fx = p.x - 0.5;
      let fy = p.y - 0.5;
      out[i4 + 3] = 255;
      const inside = fx >= -0.5 && fy >= -0.5 && fx <= lastX + 0.5 && fy <= lastY + 0.5;
      if (inside) {
        seen[o] = 1;
        seenCount++;
      } else if (outside === 'black') continue;
      fx = Math.min(lastX, Math.max(0, fx));
      fy = Math.min(lastY, Math.max(0, fy));
      const left = Math.floor(fx);
      const top = Math.floor(fy);
      const tx = fx - left;
      const ty = fy - top;
      const x1 = left + 1 > lastX ? lastX : left + 1;
      const row0 = top * width;
      const row1 = (top + 1 > lastY ? lastY : top + 1) * width;
      const p00 = (row0 + left) * 4;
      const p01 = (row0 + x1) * 4;
      const p10 = (row1 + left) * 4;
      const p11 = (row1 + x1) * 4;
      const w11 = tx * ty;
      const w01 = tx - w11;
      const w10 = ty - w11;
      const w00 = 1 - tx - w10;
      out[i4] = src[p00] * w00 + src[p01] * w01 + src[p10] * w10 + src[p11] * w11;
      out[i4 + 1] = src[p00 + 1] * w00 + src[p01 + 1] * w01 + src[p10 + 1] * w10 + src[p11 + 1] * w11;
      out[i4 + 2] = src[p00 + 2] * w00 + src[p01 + 2] * w01 + src[p10 + 2] * w10 + src[p11 + 2] * w11;
    }
  }
  return { image: { data: out, width: outW, height: outH }, seen, seenShare: seenCount / (outW * outH) };
}

/**
 * The warp with its unseen pixels painted one colour: the mean colour of the seen pixels of the art box
 * ('art-mean'), of the whole card ('mean'), or a fixed grey ('grey', 128). A missing corner of the art
 * then shifts the image's colour statistics as little as a flat patch can (the model standardises each
 * channel over the image).
 */
export function fillUnseen(w: MaskedWarp, mode: 'art-mean' | 'mean' | 'grey'): RGBAImage {
  const { width: W, height: H, data } = w.image;
  let rgb: [number, number, number] = [128, 128, 128];
  if (mode !== 'grey') {
    const [x0, x1, y0, y1] =
      mode === 'art-mean'
        ? [Math.round(ART_BOX.x * W), Math.round((ART_BOX.x + ART_BOX.w) * W), Math.round(ART_BOX.y * H), Math.round((ART_BOX.y + ART_BOX.h) * H)]
        : [0, W, 0, H];
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const o = y * W + x;
        if (!w.seen[o]) continue;
        sum[0] += data[o * 4];
        sum[1] += data[o * 4 + 1];
        sum[2] += data[o * 4 + 2];
        n++;
      }
    if (n > 0) rgb = [sum[0] / n, sum[1] / n, sum[2] / n];
  }
  const out = new Uint8ClampedArray(data);
  for (let o = 0; o < W * H; o++) {
    if (w.seen[o]) continue;
    out[o * 4] = rgb[0];
    out[o * 4 + 1] = rgb[1];
    out[o * 4 + 2] = rgb[2];
    out[o * 4 + 3] = 255;
  }
  return { data: out, width: W, height: H };
}

/**
 * `img` with `pad` px of flat `fill` grey added on each of `sides`: the picture continued past its edge,
 * so that a card cut there can be found whole (the card detector was trained on frames padded with its
 * own grey, their cards labelled whole when at least half is seen).
 */
export function padSides(img: RGBAImage, sides: readonly Side[], pad: number, fill: number): { image: RGBAImage; dx: number; dy: number } {
  const p = Math.max(0, Math.round(pad));
  const left = sides.includes('left') ? p : 0;
  const top = sides.includes('top') ? p : 0;
  const right = sides.includes('right') ? p : 0;
  const bottom = sides.includes('bottom') ? p : 0;
  const W = img.width + left + right;
  const H = img.height + top + bottom;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = fill;
    data[i * 4 + 1] = fill;
    data[i * 4 + 2] = fill;
    data[i * 4 + 3] = 255;
  }
  for (let y = 0; y < img.height; y++) {
    const from = y * img.width * 4;
    data.set(img.data.subarray(from, from + img.width * 4), ((y + top) * W + left) * 4);
  }
  return { image: { data, width: W, height: H }, dx: left, dy: top };
}
