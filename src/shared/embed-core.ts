// Runs an embedding model on RGBA images and returns L2-normalised vectors.
// Runtime-agnostic: pass an onnxruntime-web or onnxruntime-node session and its Tensor
// class, so the Node index build and the browser engine share this exact code path.
import type { EmbeddingModelSpec } from './models';
import { l2normalize, preprocess, type RGBAImage } from './preprocess';

export interface TensorLike {
  data: ArrayLike<number>;
  dims: readonly number[];
}

/** The part of an ONNX Runtime InferenceSession we use. */
export interface SessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike | undefined>>;
}

/** ONNX Runtime's Tensor constructor (ort.Tensor), for either runtime. */
export type TensorCtor = new (type: 'float32', data: Float32Array, dims: number[]) => unknown;

/** Reduce a model output to one vector per image (not yet normalised). */
export function poolOutput(t: TensorLike, pooling: EmbeddingModelSpec['pooling'], n: number): Float32Array[] {
  if (t.dims[0] !== n) throw new Error(`Model output batch is ${t.dims[0]}, expected ${n}`);
  const out: Float32Array[] = [];
  if (pooling === 'none') {
    const dim = t.dims.slice(1).reduce((a, b) => a * b, 1);
    for (let i = 0; i < n; i++) out.push(Float32Array.from({ length: dim }, (_, d) => t.data[i * dim + d]));
    return out;
  }
  if (t.dims.length !== 3) throw new Error(`Pooling "${pooling}" needs a [batch, tokens, dim] output, got [${t.dims}]`);
  const [, tokens, dim] = t.dims;
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    const base = i * tokens * dim;
    if (pooling === 'cls') {
      for (let d = 0; d < dim; d++) v[d] = t.data[base + d];
    } else {
      for (let k = 0; k < tokens; k++) for (let d = 0; d < dim; d++) v[d] += t.data[base + k * dim + d];
      for (let d = 0; d < dim; d++) v[d] /= tokens;
    }
    out.push(v);
  }
  return out;
}

export async function embedImages(
  session: SessionLike,
  Tensor: TensorCtor,
  spec: EmbeddingModelSpec,
  images: RGBAImage[],
): Promise<Float32Array[]> {
  const s = spec.inputSize;
  const plane = 3 * s * s;
  const chunk = Math.max(1, spec.maxBatch ?? 16);
  const vectors: Float32Array[] = [];
  for (let start = 0; start < images.length; start += chunk) {
    const part = images.slice(start, start + chunk);
    const batch = new Float32Array(part.length * plane);
    part.forEach((im, i) => batch.set(preprocess(im, spec), i * plane));
    const out = await session.run({ [spec.inputName]: new Tensor('float32', batch, [part.length, 3, s, s]) });
    const t = out[spec.outputName];
    if (!t) throw new Error(`Model has no output "${spec.outputName}" (got: ${Object.keys(out).join(', ') || 'none'})`);
    for (const v of poolOutput(t, spec.pooling, part.length)) vectors.push(l2normalize(v));
  }
  return vectors;
}
