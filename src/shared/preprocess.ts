// Pure pixel operations shared by the Node index build and the in-browser engine.
// Keeping one implementation guarantees both sides feed the model identical tensors.
import type { EmbeddingModelSpec } from './models';

/** Opaque RGBA pixels, row-major (like ImageData). Alpha is ignored. */
export interface RGBAImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

const triangle = (x: number) => {
  const a = Math.abs(x);
  return a < 1 ? 1 - a : 0;
};

interface Coeffs {
  bounds: Int32Array; // [start, count] per output pixel
  weights: Float64Array; // ksize weights per output pixel
  ksize: number;
}

// Antialiased bilinear (triangle filter widened when downscaling), as in Pillow's resize.
function coefficients(inSize: number, outSize: number): Coeffs {
  const scale = inSize / outSize;
  const filterScale = Math.max(scale, 1);
  const support = filterScale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const weights = new Float64Array(outSize * ksize);
  const inv = 1 / filterScale;
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * scale;
    const start = Math.max(0, Math.floor(center - support + 0.5));
    const end = Math.min(inSize, Math.floor(center + support + 0.5));
    let total = 0;
    for (let i = start; i < end; i++) {
      const w = triangle((i - center + 0.5) * inv);
      weights[o * ksize + (i - start)] = w;
      total += w;
    }
    if (total > 0) for (let i = 0; i < end - start; i++) weights[o * ksize + i] /= total;
    bounds[o * 2] = start;
    bounds[o * 2 + 1] = end - start;
  }
  return { bounds, weights, ksize };
}

/**
 * Resize to width x height (aspect ratio is not preserved) and return float RGB, HWC,
 * values in [0, 255]. Deterministic across Node and browsers.
 */
export function resizeToFloatRGB(img: RGBAImage, width: number, height: number): Float32Array {
  if (img.width < 1 || img.height < 1) throw new Error('Cannot resize an empty image');
  const h = coefficients(img.width, width);
  const v = coefficients(img.height, height);
  // Horizontal pass: img.height rows x width columns x 3 channels.
  const tmp = new Float64Array(img.height * width * 3);
  const src = img.data;
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4;
    for (let x = 0; x < width; x++) {
      const start = h.bounds[x * 2];
      const count = h.bounds[x * 2 + 1];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < count; k++) {
        const w = h.weights[x * h.ksize + k];
        const p = row + (start + k) * 4;
        r += src[p] * w;
        g += src[p + 1] * w;
        b += src[p + 2] * w;
      }
      const t = (y * width + x) * 3;
      tmp[t] = r;
      tmp[t + 1] = g;
      tmp[t + 2] = b;
    }
  }
  // Vertical pass.
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const start = v.bounds[y * 2];
    const count = v.bounds[y * 2 + 1];
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < count; k++) {
        const w = v.weights[y * v.ksize + k];
        const t = ((start + k) * width + x) * 3;
        r += tmp[t] * w;
        g += tmp[t + 1] * w;
        b += tmp[t + 2] * w;
      }
      const o = (y * width + x) * 3;
      out[o] = Math.min(255, Math.max(0, r));
      out[o + 1] = Math.min(255, Math.max(0, g));
      out[o + 2] = Math.min(255, Math.max(0, b));
    }
  }
  return out;
}

/** Resize and round back to 8-bit RGBA (alpha set to 255). */
export function resizeRGBA(img: RGBAImage, width: number, height: number): RGBAImage {
  const f = resizeToFloatRGB(img, width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < f.length; i += 3, j += 4) {
    data[j] = Math.round(f[i]);
    data[j + 1] = Math.round(f[i + 1]);
    data[j + 2] = Math.round(f[i + 2]);
    data[j + 3] = 255;
  }
  return { data, width, height };
}

/** Float RGB HWC in [0, 255] (size x size) → normalised CHW Float32 tensor data. */
export function toTensorCHW(
  rgb: Float32Array,
  size: number,
  mean: readonly number[],
  std: readonly number[],
): Float32Array {
  const plane = size * size;
  const out = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c];
  }
  return out;
}

/** Full model preprocessing: squash-resize to the model's square input, then normalise. */
export function preprocess(img: RGBAImage, spec: EmbeddingModelSpec): Float32Array {
  const s = spec.inputSize;
  return toTensorCHW(resizeToFloatRGB(img, s, s), s, spec.mean, spec.std);
}

/** Cut out a rectangle; parts outside the image are clipped away. */
export function cropRGBA(img: RGBAImage, x: number, y: number, w: number, h: number): RGBAImage {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(img.width, Math.floor(x + w));
  const y1 = Math.min(img.height, Math.floor(y + h));
  const cw = Math.max(0, x1 - x0);
  const ch = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const from = ((y0 + row) * img.width + x0) * 4;
    data.set(img.data.subarray(from, from + cw * 4), row * cw * 4);
  }
  return { data, width: cw, height: ch };
}

export function rotate180(img: RGBAImage): RGBAImage {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) data.set(img.data.subarray(i * 4, i * 4 + 4), (n - 1 - i) * 4);
  return { data, width: img.width, height: img.height };
}

/** Rotate by 90 degrees clockwise ('cw') or counter-clockwise ('ccw'). */
export function rotate90(img: RGBAImage, dir: 'cw' | 'ccw'): RGBAImage {
  const { width: w, height: h } = img;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Destination is h wide and w tall.
      const dx = dir === 'cw' ? h - 1 - y : y;
      const dy = dir === 'cw' ? x : w - 1 - x;
      data.set(img.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (dy * h + dx) * 4);
    }
  }
  return { data, width: h, height: w };
}

export function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const out = new Float32Array(v.length);
  if (sum === 0) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}
