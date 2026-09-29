// The embedding model in the offscreen document, on ONNX Runtime Web's WASM backend
// (multi-threaded when cross-origin isolated). WASM-only by the lead's ruling: for the
// dynamically quantised int8 models it measured about 1.7× faster than WebGPU in Chrome,
// with the same scores.
import { embedImages, type SessionLike, type TensorCtor } from '../shared/embed-core';
import type { EmbeddingModelSpec } from '../shared/models';
import type { Embedder } from './engine';
import { WASM_SESSION_OPTIONS, webRuntime, type WebRuntimeDeps } from './web-runtime';

/** Injected for tests; defaults are the real browser APIs. */
export type WebEmbedderDeps = WebRuntimeDeps;

export async function createWebEmbedder(spec: EmbeddingModelSpec, deps: WebEmbedderDeps = {}): Promise<Embedder> {
  const { ort, bytes } = webRuntime(deps);
  const model = await bytes(`models/${spec.file}`, `the model file ${spec.file}`);
  const session = await ort.InferenceSession.create(model, WASM_SESSION_OPTIONS);
  console.debug('[DuelLens] model ready', { model: spec.id, threads: ort.env.wasm.numThreads });

  const Tensor = ort.Tensor as unknown as TensorCtor;
  return {
    modelId: spec.id,
    // Callers must run one embedding at a time. This WASM-only build has no guard of its own
    // against a second concurrent session.run() (no "Session already started" check — that
    // guard exists only in the JSEP/WebGPU bundles we don't load), so correctness relies
    // entirely on the offscreen handler serialising all engine work through its queue.
    embed: (images) => embedImages(session as unknown as SessionLike, Tensor, spec, images),
  };
}
