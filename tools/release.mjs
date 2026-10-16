// Cuts a Chrome Web Store release of Duel Lens (how and why: docs/release/packaging.md), or with
// --firefox an addons.mozilla.org one (store/firefox.md).
//
//   npm run release                       checks, production build, verification, zip: the store build,
//                                         with YGOPRODeck's official card images (decision D2)
//   npm run release -- --firefox          the Firefox release: the XPI, the source zip AMO's reviewers
//                                         rebuild it from, and their README (see "Firefox" below)
//   npm run release -- --skip-e2e         the same without the end-to-end test
//   npm run release -- --sourcemap        also ships source maps (off by default: they aren't for users)
//   npm run release -- --no-remote-images the crop build instead: the user's own crop, no host permission
//   (--remote-images, the default, is still accepted.)
//
// 1. Checks, stopping at the first failure: npx tsc --noEmit, npx vitest run, and the E2E fixture
//    test (npx tsx test/e2e/run.ts, which builds its own dist-e2e/).
// 2. Build: node build.mjs --out release/build. dist/, the build the user has installed, is untouched.
// 3. Verification of release/build/ (verifyBuild): errors stop the release, warnings are listed.
// 4. Zip: release/duel-lens-<version>.zip with the build's files at the zip root, as the Web Store
//    expects, and its SHA-256 in release/duel-lens-<version>.zip.sha256. Entries are sorted and
//    dated 2000-01-01, so the same build always gives the same zip, byte for byte.
// 5. Summary.
// Firefox (--firefox): the E2E test is test/e2e/firefox.ts; the build is node build.mjs --target firefox
// --out release/build-firefox; verifyBuild checks Firefox's manifest too, and Firefox itself loads the build
// and must record 0 warnings (firefoxManifestReport; skipped, with a warning, without Firefox); the XPI is
// release/duel-lens-<version>-firefox.xpi; the source zip release/duel-lens-<version>-source.zip holds the
// sources, the lockfile, the shipped models and a README-AMO.md (sourceFiles, reviewerReadme), and the
// release rebuilds the XPI's files from it, byte for byte (rebuildFromSource).
// Running this file runs the release; importing it only exports the pieces (for tests).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const buildDir = path.join(releaseDir, 'build');
/** The Firefox release's build (--firefox), and where its source zip is rebuilt to check it. */
const firefoxBuildDir = path.join(releaseDir, 'build-firefox');
const sourceCheckDir = path.join(releaseDir, 'source-check');
/** AMO's limit for the source archive. */
export const SOURCE_ZIP_MAX_MB = 200;

// Size budget: over it is a warning, never an error. 0.9.0 is about 62.5 MB unpacked: the embedding
// model 25.7 MB, ONNX Runtime's wasm 14.2 MB, the card data 8.6 MB, the card detector 6.2 MB and the
// artwork index 6.2 MB; offscreen.js is 0.2 MB since OpenCV.js went (it was 17.9 MB). The WebGPU build of
// ONNX Runtime (2026-10-09) adds 26.8 MB (ORT_FILES).
export const WARN_TOTAL_MB = 100;
export const WARN_FILE_MB = 30;

const CHECKS = [
  { name: 'tsc', cmd: ['npx', 'tsc', '--noEmit'] },
  { name: 'vitest', cmd: ['npx', 'vitest', 'run'] },
  { name: 'e2e', cmd: ['npx', 'tsx', 'test/e2e/run.ts'] },
];
/** The Firefox release's checks: its own E2E test (test/e2e/firefox.ts, which builds dist-firefox-e2e/). */
const FIREFOX_CHECKS = [CHECKS[0], CHECKS[1], { name: 'e2e', cmd: ['npx', 'tsx', 'test/e2e/firefox.ts'] }];

const FLAGS = {
  '--firefox': 'the Firefox release: XPI, AMO source zip and reviewer README (store/firefox.md)',
  '--skip-e2e': 'skip the end-to-end test (the summary says so)',
  '--sourcemap': 'build and ship source maps',
  '--no-remote-images': "the crop build: the user's own crop instead of YGOPRODeck's card images, and no host permission",
  '--remote-images': 'the default (official card images, decision D2); still accepted',
  '--help': 'show this help',
};

/** YGOPRODeck's image host, which the default build asks for: it sends no CORS headers (decision D2). */
export const IMAGES_HOST = 'https://images.ygoprodeck.com/*';
/** The Anthropic API: an optional host, requested only when the user turns on the AI check. */
export const ANTHROPIC_HOST = 'https://api.anthropic.com/*';

/** The Firefox add-on's id (build.mjs FIREFOX_ID): AMO updates the add-on by it, so it never changes. */
export const FIREFOX_ID = 'duel-lens@mathulbrich.github.io';
/** The oldest Firefox the build supports: the first with built-in data-collection consent (AMO requires it). */
export const FIREFOX_MIN_VERSION = '140.0';
/**
 * The data-collection declaration (decision D-FF4): nothing is collected; the opt-in AI check sends the
 * card's crop to Anthropic only when the user asks, as optional "websiteContent".
 */
export const FIREFOX_DATA_COLLECTION = { required: ['none'], optional: ['websiteContent'] };
/**
 * Chrome's manifest keys and permissions Firefox records a warning for (firefox-spike.md §1); build.mjs
 * --target firefox leaves them out.
 */
const FIREFOX_WARNS = [
  ['cross_origin_embedder_policy', (m) => 'cross_origin_embedder_policy' in m],
  ['cross_origin_opener_policy', (m) => 'cross_origin_opener_policy' in m],
  ['side_panel', (m) => 'side_panel' in m],
  ['permissions: offscreen', (m) => (m.permissions ?? []).includes('offscreen')],
  ['permissions: sidePanel', (m) => (m.permissions ?? []).includes('sidePanel')],
  ['web_accessible_resources[].use_dynamic_url', (m) => (m.web_accessible_resources ?? []).some((w) => 'use_dynamic_url' in w)],
  ['background.service_worker', (m) => m.background?.service_worker !== undefined],
];

