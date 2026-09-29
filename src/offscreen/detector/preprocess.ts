// The detector's input: the image shrunk (never enlarged, unless asked) so its long side is at most
// `longSide`, antialiased, as float RGB / 255 in CHW order, padded right and bottom with `fill` to a
// multiple of `align`. Written for speed (it runs on every click-to-scan screenshot): a 2×2 box
// halving while the image is at least twice too large (a Retina capture), then one separable
// triangle-filter resize (Pillow's antialiased bilinear) straight into the padded tensor.
import type { RGBAImage } from '../../shared/preprocess';

export interface ModelInput {
  /** [1, 3, height, width] float32, RGB in [0, 1]. */
  data: Float32Array;
  width: number;
  height: number;
  /** Content size inside the padding, and model pixels per image pixel along x and y. */
  contentWidth: number;
  contentHeight: number;
  scaleX: number;
  scaleY: number;
}

export interface InputOptions {
  longSide: number;
  align: number;
  fill: number;
  /** Scale up small images to `longSide` too (the drag case's crops); default only shrinks. */
  enlarge?: boolean;
}

/** 2×2 box average (odd trailing row/column dropped): a Retina capture halved. */
function halve(img: RGBAImage): RGBAImage {
  const w = img.width >> 1;
  const h = img.height >> 1;
  const src = img.data;
  const out = new Uint8ClampedArray(w * h * 4);
  const row = img.width * 4;
  for (let y = 0; y < h; y++) {
    let i = y * 2 * row;
    let o = y * w * 4;
    for (let x = 0; x < w; x++, i += 8, o += 4) {
      out[o] = (src[i] + src[i + 4] + src[i + row] + src[i + row + 4] + 2) >> 2;
      out[o + 1] = (src[i + 1] + src[i + 5] + src[i + row + 1] + src[i + row + 5] + 2) >> 2;
      out[o + 2] = (src[i + 2] + src[i + 6] + src[i + row + 2] + src[i + row + 6] + 2) >> 2;
      out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

interface Taps {
  start: Int32Array;
  count: Int32Array;
  weights: Float32Array;
  k: number;
}

/** Pillow's antialiased bilinear taps (triangle filter widened when shrinking). */
function taps(inSize: number, outSize: number): Taps {
  const scale = inSize / outSize;
  const support = Math.max(scale, 1);
  const k = Math.ceil(support) * 2 + 1;
  const start = new Int32Array(outSize);
  const count = new Int32Array(outSize);
  const weights = new Float32Array(outSize * k);
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const s = Math.max(0, Math.floor(center - support + 0.5));
    const e = Math.min(inSize, Math.floor(center + support + 0.5));
    let total = 0;
    for (let i = s; i < e; i++) {
      const x = Math.abs((i - center + 0.5) / support);
      const wgt = x < 1 ? 1 - x : 0;
      weights[o * k + (i - s)] = wgt;
      total += wgt;
    }
    if (total > 0) for (let i = 0; i < e - s; i++) weights[o * k + i] /= total;
    start[o] = s;
    count[o] = e - s;
  }
  return { start, count, weights, k };
}

export function toModelInput(image: RGBAImage, opts: InputOptions): ModelInput {
  if (image.width < 1 || image.height < 1) throw new Error('Cannot detect cards in an empty image');
  const long = Math.max(image.width, image.height);
  const scale = opts.enlarge ? opts.longSide / long : Math.min(1, opts.longSide / long);
  const cw = Math.max(1, Math.round(image.width * scale));
  const ch = Math.max(1, Math.round(image.height * scale));
  const W = Math.ceil(cw / opts.align) * opts.align;
  const H = Math.ceil(ch / opts.align) * opts.align;
  const plane = W * H;
  const data = new Float32Array(3 * plane).fill(opts.fill / 255);
  let img = image;
  while (img.width >= cw * 2 && img.height >= ch * 2) img = halve(img);
  const src = img.data;
  if (img.width === cw && img.height === ch) {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = (y * cw + x) * 4;
        const o = y * W + x;
        data[o] = src[i] / 255;
        data[plane + o] = src[i + 1] / 255;
        data[2 * plane + o] = src[i + 2] / 255;
      }
    }
  } else {
    const hx = taps(img.width, cw);
    const vy = taps(img.height, ch);
    // horizontal pass: every source row, cw columns, RGB interleaved
    const tmp = new Float32Array(img.height * cw * 3);
    for (let y = 0; y < img.height; y++) {
      const rowIn = y * img.width * 4;
      const rowOut = y * cw * 3;
      for (let x = 0; x < cw; x++) {
        const s = hx.start[x];
        const n = hx.count[x];
        const wo = x * hx.k;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let t = 0; t < n; t++) {
          const wgt = hx.weights[wo + t];
          const i = rowIn + (s + t) * 4;
          r += wgt * src[i];
          g += wgt * src[i + 1];
          b += wgt * src[i + 2];
        }
        const o = rowOut + x * 3;
        tmp[o] = r;
        tmp[o + 1] = g;
        tmp[o + 2] = b;
      }
    }
    // vertical pass into the padded CHW tensor
    const inv = 1 / 255;
    for (let y = 0; y < ch; y++) {
      const s = vy.start[y];
      const n = vy.count[y];
      const wo = y * vy.k;
      for (let x = 0; x < cw; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let t = 0; t < n; t++) {
          const wgt = vy.weights[wo + t];
          const i = ((s + t) * cw + x) * 3;
          r += wgt * tmp[i];
          g += wgt * tmp[i + 1];
          b += wgt * tmp[i + 2];
        }
        const o = y * W + x;
        data[o] = Math.min(1, Math.max(0, r * inv));
        data[plane + o] = Math.min(1, Math.max(0, g * inv));
        data[2 * plane + o] = Math.min(1, Math.max(0, b * inv));
      }
    }
  }
  return { data, width: W, height: H, contentWidth: cw, contentHeight: ch, scaleX: cw / image.width, scaleY: ch / image.height };
}
