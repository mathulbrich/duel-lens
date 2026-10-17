// The release verification's checks on the models (present, and byte for byte the pinned ones), on
// OpenCV and on DRAW2 (tools/release.mjs).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packedFetch } from '../src/offscreen/packed-assets';
import { getModel } from '../src/shared/models';
import {
  buildCommand,
  DETECTOR_MODEL,
  EMBEDDER_MODEL,
  FIREFOX_DATA_COLLECTION,
  FIREFOX_ID,
  firefoxBinary,
  firefoxManifestReport,
  main,
  MODEL_SHA256,
  optionWarnings,
  ORT_FILES,
  PACKED_MANIFEST,
  PACKED_SUFFIX,
  rebuildFromSource,
  reviewerReadme,
  sha256,
  sourceFiles,
  verifyBuild,
  writeZip,
  // @ts-expect-error a plain ESM script, no .d.ts
} from './release.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const DETECTOR = 'models/detector/card-detector.onnx';
const EMBEDDER = 'models/dinov2-small-duel-v3b.q8.onnx';
/** YGOPRODeck's image host: it sends no CORS headers, so showing its card images needs host access. */
const IMAGES_HOST = 'https://images.ygoprodeck.com/*';
const ANTHROPIC = 'https://api.anthropic.com/*';
const hashOf = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Stand-ins for the two models, and the pins that match them (the real pins are MODEL_SHA256's). */
const FAKE_DETECTOR = Buffer.alloc(2048, 1);
const FAKE_EMBEDDER = Buffer.alloc(4096, 2);
const FAKE_PINS = { [EMBEDDER]: hashOf(FAKE_EMBEDDER), [DETECTOR]: hashOf(FAKE_DETECTOR) };

/** The legal texts every build ships (build.mjs; src/legal), and the project's licence (once D1 is decided). */
const LEGAL_FILES: Record<string, string> = {
  'THIRD_PARTY_NOTICES.md': '# Third-party notices\n',
  'privacy.html': '<!doctype html><title>Privacy policy</title>',
  'licenses.html': '<!doctype html><title>Licences</title>',
  LICENSE: 'Apache License, Version 2.0\n',
};

/** ONNX Runtime's runtime files, the WASM and the WebGPU builds (stand-ins). */
const ORT = ['ort/ort-wasm-simd-threaded.mjs', 'ort/ort-wasm-simd-threaded.wasm', 'ort/ort-wasm-simd-threaded.asyncify.mjs', 'ort/ort-wasm-simd-threaded.asyncify.wasm'];
const FAKE_ORT: Record<string, string> = Object.fromEntries(ORT.map((rel) => [rel, `stand-in for ${rel}`]));

/**
 * A minimal store-ready build, official card images included (the default, decision D2): a manifest,
 * its service worker, its icon, the embedding model, the legal texts, and `files` (path → contents).
 * `manifest` changes the manifest's keys.
 */
async function build(files: Record<string, string | Buffer> = {}, manifestPatch: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'duel-lens-release-'));
  dirs.push(dir);
  const manifest = {
    manifest_version: 3,
    name: 'Duel Lens',
    version: '0.9.0',
    description: 'Identify trading cards in duel videos.',
    minimum_chrome_version: '124',
    icons: { 16: 'icon.png', 48: 'icon.png', 128: 'icon.png' },
    background: { service_worker: 'background.js', type: 'module' },
    host_permissions: [IMAGES_HOST],
    optional_host_permissions: [ANTHROPIC],
    ...manifestPatch,
  };
  const all: Record<string, string | Buffer> = {
    'manifest.json': JSON.stringify(manifest),
    'background.js': '// src/background/index.ts\n',
    'icon.png': 'not a real png',
    [EMBEDDER]: FAKE_EMBEDDER,
    ...LEGAL_FILES,
    ...FAKE_ORT,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}

const errorsOf = async (dir: string, modelSha256: Record<string, string> = FAKE_PINS, opts: { remoteImages?: boolean } = {}): Promise<string[]> =>
  (await verifyBuild(dir, { modelSha256, ...opts })).errors;

describe('verifyBuild: the card detector ships in every release', () => {
  it("fails a build without the card detector's model", async () => {
    const errors = await errorsOf(await build());
    expect(errors.join('\n')).toMatch(/models\/detector\/card-detector\.onnx is missing.*card detector/);
  });

  it('fails a build whose card detector model is empty', async () => {
    expect((await errorsOf(await build({ [DETECTOR]: '' }))).join('\n')).toMatch(/card-detector\.onnx is empty/);
  });

  it('passes a build that ships it', async () => {
    expect(await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }))).toEqual([]);
  });
});

