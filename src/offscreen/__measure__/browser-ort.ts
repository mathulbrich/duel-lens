// Measurement helper (not shipped, not a test): onnxruntime-web in a real headless Chrome page, driven
// from Node, so the WebGPU execution provider the offscreen document may use can be checked against
// its WASM one on the same inputs (webgpu-parity.ts) and run through tools/eval-real.ts unchanged
// (webgpu-hooks.mjs). The page loads ORT's own builds from node_modules (ort.webgpu.min.mjs and
// ort.wasm.min.mjs, as build.mjs ships them) and the models from extension/models; it is served
// cross-origin isolated, like the offscreen document (manifest COOP/COEP), so WASM gets the same
// min(4, cores) threads.
//
// Each remote session is a SessionLike (src/shared/embed-core.ts): the caller builds the input tensors
// in Node (embedImages, createCardDetector: the extension's own preprocessing), the page runs them on
// the chosen execution provider, and the outputs come back as typed arrays. `lastRunMs` is the page's
// own session.run() time (no transfer).
//
// Chrome flags: BROWSER_ORT_FLAGS (space-separated) adds to the launch, e.g. "--enable-unsafe-webgpu".
// BROWSER_ORT_BROWSER=firefox: Firefox instead (WebDriver BiDi; FIREFOX_BIN or /Applications/Firefox.app),
// in a visible window, the only place Firefox offers a WebGPU adapter, and served without COOP/COEP, so
// WASM runs one thread as in the Firefox build's event page (which can't be cross-origin isolated).
// The Firefox gate of decision D-FF1 (firefox-port.md): webgpu-parity.ts and eval-real through it.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SessionLike, TensorLike } from '../../shared/embed-core';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const ORT_DIST = path.join(ROOT, 'node_modules/onnxruntime-web/dist');

export type Ep = 'webgpu' | 'wasm';

export interface RemoteSession extends SessionLike {
  ep: Ep;
  /** The page's own session.run() time of the last run, in ms. */
  lastRunMs: number;
  release(): Promise<void>;
}

