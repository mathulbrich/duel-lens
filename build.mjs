// Bundles the extension into dist/ (load it unpacked from chrome://extensions).
// Usage: node build.mjs [--watch] [--e2e] [--dev] [--no-remote-images] [--sourcemap] [--no-detector]
//                       [--out <dir>] [--help]
//   Every build shows YGOPRODeck's official card images and downloads new cards' artwork for the
//          artwork index (decision D2). images.ygoprodeck.com sends no CORS headers, so the manifest
//          asks for host access to https://images.ygoprodeck.com/*, the store build's included.
//   --watch  rebuilds the bundles on every source change (static files are copied once).
//   --e2e  builds into dist-e2e/ with host permission <all_urls>, because automated tests
//          cannot press the keyboard shortcut that normally grants activeTab.
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
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAGS = new Set(['--watch', '--e2e', '--dev', '--remote-images', '--no-remote-images', '--sourcemap', '--no-detector']);

/**
 * The command line, checked before anything is deleted or built: { flags, out, help, error }. `out` is
 * --out's folder (null without it); `error` says what's wrong (an unknown option, --out without a
 * folder, contradictory options). Tests: tools/release.test.ts, "build.mjs's command line".
 */
function parseArgs(argv) {
  const flags = new Set();
  let out = null;
  let help = false;
  let error;
  for (let i = 0; i < argv.length && error === undefined; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') help = true;
    else if (FLAGS.has(arg)) flags.add(arg);
    else if (arg === '--out') {
      out = argv[++i] ?? '';
      if (!out || out.startsWith('-')) error = '--out needs a folder: --out <dir>';
    } else error = `Unknown option: ${arg}`;
  }
  if (error === undefined && flags.has('--remote-images') && flags.has('--no-remote-images')) {
    error = '--remote-images and --no-remote-images contradict each other';
  }
  return { flags, out, help, error };
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
// Official card images and artwork downloads (images.ygoprodeck.com), in every build but the crop
// build (decision D2; the usage above). --remote-images, the default, changes nothing.
const remoteImages = !cli.flags.has('--no-remote-images');
const IMAGES_HOST = 'https://images.ygoprodeck.com/*';
const root = path.dirname(new URL(import.meta.url).pathname);
const dist = cli.out === null ? path.join(root, e2e ? 'dist-e2e' : 'dist') : path.resolve(cli.out);

// --out: the folder is emptied first, so it must be new, empty or hold a previous build.
async function assertOutFolderIsFree() {
  if (cli.out === null) return;
  const found = existsSync(dist) ? await readdir(dist) : [];
  const previousBuild = found.includes('manifest.json') && found.includes('background.js');
  if (found.length > 0 && !previousBuild) {
    throw new Error(`--out "${cli.out}" must name a new, empty or previous build folder (it is emptied first)`);
  }
}

// ONNX Runtime Web files the engine loads at runtime (copied to dist/ort/). The engine
// imports the WASM-only runtime (`onnxruntime-web/wasm`), which loads exactly these two.
const ORT_FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

// The card detector's model (src/offscreen/detector/spec.ts: CARD_DETECTOR.dir and .file), shipped in
// every build but a --no-detector one.
const DETECTOR_MODEL = 'models/detector/card-detector.onnx';

const common = {
  bundle: true,
  // Source maps are opt-in (they must not ship: tools/release.mjs).
  sourcemap: cli.flags.has('--sourcemap') ? 'linked' : false,
  target: 'chrome124',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  // __DUEL_LENS_DEV__: developer-only UI (e.g. Options' "save crops" debug section) for --dev and E2E
  // builds; store builds ship neither flag's code (src/build-flags.d.ts).
  // __DUEL_LENS_REMOTE_IMAGES__: YGOPRODeck's card images and artwork downloads (remoteImages above:
  // every build but --no-remote-images, the crop build).
  // __DUEL_LENS_DETECTOR__: the card detector is registered (every build but --no-detector).
  define: {
    'process.env.NODE_ENV': '"production"',
    __DUEL_LENS_E2E__: String(e2e),
    __DUEL_LENS_DEV__: String(e2e || dev),
    __DUEL_LENS_REMOTE_IMAGES__: String(remoteImages),
    __DUEL_LENS_DETECTOR__: String(withDetector),
  },
  logLevel: 'info',
};

// Entry points that exist only once their owner writes them are skipped until then.
const entries = [
  { in: 'src/background/index.ts', out: 'background', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content', format: 'iife' },
  { in: 'src/offscreen/index.ts', out: 'offscreen', format: 'esm' },
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
  if (e2e || remoteImages) {
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
    await writeFile(file, JSON.stringify(manifest, null, 2));
  }
  console.log(`card images: ${remoteImages ? "YGOPRODeck's (images.ygoprodeck.com)" : "the user's own crop (no remote images)"}`);
  // The third-party notices and the project's licence ship in the package (legal-audit.md B3); the
  // Licences page (licenses.html) shows them. The notices' <!-- maintainer comments --> stay behind.
  const notices = await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  await writeFile(path.join(dist, 'THIRD_PARTY_NOTICES.md'), notices.replace(/<!--[\s\S]*?-->\n*/g, ''));
  if (existsSync(path.join(root, 'LICENSE'))) await cp(path.join(root, 'LICENSE'), path.join(dist, 'LICENSE'));
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
    console.log(`built ${entries.length} entries into ${path.relative(root, dist)}/`);
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