describe("verifyBuild: ONNX Runtime's WASM and WebGPU builds ship, and no other", () => {
  it('requires exactly the files the offscreen document loads', () => {
    expect([...ORT_FILES].sort()).toEqual([...ORT].sort());
  });

  it('fails a build without one of them, or with one empty', async () => {
    for (const rel of ORT) {
      const dir = await build({ [DETECTOR]: FAKE_DETECTOR });
      await rm(path.join(dir, rel));
      expect((await errorsOf(dir)).join('\n')).toContain(`${rel} is missing: the offscreen document loads it at runtime`);
      expect((await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR, [rel]: '' }))).join('\n')).toContain(`${rel} is empty`);
    }
  });

  it("fails a build that ships an ORT build the extension never loads (JSEP's 28 MB)", async () => {
    const errors = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR, 'ort/ort-wasm-simd-threaded.jsep.wasm': 'x' }));
    expect(errors.join('\n')).toMatch(/ort\/ort-wasm-simd-threaded\.jsep\.wasm ships, but the extension never loads it/);
  });
});

// Security review L2: a swapped or corrupted .onnx would otherwise ship silently.
describe('verifyBuild: the models are byte for byte the pinned ones', () => {
  it('pins the default embedding model and the card detector, with the SHA-256 docs/DEVELOPMENT.md records', () => {
    expect(EMBEDDER_MODEL).toBe(`models/${getModel().file}`);
    expect(DETECTOR_MODEL).toBe(DETECTOR);
    expect(Object.keys(MODEL_SHA256).sort()).toEqual([EMBEDDER_MODEL, DETECTOR_MODEL].sort());
    const devDoc = readFileSync(path.join(root, 'docs/DEVELOPMENT.md'), 'utf8');
    for (const hash of Object.values(MODEL_SHA256) as string[]) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(devDoc).toContain(hash);
    }
  });

  it.each([EMBEDDER, DETECTOR])('matches the pin with extension/%s, when this checkout has it', async (rel) => {
    const file = path.join(root, 'extension', rel);
    if (!existsSync(file)) return; // the embedding model isn't in git (docs/DEVELOPMENT.md, "Models")
    expect(await sha256(file)).toBe(MODEL_SHA256[rel]);
  });

  it('fails a build whose models differ from the pins, naming each file, both hashes and the fix', async () => {
    const errors = (await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }), MODEL_SHA256)).join('\n');
    for (const [rel, fake] of [
      [EMBEDDER, FAKE_EMBEDDER],
      [DETECTOR, FAKE_DETECTOR],
    ] as const) {
      expect(errors).toContain(`${rel}: SHA-256 ${hashOf(fake)}, but the release pins ${MODEL_SHA256[rel]}`);
    }
    expect(errors).toMatch(/update MODEL_SHA256 in tools\/release\.mjs and docs\/DEVELOPMENT\.md \("Models"\) together/);
  });

  it('fails a build without the pinned embedding model', async () => {
    const dir = await build({ [DETECTOR]: FAKE_DETECTOR });
    await rm(path.join(dir, EMBEDDER));
    expect((await errorsOf(dir)).join('\n')).toMatch(/models\/dinov2-small-duel-v3b\.q8\.onnx is missing/);
  });

  it('fails a build that ships a model nobody pinned', async () => {
    const errors = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR, 'models/dinov3-small.int8.onnx': 'x' }));
    expect(errors.join('\n')).toMatch(/models\/dinov3-small\.int8\.onnx ships without a pinned SHA-256/);
  });
});

// Decision D2: the store build shows YGOPRODeck's official card images, so it asks for their host; the
// crop build (--no-remote-images) asks for none. Every other host is still an error.
describe('verifyBuild: host permissions', () => {
  it("passes the default build, which asks for YGOPRODeck's image host (and, optionally, Anthropic's)", async () => {
    expect(await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }))).toEqual([]);
  });

  it('fails the default build without the image host: its card images could not load', async () => {
    const errors = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }, { host_permissions: [] }));
    expect(errors.join('\n')).toMatch(/needs host access to https:\/\/images\.ygoprodeck\.com\/\*/);
  });

  it('passes the crop build (--no-remote-images) without any host, and fails it with the image host', async () => {
    const crop = await build({ [DETECTOR]: FAKE_DETECTOR }, { host_permissions: undefined });
    expect(await errorsOf(crop, FAKE_PINS, { remoteImages: false })).toEqual([]);
    const errors = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }), FAKE_PINS, { remoteImages: false });
    expect(errors.join('\n')).toMatch(/crop build .*asks for https:\/\/images\.ygoprodeck\.com\/\*/);
  });

  it('still fails access to every site, and any other host, required or optional', async () => {
    for (const host of ['<all_urls>', 'https://*/*', '*://*/*']) {
      const errors = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }, { host_permissions: [IMAGES_HOST, host] }));
      expect(errors.join('\n')).toMatch(/access to every site/);
    }
    const other = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }, { host_permissions: [IMAGES_HOST, 'https://example.com/*'] }));
    expect(other.join('\n')).toMatch(/host permission "https:\/\/example\.com\/\*"/);
    const optional = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR }, { optional_host_permissions: [ANTHROPIC, 'https://example.com/*'] }));
    expect(optional.join('\n')).toMatch(/optional host permission "https:\/\/example\.com\/\*"/);
  });
});