/** Files in a build that must never ship. */
const DEV_FILES = [
  [/\.map$/, 'a source map'],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, 'a test file'],
  [/(^|\/)(tests?|__tests__|__measure__|fixtures?|e2e)\//, 'test or fixture data'],
  [/\.([cm]?ts|tsx)$/, 'TypeScript source'],
  [/\.(log|tsbuildinfo|pyc?|ipynb|orig|rej|swp)$|~$/, 'a dev or editor file'],
  [/(^|\/)(\.env[^/]*|\.npmrc|package(-lock)?\.json|\.git[^/]*)$|(^|\/)(node_modules|\.git)\//, 'a dev file'],
];
/** Modules that must never be bundled (esbuild names each bundled module in a `// path` comment). */
const DEV_MODULE =
  /\.(test|spec)\.|test-fixtures|__measure__|^(test|tools)\/|(^|\/)node_modules\/(vitest|@vitest|@testing-library|happy-dom|fake-indexeddb|puppeteer|onnxruntime-node|sharp)\//;
/**
 * The card detector's model (src/offscreen/detector/spec.ts): click to scan and every scan's card
 * finding need it, so every release ships it (build.mjs refuses to build without it, bar --no-detector).
 */
export const DETECTOR_MODEL = 'models/detector/card-detector.onnx';
/** The default embedding model's file (src/shared/models.ts: DEFAULT_MODEL_ID's `file`), as it ships. */
export const EMBEDDER_MODEL = 'models/dinov2-small-duel-v3b.q8.onnx';
/**
 * The SHA-256 of every model a release ships, pinned as docs/DEVELOPMENT.md ("Models") records them: a swapped or
 * corrupted .onnx must not ship silently (security review L2). When a model is deliberately retrained, or
 * the default embedding model changes, update this and docs/DEVELOPMENT.md together.
 */
export const MODEL_SHA256 = {
  [EMBEDDER_MODEL]: '4be9cf627538cbf5a352872670404cf81fca93ddcee7e039bfb5a110035936c9',
  [DETECTOR_MODEL]: '542a03b523cb1398a1b5437dae665908b3bdf61be9b30a2a52e7bcea25dce03c',
};
/**
 * The legal texts every release ships (legal-audit.md B3; RELEASE-CHECKLIST C19), each with what it is.
 * The project's own LICENSE (Apache-2.0, decision D1) is required too.
 */
const LEGAL_FILES = {
  'THIRD_PARTY_NOTICES.md': 'the third-party licences, which licenses.html shows; build.mjs copies them from the project root',
  'privacy.html': 'the bundled privacy policy, which the welcome page and Options link to (src/legal)',
  'licenses.html': 'the bundled licences page (src/legal)',
};
/**
 * ONNX Runtime Web's files under ort/, which the offscreen document loads at runtime (build.mjs ORT_FILES):
 * the WebGPU build (onnxruntime-web/webgpu: both models on a WebGPU adapter) and the WASM build
 * (onnxruntime-web/wasm: without one, or when WebGPU fails). Each must ship, non-empty; any other
 * ORT build (JSEP, JSPI: 17-28 MB each) is dead weight and must not.
 */
export const ORT_FILES = [
  'ort/ort-wasm-simd-threaded.mjs',
  'ort/ort-wasm-simd-threaded.wasm',
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
];
/** OpenCV.js, which the extension dropped for its own card detector (a4-report.md), as esbuild names its module. */
const OPENCV_MODULE = /(^|\/)node_modules\/@techstark\/opencv-js\//;
/** Operating-system clutter: removed from release/build/ before verification, never shipped. */
const OS_JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/;
/** Code CDNs: the Web Store bans remotely hosted code, so naming one in a bundle deserves a look. */
const CODE_CDN = /https?:\/\/(cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev)\b[^\s"'`)]*/g;

const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1; // 2000-01-01, 00:00
const crc32 =
  zlib.crc32 ??
  ((buf) => {
    let c = ~0;
    for (const byte of buf) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  });

const byPath = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

export function human(bytes) {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} kB`;
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

/** Chrome's version format: 1 to 4 dot-separated integers, 0-65535, no leading zeros. */
export const isChromeVersion = (v) =>
  typeof v === 'string' && /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(v) && v.split('.').every((n) => Number(n) <= 65535);

/** Every file under `dir`, sorted, as '/'-separated paths relative to it. */
export async function listFiles(dir) {
  const files = [];
  for (const ent of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (ent.isDirectory()) continue;
    const abs = path.join(ent.parentPath ?? ent.path, ent.name);
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    files.push({ rel, abs, size: (await lstat(abs)).size, symlink: ent.isSymbolicLink() });
  }
  return files.sort(byPath);
}

/** Every extension file the manifest names, as [manifest key, path] (web_accessible_resources apart). */
function manifestRefs(m) {
  const refs = [];
  const add = (key, file) => typeof file === 'string' && refs.push([key, file.replace(/^\//, '')]);
  const addEach = (key, value) => {
    if (typeof value === 'string') add(key, value);
    else for (const [k, v] of Object.entries(value ?? {})) add(`${key}.${k}`, v);
  };
  add('background.service_worker', m.background?.service_worker);
  (m.background?.scripts ?? []).forEach((f) => add('background.scripts', f));
  add('sidebar_action.default_panel', m.sidebar_action?.default_panel);
  addEach('sidebar_action.default_icon', m.sidebar_action?.default_icon);
  addEach('icons', m.icons);
  addEach('action.default_icon', m.action?.default_icon);
  add('action.default_popup', m.action?.default_popup);
  add('side_panel.default_path', m.side_panel?.default_path);
  add('options_ui.page', m.options_ui?.page);
  add('options_page', m.options_page);
  add('devtools_page', m.devtools_page);
  addEach('chrome_url_overrides', m.chrome_url_overrides);
  (m.content_scripts ?? []).forEach((c, i) => [...(c.js ?? []), ...(c.css ?? [])].forEach((f) => add(`content_scripts[${i}]`, f)));
  (m.sandbox?.pages ?? []).forEach((f) => add('sandbox.pages', f));
  (m.declarative_net_request?.rule_resources ?? []).forEach((r) => add('declarative_net_request', r.path));
  add('storage.managed_schema', m.storage?.managed_schema);
  if (m.default_locale) add('default_locale', `_locales/${m.default_locale}/messages.json`);
  return refs;
}

const globToRegExp = (glob) =>
  new RegExp(`^${glob.replace(/^\//, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/** Width and height of a PNG, from its IHDR chunk. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** " (src/background/index.ts:106)": where a pattern first appears in the non-test sources, or "". */
async function sourceOf(re) {
  const src = path.join(root, 'src');
  if (!existsSync(src)) return '';
  for (const f of await listFiles(src)) {
    if (!/\.tsx?$/.test(f.rel) || /\.test\.|test-fixtures/.test(f.rel)) continue;
    const line = (await readFile(f.abs, 'utf8')).split('\n').findIndex((l) => re.test(l));
    if (line !== -1) return ` (src/${f.rel}:${line + 1})`;
  }
  return '';
}

/**
 * Checks a production build: a store-ready manifest whose files all exist, its hosts (YGOPRODeck's
 * image host unless it is the crop build, `remoteImages: false`; optionally Anthropic's; nothing else),
 * the legal texts (LEGAL_FILES and LICENSE), the card detector's model, every model
 * byte for byte the pinned one (`modelSha256`, MODEL_SHA256 unless a test says otherwise), no dev or
 * E2E artefacts, no DRAW2 (AGPL-3.0), no OpenCV.js, no path of this machine, and the size budget.
 * `target: 'firefox'` checks Firefox's manifest instead (verifyFirefoxManifest).
 * Returns { errors, warnings, files, total, manifest }; any error means "don't ship this".
 */
export async function verifyBuild(dir, { sourcemap = false, remoteImages = true, modelSha256 = MODEL_SHA256, target = 'chrome' } = {}) {
  const errors = [];
  const warnings = [];
  const files = await listFiles(dir);
  const has = new Set(files.map((f) => f.rel));
  const report = { errors, warnings, files, total: files.reduce((s, f) => s + f.size, 0), manifest: null };

  // The manifest: store-ready, and not the E2E build's.
  let m;
  try {
    m = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (err) {
    errors.push(`manifest.json is missing or invalid: ${err.message}`);
    return report;
  }
  report.manifest = m;
  if (m.manifest_version !== 3) errors.push(`manifest_version is ${m.manifest_version}, not 3`);
  if (!isChromeVersion(m.version)) {
    errors.push(`version "${m.version ?? ''}" is not a Chrome version (1 to 4 dot-separated integers, 0-65535, no leading zeros)`);
  }
  // The interface's languages (_locales/<locale>/messages.json, src/shared/i18n.ts): each file parses, the
  // default locale's names every __MSG_key__ the manifest uses, and each language's name and description fit the
  // Web Store's limits.
  const locales = new Map();
  for (const f of files) {
    const at = /^_locales\/([^/]+)\/messages\.json$/.exec(f.rel);
    if (!at) continue;
    try {
      locales.set(at[1], JSON.parse(await readFile(f.abs, 'utf8')));
    } catch (err) {
      errors.push(`${f.rel} is not valid JSON: ${err.message}`);
    }
  }
  if (files.some((f) => f.rel.startsWith('_locales/')) && !m.default_locale) {
    errors.push('_locales/ ships but the manifest has no default_locale, so Chrome refuses to load the extension');
  }
  const localized = (field) => {
    const value = m[field] ?? '';
    const key = /^__MSG_(\w+)__$/.exec(value)?.[1];
    if (!key) return [['', value]];
    return [...locales].map(([locale, messages]) => [` (${locale})`, messages[key]?.message ?? '']);
  };
  for (const [locale, name] of localized('name')) {
    if (!name || name.length > 75) errors.push(`name${locale} must be 1-75 characters: "${name}"`);
  }
  for (const [locale, description] of localized('description')) {
    if (!description || description.length > 132) {
      errors.push(`description${locale} must be 1-132 characters for the Web Store (it is ${description.length})`);
    }
  }
  for (const value of JSON.stringify(m).matchAll(/__MSG_(\w+)__/g)) {
    if (m.default_locale && !locales.get(m.default_locale)?.[value[1]]) {
      errors.push(`manifest uses __MSG_${value[1]}__, but _locales/${m.default_locale}/messages.json has no "${value[1]}"`);
    }
  }
  if (target === 'firefox') verifyFirefoxManifest(m, has, errors);
  else {
    if (!m.minimum_chrome_version) warnings.push('minimum_chrome_version is not set');
    if (!m.background?.service_worker) errors.push("background.service_worker is missing: Chrome's build runs a service worker (is this the Firefox build?)");
  }
  for (const key of ['key', 'update_url']) {
    if (key in m) errors.push(`manifest has "${key}", which is for unpacked or self-hosted builds; the Web Store sets its own`);
  }
  if (/\be2e\b/i.test(m.name ?? '')) errors.push(`name "${m.name}" is the E2E build's`);
  const everySite = [
    ...(m.permissions ?? []),
    ...(m.host_permissions ?? []),
    ...(m.content_scripts ?? []).flatMap((c) => c.matches ?? []),
  ].filter((p) => p === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(p));
  if (everySite.length) {
    errors.push(`access to every site (${[...new Set(everySite)].join(', ')}) is the E2E build's; the store build works through activeTab`);
  }
  // The hosts (decision D2): YGOPRODeck's image host for the official card images, unless this is the
  // crop build; optionally the Anthropic API, for the opt-in AI check. Nothing else.
  const hosts = m.host_permissions ?? [];
  if (remoteImages && !hosts.includes(IMAGES_HOST)) {
    errors.push(
      `host_permissions: the official-images build needs host access to ${IMAGES_HOST} (it sends no CORS headers), ` +
        'or its card images cannot load; build.mjs adds it',
    );
  }
  for (const host of hosts) {
    if (everySite.includes(host) || (remoteImages && host === IMAGES_HOST)) continue;
    errors.push(
      host === IMAGES_HOST
        ? `host_permissions: the crop build (--no-remote-images) asks for ${IMAGES_HOST}, which it never uses`
        : `host permission "${host}" is not one a release asks for (only ${IMAGES_HOST}, for the official card images)`,
    );
  }
  for (const host of m.optional_host_permissions ?? []) {
    if (host !== ANTHROPIC_HOST) {
      errors.push(`optional host permission "${host}" is not one a release asks for (only ${ANTHROPIC_HOST}, for the opt-in AI check)`);
    }
  }

  // Every file the manifest and the pages name is in the build; icons have the size they claim.
  if (!m.icons?.['128']) errors.push('icons has no 128 px icon, which the Web Store requires');
  for (const size of ['16', '48']) if (!m.icons?.[size]) warnings.push(`icons has no ${size} px icon`);
  for (const [key, file] of manifestRefs(m)) {
    if (!has.has(file)) {
      errors.push(`manifest ${key}: ${file} is not in the build`);
      continue;
    }
    const px = /\.(\d+)$/.exec(key)?.[1];
    const dim = px && file.endsWith('.png') ? pngSize(await readFile(path.join(dir, file))) : null;
    if (dim && (dim.w !== Number(px) || dim.h !== Number(px))) warnings.push(`manifest ${key}: ${file} is ${dim.w}x${dim.h}, not ${px}x${px}`);
  }
  for (const war of m.web_accessible_resources ?? []) {
    for (const glob of war.resources ?? []) {
      const re = globToRegExp(glob);
      if (!files.some((f) => re.test(f.rel))) errors.push(`manifest web_accessible_resources: "${glob}" matches no file`);
    }
  }
  // The legal texts (final review M10): the notices, the privacy and licences pages, and the project's
  // own LICENSE (Apache-2.0, decision D1).
  for (const [rel, what] of Object.entries(LEGAL_FILES)) {
    if (!has.has(rel)) errors.push(`${rel} is missing: every release ships ${what}`);
  }
  if (!has.has('LICENSE')) {
    errors.push('LICENSE is missing: Duel Lens is Apache-2.0 (decision D1); keep LICENSE at the project root, build.mjs ships it');
  }
  for (const page of files.filter((f) => f.rel.endsWith('.html'))) {
    const html = await readFile(page.abs, 'utf8');
    if (/<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\//i.test(html)) {
      errors.push(`${page.rel} loads a script from the network; MV3 extensions may only run packaged code`);
    }
    for (const [, ref] of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
      if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) continue; // https:, data:, chrome:, anchors
      const clean = ref.split(/[?#]/)[0];
      const target = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(page.rel), clean));
      if (!has.has(target)) errors.push(`${page.rel} references ${ref}, which is not in the build`);
    }
  }

  // The card detector's model: a build without it has no click to scan and finds no card in a scan.
  const detector = files.find((f) => f.rel === DETECTOR_MODEL);
  if (!detector) {
    errors.push(
      `${DETECTOR_MODEL} is missing: every release ships the card detector (click to scan, and the card found in ` +
        'every scan); build.mjs copies it from extension/ (tools/train-detector/README.md rebuilds it)',
    );
  } else if (detector.size === 0) {
    errors.push(`${DETECTOR_MODEL} is empty`);
  }

  // ONNX Runtime's runtime files: the ones the offscreen document loads, and no other.
  for (const rel of ORT_FILES) {
    const file = files.find((f) => f.rel === rel);
    if (!file) errors.push(`${rel} is missing: the offscreen document loads it at runtime (build.mjs copies ORT_FILES from onnxruntime-web)`);
    else if (file.size === 0) errors.push(`${rel} is empty`);
  }
  for (const f of files) {
    if (f.rel.startsWith('ort/') && !ORT_FILES.includes(f.rel)) {
      errors.push(`${f.rel} ships, but the extension never loads it: keep it out of ort/ (build.mjs ORT_FILES; tools/release.mjs ORT_FILES)`);
    }
  }

  // The models, byte for byte: each pinned model ships with its pinned SHA-256, and no other model ships.
  const repin = 'update MODEL_SHA256 in tools/release.mjs and docs/DEVELOPMENT.md ("Models") together';
  for (const [rel, expected] of Object.entries(modelSha256)) {
    const file = files.find((f) => f.rel === rel);
    if (rel === DETECTOR_MODEL && !(file?.size > 0)) continue; // missing or empty: said just above
    if (!file) {
      errors.push(`${rel} is missing: every release ships the models MODEL_SHA256 pins (if the default embedding model changed, ${repin})`);
      continue;
    }
    const actual = await sha256(file.abs);
    if (actual !== expected) {
      errors.push(
        `${rel}: SHA-256 ${actual}, but the release pins ${expected}. A swapped or corrupted model must not ship; ` +
          `if this one was deliberately retrained, ${repin}`,
      );
    }
  }
  for (const f of files) {
    if (/\.onnx$/i.test(f.rel) && !Object.hasOwn(modelSha256, f.rel)) {
      errors.push(`${f.rel} ships without a pinned SHA-256: keep it out of the build, or ${repin}`);
    }
  }

  // Files that must not ship: dev and test files, DRAW2's models, oversized files.
  for (const f of files) {
    if (f.symlink) errors.push(`${f.rel} is a symlink; the zip needs the file itself`);
    for (const [re, what] of DEV_FILES) {
      if (re.test(f.rel) && !(sourcemap && what === 'a source map')) errors.push(`${f.rel} is ${what}`);
    }
    if (/draw2/i.test(f.rel)) errors.push(`${f.rel} is part of DRAW2 (AGPL-3.0), which must not ship`);
    if (f.size > WARN_FILE_MB * 1e6) warnings.push(`${f.rel} is ${human(f.size)}, over the ${WARN_FILE_MB} MB per-file budget`);
  }
  if (report.total > WARN_TOTAL_MB * 1e6) warnings.push(`the build is ${human(report.total)}, over the ${WARN_TOTAL_MB} MB budget`);

  // What the files contain: this machine's paths, and in the bundles dev/E2E code and DRAW2's code.
  const localPaths = [...new Set([root, realpathSync(root)])];
  for (const f of files) {
    if (f.symlink) continue;
    const buf = await readFile(f.abs);
    for (const p of localPaths) if (buf.includes(p)) errors.push(`${f.rel} contains this machine's path ${p}`);
    if (!/\.m?js$/.test(f.rel)) continue;
    const text = buf.toString('utf8');
    const modules = [...text.matchAll(/^[ \t]*\/\/ (\S+\.[cm]?[jt]sx?)$/gm)].map((x) => x[1]);
    const outside = modules.filter((p) => p.startsWith('../'));
    if (outside.length) {
      errors.push(`${f.rel} was bundled from outside the project (${outside.length} module paths like ${outside[0]}); build from the project root`);
    }
    const dev = [...new Set(modules.filter((p) => DEV_MODULE.test(p)))];
    if (dev.length) errors.push(`${f.rel} bundles test or dev code: ${dev.join(', ')}`);
    // A guard: DRAW2, the AGPL-3.0 prototype, was deleted from the repository (A6); it must never come back.
    const draw2 = modules.filter((p) => p.includes('/draw2/'));
    if (draw2.length || text.includes('models/draw2')) {
      const names = draw2.map((p) => path.posix.basename(p)).join(', ') || 'models/draw2';
      errors.push(
        `${f.rel} bundles DRAW2's AGPL-3.0 code (${names}), the prototype deleted from this repository; publishing ` +
          'it makes the whole extension AGPL-3.0, so remove it first',
      );
    }
    if (modules.some((p) => OPENCV_MODULE.test(p))) {
      errors.push(
        `${f.rel} bundles OpenCV.js (@techstark/opencv-js): the extension dropped it for its own card detector, ` +
          'THIRD_PARTY_NOTICES.md no longer lists it, and its WebAssembly inlined as one long string reads as obfuscation to the Web Store',
      );
    }
    if (!sourcemap && /\/[/*][#@] sourceMappingURL=/.test(text)) errors.push(`${f.rel} links a source map`);
    if (text.includes('duelLensDebug')) {
      errors.push(`${f.rel} contains the E2E hook duelLensDebug${await sourceOf(/duelLensDebug\s*=/)}: register it in the --e2e build only`);
    }
    if (text.includes('data-duel-lens-state')) {
      warnings.push(
        `${f.rel} mirrors the popover state, the scanned card's name included, onto a page-visible element for the ` +
          `E2E test, in mirrorState${await sourceOf(/function mirrorState\b/)}: any page can read it; mirror in the --e2e build only`,
      );
    }
    const cdn = [...new Set(text.match(CODE_CDN) ?? [])];
    if (cdn.length) warnings.push(`${f.rel} names a code CDN (${cdn.slice(0, 2).join(', ')}): make sure nothing is loaded from it`);
  }
  return report;
}

/**
 * The Firefox build's manifest (build.mjs firefoxManifest): an event page running background.js as a
 * module, Firefox's sidebar on the side panel's page, the add-on id, Firefox 140 or later, the
 * data-collection declaration, none of the Chrome keys Firefox warns about, and the in-page engine
 * (engine.js) instead of the offscreen document. Pushes to `errors`.
 */
function verifyFirefoxManifest(m, has, errors) {
  const bg = m.background ?? {};
  if (!(bg.scripts ?? []).includes('background.js') || bg.type !== 'module') {
    errors.push('background must be { scripts: ["background.js"], type: "module" } (Firefox MV3 runs an event page, not a service worker)');
  }
  for (const [what, found] of FIREFOX_WARNS) {
    if (found(m)) errors.push(`${what}: Firefox warns about it (build.mjs --target firefox leaves it out)`);
  }
  const gecko = m.browser_specific_settings?.gecko ?? {};
  if (gecko.id !== FIREFOX_ID) errors.push(`browser_specific_settings.gecko.id is "${gecko.id ?? ''}", not ${FIREFOX_ID}: AMO updates the add-on by it`);
  if (gecko.strict_min_version !== FIREFOX_MIN_VERSION) {
    errors.push(`browser_specific_settings.gecko.strict_min_version is "${gecko.strict_min_version ?? ''}", not ${FIREFOX_MIN_VERSION} (the first Firefox with built-in data consent)`);
  }
  if (JSON.stringify(gecko.data_collection_permissions) !== JSON.stringify(FIREFOX_DATA_COLLECTION)) {
    errors.push(
      `browser_specific_settings.gecko.data_collection_permissions is ${JSON.stringify(gecko.data_collection_permissions)}, not ` +
        `${JSON.stringify(FIREFOX_DATA_COLLECTION)} (decision D-FF4; store/firefox.md)`,
    );
  }
  if (m.sidebar_action?.default_panel !== 'sidepanel.html') errors.push('sidebar_action.default_panel must be sidepanel.html (the side panel in Firefox)');
  if (!has.has('engine.js')) errors.push('engine.js is missing: Firefox runs the engine in the event page (src/offscreen/in-page.ts)');
  for (const rel of ['offscreen.html', 'offscreen.js']) if (has.has(rel)) errors.push(`${rel} ships, but Firefox has no offscreen document`);
}

/**
 * Zips every file under `dir` at the zip root: sorted entries with their folders, DOS date
 * 2000-01-01, Unix modes 644/755, deflated unless that doesn't shrink them. No ZIP64 (4 GB).
 */
export async function writeZip(dir, zipPath) {
  const files = (await listFiles(dir)).filter((f) => !f.symlink);
  const folders = new Set();
  for (const f of files) for (let d = path.posix.dirname(f.rel); d !== '.'; d = path.posix.dirname(d)) folders.add(`${d}/`);
  const entries = [...[...folders].map((rel) => ({ rel })), ...files].sort(byPath);
  if (entries.length > 0xffff) throw new Error(`${entries.length} zip entries need ZIP64, which this writer doesn't do`);

  const out = await open(zipPath, 'w');
  const central = [];
  let offset = 0;
  const put = async (...bufs) => {
    for (const b of bufs) {
      await out.write(b);
      offset += b.length;
    }
  };
  try {
    for (const e of entries) {
      const name = Buffer.from(e.rel, 'utf8');
      const data = e.abs ? await readFile(e.abs) : Buffer.alloc(0);
      const deflated = data.length ? zlib.deflateRawSync(data, { level: 9 }) : null;
      const method = deflated && deflated.length < data.length ? 8 : 0;
      const body = method === 8 ? deflated : data;
      const crc = crc32(data);
      const needed = method === 8 || !e.abs ? 20 : 10;
      const flags = /[^\x20-\x7e]/.test(e.rel) ? 0x0800 : 0; // UTF-8 names
      const attrs = (((e.abs ? 0o100644 : 0o040755) << 16) | (e.abs ? 0 : 0x10)) >>> 0;
      const at = offset;
      if (at + 30 + name.length + body.length > 0xffffffff) throw new Error('a zip over 4 GB needs ZIP64');

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(needed, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(0, 10); // time 00:00
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      await put(local, name, body);

      const header = Buffer.alloc(46); // extra, comment, disk and internal attributes stay 0
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, zip 2.0
      header.writeUInt16LE(needed, 6);
      header.writeUInt16LE(flags, 8);
      header.writeUInt16LE(method, 10);
      header.writeUInt16LE(0, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(body.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE(attrs, 38);
      header.writeUInt32LE(at, 42);
      central.push(header, name);
    }
    const start = offset;
    await put(...central);
    const end = Buffer.alloc(22); // disk numbers and comment length stay 0
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12);
    end.writeUInt32LE(start, 16);
    await put(end);
  } finally {
    await out.close();
  }
  return { files: files.length, size: offset };
}

/** true when `unzip -t` passes, its complaint when it fails, null without unzip on the PATH. */
export function testZip(zipPath) {
  const r = spawnSync('unzip', ['-tq', zipPath], { encoding: 'utf8' });
  if (r.error) return null;
  return r.status === 0 ? true : `${r.stdout}${r.stderr}`.trim();
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * The release's build: node build.mjs --out <dir> [--sourcemap] [--no-remote-images]. Official card
 * images are build.mjs's default (decision D2). build.mjs refuses an option it doesn't know, so a flag
 * renamed on one side stops the release instead of being ignored.
 */
export function buildCommand(outDir, { sourcemap = false, remoteImages = true, target = 'chrome' } = {}) {
  return [
    'node',
    'build.mjs',
    ...(target === 'firefox' ? ['--target', 'firefox'] : []),
    '--out',
    outDir,
    ...(sourcemap ? ['--sourcemap'] : []),
    ...(remoteImages ? [] : ['--no-remote-images']),
  ];
}

// --- Firefox: the warnings Firefox records, the source zip, and the rebuild from it ---------------

/** Firefox's executable: FIREFOX_BIN, the macOS app, or firefox on the PATH; null without one. */
export function firefoxBinary() {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const mac = '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'darwin' && existsSync(mac)) return mac;
  const which = spawnSync('which', ['firefox'], { encoding: 'utf8' });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

/**
 * What Firefox itself records when it loads `dir` as a temporary add-on, what about:debugging shows:
 * { warnings, errors, firefox } (Extension.warnings and .errors, read in Firefox's chrome scope over
 * WebDriver BiDi, firefox-spike.md §1), or null without Firefox. A fresh headless profile; never throws
 * for a build Firefox refuses (its error is in `errors`).
 */
export async function firefoxManifestReport(dir, { binary = firefoxBinary(), timeoutMs = 60_000 } = {}) {
  if (!binary) return null;
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const profile = await mkdtemp(path.join(tmpdir(), 'duel-lens-ff-'));
  const port = 9400 + Math.floor(Math.random() * 500);
  const { spawn } = await import('node:child_process');
  const ff = spawn(binary, ['-headless', '-no-remote', '-profile', profile, '--remote-debugging-port', String(port), '--remote-allow-system-access'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const timer = setTimeout(() => ff.kill(), timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      ff.stderr.on('data', (d) => String(d).includes('WebDriver BiDi listening') && resolve());
      ff.on('exit', () => reject(new Error('Firefox exited before WebDriver BiDi listened')));
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('could not reach WebDriver BiDi'));
    });
    let n = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const d = JSON.parse(String(e.data));
      if (d.id && pending.has(d.id)) {
        pending.get(d.id)(d);
        pending.delete(d.id);
      }
    };
    const send = (method, params) =>
      new Promise((resolve) => {
        const id = ++n;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    await send('session.new', { capabilities: {} });
    const installed = await send('webExtension.install', { extensionData: { type: 'path', path: path.resolve(dir) } });
    const version = (await send('session.status', {}))?.result?.message ?? '';
    if (installed.type !== 'success') return { warnings: [], errors: [`${installed.error}: ${installed.message}`], firefox: version };
    const id = installed.result.extension;
    await new Promise((r) => setTimeout(r, 1500));
    const tree = await send('browsingContext.getTree', { 'moz:scope': 'chrome' });
    const context = tree.result?.contexts?.[0]?.context;
    const expression = `(() => { const p = WebExtensionPolicy.getByID(${JSON.stringify(id)}); const e = p && p.extension; return JSON.stringify({ warnings: (e && e.warnings) || [], errors: (e && e.errors) || [], firefox: Services.appinfo.version }); })()`;
    const ev = await send('script.evaluate', { expression, target: { context }, awaitPromise: false, 'moz:scope': 'chrome' });
    ws.close();
    const value = ev.result?.result?.value;
    if (typeof value !== 'string') return { warnings: [], errors: [`could not read Firefox's warnings: ${JSON.stringify(ev).slice(0, 300)}`], firefox: version };
    return JSON.parse(value);
  } finally {
    clearTimeout(timer);
    ff.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** The project files the Firefox build is made from (besides src/ and extension/), all in the source zip. */
const SOURCE_ROOT_FILES = ['build.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];

/**
 * The files of the AMO source zip, as { rel, abs }: SOURCE_ROOT_FILES; src/ without tests and
 * measurement code (never bundled: verifyBuild checks the bundles); and extension/, of whose models
 * and indexes only the ones the build ships (`shipped`, the build's own files), since the others are
 * hundreds of MB of experiments the build leaves out.
 */
export async function sourceFiles(projectRoot, shipped) {
  const out = SOURCE_ROOT_FILES.map((rel) => ({ rel, abs: path.join(projectRoot, rel) }));
  for (const f of await listFiles(path.join(projectRoot, 'src'))) {
    if (/\.test\.[jt]sx?$|(^|\/)__measure__\/|test-fixtures/.test(f.rel)) continue;
    out.push({ rel: `src/${f.rel}`, abs: f.abs });
  }
  for (const f of await listFiles(path.join(projectRoot, 'extension'))) {
    if (OS_JUNK.test(f.rel)) continue;
    const optional = f.rel.startsWith('models/') || f.rel.startsWith('data/index-');
    if (optional && !shipped.has(f.rel)) continue;
    out.push({ rel: `extension/${f.rel}`, abs: f.abs });
  }
  return out.sort(byPath);
}

/** The README AMO's reviewers build from (README-AMO.md at the source zip's root). */
export function reviewerReadme({ version, node, npm, xpi }) {
  return `# Duel Lens ${version}: building the Firefox add-on from source

This archive is the complete source of the Duel Lens Firefox add-on ${version} (${xpi}).
The add-on is bundled with esbuild, so this source is provided for review.
The build produces every file in the XPI, byte for byte.

## Environment

- Any OS. Built here on ${process.platform === 'darwin' ? 'macOS' : process.platform} with Node.js ${node} and npm ${npm}.
  Ubuntu 24.04 with Node.js 24 and npm 11 works the same.
- No network access is needed for the build itself, only for \`npm ci\`.

## Build

\`\`\`sh
npm ci
node build.mjs --target firefox --out dist-firefox
\`\`\`

\`dist-firefox/\` then holds the add-on: compare it with the unpacked XPI.

## What the build does (build.mjs)

1. It copies \`extension/\` (the manifest, pages, icons, locales, fonts, the card data, and the two
   models it ships) into \`dist-firefox/\`, and makes the manifest Firefox's (\`firefoxManifest\`).
2. It copies ONNX Runtime Web's runtime files, unmodified, from \`node_modules/onnxruntime-web/dist/\`
   into \`dist-firefox/ort/\`.
3. It bundles each entry point with esbuild, minified only by esbuild's defaults (no obfuscation):
   - \`src/background/index.ts\` becomes \`background.js\`;
   - \`src/offscreen/in-page.ts\` becomes \`engine.js\`;
   - \`src/content/index.ts\` becomes \`content.js\`;
   - and the extension's pages: \`sidepanel.js\`, \`options.js\`, \`welcome.js\`, \`legal.js\`.

## Third-party code (official releases, unmodified, from npm with the lockfile's integrity hashes)

- onnxruntime-web (MIT): https://github.com/microsoft/onnxruntime/releases. The \`ort/*.mjs\` and
  \`ort/*.wasm\` files are copied as published.
- preact (MIT): https://github.com/preactjs/preact/releases.
- The exact versions are in package-lock.json. THIRD_PARTY_NOTICES.md lists every licence.

## The models (not code)

\`extension/models/*.onnx\` are ONNX model files (weights), our own, trained by the project.
They are data that ONNX Runtime executes; they are not JavaScript.
Their SHA-256 hashes are pinned in the release tooling.

## Notes for reviewers

- \`new Function\` appears in ONNX Runtime's Emscripten glue (engine.js and \`ort/*.mjs\`).
  It is never reached under the add-on's CSP (\`script-src 'self' 'wasm-unsafe-eval'\`).
- \`innerHTML\` appears in Preact's bundled code. The add-on renders only its own components.
- No remote code is loaded. The card data (db.ygoprodeck.com), card images (images.ygoprodeck.com)
  and the optional AI check's answers (api.anthropic.com) are data.
`;
}

/** Copies a node_modules tree for a rebuild: an APFS clone on macOS, a reflink where Linux has one. */
function copyTree(from, to) {
  // macOS's own cp (a GNU cp first on the PATH has no -c).
  const [cp, args] = process.platform === 'darwin' ? ['/bin/cp', ['-cR', from, to]] : ['cp', ['-R', '--reflink=auto', from, to]];
  const r = spawnSync(cp, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not copy ${from}: ${r.stderr}`);
}

/**
 * Unzips the source zip into a fresh folder, builds it as README-AMO.md says (with this project's
 * node_modules, copied in place of \`npm ci\`), and compares every file with `buildDir`. Returns the
 * differences (empty: byte for byte the same). The folder is removed afterwards.
 */
export async function rebuildFromSource(sourceZip, buildDir, workDir) {
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  try {
    const unzip = spawnSync('unzip', ['-q', sourceZip, '-d', workDir], { encoding: 'utf8' });
    if (unzip.error) return ['unzip is not available: the rebuild from the source zip was not checked'];
    if (unzip.status !== 0) return [`unzip failed: ${unzip.stderr}`];
    copyTree(path.join(root, 'node_modules'), path.join(workDir, 'node_modules'));
    const built = spawnSync('node', ['build.mjs', '--target', 'firefox', '--out', 'dist-firefox'], { cwd: workDir, encoding: 'utf8' });
    if (built.status !== 0) return [`the build from the source zip failed: ${built.stderr || built.stdout}`];
    const a = await listFiles(buildDir);
    const b = await listFiles(path.join(workDir, 'dist-firefox'));
    const diffs = [];
    const inB = new Map(b.map((f) => [f.rel, f]));
    for (const f of a) {
      const g = inB.get(f.rel);
      if (!g) diffs.push(`${f.rel}: not rebuilt from the source zip`);
      else if ((await sha256(f.abs)) !== (await sha256(g.abs))) diffs.push(`${f.rel}: rebuilt differently from the source zip`);
      inB.delete(f.rel);
    }
    for (const rel of inB.keys()) diffs.push(`${rel}: rebuilt from the source zip but not in the XPI`);
    return diffs;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The warnings a release's own options put first in its summary. */
export function optionWarnings({ skipE2e = false, sourcemap = false, remoteImages = true } = {}) {
  return [
    ...(remoteImages
      ? []
      : [
          "the crop build (--no-remote-images): no official card images and no host permission, so host the privacy text that " +
            "matches it, not the default build's (docs/release/privacy-policy.md)",
        ]),
    ...(sourcemap ? ['source maps ship (--sourcemap)'] : []),
    ...(skipE2e ? ['released without the E2E test (--skip-e2e)'] : []),
  ];
}

function run(cmd) {
  console.log(`\n> ${cmd.join(' ')}`);
  const started = Date.now();
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  return { ok: r.status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

/** What the E2E test needs that a fresh clone lacks (docs/DEVELOPMENT.md, "Tests"). */
function e2eMissing() {
  const missing = [];
  if (!existsSync(path.join(root, 'test/e2e/node_modules/puppeteer'))) missing.push('Puppeteer: run "npm install" in test/e2e');
  if (!existsSync(path.join(root, 'test/fixtures/cards'))) missing.push('the fixture card images in test/fixtures/cards/');
  return missing;
}

function printSummary({ checks, report, zip, junk, firefox = null, dir = buildDir }) {
  const line = (label, text) => console.log(`${label.padEnd(10)}${text}`);
  const version = report?.manifest?.version;
  console.log(`\n=== Duel Lens ${version ? `${version} ` : ''}release ===`);
  line('Checks', checks.map((c) => (c.skipped ? `${c.name} SKIPPED` : `${c.name} ${c.ok ? 'ok' : 'FAILED'} (${c.seconds} s)`)).join(', '));
  if (!report) return;
  line('Build', `${path.relative(root, dir)}/: ${report.files.length} files, ${human(report.total)} unpacked`);
  for (const f of [...report.files].sort((a, b) => b.size - a.size)) line('', `${human(f.size).padStart(9)}  ${f.rel}`);
  if (junk.length) line('', `(removed ${junk.join(', ')})`);
  const m = report.manifest;
  if (m) {
    const gecko = m.browser_specific_settings?.gecko;
    const browser = gecko ? `Firefox ${gecko.strict_min_version ?? '(any)'}+, id ${gecko.id}` : `Chrome ${m.minimum_chrome_version ?? '(any)'}+`;
    line('Manifest', `${m.name} ${m.version}, ${browser}, "${m.description ?? ''}"`);
    if (gecko) line('', `data collection: ${JSON.stringify(gecko.data_collection_permissions)}`);
    line('', `permissions: ${(m.permissions ?? []).join(', ') || 'none'}`);
    line('', `hosts: ${(m.host_permissions ?? []).join(', ') || 'none'}; optional: ${(m.optional_host_permissions ?? []).join(', ') || 'none'}`);
  }
  for (const [label, list] of [
    ['Warnings', report.warnings],
    ['Errors', report.errors],
  ]) {
    if (!list.length) continue;
    line(label, `${list.length}`);
    for (const item of list) line('', `- ${item}`);
  }
  if (!zip) {
    line('Zip', 'NOT WRITTEN: fix the errors above, then run the release again');
    return;
  }
  const rel = path.relative(root, zip.path);
  line(firefox ? 'XPI' : 'Zip', `${rel}: ${human(zip.size)}, ${zip.files} files at its root, ${zip.tested ? 'passes unzip -t' : 'not tested (no unzip)'}`);
  line('SHA-256', `${zip.sha256}  (${rel}.sha256)`);
  if (firefox) {
    const src = path.relative(root, firefox.source.path);
    line('Source', `${src}: ${human(firefox.source.size)}, ${firefox.source.files} files (README-AMO.md at its root)`);
    line('SHA-256', `${firefox.source.sha256}  (${src}.sha256)`);
    line('Next', `smoke-test ${path.relative(root, dir)}/ in Firefox (docs/DEVELOPMENT.md, "Firefox"), then upload both to AMO (store/firefox.md)`);
    return;
  }
  line('Next', `smoke-test ${path.relative(root, buildDir)}/ unpacked, then upload the zip (docs/release/packaging.md)`);
}

/**
 * The Firefox-only steps for a build that verifyBuild passed: Firefox's own warnings (0, or errors),
 * the XPI, the source zip with its README, and the rebuild from it. Adds to `report`; returns
 * { xpi, source } or null.
 */
async function releaseFirefox(report, dir) {
  const version = report.manifest.version;
  const loaded = await firefoxManifestReport(dir);
  if (!loaded) report.warnings.push("not loaded in Firefox (no Firefox found; set FIREFOX_BIN): its own manifest warnings weren't checked");
  else {
    for (const w of loaded.warnings) report.errors.push(`Firefox ${loaded.firefox} warns: ${w}`);
    for (const e of loaded.errors) report.errors.push(`Firefox ${loaded.firefox} refuses the build: ${e}`);
  }
  if (report.errors.length) return null;

  const xpiPath = path.join(releaseDir, `duel-lens-${version}-firefox.xpi`);
  const sourcePath = path.join(releaseDir, `duel-lens-${version}-source.zip`);
  for (const f of [xpiPath, sourcePath]) await rm(`${f}.sha256`, { force: true });
  const xpi = await zipChecked(dir, xpiPath, report);
  if (!xpi) return null;

  // The source zip: staged as it unzips (README-AMO.md beside the sources), then zipped like the XPI.
  const stage = path.join(releaseDir, 'source-firefox');
  await rm(stage, { recursive: true, force: true });
  const shipped = new Set(report.files.map((f) => f.rel));
  const npm = spawnSync('npm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim() || 'unknown';
  for (const f of await sourceFiles(root, shipped)) {
    await mkdir(path.dirname(path.join(stage, f.rel)), { recursive: true });
    await writeFile(path.join(stage, f.rel), await readFile(f.abs));
  }
  await writeFile(path.join(stage, 'README-AMO.md'), reviewerReadme({ version, node: process.versions.node, npm, xpi: path.basename(xpiPath) }));
  const source = await zipChecked(stage, sourcePath, report);
  await rm(stage, { recursive: true, force: true });
  if (!source) return null;
  if (source.size > SOURCE_ZIP_MAX_MB * 1e6) report.errors.push(`the source zip is ${human(source.size)}, over AMO's ${SOURCE_ZIP_MAX_MB} MB`);
  for (const d of await rebuildFromSource(sourcePath, dir, sourceCheckDir)) {
    (d.startsWith('unzip is not available') ? report.warnings : report.errors).push(`source zip: ${d}`);
  }
  if (report.errors.length) {
    for (const f of [xpiPath, sourcePath]) await rm(f, { force: true });
    return null;
  }
  return { xpi, source };
}

/** Writes a zip of `dir` (writeZip), tests it, and writes its .sha256; null (and an error) when it fails unzip -t. */
async function zipChecked(dir, zipPath, report) {
  const written = await writeZip(dir, zipPath);
  const tested = testZip(zipPath);
  if (typeof tested === 'string') {
    await rm(zipPath, { force: true });
    report.errors.push(`${path.basename(zipPath)} failed unzip -t, so it was deleted: ${tested}`);
    return null;
  }
  const hash = await sha256(zipPath);
  await writeFile(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);
  return { path: zipPath, ...written, tested: tested === true, sha256: hash };
}

export async function main(argv) {
  const unknown = argv.filter((a) => !(a in FLAGS));
  if (unknown.length || argv.includes('--help')) {
    console.log(`Usage: npm run release [-- ${Object.keys(FLAGS).join(' ')}]`);
    for (const [flag, what] of Object.entries(FLAGS)) console.log(`  ${flag.padEnd(18)} ${what}`);
    if (unknown.length) console.error(`Unknown option: ${unknown.join(' ')}`);
    return unknown.length ? 1 : 0;
  }
  const skipE2e = argv.includes('--skip-e2e');
  const sourcemap = argv.includes('--sourcemap');
  const target = argv.includes('--firefox') ? 'firefox' : 'chrome';
  const dir = target === 'firefox' ? firefoxBuildDir : buildDir;
  if (argv.includes('--remote-images') && argv.includes('--no-remote-images')) {
    console.error('--remote-images and --no-remote-images contradict each other');
    return 1;
  }
  // Official card images unless --no-remote-images (decision D2); --remote-images is the default.
  const remoteImages = !argv.includes('--no-remote-images');

  // 1. Checks.
  const checks = [];
  for (const check of target === 'firefox' ? FIREFOX_CHECKS : CHECKS) {
    if (check.name === 'e2e') {
      if (skipE2e) {
        checks.push({ name: 'e2e', skipped: true });
        continue;
      }
      const missing = e2eMissing();
      if (missing.length) {
        console.error(`\nThe E2E test can't run: it needs ${missing.join(', and ')}. Or release with --skip-e2e.`);
        return 1;
      }
    }
    const result = run(check.cmd);
    checks.push({ name: check.name, ...result });
    if (!result.ok) {
      printSummary({ checks });
      console.error(`\n${check.name} failed, so there is no release.`);
      return 1;
    }
  }

  // 2. Production build into release/build/ (release/build-firefox/ for --firefox; this script owns those
  // folders; dist/ is never touched).
  await rm(dir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  const built = run(buildCommand(path.relative(root, dir), { sourcemap, remoteImages, target }));
  if (!built.ok) {
    printSummary({ checks });
    console.error('\nThe build failed, so there is no release.');
    return 1;
  }
  const junk = [];
  for (const f of await listFiles(dir)) {
    if (!OS_JUNK.test(f.rel)) continue;
    await rm(f.abs);
    junk.push(f.rel);
  }

  // 3. Verification.
  const report = await verifyBuild(dir, { sourcemap, remoteImages, target });
  report.warnings.unshift(...optionWarnings({ skipE2e, sourcemap, remoteImages }));

  // 4. Zip and checksum, only for a build without errors. Firefox: the XPI, the source zip and the checks on both.
  if (target === 'firefox') {
    const done = report.errors.length ? null : await releaseFirefox(report, dir);
    printSummary({ checks, report, zip: done?.xpi ?? null, junk, firefox: done, dir });
    return done ? 0 : 1;
  }
  let zip = null;
  if (!report.errors.length) {
    const zipPath = path.join(releaseDir, `duel-lens-${report.manifest.version}.zip`);
    await rm(`${zipPath}.sha256`, { force: true });
    const written = await writeZip(buildDir, zipPath);
    const tested = testZip(zipPath);
    if (typeof tested === 'string') {
      await rm(zipPath, { force: true });
      report.errors.push(`the zip failed unzip -t, so it was deleted: ${tested}`);
    } else {
      const hash = await sha256(zipPath);
      await writeFile(`${zipPath}.sha256`, `${hash}  ${path.basename(zipPath)}\n`);
      zip = { path: zipPath, ...written, tested: tested === true, sha256: hash };
    }
  }

  // 5. Summary.
  printSummary({ checks, report, zip, junk });
  return zip ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
