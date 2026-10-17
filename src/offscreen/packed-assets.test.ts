// The Opera build's packed assets (packed-assets.ts): base64 text decoded back to the original bytes,
// checked against packed-assets.json's size and SHA-256, and served through fetch.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeBase64,
  installPackedFetch,
  PACKED_MANIFEST,
  PackedAssetError,
  packedFetch,
  sha256Hex,
  unpackAsset,
  type PackedManifest,
} from './packed-assets';

afterEach(() => vi.restoreAllMocks());

const BASE = 'chrome-extension://abcdefghijklmnop/';
const hashOf = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** build.mjs packBinaryFiles's format: base64 in 76-character lines, a newline at the end. */
const pack = (b: Uint8Array) => `${Buffer.from(b).toString('base64').replace(/.{76}/g, '$&\n').replace(/\n?$/, '\n')}`;
/** Bytes 0-255 over and over, `n` of them: every byte value, lines that wrap, and padding when n % 3 != 0. */
const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256);

describe('decodeBase64', () => {
  it('decodes the build\'s 76-character lines back to the bytes, without the native decoder (atob)', () => {
    for (const n of [0, 1, 2, 3, 56, 57, 58, 1000]) {
      const bytes = bytesOf(n);
      expect(decodeBase64(pack(bytes), undefined)).toEqual(bytes);
    }
  });

  it('uses Uint8Array.fromBase64 when the browser has it', () => {
    const native = vi.fn((text: string) => new Uint8Array(Buffer.from(text, 'base64')));
    expect(decodeBase64(pack(bytesOf(100)), native)).toEqual(bytesOf(100));
    expect(native).toHaveBeenCalledOnce();
  });

  it('throws on a character outside the alphabet', () => {
    expect(() => decodeBase64('AAAA*AAA', undefined)).toThrow();
  });
});

describe('sha256Hex', () => {
  it("is the file's SHA-256 in lowercase hex", async () => {
    const bytes = bytesOf(5000);
    expect(await sha256Hex(bytes)).toBe(hashOf(bytes));
  });
});

describe('unpackAsset: the decoded bytes, checked', () => {
  const bytes = bytesOf(3000);
  const entry = { size: bytes.length, sha256: hashOf(bytes) };
  const reader = (text: string) => vi.fn(async (_rel: string) => text);

  it('reads <file>.b64.txt and returns the original bytes', async () => {
    const read = reader(pack(bytes));
    expect(await unpackAsset('models/m.onnx', entry, read)).toEqual(bytes);
    expect(read).toHaveBeenCalledWith('models/m.onnx.b64.txt');
  });

  it('refuses a file of the wrong size (a truncated upload)', async () => {
    const text = pack(bytes.subarray(0, 2997));
    await expect(unpackAsset('models/m.onnx', entry, reader(text))).rejects.toThrow(PackedAssetError);
    await expect(unpackAsset('models/m.onnx', entry, reader(text))).rejects.toThrow(/corrupted: .* decodes to 2997 bytes, not 3000/);
  });

  it('refuses a file of the right size whose SHA-256 differs (one byte changed)', async () => {
    const changed = bytes.slice();
    changed[1234] ^= 1;
    await expect(unpackAsset('models/m.onnx', entry, reader(pack(changed)))).rejects.toThrow(/models\/m\.onnx is corrupted: its SHA-256 is [0-9a-f]{64}, not /);
  });

  it('refuses text that is not base64', async () => {
    await expect(unpackAsset('models/m.onnx', entry, reader('<html>not found</html>'))).rejects.toThrow(/m\.onnx\.b64\.txt is not base64 text/);
  });
});