// Final review M10 (RELEASE-CHECKLIST C19): the package carries its legal texts: the third-party notices
// and the bundled privacy and licences pages always, and the project's licence once one is chosen (D1).
describe('verifyBuild: the legal texts ship', () => {
  it.each(['THIRD_PARTY_NOTICES.md', 'privacy.html', 'licenses.html'])('fails a build without %s', async (rel) => {
    const dir = await build({ [DETECTOR]: FAKE_DETECTOR });
    await rm(path.join(dir, rel));
    expect((await errorsOf(dir)).join('\n')).toMatch(new RegExp(`^${rel.replace(/\./g, '\\.')} is missing`, 'm'));
  });

  it('refuses a build without LICENSE: the project is Apache-2.0 (decision D1)', async () => {
    const dir = await build({ [DETECTOR]: FAKE_DETECTOR });
    await rm(path.join(dir, 'LICENSE'));
    const report = await verifyBuild(dir, { modelSha256: FAKE_PINS });
    expect(report.errors.join('\n')).toMatch(/^LICENSE is missing/m);
    expect(report.warnings.join('\n')).not.toMatch(/LICENSE/);
  });

  it('passes a build that has them all, with no warning about them', async () => {
    const report = await verifyBuild(await build({ [DETECTOR]: FAKE_DETECTOR }), { modelSha256: FAKE_PINS });
    expect(report.errors).toEqual([]);
    expect(report.warnings.join('\n')).not.toMatch(/LICENSE|THIRD_PARTY_NOTICES|privacy\.html|licenses\.html/);
  });
});

// The interface's languages (src/shared/i18n.ts): _locales/ ships with default_locale, and the store fields the
// manifest takes from it (__MSG_extDescription__) fit the Web Store's limits in every language.
describe('verifyBuild: the interface languages (_locales)', () => {
  const messages = (description: string) => JSON.stringify({ extDescription: { message: description }, title: { message: 'Scan a card' } });
  const localized = { default_locale: 'en', description: '__MSG_extDescription__', action: { default_title: '__MSG_title__' } };

  it('passes a build whose manifest takes its description from _locales, in every language', async () => {
    const dir = await build(
      { [DETECTOR]: FAKE_DETECTOR, '_locales/en/messages.json': messages('Read Yu-Gi-Oh! cards.'), '_locales/de/messages.json': messages('Yu-Gi-Oh!-Karten lesen.') },
      localized,
    );
    expect(await errorsOf(dir)).toEqual([]);
  });

  it("fails a language whose description is over the Web Store's 132 characters, naming it", async () => {
    const dir = await build(
      { [DETECTOR]: FAKE_DETECTOR, '_locales/en/messages.json': messages('Read cards.'), '_locales/de/messages.json': messages('x'.repeat(133)) },
      localized,
    );
    expect((await errorsOf(dir)).join('\n')).toMatch(/^description \(de\) must be 1-132 characters for the Web Store \(it is 133\)/m);
  });

  it('fails _locales without default_locale (Chrome refuses to load it), a __MSG_ key en lacks, and a broken file', async () => {
    const without = await build({ [DETECTOR]: FAKE_DETECTOR, '_locales/en/messages.json': messages('Read cards.') });
    expect((await errorsOf(without)).join('\n')).toMatch(/_locales\/ ships but the manifest has no default_locale/);

    const unknown = await build(
      { [DETECTOR]: FAKE_DETECTOR, '_locales/en/messages.json': messages('Read cards.') },
      { ...localized, action: { default_title: '__MSG_nope__' } },
    );
    expect((await errorsOf(unknown)).join('\n')).toMatch(/manifest uses __MSG_nope__, but _locales\/en\/messages\.json has no "nope"/);

    const broken = await build({ [DETECTOR]: FAKE_DETECTOR, '_locales/en/messages.json': messages('Read cards.'), '_locales/fr/messages.json': '{' }, localized);
    expect((await errorsOf(broken)).join('\n')).toMatch(/_locales\/fr\/messages\.json is not valid JSON/);
  });
});

describe('verifyBuild: no OpenCV.js', () => {
  it('fails a bundle that inlines OpenCV.js (its WebAssembly as one long string; the notices no longer list it)', async () => {
    const offscreen = '// node_modules/@techstark/opencv-js/dist/opencv.js\nvar cv = 1;\n// src/offscreen/index.ts\n';
    const errors = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR, 'offscreen.js': offscreen }));
    expect(errors.join('\n')).toMatch(/offscreen\.js bundles OpenCV\.js/);
  });
});