export interface BrowserOrt {
  /** The page's WebGPU adapter (vendor, architecture, description), or null when it has none. */
  adapter: { vendor: string; architecture: string; description: string } | null;
  /** A session on `ep` for a model file (a path under extension/). */
  session(file: string, ep: Ep): Promise<RemoteSession>;
  close(): Promise<void>;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>browser-ort</title><script type="module">
import * as gpu from '/ort/ort.webgpu.min.mjs';
import * as wasm from '/ort/ort.wasm.min.mjs';
for (const o of [gpu, wasm]) { o.env.wasm.wasmPaths = '/ort/'; o.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1; }
const TYPES = { float32: Float32Array, int32: Int32Array, int64: BigInt64Array, uint8: Uint8Array, int8: Int8Array, bool: Uint8Array };
const b64 = (u8) => u8.toBase64();
const unb64 = (s) => Uint8Array.fromBase64(s);
const sessions = new Map();
let next = 0;
let creating = Promise.resolve();
window.browserOrt = {
  async adapter() {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { vendor: a.info?.vendor ?? '', architecture: a.info?.architecture ?? '', description: a.info?.description ?? '' } : null;
  },
  async create(url, ep) {
    const ort = ep === 'webgpu' ? gpu : wasm;
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    // One create at a time (the WebGPU build refuses a second one under way, as web-runtime.ts says).
    const made = creating.then(() => ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' }));
    creating = made.catch(() => {});
    const s = await made;
    const id = String(next++);
    sessions.set(id, { s, ort });
    return id;
  },
  async run(id, feeds) {
    const { s, ort } = sessions.get(id);
    const t = {};
    for (const [k, f] of Object.entries(feeds)) {
      const u8 = unb64(f.b64);
      t[k] = new ort.Tensor(f.type, new TYPES[f.type](u8.buffer, u8.byteOffset, u8.byteLength / TYPES[f.type].BYTES_PER_ELEMENT), f.dims);
    }
    const t0 = performance.now();
    const out = await s.run(t);
    const ms = performance.now() - t0;
    const res = {};
    for (const [k, v] of Object.entries(out)) {
      const d = await v.getData();
      res[k] = { type: v.type, dims: [...v.dims], b64: b64(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)) };
    }
    return { ms, out: res };
  },
  async release(id) { await sessions.get(id)?.s.release(); sessions.delete(id); },
};
window.browserOrtReady = true;
</script>`;

const TYPED: Record<string, new (buf: ArrayBuffer, off: number, len: number) => ArrayLike<number> & { byteLength: number }> = {
  float32: Float32Array,
  int32: Int32Array,
  int64: BigInt64Array as never,
  uint8: Uint8Array,
  int8: Int8Array,
  bool: Uint8Array,
};

interface TensorIn {
  type?: string;
  data: ArrayBufferView;
  dims: readonly number[];
}

const FIREFOX = process.env.BROWSER_ORT_BROWSER === 'firefox';

function serve(): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const headers: Record<string, string> = FIREFOX
      ? {}
      : { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' };
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { ...headers, 'Content-Type': 'text/html' }).end(PAGE);
      } else if (url.pathname.startsWith('/ort/')) {
        const f = path.join(ORT_DIST, path.basename(url.pathname));
        const type = f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
        res.writeHead(200, { ...headers, 'Content-Type': type }).end(await readFile(f));
      } else if (url.pathname.startsWith('/extension/')) {
        const f = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
        if (!f.startsWith(path.join(ROOT, 'extension'))) throw new Error('outside extension/');
        res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream' }).end(await readFile(f));
      } else res.writeHead(404, headers).end();
    } catch {
      res.writeHead(404, headers).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

export async function launchBrowserOrt(opts: { flags?: string[]; headless?: boolean } = {}): Promise<BrowserOrt> {
  const require = createRequire(path.join(ROOT, 'test/e2e/package.json'));
  // puppeteer lives in test/e2e's own node_modules (no types from the project root): the part used here.
  interface Page {
    on(event: 'console', fn: (m: { type(): string; text(): string }) => void): void;
    on(event: 'pageerror', fn: (e: unknown) => void): void;
    goto(url: string): Promise<unknown>;
    waitForFunction(fn: string, opts: { timeout: number }): Promise<unknown>;
    evaluate<A extends unknown[]>(fn: string | ((...args: A) => unknown), ...args: A): Promise<unknown>;
  }
  const puppeteer = (await import(require.resolve('puppeteer'))).default as {
    launch(o: Record<string, unknown>): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }>;
  };
  const flags = [...(opts.flags ?? []), ...(process.env.BROWSER_ORT_FLAGS ?? '').split(' ').filter(Boolean)];
  const server = await serve();
  const port = (server.address() as AddressInfo).port;
  const browser = await puppeteer.launch(
    FIREFOX
      ? {
          browser: 'firefox',
          executablePath: process.env.FIREFOX_BIN ?? '/Applications/Firefox.app/Contents/MacOS/firefox',
          headless: false,
        }
      : { headless: opts.headless ?? true, pipe: true, args: ['--no-first-run', ...flags] },
  );
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warn') console.error(`[browser-ort ${m.type()}]`, m.text());
  });
  page.on('pageerror', (e) => console.error('[browser-ort pageerror]', e));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction('window.browserOrtReady === true', { timeout: 30000 });
  const adapter = (await page.evaluate('window.browserOrt.adapter()')) as BrowserOrt['adapter'];
  return {
    adapter,
    async session(file, ep) {
      const id = (await page.evaluate((u: string, e: string) => (window as never as { browserOrt: { create(u: string, e: string): Promise<string> } }).browserOrt.create(u, e), `/extension/${file}`, ep)) as string;
      const remote: RemoteSession = {
        ep,
        lastRunMs: 0,
        async run(feeds) {
          const wire: Record<string, { type: string; dims: number[]; b64: string }> = {};
          for (const [k, v] of Object.entries(feeds)) {
            const t = v as TensorIn;
            const bytes = Buffer.from(t.data.buffer, t.data.byteOffset, t.data.byteLength);
            wire[k] = { type: t.type ?? 'float32', dims: [...t.dims], b64: bytes.toString('base64') };
          }
          const r = (await page.evaluate(
            (i: string, f: unknown) => (window as never as { browserOrt: { run(i: string, f: unknown): Promise<unknown> } }).browserOrt.run(i, f),
            id,
            wire,
          )) as { ms: number; out: Record<string, { type: string; dims: number[]; b64: string }> };
          remote.lastRunMs = r.ms;
          const out: Record<string, TensorLike> = {};
          for (const [k, v] of Object.entries(r.out)) {
            const buf = Buffer.from(v.b64, 'base64');
            const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
            const Ctor = TYPED[v.type] ?? Float32Array;
            out[k] = { data: new Ctor(ab, 0, ab.byteLength / (Ctor as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT), dims: v.dims };
          }
          return out;
        },
        release: async () => {
          await page.evaluate((i: string) => (window as never as { browserOrt: { release(i: string): Promise<void> } }).browserOrt.release(i), id);
        },
      };
      return remote;
    },
    async close() {
      await browser.close();
      server.close();
    },
  };
}
