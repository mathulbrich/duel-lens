// Finds where a real-set frame (data/debug/frames/<frame>.png, a crop of a video frame) sits in a
// live video frame grabbed from the page: zero-mean normalised cross-correlation (NCC), coarse to
// fine. The result maps the frame's own pixels (where set.json's boxes live) onto the video's pixels,
// and its score says whether the live frame is the one the crop was taken from (a seek mismatch, or a
// hand that moved, shows as a lower score).
import sharp from 'sharp';

export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** Decodes an image (path or bytes) to 0–255 grey, optionally resized to `size` first. */
export async function grayOf(input: string | Buffer, size?: { width: number; height: number }): Promise<Gray> {
  let img = sharp(input).removeAlpha();
  if (size) img = img.resize(Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height)), { fit: 'fill' });
  const { data, info } = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
  const out = new Float32Array(info.width * info.height);
  const ch = info.channels;
  for (let i = 0; i < out.length; i++) out[i] = data[i * ch];
  return { data: out, width: info.width, height: info.height };
}

/** Pixel size of an image file or buffer. */
export async function sizeOf(input: string | Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(input).metadata();
  return { width: m.width ?? 0, height: m.height ?? 0 };
}

/** Integral images of I and I² for O(1) window sums. */
function integrals(img: Gray): { s: Float64Array; s2: Float64Array } {
  const w = img.width + 1;
  const s = new Float64Array(w * (img.height + 1));
  const s2 = new Float64Array(w * (img.height + 1));
  for (let y = 0; y < img.height; y++) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < img.width; x++) {
      const v = img.data[y * img.width + x];
      row += v;
      row2 += v * v;
      s[(y + 1) * w + x + 1] = s[y * w + x + 1] + row;
      s2[(y + 1) * w + x + 1] = s2[y * w + x + 1] + row2;
    }
  }
  return { s, s2 };
}

interface Prepared {
  tpl: Gray;
  /** The template minus its mean. */
  zero: Float32Array;
  /** sqrt(Σ (T − mean)²) */
  norm: number;
}

function prepare(tpl: Gray): Prepared {
  let sum = 0;
  for (const v of tpl.data) sum += v;
  const mean = sum / tpl.data.length;
  const zero = new Float32Array(tpl.data.length);
  let ss = 0;
  for (let i = 0; i < zero.length; i++) {
    zero[i] = tpl.data[i] - mean;
    ss += zero[i] * zero[i];
  }
  return { tpl, zero, norm: Math.sqrt(ss) };
}

/** NCC of the prepared template at (x, y) of `img` (top-left corner); −1 when out of bounds or flat. */
function nccAt(img: Gray, ints: { s: Float64Array; s2: Float64Array }, p: Prepared, x: number, y: number): number {
  const { width: tw, height: th } = p.tpl;
  if (x < 0 || y < 0 || x + tw > img.width || y + th > img.height) return -1;
  const W = img.width + 1;
  const n = tw * th;
  const sum = ints.s[(y + th) * W + x + tw] - ints.s[y * W + x + tw] - ints.s[(y + th) * W + x] + ints.s[y * W + x];
  const sum2 = ints.s2[(y + th) * W + x + tw] - ints.s2[y * W + x + tw] - ints.s2[(y + th) * W + x] + ints.s2[y * W + x];
  const varI = sum2 - (sum * sum) / n;
  if (varI <= 1e-6 || p.norm <= 1e-6) return -1;
  let dot = 0;
  const d = img.data;
  const z = p.zero;
  for (let ty = 0; ty < th; ty++) {
    const io = (y + ty) * img.width + x;
    const to = ty * tw;
    for (let tx = 0; tx < tw; tx++) dot += z[to + tx] * d[io + tx];
  }
  return dot / (p.norm * Math.sqrt(varI));
}