describe('verifyBuild: DRAW2, the deleted AGPL-3.0 prototype, never ships again', () => {
  it('fails a build with a DRAW2 file, and a bundle with its code', async () => {
    const withFile = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR, 'models/draw2/detector.onnx': 'x' }));
    expect(withFile.join('\n')).toMatch(/models\/draw2\/detector\.onnx is part of DRAW2 \(AGPL-3\.0\)/);
    const offscreen = '// src/offscreen/draw2/recognizer.ts\nvar d = 1;\n// src/offscreen/index.ts\n';
    const bundled = await errorsOf(await build({ [DETECTOR]: FAKE_DETECTOR, 'offscreen.js': offscreen }));
    expect(bundled.join('\n')).toMatch(/offscreen\.js bundles DRAW2's AGPL-3\.0 code \(recognizer\.ts\)/);
  });
});

// build.mjs used to ignore options it didn't know: `node build.mjs --help` rebuilt dist/, the user's
// installed build. Every run here passes --out <a temporary folder>, so a regression can only ever touch that.
describe("build.mjs's command line", () => {
  /** A folder holding a previous build (build.mjs would empty it and build there), and what it holds. */
  async function previousBuild(): Promise<{ dir: string; before: Record<string, string> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'duel-lens-build-cli-'));
    dirs.push(dir);
    const before = { 'manifest.json': '{}', 'background.js': '// an earlier build', 'keep.txt': 'untouched' };
    for (const [rel, body] of Object.entries(before)) await writeFile(path.join(dir, rel), body);
    return { dir, before };
  }
  async function contents(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const rel of (await readdir(dir)).sort()) out[rel] = await readFile(path.join(dir, rel), 'utf8');
    return out;
  }
  const runBuild = (args: string[]) =>
    spawnSync(process.execPath, ['build.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 110_000 });

  it('refuses an unknown option: its usage, exit code 1, and nothing deleted or built', { timeout: 120_000 }, async () => {
    const { dir, before } = await previousBuild();
    const r = runBuild(['--bogus', '--out', dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown option: --bogus/);
    expect(r.stdout + r.stderr).toMatch(/Usage: node build\.mjs/);
    expect(await contents(dir)).toEqual(before);
  });

  it.each([['--help'], ['-h']])('prints its usage for %s and exits 0 without building', { timeout: 120_000 }, async (flag) => {
    const { dir, before } = await previousBuild();
    const r = runBuild([flag, '--out', dir]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Usage: node build\.mjs/);
    expect(r.stdout).toMatch(/--no-detector/);
    expect(await contents(dir)).toEqual(before);
  });

  it('refuses --out without a folder, and contradictory image options', { timeout: 120_000 }, async () => {
    const { dir, before } = await previousBuild();
    const noFolder = runBuild(['--help', '--out']); // --help: even a regression builds nothing
    expect(noFolder.status).toBe(1);
    expect(noFolder.stderr).toMatch(/--out needs a folder/);
    const contradiction = runBuild(['--remote-images', '--no-remote-images', '--out', dir]);
    expect(contradiction.status).toBe(1);
    expect(contradiction.stderr).toMatch(/--remote-images and --no-remote-images contradict each other/);
    expect(await contents(dir)).toEqual(before);
  });

  it('accepts every option npm run release passes it, and --remote-images still (now the default)', { timeout: 120_000 }, async () => {
    const { dir, before } = await previousBuild();
    const [node, script, ...args] = buildCommand(dir, { sourcemap: true, remoteImages: false });
    expect([node, script]).toEqual(['node', 'build.mjs']);
    expect(args).toEqual(['--out', dir, '--sourcemap', '--no-remote-images']);
    for (const argv of [args, ['--remote-images', '--out', dir]]) {
      const r = runBuild([...argv, '--help']); // all known, so --help answers (and builds nothing)
      expect(r.status).toBe(0);
    }
    expect(await contents(dir)).toEqual(before);
  });
});

// Decision D2: official card images in every build; --no-remote-images gives the crop build. These
// are real builds, into temporary folders (about a second each), checked by the release's verifyBuild.
describe('build.mjs: official card images in every build but --no-remote-images', () => {
  const haveModels = existsSync(path.join(root, 'extension', EMBEDDER)) && existsSync(path.join(root, 'extension', DETECTOR));
  async function realBuild(args: string[]): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'duel-lens-build-'));
    dirs.push(dir);
    const r = spawnSync(process.execPath, ['build.mjs', '--out', dir, ...args], { cwd: root, encoding: 'utf8', timeout: 110_000 });
    expect(r.status, r.stderr).toBe(0);
    return dir;
  }
  const bundles = async (dir: string) =>
    (await Promise.all((await readdir(dir)).filter((f) => f.endsWith('.js')).map((f) => readFile(path.join(dir, f), 'utf8')))).join('\n');

  it.skipIf(!haveModels)('builds the official-images build by default, and the release verification passes it', { timeout: 120_000 }, async () => {
    const dir = await realBuild([]);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.host_permissions).toEqual([IMAGES_HOST]);
    // The interface's languages ship (src/shared/i18n.ts), English the default.
    expect(manifest.default_locale).toBe('en');
    expect(existsSync(path.join(dir, '_locales/en/messages.json'))).toBe(true);
    expect(await bundles(dir)).toContain('images.ygoprodeck.com');
    const report = await verifyBuild(dir);
    expect(report.errors).toEqual([]);
  });

  it.skipIf(!haveModels)('builds the crop build with --no-remote-images: no image host, no card image request', { timeout: 120_000 }, async () => {
    const dir = await realBuild(['--no-remote-images']);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(await bundles(dir)).not.toContain('images.ygoprodeck.com');
    expect((await verifyBuild(dir, { remoteImages: false })).errors).toEqual([]);
  });
});

