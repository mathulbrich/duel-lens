// Embedding in Node with onnxruntime-node, through the same embedImages() code path the
// extension uses with onnxruntime-web, so index vectors and runtime queries match.
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { embedImages, type SessionLike, type TensorCtor } from '../../src/shared/embed-core';
import type { EmbeddingModelSpec } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';

export const MODELS_DIR = path.resolve(import.meta.dirname, '../../extension/models');

export const modelPath = (spec: EmbeddingModelSpec) => path.join(MODELS_DIR, spec.file);

export interface NodeEmbedder {
  spec: EmbeddingModelSpec;
  session: ort.InferenceSession;
  /** L2-normalised vectors, one per image, batched in chunks of spec.maxBatch (default 16). */
  embed(images: RGBAImage[]): Promise<Float32Array[]>;
  release(): Promise<void>;
}

export interface NodeEmbedderOptions {
  /** Intra-op threads; default lets onnxruntime choose (all performance cores). */
  threads?: number;
}

export async function createNodeEmbedder(
  spec: EmbeddingModelSpec,
  opts: NodeEmbedderOptions = {},
): Promise<NodeEmbedder> {
  const session = await ort.InferenceSession.create(modelPath(spec), {
    graphOptimizationLevel: 'all',
    ...(opts.threads ? { intraOpNumThreads: opts.threads, interOpNumThreads: 1 } : {}),
  });
  const runner = session as unknown as SessionLike;
  const Tensor = ort.Tensor as unknown as TensorCtor;
  return {
    spec,
    session,
    embed: (images) => embedImages(runner, Tensor, spec, images),
    release: () => session.release(),
  };
}
