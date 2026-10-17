// Bundles the extension into dist/ (load it unpacked from chrome://extensions).
// Usage: node build.mjs [--target chrome|firefox|opera] [--watch] [--e2e] [--dev] [--no-remote-images] [--sourcemap]
//                       [--no-detector] [--out <dir>] [--help]
//   --target  the browser: chrome (the default: Chrome, Edge, Opera) or firefox (Firefox 140 or later:
//          an event page instead of the service worker, the engine in that page instead of an
//          offscreen document, Firefox's sidebar, and the add-on id and data-collection declaration
//          AMO requires; src/build-flags.d.ts __DUEL_LENS_FIREFOX__). A Firefox build goes into
//          dist-firefox/ (dist-firefox-e2e/ with --e2e) unless --out says otherwise.
//          opera: Chrome's build, except that every .bin, .onnx and .wasm ships as base64 text
//          (<file>.b64.txt) with packed-assets.json (each original's size and SHA-256), because
//          addons.opera.com refuses raw binary files ("Invalid type on file"); its offscreen document
//          (src/offscreen/opera.ts, __DUEL_LENS_OPERA__) decodes and checks them. Into dist-opera/
//          (dist-opera-e2e/ with --e2e) unless --out says otherwise. store/opera.md.
//   Every build shows YGOPRODeck's official card images and downloads new cards' artwork for the
//          artwork index (decision D2). images.ygoprodeck.com sends no CORS headers, so the manifest
//          asks for host access to https://images.ygoprodeck.com/*, the store build's included.
//   --watch  rebuilds the bundles on every source change (static files are copied once).
//   --e2e  builds into dist-e2e/ with host permission <all_urls>, because automated tests
//          cannot press the keyboard shortcut that normally grants activeTab. With --target firefox it
//          also adds the E2E bridge (src/background/e2e-bridge.ts) as a content script on
//          http://127.0.0.1/*, the only way test/e2e/firefox.ts reaches the event page.
//   --dev  adds the developer-only UI (the Options page's debug section).
//   --no-remote-images  the crop build instead: the popover and the side panel show the user's own
//          crop, no card image or artwork is downloaded (the bundled artwork index only), and the
//          manifest asks for no host permission. For a rollback, or to test that mode.
//   --remote-images  the default; still accepted, so older commands keep working.
//   --sourcemap  also writes source maps (they must not ship: tools/release.mjs).
//   --no-detector  builds without the card detector (extension/models/detector/card-detector.onnx;
//          tools/train-detector/README.md rebuilds it): click to scan stays off ("no card detector in
//          this build") and scans match the user's box as drawn. Every other build ships the detector
//          and stops if its model is missing.
//   --out <dir>  builds into <dir> instead of dist/ (npm run release builds release/build/, so dist/
//          stays the installed build). The folder is emptied first, so it must be new, empty or hold
//          a previous build.
//   --help, -h  prints this and exits. An unknown option prints it and exits 1, before anything is
//          deleted or built.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAGS = new Set(['--watch', '--e2e', '--dev', '--remote-images', '--no-remote-images', '--sourcemap', '--no-detector']);

/**
 * The command line, checked before anything is deleted or built: { flags, out, target, help, error }.
 * `out` is --out's folder (null without it); `target` is 'chrome' or 'firefox'; `error` says what's
 * wrong (an unknown option, --out without a folder, an unknown --target, contradictory options). Tests: tools/release.test.ts, "build.mjs's command line".
 */
const TARGETS = new Set(['chrome', 'firefox', 'opera']);

function parseArgs(argv) {
  const flags = new Set();
  let out = null;
  let target = 'chrome';
  let help = false;
  let error;
  for (let i = 0; i < argv.length && error === undefined; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (FLAGS.has(arg)) flags.add(arg);
    else if (arg === '--out') {
      out = argv[++i] ?? '';
      if (!out || out.startsWith('-')) error = '--out needs a folder: --out <dir>';
    } else if (arg === '--target') {
      target = argv[++i] ?? '';
      if (!TARGETS.has(target)) error = `--target needs a browser: --target chrome, firefox or opera (not "${target}")`;
    } else error = `Unknown option: ${arg}`;
  }
  if (error === undefined && flags.has('--remote-images') && flags.has('--no-remote-images')) {
    error = '--remote-images and --no-remote-images contradict each other';
  }
  return { flags, out, target, help, error };
}

