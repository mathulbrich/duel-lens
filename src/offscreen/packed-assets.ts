// The Opera build's packed assets (build.mjs --target opera; store/opera.md). addons.opera.com refuses
// raw binary files ("Invalid type on file: data/index-dinov2-small-duel-v3b.bin"), so that build ships
// every .bin, .onnx and .wasm as base64 text, `<file>.b64.txt` (76-character lines), and
// packed-assets.json lists each original's size and SHA-256 (MODEL_SHA256's pins for the two models:
// tools/release.mjs verifyBuild checks that). Opera's offscreen document (opera.ts) puts packedFetch in
// front of fetch: a request for an original file gets its decoded bytes, checked against that list, so
// the engine's loaders (the index, both models: engine-handler.ts, web-runtime.ts) and ONNX Runtime's
// own fetch of its .wasm read them unchanged. A decoded file of the wrong size or SHA-256 is an error,
// never a different model or runtime.
//
// Why fetch, and not ONNX Runtime's env.wasm.wasmBinary (which 1.30 supports, for the WASM and the WebGPU
// build alike: lib/wasm/wasm-factory.ts): wasmBinary needs the bytes before the first session, so both
// runtimes (41 MB) would be decoded at every engine start, or web-runtime.ts would need code that changes
// Chrome's bundle. Through fetch, ORT's own loader asks for the one runtime it uses, when it uses it, and
// the Chrome, Edge and Firefox bundles stay byte for byte what they were (this file ships in Opera's only).

/** The suffix of a packed file: `models/x.onnx` ships as `models/x.onnx.b64.txt`. */
export const PACKED_SUFFIX = '.b64.txt';
/** The list of packed files, at the package root. */
export const PACKED_MANIFEST = 'packed-assets.json';
/** The raw binary files the Opera build packs (build.mjs PACKED_TYPES, tools/release.mjs PACKED_TYPES). */
export const PACKED_TYPES = /\.(bin|onnx|wasm)$/i;

/** One original file: its size in bytes and its SHA-256 (lowercase hex). */
export interface PackedEntry {
  size: number;
  sha256: string;
}

/** packed-assets.json: the originals by their path in the package (`models/x.onnx`). */
export interface PackedManifest {
  encoding: 'base64';
  suffix: string;
  files: Record<string, PackedEntry>;
}

/** A packed file that doesn't decode to its original: the wrong size or the wrong SHA-256. */
export class PackedAssetError extends Error {
  override name = 'PackedAssetError';
}

type Base64Decoder = (text: string) => Uint8Array<ArrayBuffer>;
/** Uint8Array.fromBase64 (Chromium 140 and later), when the browser has it. */
const nativeDecoder = (): Base64Decoder | undefined => (Uint8Array as unknown as { fromBase64?: Base64Decoder }).fromBase64?.bind(Uint8Array);

/**
 * The bytes of base64 text. ASCII whitespace (the 76-character lines) is skipped, as both decoders do;
 * any other character outside the alphabet throws. `native` is for tests (the browser's by default).
 */
export function decodeBase64(text: string, native: Base64Decoder | undefined = nativeDecoder()): Uint8Array<ArrayBuffer> {
  if (native) return native(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** SHA-256 of `bytes`, as lowercase hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `rel`'s original bytes, from `<rel>.b64.txt` (read by `readText`): decoded, then checked against its
 * entry. Throws a PackedAssetError when the size or the SHA-256 differs.
 */
export async function unpackAsset(rel: string, entry: PackedEntry, readText: (rel: string) => Promise<string>): Promise<Uint8Array<ArrayBuffer>> {
  const packed = `${rel}${PACKED_SUFFIX}`;
  const text = await readText(packed);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64(text);
  } catch (e) {
    throw new PackedAssetError(`${packed} is not base64 text (${e instanceof Error ? e.message : String(e)})`);
  }
  if (bytes.byteLength !== entry.size) {
    throw new PackedAssetError(`${rel} is corrupted: ${packed} decodes to ${bytes.byteLength} bytes, not ${entry.size}`);
  }
  const sum = await sha256Hex(bytes);
  if (sum !== entry.sha256) throw new PackedAssetError(`${rel} is corrupted: its SHA-256 is ${sum}, not ${entry.sha256}`);
  return bytes;
}

export interface PackedFetchDeps {
  /** The browser's fetch, which reads the packed files themselves. */
  fetch: typeof fetch;
  /** The extension's own base URL: chrome.runtime.getURL(''). */
  baseUrl: string;
  /** Each file's decode time goes here (console.debug by default). */
  log?: (message: string) => void;
  now?: () => number;
}

const urlOf = (input: RequestInfo | URL): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

/**
 * fetch, except that a request for one of this extension's packed files (packed-assets.json; .bin,
 * .onnx and .wasm only) answers with its decoded, checked bytes (unpackAsset): 200, application/wasm
 * for a .wasm (ONNX Runtime compiles it with WebAssembly.instantiateStreaming), application/octet-stream
 * otherwise. Every other request goes to `deps.fetch` as it is. The list is read once; a failed read is
 * tried again next time. Decoded bytes aren't kept: a file asked for twice is decoded twice.
 */
export function packedFetch(deps: PackedFetchDeps): typeof fetch {
  const log = deps.log ?? ((message: string) => console.debug(message));
  const now = deps.now ?? (() => performance.now());
  const readText = async (rel: string): Promise<string> => {
    const res = await deps.fetch(`${deps.baseUrl}${rel}`);
    if (!res.ok) throw new Error(`${rel} could not be read (HTTP ${res.status})`);
    return res.text();
  };
  let manifest: Promise<PackedManifest> | null = null;
  const loadManifest = (): Promise<PackedManifest> => {
    if (!manifest) {
      const attempt = readText(PACKED_MANIFEST).then((text) => JSON.parse(text) as PackedManifest);
      manifest = attempt;
      attempt.catch(() => {
        if (manifest === attempt) manifest = null;
      });
    }
    return manifest;
  };

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const rel = url.startsWith(deps.baseUrl) ? url.slice(deps.baseUrl.length).split(/[?#]/)[0] : '';
    if (!PACKED_TYPES.test(rel)) return deps.fetch(input, init);
    const { files } = await loadManifest();
    const entry = Object.hasOwn(files, rel) ? files[rel] : undefined;
    if (!entry) return deps.fetch(input, init);
    const start = now();
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = await unpackAsset(rel, entry, readText);
    } catch (e) {
      console.error(`[DuelLens] ${rel} could not be unpacked`, e);
      throw e;
    }
    log(`[DuelLens] unpacked ${rel} (${(entry.size / 1e6).toFixed(1)} MB, SHA-256 checked) in ${Math.round(now() - start)} ms`);
    const type = rel.toLowerCase().endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
    return new Response(bytes, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(bytes.byteLength) } });
  };
}

/** Puts packedFetch in front of `scope.fetch` (the offscreen document's global: opera.ts). */
export function installPackedFetch(scope: { fetch: typeof fetch }, baseUrl: string): void {
  scope.fetch = packedFetch({ fetch: scope.fetch.bind(scope), baseUrl });
}