/** Best NCC over every position in the window [x0..x1] × [y0..y1] (clipped to the image). */
function search(img: Gray, p: Prepared, x0: number, x1: number, y0: number, y1: number): { x: number; y: number; score: number } {
  const ints = integrals(img);
  let best = { x: 0, y: 0, score: -2 };
  const xa = Math.max(0, x0);
  const ya = Math.max(0, y0);
  const xb = Math.min(img.width - p.tpl.width, x1);
  const yb = Math.min(img.height - p.tpl.height, y1);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const s = nccAt(img, ints, p, x, y);
      if (s > best.score) best = { x, y, score: s };
    }
  }
  return best;
}

export interface Placement {
  /** Where the crop's (0, 0) sits in the video frame, in video pixels. */
  x: number;
  y: number;
  /** Video pixels per crop pixel. */
  scale: number;
  /** NCC at full resolution (1 = identical up to brightness and contrast). */
  score: number;
}

/**
 * Where `crop` (a real-set frame) sits in `frame` (a video frame at its served size), assuming video
 * px = crop px × scale, for each of `scales` (the first that scores ≥ `good` wins; else the best).
 * `prior` (video px) narrows the search to ±`priorRadius` px around it.
 */
export async function locate(
  frame: Buffer,
  crop: string | Buffer,
  opts: { scales: number[]; prior?: { x: number; y: number }; priorRadius?: number; good?: number },
): Promise<Placement> {
  const good = opts.good ?? 0.8;
  const frameSize = await sizeOf(frame);
  const cropSize = await sizeOf(crop);
  let best: Placement = { x: 0, y: 0, scale: 1, score: -2 };
  for (const scale of opts.scales) {
    const tw = cropSize.width * scale;
    const th = cropSize.height * scale;
    if (tw > frameSize.width + 1 || th > frameSize.height + 1) continue;
    // Coarse level: at least ~40 px on the template's short side, at most 1/2 scale.
    const f = Math.min(0.5, Math.max(0.1, 40 / Math.min(tw, th)));
    const fFrame = await grayOf(frame, { width: frameSize.width * f, height: frameSize.height * f });
    const fTpl = prepare(await grayOf(crop, { width: tw * f, height: th * f }));
    let coarse: { x: number; y: number; score: number };
    if (opts.prior) {
      const r = Math.ceil((opts.priorRadius ?? 24) * f) + 1;
      const cx = Math.round(opts.prior.x * f);
      const cy = Math.round(opts.prior.y * f);
      coarse = search(fFrame, fTpl, cx - r, cx + r, cy - r, cy + r);
    } else {
      coarse = search(fFrame, fTpl, 0, fFrame.width, 0, fFrame.height);
    }
    // Middle level (1/2) when the coarse one was much smaller, then full resolution.
    let x = coarse.x / f;
    let y = coarse.y / f;
    if (f < 0.4) {
      const m = 0.5;
      const mFrame = await grayOf(frame, { width: frameSize.width * m, height: frameSize.height * m });
      const mTpl = prepare(await grayOf(crop, { width: tw * m, height: th * m }));
      const r = Math.ceil((m / f) * 1.5) + 1;
      const mid = search(mFrame, mTpl, Math.round(x * m) - r, Math.round(x * m) + r, Math.round(y * m) - r, Math.round(y * m) + r);
      x = mid.x / m;
      y = mid.y / m;
    }
    const full = await grayOf(frame);
    const tpl = prepare(await grayOf(crop, { width: tw, height: th }));
    const fine = search(full, tpl, Math.round(x) - 3, Math.round(x) + 3, Math.round(y) - 3, Math.round(y) + 3);
    const placed: Placement = { x: fine.x, y: fine.y, scale, score: fine.score };
    if (placed.score > best.score) best = placed;
    if (best.score >= good) break;
  }
  return best;
}

/** NCC of `crop` placed exactly at `at` in `frame` (±`slack` px), for re-checking a known placement at another moment. */
export async function scoreAt(frame: Buffer, crop: string | Buffer, at: Placement, slack = 2): Promise<number> {
  const cropSize = await sizeOf(crop);
  const full = await grayOf(frame);
  const tpl = prepare(await grayOf(crop, { width: cropSize.width * at.scale, height: cropSize.height * at.scale }));
  return search(full, tpl, at.x - slack, at.x + slack, at.y - slack, at.y + slack).score;
}
