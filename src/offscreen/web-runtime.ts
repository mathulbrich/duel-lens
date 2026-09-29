// ONNX Runtime Web as the offscreen page runs it, shared by the embedder and the card detector: the
// WASM-only build (multi-threaded when cross-origin isolated), its .mjs/.wasm loaded from the
// extension's ort/ folder, models fetched from the extension package.
import * as ortWasm from 'onnxruntime-web/wasm';

export type WebOrt = Pick<typeof ortWasm, 'env' | 'InferenceSession' | 'Tensor'>;

/** Injected for tests; defaults are the real browser APIs. */
export interface WebRuntimeDeps {
  ort?: WebOrt;
  getURL?: (path: string) => string;
  fetch?: typeof fetch;
  crossOriginIsolated?: boolean;
  hardwareConcurrency?: number;
}

export interface WebRuntime {
  ort: WebOrt;
  /** The bytes of a file packaged with the extension; `what` names it in errors. */
  bytes(path: string, what?: string): Promise<Uint8Array>;
  /** A packaged JSON file. */
  json(path: string, what?: string): Promise<unknown>;
}

/** WASM execution provider only (see web-embedder.ts for why). */
export const WASM_SESSION_OPTIONS = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } as const;

export function webRuntime(deps: WebRuntimeDeps = {}): WebRuntime {
  const ort = deps.ort ?? ortWasm;
  const getURL = deps.getURL ?? ((path: string) => chrome.runtime.getURL(path));
  const fetchFile = deps.fetch ?? fetch;
  const isolated = deps.crossOriginIsolated ?? globalThis.crossOriginIsolated === true;
  const cores = deps.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 1;

  // A string prefix makes ORT load its own .mjs/.wasm from the package (never a CDN),
  // so its thread workers start from that file rather than from the offscreen bundle.
  ort.env.wasm.wasmPaths = getURL('ort/');
  ort.env.wasm.numThreads = isolated ? Math.min(4, cores) : 1;

  async function fetchPackaged(path: string, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchFile(getURL(path));
    } catch (e) {
      throw new Error(`Could not load ${what} (${e instanceof Error ? e.message : String(e)})`);
    }
    if (!res.ok) throw new Error(`Could not load ${what} (HTTP ${res.status})`);
    return res;
  }

  return {
    ort,
    bytes: async (path, what = path) => new Uint8Array(await (await fetchPackaged(path, what)).arrayBuffer()),
    json: async (path, what = path) => (await fetchPackaged(path, what)).json() as Promise<unknown>,
  };
}
