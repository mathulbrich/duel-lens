// The engine's message handler, as both engines build it: Chrome's offscreen document (index.ts,
// registered with chrome.runtime.onMessage) and Firefox's event page (in-page.ts, called directly:
// Firefox has no chrome.offscreen). It loads on first use only what each message needs (loaders.ts):
// the whole engine for a scan, the index metadata for index-missing, the embedding model for
// embed-artworks.
import { getModel } from '../shared/models';
import { decodeDataUrl } from './decode';
import { CARD_DETECTOR } from './detector/spec';
import { createWebCardDetector } from './detector/web';
import { createOffscreenHandler } from './handler';
import { createLoaders } from './loaders';
import { createWebEmbedder } from './web-embedder';

/** Fetch a file packaged with the extension, with a readable error if it is missing. */
async function packaged(path: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(chrome.runtime.getURL(path));
  } catch (e) {
    throw new Error(`${path} is missing from the extension (${e instanceof Error ? e.message : e})`);
  }
  if (!res.ok) throw new Error(`${path} could not be read (HTTP ${res.status})`);
  return res;
}

export interface EngineOptions {
  /**
   * Whether the card detector may run on WebGPU (it falls back to WASM on its own either way;
   * web-runtime.ts createModelSession). The embedder always tries WebGPU first.
   * - Chrome: true. Both models are faster on its WebGPU (features3-webgpu.md).
   * - Firefox: false (decision D-FF1). Its WebGPU makes the embedder about 3.5 times faster than its
   *   one-thread WASM, but the detector slower (292 ms against 62 ms a screenshot): firefox-spike.md §2,
   *   firefox-port.md. The native-frame run is then skipped, as on any WASM detector (FRAME_SKIPPED_ON_WASM).
   */
  detectorWebGpu: boolean;
}

/** The engine's listener: (message, sender, sendResponse) => true while an answer is pending. */
export function createEngineHandler(opts: EngineOptions) {
  const spec = getModel();
  // The card detector (src/offscreen/detector/, models/detector/card-detector.onnx): the ONE
  // CardDetector, which createLoaders loads once and hands to click to scan (the handler, through
  // `loaders`: one run per screenshot, face-up cards outlined) and to the engine (every scan's crop:
  // the card the user drew around or clicked, straightened by its corners). A --no-detector build
  // registers none: detect-cards then answers "no card detector in this build" (drag only) and scans
  // match the user's box as drawn.
  const loaders = createLoaders({
    spec,
    packaged,
    createEmbedder: createWebEmbedder,
    ...(__DUEL_LENS_DETECTOR__
      ? {
          loadCardDetector: async () =>
            (await createWebCardDetector(opts.detectorWebGpu ? {} : { webgpu: false })).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence }),
        }
      : {}),
  });
  return createOffscreenHandler({
    modelId: spec.id,
    // Only the extension's own messages are answered (handler.ts; security review M2).
    extension: { id: chrome.runtime.id, baseUrl: chrome.runtime.getURL('') },
    decode: decodeDataUrl,
    ...loaders,
  });
}
