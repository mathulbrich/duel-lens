// The embedding model in the offscreen document, on ONNX Runtime Web: WebGPU when the browser has an
// adapter, WASM otherwise or whenever WebGPU fails (web-runtime.ts createModelSession, which says why
// and when).
import { embedImages } from '../shared/embed-core';
import type { EmbeddingModelSpec } from '../shared/models';
import type { Embedder } from './engine';
import { createModelSession, type WebRuntimeDeps } from './web-runtime';

/** Injected for tests; defaults are the real browser APIs. */
export type WebEmbedderDeps = WebRuntimeDeps;

export async function createWebEmbedder(spec: EmbeddingModelSpec, deps: WebEmbedderDeps = {}): Promise<Embedder> {
  const { session, Tensor } = await createModelSession(`models/${spec.file}`, `the model file ${spec.file}`, deps);
  console.debug(`[DuelLens] model ready: ${spec.id} on ${session.ep === 'webgpu' ? 'WebGPU' : 'WASM'}`, { model: spec.id, ep: session.ep });
  return {
    modelId: spec.id,
    // Callers must run one embedding at a time: correctness relies on the offscreen handler
    // serialising all engine work through its queue (the WASM build has no guard of its own against a
    // second concurrent session.run()).
    embed: (images) => embedImages(session, Tensor, spec, images),
  };
}
