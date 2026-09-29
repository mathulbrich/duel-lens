// The card detector in the offscreen document: onnxruntime-web's WASM backend (web-runtime.ts), the
// model from the extension's models/detector/ folder. Loading fails when the model is missing (a
// build without it); click to scan then keeps working as drag-only.
import type { SessionLike, TensorCtor } from '../../shared/embed-core';
import { elapsedMs } from '../elapsed';
import { WASM_SESSION_OPTIONS, webRuntime, type WebRuntimeDeps } from '../web-runtime';
import { createCardDetector, type OwnCardDetector } from './detector';
import { CARD_DETECTOR } from './spec';

export async function createWebCardDetector(deps: WebRuntimeDeps = {}): Promise<OwnCardDetector> {
  const start = performance.now();
  const { ort, bytes } = webRuntime(deps);
  const model = await bytes(`${CARD_DETECTOR.dir}/${CARD_DETECTOR.file}`, "the card detector's model");
  const session = await ort.InferenceSession.create(model, WASM_SESSION_OPTIONS);
  console.debug('[DuelLens] card detector ready', { readyMs: elapsedMs(start), MB: +(model.byteLength / 1e6).toFixed(1) });
  return createCardDetector({
    // Like every model here, this session must never run concurrently with another run: the
    // offscreen handler's work queue (the CardDetector's schedule) serialises them.
    session: session as unknown as SessionLike,
    Tensor: ort.Tensor as unknown as TensorCtor,
    release: () => session.release(),
  });
}