describe('npm run release: the official-images build by default (decision D2)', () => {
  it('builds it with no image option, and the crop build with --no-remote-images', () => {
    expect(buildCommand('release/build')).toEqual(['node', 'build.mjs', '--out', 'release/build']);
    expect(buildCommand('release/build', { remoteImages: false })).toEqual(['node', 'build.mjs', '--out', 'release/build', '--no-remote-images']);
  });

  it('asks for the matching privacy text to be hosted for the crop build, not for the default one', () => {
    expect(optionWarnings({ remoteImages: true }).join('\n')).not.toMatch(/privacy/);
    expect(optionWarnings({ remoteImages: false }).join('\n')).toMatch(/crop build \(--no-remote-images\).*privacy text/);
    expect(optionWarnings({ remoteImages: true, sourcemap: true, skipE2e: true })).toEqual([
      'source maps ship (--sourcemap)',
      'released without the E2E test (--skip-e2e)',
    ]);
  });

  it('takes --no-remote-images, keeps --remote-images (a no-op now), and refuses both at once', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await main(['--no-remote-images', '--help'])).toBe(0);
      expect(await main(['--remote-images', '--help'])).toBe(0);
      expect(await main(['--remote-images', '--no-remote-images'])).toBe(1);
      expect(error.mock.calls.flat().join('\n')).toMatch(/contradict each other/);
      expect(await main(['--bogus'])).toBe(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

// The Firefox release (npm run release -- --firefox; build.mjs --target firefox).
describe('verifyBuild: the Firefox build (target: firefox)', () => {
  /** A minimal Firefox build: build.mjs firefoxManifest's keys on the stand-in build above. */
  const firefoxManifest = {
    minimum_chrome_version: undefined,
    background: { scripts: ['background.js'], type: 'module' },
    sidebar_action: { default_panel: 'sidepanel.html', default_title: 'Duel Lens' },
    browser_specific_settings: { gecko: { id: FIREFOX_ID, strict_min_version: '140.0', data_collection_permissions: FIREFOX_DATA_COLLECTION } },
  };
  const firefoxFiles = { 'engine.js': '// src/offscreen/in-page.ts\n', 'sidepanel.html': '<!doctype html>' };
  const firefoxErrors = async (files: Record<string, string> = {}, patch: Record<string, unknown> = {}) =>
    (await verifyBuild(await build({ ...firefoxFiles, ...files }, { ...firefoxManifest, ...patch }), { modelSha256: FAKE_PINS, target: 'firefox' })).errors.filter(
      (e: string) => !/card-detector/.test(e),
    );

  it('passes the build.mjs --target firefox manifest, without asking for minimum_chrome_version', async () => {
    const dir = await build({ ...firefoxFiles, [DETECTOR]: FAKE_DETECTOR }, firefoxManifest);
    const report = await verifyBuild(dir, { modelSha256: FAKE_PINS, target: 'firefox' });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it.each([
    ['cross_origin_embedder_policy', { cross_origin_embedder_policy: { value: 'require-corp' } }],
    ['cross_origin_opener_policy', { cross_origin_opener_policy: { value: 'same-origin' } }],
    ['side_panel', { side_panel: { default_path: 'sidepanel.html' } }],
    ['permissions: offscreen', { permissions: ['offscreen'] }],
    ['permissions: sidePanel', { permissions: ['sidePanel'] }],
    ['use_dynamic_url', { web_accessible_resources: [{ resources: ['engine.js'], matches: ['<all_urls>'], use_dynamic_url: true }] }],
  ])('refuses %s, which Firefox warns about', async (what, patch) => {
    expect((await firefoxErrors({}, patch)).join('\n')).toContain(what);
  });

  it('refuses a service worker, a wrong add-on id or minimum version, and a wrong data-collection declaration', async () => {
    expect((await firefoxErrors({}, { background: { service_worker: 'background.js', scripts: ['background.js'], type: 'module' } })).join('\n')).toMatch(
      /background.service_worker/,
    );
    expect((await firefoxErrors({}, { background: { service_worker: 'background.js' } })).join('\n')).toMatch(/event page/);
    const gecko = (g: Record<string, unknown>) => ({ browser_specific_settings: { gecko: { ...firefoxManifest.browser_specific_settings.gecko, ...g } } });
    expect((await firefoxErrors({}, gecko({ id: 'other@example.com' }))).join('\n')).toMatch(/gecko.id/);
    expect((await firefoxErrors({}, gecko({ strict_min_version: '128.0' }))).join('\n')).toMatch(/strict_min_version/);
    expect((await firefoxErrors({}, gecko({ data_collection_permissions: { required: ['websiteContent'] } }))).join('\n')).toMatch(/data_collection_permissions/);
  });

  it('wants the in-page engine and no offscreen document', async () => {
    const dir = await build({ 'sidepanel.html': '<!doctype html>', 'offscreen.html': '<!doctype html>' }, firefoxManifest);
    const errors = (await verifyBuild(dir, { modelSha256: FAKE_PINS, target: 'firefox' })).errors.join('\n');
    expect(errors).toMatch(/engine.js is missing/);
    expect(errors).toMatch(/offscreen.html ships/);
  });

  it("refuses the Firefox build as Chrome's: no service worker", async () => {
    const dir = await build({ ...firefoxFiles, [DETECTOR]: FAKE_DETECTOR }, firefoxManifest);
    expect((await errorsOf(dir)).join('\n')).toMatch(/service_worker is missing/);
  });
});

describe('npm run release -- --firefox', () => {
  it('builds with --target firefox', () => {
    expect(buildCommand('release/build-firefox', { target: 'firefox' })).toEqual(['node', 'build.mjs', '--target', 'firefox', '--out', 'release/build-firefox']);
  });

  it("puts the sources, the lockfile and only the shipped models in the source zip, not tests or other models", async () => {
    const proj = await mkdtemp(path.join(tmpdir(), 'duel-lens-src-'));
    dirs.push(proj);
    const files: Record<string, string> = {
      'build.mjs': '', 'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}', LICENSE: '', 'THIRD_PARTY_NOTICES.md': '',
      'src/background/index.ts': '', 'src/background/index.test.ts': '', 'src/offscreen/__measure__/x.ts': '', 'src/content/test-fixtures.ts': '',
      'extension/manifest.json': '{}', 'extension/models/shipped.onnx': 'm', 'extension/models/experiment.onnx': 'x',
      'extension/data/cards.json': '[]', 'extension/data/index-shipped.bin': 'i', 'extension/data/index-other.bin': 'o', 'extension/.DS_Store': '',
      'tools/eval-real.ts': '', 'test/e2e/run.ts': '',
    };
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(proj, rel)), { recursive: true });
      await writeFile(path.join(proj, rel), body);
    }
    const shipped = new Set(['manifest.json', 'models/shipped.onnx', 'data/cards.json', 'data/index-shipped.bin']);
    expect((await sourceFiles(proj, shipped)).map((f: { rel: string }) => f.rel)).toEqual([
      'LICENSE', 'THIRD_PARTY_NOTICES.md', 'build.mjs', 'extension/data/cards.json', 'extension/data/index-shipped.bin', 'extension/manifest.json',
      'extension/models/shipped.onnx', 'package-lock.json', 'package.json', 'src/background/index.ts', 'tsconfig.json',
    ]);
  });

  it("tells AMO's reviewers how to build, with what, and why the linter flags what it flags", () => {
    const readme = reviewerReadme({ version: '1.2.3', node: '24.14.0', npm: '11.9.0', xpi: 'duel-lens-1.2.3-firefox.xpi' });
    expect(readme).toContain('npm ci');
    expect(readme).toContain('node build.mjs --target firefox --out dist-firefox');
    expect(readme).toMatch(/Node\.js 24\.14\.0 and npm 11\.9\.0/);
    expect(readme).toMatch(/new Function/);
    expect(readme).toMatch(/onnxruntime-web/);
  });

  // A real Firefox build, its source zip, the rebuild from it, and Firefox's own warnings (about 10 s).
  const haveModels = existsSync(path.join(root, 'extension', EMBEDDER)) && existsSync(path.join(root, 'extension', DETECTOR));
  it.skipIf(!haveModels)('builds a Firefox build that verifyBuild passes, rebuilt byte for byte from its source zip', { timeout: 240_000 }, async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'duel-lens-ff-release-'));
    dirs.push(work);
    const out = path.join(work, 'build');
    const r = spawnSync(process.execPath, ['build.mjs', '--target', 'firefox', '--out', out], { cwd: root, encoding: 'utf8', timeout: 110_000 });
    expect(r.status, r.stderr).toBe(0);
    const report = await verifyBuild(out, { target: 'firefox' });
    expect(report.errors).toEqual([]);
    const manifest = report.manifest;
    expect(manifest.browser_specific_settings.gecko.data_collection_permissions).toEqual(FIREFOX_DATA_COLLECTION);
    expect(manifest.permissions).not.toContain('offscreen');

    const stage = path.join(work, 'stage');
    for (const f of await sourceFiles(root, new Set(report.files.map((x: { rel: string }) => x.rel)))) {
      await mkdir(path.dirname(path.join(stage, f.rel)), { recursive: true });
      await writeFile(path.join(stage, f.rel), await readFile(f.abs));
    }
    await writeZip(stage, path.join(work, 'source.zip'));
    expect(await rebuildFromSource(path.join(work, 'source.zip'), out, path.join(work, 'check'))).toEqual([]);

    if (firefoxBinary()) {
      const loaded = await firefoxManifestReport(out);
      expect(loaded).toMatchObject({ warnings: [], errors: [] });
    }
  });
});