/** The usage: this file's header comment. */
function usage() {
  const header = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/^(?:\/\/.*\n)+/)?.[0] ?? '';
  return header.replace(/^\/\/ ?/gm, '').trimEnd();
}

const cli = parseArgs(process.argv.slice(2));
const watch = cli.flags.has('--watch');
const e2e = cli.flags.has('--e2e');
const dev = cli.flags.has('--dev');
const withDetector = !cli.flags.has('--no-detector');
// --target firefox: Firefox's own manifest and engine seam (firefoxManifest below; src/build-flags.d.ts).
const firefox = cli.target === 'firefox';
// --target opera: Chrome's build with its raw binary files packed as base64 text (packBinaryFiles below).
const opera = cli.target === 'opera';
// Official card images and artwork downloads (images.ygoprodeck.com), in every build but the crop
// build (decision D2; the usage above). --remote-images, the default, changes nothing.
const remoteImages = !cli.flags.has('--no-remote-images');
const IMAGES_HOST = 'https://images.ygoprodeck.com/*';
const root = path.dirname(new URL(import.meta.url).pathname);
const defaultOut = `dist${firefox ? '-firefox' : opera ? '-opera' : ''}${e2e ? '-e2e' : ''}`;
const dist = cli.out === null ? path.join(root, defaultOut) : path.resolve(cli.out);

// --out: the folder is emptied first, so it must be new, empty or hold a previous build.
async function assertOutFolderIsFree() {
  if (cli.out === null) return;
  const found = existsSync(dist) ? await readdir(dist) : [];
  const previousBuild = found.includes('manifest.json') && found.includes('background.js');
  if (found.length > 0 && !previousBuild) {
    throw new Error(`--out "${cli.out}" must name a new, empty or previous build folder (it is emptied first)`);
  }
}

// ONNX Runtime Web files the engine loads at runtime (copied to dist/ort/): the WebGPU build, which
// `onnxruntime-web/webgpu` loads (the embedder and the card detector when the browser has a WebGPU
// adapter), and the WASM build, which `onnxruntime-web/wasm` loads (without one, or when WebGPU fails;
// src/offscreen/web-runtime.ts createModelSession). Its JSEP and JSPI builds are never loaded and don't ship.
// tools/release.mjs ORT_FILES checks a release ships exactly these.
const ORT_FILES = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];

// The card detector's model (src/offscreen/detector/spec.ts: CARD_DETECTOR.dir and .file), shipped in
// every build but a --no-detector one.
const DETECTOR_MODEL = 'models/detector/card-detector.onnx';

const common = {
  bundle: true,
  // Source maps are opt-in (they must not ship: tools/release.mjs).
  sourcemap: cli.flags.has('--sourcemap') ? 'linked' : false,
  target: firefox ? 'firefox140' : 'chrome124',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // __DUEL_LENS_DEV__: developer-only UI (e.g. Options' "save crops" debug section) for --dev and E2E
  // builds; store builds ship neither flag's code (src/build-flags.d.ts).
  // __DUEL_LENS_REMOTE_IMAGES__: YGOPRODeck's card images and artwork downloads (remoteImages above:
  // every build but --no-remote-images, the crop build).
  // __DUEL_LENS_DETECTOR__: the card detector is registered (every build but --no-detector).
  // __DUEL_LENS_FIREFOX__: the Firefox build (--target firefox): the in-page engine and the keep-alive.
  // __DUEL_LENS_OPERA__: the Opera build (--target opera): its offscreen entry, src/offscreen/opera.ts.
  define: {
    'process.env.NODE_ENV': '"production"',
    __DUEL_LENS_E2E__: String(e2e),
    __DUEL_LENS_DEV__: String(e2e || dev),
    __DUEL_LENS_REMOTE_IMAGES__: String(remoteImages),
    __DUEL_LENS_DETECTOR__: String(withDetector),
    __DUEL_LENS_FIREFOX__: String(firefox),
    __DUEL_LENS_OPERA__: String(opera),
  },
  logLevel: 'info',
};

