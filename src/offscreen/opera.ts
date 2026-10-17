// Opera's offscreen document (offscreen.html → offscreen.js in build.mjs --target opera, instead of
// index.ts): Chrome's engine, with packedFetch in front of fetch, because that build ships its .bin,
// .onnx and .wasm as base64 text, which addons.opera.com accepts (packed-assets.ts; store/opera.md).
// index.ts only registers the message listener, so fetch is wrapped before the first message comes.
import './index';
import { installPackedFetch } from './packed-assets';

if (__DUEL_LENS_OPERA__) installPackedFetch(globalThis, chrome.runtime.getURL(''));
