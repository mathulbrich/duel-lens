// The release verification's checks on the models (present, and byte for byte the pinned ones), on
// OpenCV and on DRAW2 (tools/release.mjs).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '../src/shared/models';
// @ts-expect-error a plain ESM script, no .d.ts
import { buildCommand, DETECTOR_MODEL, EMBEDDER_MODEL, main, MODEL_SHA256, optionWarnings, sha256, verifyBuild } from './release.mjs';

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
