// Firefox's engine (build.mjs --target firefox → engine.js): Firefox has no chrome.offscreen, but its
// MV3 background is an event page with a DOM, so the engine runs there. The event page imports this
// file at its first engine request (src/background/offscreen-client.ts toEngine), never when it wakes,
// and calls handle() directly: a page's own runtime.sendMessage never reaches its own listeners.
// Every queue, timeout and check of the offscreen handler applies as in Chrome.
import { createEngineHandler } from './engine-handler';

// The detector on WASM, the embedder on WebGPU when Firefox offers an adapter (decision D-FF1;
// engine-handler.ts EngineOptions).
const listener = createEngineHandler({ detectorWebGpu: false });
// The event page itself, as the handler's sender check sees it: one of the extension's own pages.
const self = { id: chrome.runtime.id, url: location.href } as chrome.runtime.MessageSender;

/** One ToOffscreen message, answered as the offscreen document's listener answers it (undefined: not the engine's). */
export function handle(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (!listener(msg, self, resolve)) resolve(undefined);
  });
}
