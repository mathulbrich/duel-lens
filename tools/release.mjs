// Cuts a Chrome Web Store release of Duel Lens (how and why: docs/release/packaging.md).
//
//   npm run release                       checks, production build, verification, zip: the store build,
//                                         with YGOPRODeck's official card images (decision D2)
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

// Size budget: over it is a warning, never an error. 0.9.0 is about 62.5 MB unpacked: the embedding
// model 25.7 MB, ONNX Runtime's wasm 14.2 MB, the card data 8.6 MB, the card detector 6.2 MB and the
// artwork index 6.2 MB; offscreen.js is 0.2 MB since OpenCV.js went (it was 17.9 MB).
export const WARN_TOTAL_MB = 100;
export const WARN_FILE_MB = 30;

const CHECKS = [
  { name: 'tsc', cmd: ['npx', 'tsc', '--noEmit'] },
  { name: 'vitest', cmd: ['npx', 'vitest', 'run'] },
  { name: 'e2e', cmd: ['npx', 'tsx', 'test/e2e/run.ts'] },
];

const FLAGS = {
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
 * Returns { errors, warnings, files, total, manifest }; any error means "don't ship this".
 */
export async function verifyBuild(dir, { sourcemap = false, remoteImages = true, modelSha256 = MODEL_SHA256 } = {}) {
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
  if (!m.name || m.name.length > 75) errors.push(`name must be 1-75 characters: "${m.name ?? ''}"`);
  if (!m.description || m.description.length > 132) {
    errors.push(`description must be 1-132 characters for the Web Store (it is ${m.description?.length ?? 0})`);
  }
  if (!m.minimum_chrome_version) warnings.push('minimum_chrome_version is not set');
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
export function buildCommand(outDir, { sourcemap = false, remoteImages = true } = {}) {
  return ['node', 'build.mjs', '--out', outDir, ...(sourcemap ? ['--sourcemap'] : []), ...(remoteImages ? [] : ['--no-remote-images'])];
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

function printSummary({ checks, report, zip, junk }) {
  const line = (label, text) => console.log(`${label.padEnd(10)}${text}`);
  const version = report?.manifest?.version;
  console.log(`\n=== Duel Lens ${version ? `${version} ` : ''}release ===`);
  line('Checks', checks.map((c) => (c.skipped ? `${c.name} SKIPPED` : `${c.name} ${c.ok ? 'ok' : 'FAILED'} (${c.seconds} s)`)).join(', '));
  if (!report) return;
  line('Build', `${path.relative(root, buildDir)}/: ${report.files.length} files, ${human(report.total)} unpacked`);
  for (const f of [...report.files].sort((a, b) => b.size - a.size)) line('', `${human(f.size).padStart(9)}  ${f.rel}`);
  if (junk.length) line('', `(removed ${junk.join(', ')})`);
  const m = report.manifest;
  if (m) {
    line('Manifest', `${m.name} ${m.version}, Chrome ${m.minimum_chrome_version ?? '(any)'}+, "${m.description ?? ''}"`);
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
  line('Zip', `${rel}: ${human(zip.size)}, ${zip.files} files at its root, ${zip.tested ? 'passes unzip -t' : 'not tested (no unzip)'}`);
  line('SHA-256', `${zip.sha256}  (${rel}.sha256)`);
  line('Next', `smoke-test ${path.relative(root, buildDir)}/ unpacked, then upload the zip (docs/release/packaging.md)`);
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
  if (argv.includes('--remote-images') && argv.includes('--no-remote-images')) {
    console.error('--remote-images and --no-remote-images contradict each other');
    return 1;
  }
  // Official card images unless --no-remote-images (decision D2); --remote-images is the default.
  const remoteImages = !argv.includes('--no-remote-images');

  // 1. Checks.
  const checks = [];
  for (const check of CHECKS) {
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

  // 2. Production build into release/build/ (this script owns that folder; dist/ is never touched).
  await rm(buildDir, { recursive: true, force: true });
  await mkdir(releaseDir, { recursive: true });
  const built = run(buildCommand(path.relative(root, buildDir), { sourcemap, remoteImages }));
  if (!built.ok) {
    printSummary({ checks });
    console.error('\nThe build failed, so there is no release.');
    return 1;
  }
  const junk = [];
  for (const f of await listFiles(buildDir)) {
    if (!OS_JUNK.test(f.rel)) continue;
    await rm(f.abs);
    junk.push(f.rel);
  }

  // 3. Verification.
  const report = await verifyBuild(buildDir, { sourcemap, remoteImages });
  report.warnings.unshift(...optionWarnings({ skipE2e, sourcemap, remoteImages }));

  // 4. Zip and checksum, only for a build without errors.
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