describe('packedFetch', () => {
  const model = bytesOf(4000);
  const wasm = bytesOf(1500);
  const manifest: PackedManifest = {
    encoding: 'base64',
    suffix: '.b64.txt',
    files: {
      'models/m.onnx': { size: model.length, sha256: hashOf(model) },
      'ort/r.wasm': { size: wasm.length, sha256: hashOf(wasm) },
    },
  };
  /** The extension's package: path → body; a fetch that serves it and records each request. */
  function packageFetch(files: Record<string, string> = {}) {
    const all: Record<string, string> = {
      [PACKED_MANIFEST]: JSON.stringify(manifest),
      'models/m.onnx.b64.txt': pack(model),
      'ort/r.wasm.b64.txt': pack(wasm),
      'data/cards.json': '{"cards":[]}',
      ...files,
    };
    return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const rel = url.startsWith(BASE) ? url.slice(BASE.length) : null;
      return rel !== null && all[rel] !== undefined ? new Response(all[rel]) : new Response('missing', { status: 404 });
    });
  }

  it('answers a packed model with its decoded bytes, and says how long the decode took', async () => {
    const real = packageFetch();
    const log = vi.fn();
    const res = await packedFetch({ fetch: real, baseUrl: BASE, log })(`${BASE}models/m.onnx`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(model);
    expect(real.mock.calls.map((c) => c[0])).toEqual([`${BASE}${PACKED_MANIFEST}`, `${BASE}models/m.onnx.b64.txt`]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/unpacked models\/m\.onnx \(0\.0 MB, SHA-256 checked\) in \d+ ms/));
  });

  it("answers ONNX Runtime's .wasm as application/wasm (for WebAssembly.instantiateStreaming), a Request or a URL alike", async () => {
    const f = packedFetch({ fetch: packageFetch(), baseUrl: BASE, log: () => {} });
    for (const input of [new Request(`${BASE}ort/r.wasm`), new URL(`${BASE}ort/r.wasm`)]) {
      const res = await f(input, { credentials: 'same-origin' });
      expect(res.headers.get('Content-Type')).toBe('application/wasm');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(wasm);
    }
  });

  it('passes every other request through untouched: JSON, an unlisted binary, another origin', async () => {
    const real = packageFetch();
    const f = packedFetch({ fetch: real, baseUrl: BASE, log: () => {} });
    const init = { credentials: 'same-origin' } as const;
    expect(await (await f(`${BASE}data/cards.json`, init)).text()).toBe('{"cards":[]}');
    expect(real).toHaveBeenLastCalledWith(`${BASE}data/cards.json`, init);
    expect((await f(`${BASE}models/other.onnx`)).status).toBe(404);
    expect(real).toHaveBeenLastCalledWith(`${BASE}models/other.onnx`, undefined);
    await f('https://images.ygoprodeck.com/images/cards/1.jpg');
    expect(real).toHaveBeenLastCalledWith('https://images.ygoprodeck.com/images/cards/1.jpg', undefined);
    // The JSON and the other origin never needed the list; the unlisted .onnx read it once.
    expect(real.mock.calls.filter((c) => c[0] === `${BASE}${PACKED_MANIFEST}`)).toHaveLength(1);
  });

  it('reads the list once, and again after a failed read', async () => {
    const real = packageFetch({ [PACKED_MANIFEST]: '{' });
    const f = packedFetch({ fetch: real, baseUrl: BASE, log: () => {} });
    await expect(f(`${BASE}models/m.onnx`)).rejects.toThrow(SyntaxError);
    real.mockImplementation(packageFetch());
    await f(`${BASE}models/m.onnx`);
    await f(`${BASE}ort/r.wasm`);
    expect(real.mock.calls.filter((c) => c[0] === `${BASE}${PACKED_MANIFEST}`)).toHaveLength(2);
  });

  it('fails loudly on a corrupted file: the fetch rejects with the reason, and the console says so', async () => {
    const changed = model.slice();
    changed[0] ^= 0xff;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = packedFetch({ fetch: packageFetch({ 'models/m.onnx.b64.txt': pack(changed) }), baseUrl: BASE, log: () => {} });
    await expect(f(`${BASE}models/m.onnx`)).rejects.toThrow(/models\/m\.onnx is corrupted: its SHA-256 is/);
    expect(error).toHaveBeenCalledWith('[DuelLens] models/m.onnx could not be unpacked', expect.any(PackedAssetError));
  });

  it('fails when a listed file is missing from the package', async () => {
    const f = packedFetch({ fetch: packageFetch({ 'ort/r.wasm.b64.txt': undefined as unknown as string }), baseUrl: BASE, log: () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(f(`${BASE}ort/r.wasm`)).rejects.toThrow(/ort\/r\.wasm\.b64\.txt could not be read \(HTTP 404\)/);
  });

  it('installPackedFetch puts it in front of the scope\'s fetch', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const real = packageFetch();
    const scope = { fetch: real as unknown as typeof fetch };
    installPackedFetch(scope, BASE);
    expect(scope.fetch).not.toBe(real);
    expect(new Uint8Array(await (await scope.fetch(`${BASE}models/m.onnx`)).arrayBuffer())).toEqual(model);
  });
});