describe("build.mjs's --target", () => {
  const runBuild = (args: string[]) => spawnSync(process.execPath, ['build.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 110_000 });
  it('accepts chrome, firefox and opera, and refuses any other browser before building anything', () => {
    expect(runBuild(['--target', 'firefox', '--help']).status).toBe(0);
    expect(runBuild(['--target', 'opera', '--help']).status).toBe(0);
    expect(runBuild(['--target', 'chrome', '--help']).status).toBe(0);
    const bad = runBuild(['--target', 'safari', '--help']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--target needs a browser/);
    expect(runBuild(['--target']).stderr).toMatch(/--target needs a browser/);
  });
});


// The Opera release (npm run release -- --opera; build.mjs --target opera): addons.opera.com refuses raw
// binary files, so every .bin, .onnx and .wasm ships as base64 text (src/offscreen/packed-assets.ts).
describe('verifyBuild: the Opera build (target: opera)', () => {
  /** build.mjs packBinaryFiles's format. */
  const pack = (b: Buffer) => `${b.toString('base64').replace(/.{76}/g, '$&\n').replace(/\n?$/, '\n')}`;
  /** The stand-in build above, packed as build.mjs --target opera packs it, with Opera's offscreen.js. */
  async function operaBuild(files: Record<string, string | Buffer> = {}): Promise<string> {
    const dir = await build({ [DETECTOR]: FAKE_DETECTOR, 'offscreen.js': '// src/offscreen/packed-assets.ts\n// src/offscreen/opera.ts\n', ...files });
    const list: Record<string, { size: number; sha256: string }> = {};
    for (const rel of (await readdir(dir, { recursive: true })).map((r) => r.split(path.sep).join('/')).sort()) {
      if (!/\.(bin|onnx|wasm)$/.test(rel)) continue;
      const bytes = await readFile(path.join(dir, rel));
      list[rel] = { size: bytes.length, sha256: hashOf(bytes) };
      await writeFile(path.join(dir, `${rel}${PACKED_SUFFIX}`), pack(bytes));
      await rm(path.join(dir, rel));
    }
    await writeFile(path.join(dir, PACKED_MANIFEST), JSON.stringify({ encoding: 'base64', suffix: PACKED_SUFFIX, files: list }));
    return dir;
  }
  const operaErrors = async (dir: string, pins: Record<string, string> = FAKE_PINS) => (await verifyBuild(dir, { modelSha256: pins, target: 'opera' })).errors;

  it('passes a packed build: the models, the index and the runtime checked once decoded', async () => {
    const dir = await operaBuild({ 'data/index-x.bin': Buffer.alloc(300, 7) });
    const report = await verifyBuild(dir, { modelSha256: FAKE_PINS, target: 'opera' });
    expect(report.errors).toEqual([]);
    expect(report.packed.map((f: { rel: string }) => f.rel)).toEqual(['data/index-x.bin', DETECTOR, EMBEDDER, ORT[3], ORT[1]]);
    expect(report.files.some((f: { rel: string }) => /\.(bin|onnx|wasm)$/.test(f.rel))).toBe(false);
  });

  it("checks the models' pins on the decoded bytes", async () => {
    const errors = await operaErrors(await operaBuild(), { ...FAKE_PINS, [EMBEDDER]: 'f'.repeat(64) });
    expect(errors.join('\n')).toContain(`${EMBEDDER} (decoded from ${EMBEDDER}${PACKED_SUFFIX}): SHA-256 ${hashOf(FAKE_EMBEDDER)}, but the release pins ${'f'.repeat(64)}`);
  });

  it('refuses a raw .bin, .onnx or .wasm, which addons.opera.com rejects', async () => {
    const dir = await operaBuild();
    await mkdir(path.join(dir, 'data'));
    await writeFile(path.join(dir, 'data/index-x.bin'), Buffer.alloc(10));
    expect((await operaErrors(dir)).join('\n')).toMatch(/data\/index-x\.bin ships as a raw binary file, which addons\.opera\.com refuses/);
  });

  it('refuses a packed file that decodes to other bytes than the list says, or is not base64', async () => {
    const dir = await operaBuild();
    const other = Buffer.from(FAKE_EMBEDDER);
    other[5] ^= 1;
    await writeFile(path.join(dir, `${EMBEDDER}${PACKED_SUFFIX}`), pack(other));
    await writeFile(path.join(dir, `${ORT[1]}${PACKED_SUFFIX}`), pack(Buffer.from('short')));
    await writeFile(path.join(dir, `${DETECTOR}${PACKED_SUFFIX}`), '<html>\n');
    const errors = (await operaErrors(dir)).join('\n');
    expect(errors).toContain(`${EMBEDDER}${PACKED_SUFFIX} decodes to SHA-256 ${hashOf(other)}, but ${PACKED_MANIFEST} says ${hashOf(FAKE_EMBEDDER)}`);
    expect(errors).toMatch(new RegExp(`${ORT[1]}\\.b64\\.txt decodes to 5 bytes`));
    expect(errors).toContain(`${DETECTOR}${PACKED_SUFFIX} is not base64 text`);
  });

  it('refuses a listed file that is missing, an unlisted packed file, and a missing list', async () => {
    const dir = await operaBuild();
    await rm(path.join(dir, `${ORT[3]}${PACKED_SUFFIX}`));
    await mkdir(path.join(dir, 'data'));
    await writeFile(path.join(dir, `data/extra.bin${PACKED_SUFFIX}`), pack(Buffer.alloc(3)));
    const errors = (await operaErrors(dir)).join('\n');
    expect(errors).toContain(`${ORT[3]}${PACKED_SUFFIX} is missing, but ${PACKED_MANIFEST} lists ${ORT[3]}`);
    expect(errors).toContain(`data/extra.bin${PACKED_SUFFIX} is not in ${PACKED_MANIFEST}`);
    await rm(path.join(dir, PACKED_MANIFEST));
    expect((await operaErrors(dir)).join('\n')).toMatch(/packed-assets\.json is missing or invalid/);
  });

  it("refuses an offscreen.js that can't decode them (Chrome's)", async () => {
    const errors = (await operaErrors(await operaBuild({ 'offscreen.js': '// src/offscreen/index.ts\n' }))).join('\n');
    expect(errors).toMatch(/offscreen\.js doesn't bundle src\/offscreen\/packed-assets\.ts/);
  });

  it("refuses packed files in any other build: Chrome's engine reads raw files", async () => {
    const dir = await operaBuild();
    const errors = (await verifyBuild(dir, { modelSha256: FAKE_PINS })).errors.join('\n');
    expect(errors).toContain(`${PACKED_MANIFEST} is the Opera build's`);
    expect(errors).toMatch(/card-detector\.onnx is missing/);
  });

  it('npm run release -- --opera builds with --target opera', () => {
    expect(buildCommand('release/build-opera', { target: 'opera' })).toEqual(['node', 'build.mjs', '--target', 'opera', '--out', 'release/build-opera']);
  });

  it('refuses --firefox with --opera', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--firefox', '--opera'])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/two releases/));
  });

  // A real Opera build: verifyBuild passes it with the real pins, its packed files decode (through the
  // offscreen document's own packedFetch) to the very files Chrome's build ships, and every other file is
  // Chrome's byte for byte, offscreen.js apart (about 10 s).
  const haveModels = existsSync(path.join(root, 'extension', EMBEDDER)) && existsSync(path.join(root, 'extension', DETECTOR));
  it.skipIf(!haveModels)("builds an Opera build that verifyBuild passes, whose decoded files are Chrome's", { timeout: 240_000 }, async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'duel-lens-opera-release-'));
    dirs.push(work);
    const out = { opera: path.join(work, 'opera'), chrome: path.join(work, 'chrome') };
    for (const [target, dir] of Object.entries(out)) {
      const r = spawnSync(process.execPath, ['build.mjs', '--target', target, '--out', dir], { cwd: root, encoding: 'utf8', timeout: 110_000 });
      expect(r.status, r.stderr).toBe(0);
    }
    const report = await verifyBuild(out.opera, { target: 'opera' });
    expect(report.errors).toEqual([]);
    const list = JSON.parse(await readFile(path.join(out.opera, PACKED_MANIFEST), 'utf8')).files;
    expect(Object.keys(list).sort()).toEqual(['data/index-dinov2-small-duel-v3b.bin', DETECTOR, EMBEDDER, ORT[3], ORT[1]]);
    expect(list[EMBEDDER].sha256).toBe(MODEL_SHA256[EMBEDDER]);
    expect(list[DETECTOR].sha256).toBe(MODEL_SHA256[DETECTOR]);

    const base = 'chrome-extension://test/';
    const serve = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response(await readFile(path.join(out.opera, url.slice(base.length))));
    };
    const f = packedFetch({ fetch: serve as typeof fetch, baseUrl: base, log: () => {} });
    for (const rel of Object.keys(list)) {
      const decoded = Buffer.from(await (await f(`${base}${rel}`)).arrayBuffer());
      expect(decoded.equals(await readFile(path.join(out.chrome, rel))), rel).toBe(true);
    }

    const chrome = (await readdir(out.chrome, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    for (const e of chrome) {
      const rel = path.relative(out.chrome, path.join(e.parentPath, e.name)).split(path.sep).join('/');
      if (rel in list || rel === 'offscreen.js') continue;
      expect((await readFile(path.join(out.opera, rel))).equals(await readFile(path.join(out.chrome, rel))), rel).toBe(true);
    }
    expect(await readFile(path.join(out.chrome, 'offscreen.js'), 'utf8')).not.toContain('packed-assets');
  });
});
