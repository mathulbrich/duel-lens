// The card detector in the offscreen document: ONNX Runtime Web on WebGPU when the browser has an
// adapter, WASM otherwise or whenever WebGPU fails (web-runtime.ts createModelSession), the model from
// the extension's models/detector/ folder. Its outlines are the same on both; a whole screenshot takes
// 37 ms on WebGPU against 88 ms on WASM, a scan's crop 15 ms on either (Apple M-series GPU;
// src/offscreen/__measure__/webgpu-parity.ts). Loading fails when the model is missing (a build without
// it); click to scan then keeps working as drag-only.
import { elapsedMs } from '../elapsed';
import { createModelSession, type WebRuntimeDeps } from '../web-runtime';
import { createCardDetector, type OwnCardDetector } from './detector';
import { CARD_DETECTOR } from './spec';

export async function createWebCardDetector(deps: WebRuntimeDeps = {}): Promise<OwnCardDetector> {
  const start = performance.now();
  const { session, Tensor } = await createModelSession(`${CARD_DETECTOR.dir}/${CARD_DETECTOR.file}`, "the card detector's model", deps);
  console.debug(`[DuelLens] card detector ready on ${session.ep === 'webgpu' ? 'WebGPU' : 'WASM'}`, { readyMs: elapsedMs(start), ep: session.ep });
  return createCardDetector({
    // Like every model here, this session must never run concurrently with another run: the
    // offscreen handler's work queue (the CardDetector's schedule) serialises them.
    session,
    Tensor,
    release: () => session.release(),
    // A getter on the session: 'wasm' from the start without WebGPU, or once WebGPU failed and it fell back.
    backend: () => session.ep,
  });
}
