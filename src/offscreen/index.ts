// Offscreen document entry (offscreen.html → offscreen.js), Chrome's engine: answers ToOffscreen
// messages from the background service worker (engine-handler.ts). Firefox has no offscreen document:
// its engine runs in the event page (in-page.ts).
import { createEngineHandler } from './engine-handler';

chrome.runtime.onMessage.addListener(createEngineHandler({ detectorWebGpu: true }));