// Entry points that exist only once their owner writes them are skipped until then.
// The engine: Chrome's offscreen document (offscreen.html, offscreen.js), or in Firefox, which has no
// chrome.offscreen, engine.js, which the event page imports at its first engine request
// (src/background/offscreen-client.ts, src/offscreen/in-page.ts).
const entries = [
  { in: 'src/background/index.ts', out: 'background', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content', format: 'iife' },
  // Opera's offscreen document is Chrome's with packedFetch in front of fetch (src/offscreen/opera.ts).
  firefox
    ? { in: 'src/offscreen/in-page.ts', out: 'engine', format: 'esm' }
    : { in: opera ? 'src/offscreen/opera.ts' : 'src/offscreen/index.ts', out: 'offscreen', format: 'esm' },
  ...(firefox && e2e ? [{ in: 'src/background/e2e-bridge.ts', out: 'e2e-bridge', format: 'iife' }] : []),
  { in: 'src/sidepanel/index.tsx', out: 'sidepanel', format: 'esm' },
  { in: 'src/options/index.tsx', out: 'options', format: 'esm' },
  { in: 'src/welcome/index.tsx', out: 'welcome', format: 'esm' },
  // privacy.html and licenses.html (the bundled privacy policy and licences; src/legal/index.tsx).
  { in: 'src/legal/index.tsx', out: 'legal', format: 'esm' },
].filter((e) => existsSync(path.join(root, e.in)));

// Only the default model and its index ship; other models in extension/models/ stay out of the build.
async function defaultModelFiles() {
  const src = await readFile(path.join(root, 'src/shared/models.ts'), 'utf8');
  const id = src.match(/DEFAULT_MODEL_ID\s*=\s*'([^']+)'/)?.[1];
  const block = id && src.match(new RegExp(`'${id}':\\s*\\{([\\s\\S]*?)\\n  \\},`))?.[1];
  const file = block?.match(/\bfile:\s*'([^']+)'/)?.[1];
  if (!id || !file) throw new Error('Could not read DEFAULT_MODEL_ID and its file from src/shared/models.ts');
  // 'local: …' marks a model built on this machine (tools/train), which fetch-models can't download.
  const local = /\bsourceUrl:\s*'local:/.test(block);
  return { id, file, local };
}

// The card detector's model is built locally by tools/train-detector and kept with the source
// (.gitignore re-includes it). A build without it would ship an extension whose click to scan and
// card finding fail at the first shortcut, so stop here unless --no-detector says to build without it.
function assertDetectorModelExists() {
  if (!withDetector) return;
  const file = path.join(root, 'extension', DETECTOR_MODEL);
  if (existsSync(file)) return;
  throw new Error(
    `Missing the card detector's model: extension/${DETECTOR_MODEL}. Every build ships it (click to scan, and the card ` +
      'found in every scan). Restore it from version control or copy it from a machine that has it (6.2 MB; its SHA-256 ' +
      'is in docs/DEVELOPMENT.md, "Models"), or rebuild it with tools/train-detector (tools/train-detector/README.md, "Pipeline": ' +
      'train, then final-eval.sh installs it). Or build without it: node build.mjs --no-detector (drag only, no click to scan).',
  );
}

