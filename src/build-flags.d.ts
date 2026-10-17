// Build-time flags, replaced by esbuild's `define` (build.mjs) and Vitest's (vitest.config.ts).

/**
 * True only in E2E builds (`node build.mjs --e2e`) and in unit tests. The test-only hooks it
 * guards (the service worker's `duelLensDebug`, the popover state mirrored onto page-readable
 * attributes) must not exist in a store build: esbuild drops the code behind `if (false)`.
 */
declare const __DUEL_LENS_E2E__: boolean;

/**
 * True in developer builds (`node build.mjs --dev`), E2E builds and unit tests. Guards developer-
 * only UI, e.g. the Options page's "save crops" debug section, which a store build must not ship
 * (the privacy disclosures don't cover it).
 */
declare const __DUEL_LENS_DEV__: boolean;

/**
 * Whether this build shows YGOPRODeck's official card images (images.ygoprodeck.com) and downloads
 * new cards' artwork for the self-updating index. True in every build, the store build included
 * (decision D2), and in unit tests; false only in the crop build (`--no-remote-images`), which shows
 * the user's own crop instead, keeps the bundled artwork index only, and asks for no access to
 * images.ygoprodeck.com (legal-audit.md B2, decisions D2 and D3). Unit tests stub the global to test
 * the crop build: read it where it's used, not at module load.
 */
declare const __DUEL_LENS_REMOTE_IMAGES__: boolean;

/**
 * Whether this build ships Duel Lens's card detector (models/detector/card-detector.onnx) and
 * registers it: click to scan's outlines, and the card found in every scan's crop. True in every
 * build and in unit tests; false only with `node build.mjs --no-detector` (a checkout without the
 * model: tools/train-detector/README.md rebuilds it), whose click to scan answers "no card detector in
 * this build" and whose scans match the user's box as drawn.
 */
declare const __DUEL_LENS_DETECTOR__: boolean;

/**
 * True only in the Firefox build (`node build.mjs --target firefox`); false in Chrome's and in unit
 * tests (a test stubs it to test the Firefox path: read it where it's used, not at module load).
 * Firefox has no chrome.offscreen, so its engine runs in the event page itself
 * (src/background/offscreen-client.ts, src/offscreen/in-page.ts), and while scan mode is open the
 * content script pings so that page isn't suspended (src/content/keep-alive.ts). The Chrome build
 * ships none of that code.
 */
declare const __DUEL_LENS_FIREFOX__: boolean;

/**
 * True only in the Opera build (`node build.mjs --target opera`); false everywhere else and in unit
 * tests. addons.opera.com refuses raw binary files, so that build ships every .bin, .onnx and .wasm as
 * base64 text and its offscreen document is src/offscreen/opera.ts, which decodes and checks them
 * (src/offscreen/packed-assets.ts). The flag guards that entry; the other builds never bundle it, so
 * their bundles are byte for byte what they were before the Opera build existed.
 */
declare const __DUEL_LENS_OPERA__: boolean;
