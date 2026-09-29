// Offscreen document entry (offscreen.html → offscreen.js): answers ToOffscreen messages from
// the background service worker, loading on first use only what each message needs
// (loaders.ts): the whole engine for a scan, the index metadata for index-missing, the
// embedding model for embed-artworks.
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
    ? { loadCardDetector: async () => (await createWebCardDetector()).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence }) }
    : {}),
});

chrome.runtime.onMessage.addListener(
  createOffscreenHandler({
    modelId: spec.id,
    // Only the service worker's messages are answered (handler.ts; security review M2).
    extension: { id: chrome.runtime.id, baseUrl: chrome.runtime.getURL('') },
    decode: decodeDataUrl,
    ...loaders,
  }),
);