// The model itself is fetched or built locally (kept with the source only for the default model);
// its index is committed (see docs/DEVELOPMENT.md, "Models") but matches only that exact model file - fail loudly
// here rather than let `cp`'s filter silently skip a missing model and ship a dist/ that
// fails at the user's first scan with a cryptic "models/... is missing".
async function assertModelFilesExist(model) {
  const required = [
    path.join(root, 'extension/models', model.file),
    path.join(root, 'extension/data', `index-${model.id}.bin`),
    path.join(root, 'extension/data', `index-${model.id}.meta.json`),
  ];
  const missing = required.filter((f) => !existsSync(f)).map((f) => path.relative(root, f));
  if (missing.length > 0) {
    const getModel = model.local
      ? `build extension/models/${model.file} with tools/train (see tools/train/README.md) or copy it from a machine that has it`
      : `run "npx tsx tools/fetch-models.ts" (needs Python with the onnx package)`;
    throw new Error(
      `Missing model/index file(s) for the default model (${model.id}): ${missing.join(', ')}. ` +
        `To get the model, ${getModel}; then run "npx tsx tools/build-index.ts --model ${model.id}" for its index.`,
    );
  }
}

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  const model = await defaultModelFiles();
  await assertModelFilesExist(model);
  assertDetectorModelExists();
  const keep = (src) => {
    const rel = path.relative(path.join(root, 'extension'), src).split(path.sep).join('/');
    // Of models/, only the default embedding model's file and the card detector's: no other model
    // or model file ever ships.
    if (withDetector && (rel === 'models/detector' || rel === DETECTOR_MODEL)) return true;
    if (rel.startsWith('models/') && rel !== `models/${model.file}`) return false;
    // Firefox has no offscreen document: its engine runs in the event page (engine.js).
    if (firefox && rel === 'offscreen.html') return false;
    if (/^data\/index-/.test(rel) && !rel.startsWith(`data/index-${model.id}.`)) return false;
    return true;
  };
  await cp(path.join(root, 'extension'), dist, { recursive: true, filter: keep });
  console.log(`model: ${model.id} (${model.file})`);
  console.log(`card detector: ${withDetector ? DETECTOR_MODEL : 'none (--no-detector: drag only, no click to scan)'}`);
  // ONNX Runtime Web loads its .wasm and .mjs loader at runtime from ort/ (never from a CDN).
  const ortDir = path.join(root, 'node_modules/onnxruntime-web/dist');
  const ortOut = path.join(dist, 'ort');
  await mkdir(ortOut, { recursive: true });
  const available = new Set(await readdir(ortDir));
  for (const f of ORT_FILES) {
    if (!available.has(f)) throw new Error(`onnxruntime-web is missing ${f}; update ORT_FILES in build.mjs`);
    await cp(path.join(ortDir, f), path.join(ortOut, f));
  }
  if (e2e || remoteImages || firefox) {
    const file = path.join(dist, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const hosts = [...(manifest.host_permissions ?? [])];
    // images.ygoprodeck.com sends no CORS headers: reading its images needs host access. The crop
    // build asks for none (the card data API, db.ygoprodeck.com, allows any origin).
    if (remoteImages) hosts.push(IMAGES_HOST);
    if (e2e) {
      manifest.name = 'Duel Lens (E2E)';
      hosts.push('<all_urls>');
    }
    manifest.host_permissions = [...new Set(hosts)];
    await writeFile(file, JSON.stringify(firefox ? firefoxManifest(manifest) : manifest, null, 2));
  }
  console.log(`card images: ${remoteImages ? "YGOPRODeck's (images.ygoprodeck.com)" : "the user's own crop (no remote images)"}`);
  // The third-party notices and the project's licence ship in the package (legal-audit.md B3); the
  // Licences page (licenses.html) shows them. The notices' <!-- maintainer comments --> stay behind.
  const notices = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  await writeFile(path.join(dist, 'THIRD_PARTY_NOTICES.md'), notices.replace(/<!--[\s\S]*?-->\n*/g, ''));
  if (existsSync(path.join(root, 'LICENSE'))) await cp(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
  if (opera) await packBinaryFiles();
}

/**
 * The raw binary files the Opera build packs as base64 text (src/offscreen/packed-assets.ts PACKED_TYPES):
 * the index, both models and ONNX Runtime's two .wasm. Fonts and images aren't raw binaries to Opera's
 * validator and stay as they are.
 */
const PACKED_TYPES = /\.(bin|onnx|wasm)$/i;

/**
 * --target opera: addons.opera.com refuses raw binary files ("Invalid type on file:
 * data/index-dinov2-small-duel-v3b.bin"; Opera publishes no list of allowed types and appears to judge a
 * file by its content too), so each .bin, .onnx and .wasm in the build becomes <file>.b64.txt, base64 in
 * 76-character lines, and packed-assets.json lists every original's size and SHA-256, in path order.
 * The offscreen document decodes them and checks both (src/offscreen/packed-assets.ts); tools/release.mjs
 * verifyBuild decodes them too and checks the models against MODEL_SHA256's pins.
 */
async function packBinaryFiles() {
  const files = {};
  const found = (await readdir(dist, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const rels = found.map((e) => path.relative(dist, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));
  for (const rel of rels.filter((r) => PACKED_TYPES.test(r)).sort()) {
    const abs = path.join(dist, rel);
    const bytes = await readFile(abs);
    files[rel] = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    const text = bytes.toString('base64').replace(/.{76}/g, '$&\n');
    await writeFile(`${abs}.b64.txt`, text.endsWith('\n') ? text : `${text}\n`);
    await rm(abs);
  }
  const manifest = { encoding: 'base64', suffix: '.b64.txt', files };
  await writeFile(path.join(dist, 'packed-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`packed for Opera: ${Object.keys(files).length} binary files as base64 text (packed-assets.json)`);
}

/**
 * The add-on's id on addons.mozilla.org (browser_specific_settings.gecko.id): fixed for good once
 * listed, since Firefox updates an add-on by it. tools/release.mjs FIREFOX_ID checks it.
 */
const FIREFOX_ID = 'duel-lens@mathulbrich.github.io';

/**
 * Chrome's manifest (extension/manifest.json), made Firefox's (--target firefox). Firefox 156 loads the
 * result with 0 warnings (firefox-spike.md §1; tools/release.mjs checks it again in Firefox):
 * - an event page (Firefox MV3 has no extension service worker), which also runs the engine, since
 *   there is no chrome.offscreen: the offscreen and sidePanel permissions and the side_panel key go;
 * - Firefox's sidebar shows the side panel's page (src/background/panel.ts opens it);
 * - keys Firefox warns about go: minimum_chrome_version (strict_min_version says it instead),
 *   cross_origin_embedder_policy and cross_origin_opener_policy (an extension page can't be
 *   cross-origin isolated there, so ONNX Runtime runs one WASM thread), and use_dynamic_url;
 * - the add-on id, Firefox 140 or later (the first with built-in data consent), and the
 *   data-collection declaration AMO requires (decision D-FF4): nothing is collected; the opt-in AI
 *   check, which sends the card's crop to Anthropic when the user asks, is optional
 *   "websiteContent", which Options requests with the api.anthropic.com host (src/shared/hosts.ts).
 * E2E builds add the bridge content script on the test's local board (src/background/e2e-bridge.ts).
 */
function firefoxManifest(chromeManifest) {
  const m = structuredClone(chromeManifest);
  m.background = { scripts: ['background.js'], type: 'module' };
  m.permissions = (m.permissions ?? []).filter((p) => p !== 'offscreen' && p !== 'sidePanel');
  delete m.side_panel;
  delete m.minimum_chrome_version;
  delete m.cross_origin_embedder_policy;
  delete m.cross_origin_opener_policy;
  for (const war of m.web_accessible_resources ?? []) delete war.use_dynamic_url;
  m.sidebar_action = {
    default_panel: 'sidepanel.html',
    default_title: m.short_name ?? m.name,
    default_icon: m.action?.default_icon,
    open_at_install: false,
  };
  if (e2e) m.content_scripts = [{ matches: ['http://127.0.0.1/*'], js: ['e2e-bridge.js'], run_at: 'document_start' }];
  m.browser_specific_settings = {
    gecko: {
      id: FIREFOX_ID,
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'], optional: ['websiteContent'] },
    },
  };
  return m;
}

async function build() {
  await assertOutFolderIsFree();
  if (!watch) await rm(dist, { recursive: true, force: true });
  await copyStatic();

  const contexts = await Promise.all(
    entries.map((e) =>
      esbuild.context({
        ...common,
        entryPoints: { [e.out]: path.join(root, e.in) },
        outdir: dist,
        format: e.format,
      }),
    ),
  );

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching… (static files are copied once; re-run for manifest/asset changes)');
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
    console.log(`built ${entries.length} entries into ${path.relative(root, dist)}/${firefox ? ' (Firefox)' : opera ? ' (Opera)' : ''}`);
  }
}

// --help, or a command line with a mistake: the usage, and nothing is deleted or built.
if (cli.error !== undefined) {
  console.error(`${cli.error}\n\n${usage()}`);
  process.exitCode = 1;
} else if (cli.help) {
  console.log(usage());
} else {
  await build();
}
