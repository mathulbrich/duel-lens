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
