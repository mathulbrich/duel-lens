// ONNX Runtime Web as the offscreen page runs it, shared by the embedder and the card detector, its
// .mjs/.wasm loaded from the extension's ort/ folder, models fetched from the extension package:
// - the WebGPU build (onnxruntime-web/webgpu) when the browser has a WebGPU adapter;
// - otherwise, or whenever WebGPU fails, the WASM build (onnxruntime-web/wasm, multi-threaded when
//   cross-origin isolated), as before 2026-10-09.
// createModelSession() picks one per model and falls back on its own (see there).
//
// Why WebGPU now: the 2026-09-28 ruling kept the engine WASM-only because the embedder of the time
// (dynamically quantised int8: MatMulInteger, which the WebGPU provider leaves on the CPU) ran about
// 1.7x slower on WebGPU. Our embedders since dinov2-small-duel are MatMulNBits 8-bit weights with float32
// activations, which it runs on the GPU: about 11 ms against 77 ms per crop on an Apple M-series GPU,
// with the same vectors (cosine >= 0.9999999 on 200 real crops; eval-real and realset2 unchanged row for
// row). The card detector's outlines are the same on both, and a whole screenshot takes 37 ms against
// 88 ms (a scan's crop: 15 ms on either). .superpowers/sdd/2026-09-28-duel-lens-v1/features3-webgpu.md;
// src/offscreen/__measure__/webgpu-parity.ts measures it again.
import * as ortWasm from 'onnxruntime-web/wasm';
import type { SessionLike, TensorCtor, TensorLike } from '../shared/embed-core';

export type WebOrt = Pick<typeof ortWasm, 'env' | 'InferenceSession' | 'Tensor'>;

/** The part of navigator.gpu we use: is there an adapter at all. */
export interface GpuLike {
  requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string } } | null>;
}

/** Injected for tests; defaults are the real browser APIs. */
export interface WebRuntimeDeps {
  /** Off: WASM only, WebGPU is not tried. Default on. */
  webgpu?: boolean;
  /** How long each WebGPU step may take before WASM is used instead (WEBGPU_TIMEOUTS; tests shorten them). */
  webgpuTimeouts?: Partial<WebGpuTimeouts>;
  ort?: WebOrt;
  /** onnxruntime-web's WebGPU build; default: `import('onnxruntime-web/webgpu')`, on first use. */
  ortWebGpu?: () => Promise<WebOrt>;
  /** navigator.gpu; null or undefined when the browser has no WebGPU. */
  gpu?: GpuLike | null;
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

/** WASM execution provider only. */
export const WASM_SESSION_OPTIONS = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } as const;

/**
 * The WebGPU execution provider. Nodes it has no kernel for (ORT puts shape arithmetic on the CPU on
 * purpose) run on the WebGPU build's own CPU provider, in the same session.
 */
export const WEBGPU_SESSION_OPTIONS = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' } as const;

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

/**
 * How long each WebGPU step may take, in ms, before WASM is used instead: a GPU or driver that hangs
 * must never hang the extension. Measured cold (a fresh Chrome profile, Apple M-series GPU, E2E click
 * run of 2026-10-09): the adapter and the build's import 12 ms together (esbuild inlines the import);
 * the first session 427 ms (the 26.8 MB WebGPU .wasm compiled, the device, the model), the second
 * 133 ms; first runs 44–65 ms (shaders compiled), later runs 11–40 ms. Each limit is over 20 times that,
 * for slower computers: a slow GPU is still faster than WASM, so it must not be timed out.
 */
export interface WebGpuTimeouts {
  adapterMs: number;
  importMs: number;
  /** One session's creation (after any created before it: see gpuCreates). */
  createMs: number;
  /** One run (the watchdog). */
  runMs: number;
}
export const WEBGPU_TIMEOUTS: WebGpuTimeouts = { adapterMs: 3_000, importMs: 3_000, createMs: 10_000, runMs: 10_000 };

class WebGpuTimeout extends Error {}

/** `p`, or a WebGpuTimeout after `ms`. */
function within<T>(p: Promise<T>, ms: number, step: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WebGpuTimeout(`${step} took over ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * WebGPU builds that timed out once (a create or a run that never came back): the GPU or its driver is
 * stuck, and the build's WebAssembly may still be inside that call, so no model uses it again in this
 * offscreen document. Each model on it moves to WASM at its next run.
 */
const stuckGpu = new WeakSet<WebOrt>();

export type WebGpuRuntime = { ort: WebOrt; adapter: string } | { ort: null; why: string };

/**
 * onnxruntime-web's WebGPU build (ort/ort-wasm-simd-threaded.asyncify.mjs/.wasm, from the package like
 * the WASM build's), or why this browser can't use it: no navigator.gpu, no adapter (a blocklisted GPU
 * or driver, WebGPU turned off), the adapter or the build took too long (WEBGPU_TIMEOUTS), or the build
 * failed to load. Never throws. One thread: the GPU does the model's work, the CPU only its shape
 * arithmetic, so no worker pool is started for it.
 */
export async function webGpuRuntime(deps: WebRuntimeDeps = {}): Promise<WebGpuRuntime> {
  const gpu = deps.gpu !== undefined ? deps.gpu : ((globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu ?? null);
  if (!gpu) return { ort: null, why: 'this browser has no WebGPU' };
  const limits = { ...WEBGPU_TIMEOUTS, ...deps.webgpuTimeouts };
  try {
    const adapter = await within(gpu.requestAdapter(), limits.adapterMs, 'the WebGPU adapter');
    if (!adapter) return { ort: null, why: 'no WebGPU adapter' };
    const load = deps.ortWebGpu ?? (async () => (await import('onnxruntime-web/webgpu')) as WebOrt);
    const ort = await within(load(), limits.importMs, "ONNX Runtime's WebGPU build");
    if (stuckGpu.has(ort)) return { ort: null, why: 'WebGPU got stuck earlier' };
    const getURL = deps.getURL ?? ((path: string) => chrome.runtime.getURL(path));
    ort.env.wasm.wasmPaths = getURL('ort/');
    ort.env.wasm.numThreads = 1;
    const name = [adapter.info?.vendor, adapter.info?.architecture].filter(Boolean).join(' ');
    return { ort, adapter: name || 'unknown' };
  } catch (e) {
    return { ort: null, why: `WebGPU is unavailable (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** A model's session on WebGPU or WASM; WASM takes over from WebGPU on its own (createModelSession). */
export interface ModelSession extends SessionLike {
  /** Where the next run goes. */
  readonly ep: 'webgpu' | 'wasm';
  release(): Promise<void>;
}

interface Opened {
  ort: WebOrt;
  session: { run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike | undefined>>; release?(): Promise<void> };
}

interface FeedTensor {
  type: 'float32';
  data: Float32Array;
  dims: readonly number[];
}

/**
 * The WebGPU build creates one session at a time: a second create() while one is under way fails with
 * "another WebGPU EP inference session is being created". The embedder and the card detector load
 * together (load-engine.ts), so their WebGPU sessions are created one after the other, per ORT build.
 */
const gpuCreates = new WeakMap<WebOrt, Promise<unknown>>();

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** False when a float32 output holds a NaN or an infinity (a plain loop: a detector output is about 1M floats). */
function isFinite32(t: TensorLike | undefined): boolean {
  if (!(t?.data instanceof Float32Array)) return true;
  const d = t.data;
  for (let i = 0; i < d.length; i++) if (d[i] - d[i] !== 0) return false;
  return true;
}

/**
 * A packaged model's session, and the Tensor class to build its inputs with. It runs on WebGPU when the
 * browser has an adapter, and WASM takes over, for good, when:
 * - the browser has no WebGPU or no adapter, or the adapter or the WebGPU build fails or takes too long;
 * - the WebGPU session can't be created, or takes too long (it is released if it turns up);
 * - a WebGPU run fails, returns a float output that isn't finite, or takes too long (the watchdog): that
 *   run is done again on WASM, so the job still gets its answer and the work queue moves on (the model is
 *   fetched again: the first fetch's 25 MB aren't kept for it). A failed WebGPU session is released; a
 *   stuck one is dropped (released only if its run ever comes back), and the other models leave that
 *   WebGPU build too (stuckGpu).
 * The extension must never break on a GPU. `what` names the model in errors and in the console.
 */
export async function createModelSession(path: string, what: string, deps: WebRuntimeDeps = {}): Promise<{ session: ModelSession; Tensor: TensorCtor }> {
  const wasm = webRuntime(deps);
  const limits = { ...WEBGPU_TIMEOUTS, ...deps.webgpuTimeouts };
  let model: Uint8Array | null = await wasm.bytes(path, what);
  const create = async (ort: WebOrt, bytes: Uint8Array, options: typeof WASM_SESSION_OPTIONS | typeof WEBGPU_SESSION_OPTIONS): Promise<Opened> => ({
    ort,
    session: (await ort.InferenceSession.create(bytes, options)) as unknown as Opened['session'],
  });
  /** A WebGPU session, created after the ones before it: see gpuCreates. */
  const createOnGpu = (ort: WebOrt, bytes: Uint8Array): Promise<Opened> => {
    const created = (gpuCreates.get(ort) ?? Promise.resolve()).then(() => create(ort, bytes, WEBGPU_SESSION_OPTIONS));
    gpuCreates.set(ort, created.catch(() => {}));
    return created;
  };
  // The first fetch's bytes while they are whole (a failed WebGPU create may have used them), or a new fetch.
  const openWasm = async () => create(wasm.ort, model && model.byteLength > 0 ? model : await wasm.bytes(path, what), WASM_SESSION_OPTIONS);

  async function openWebGpu(): Promise<Opened | null> {
    if (deps.webgpu === false) return null;
    const start = performance.now();
    const gpu = await webGpuRuntime(deps);
    if (!gpu.ort) {
      console.debug(`[DuelLens] ${what} runs on WASM: ${gpu.why}`);
      return null;
    }
    const ready = performance.now();
    const creating = createOnGpu(gpu.ort, model!);
    try {
      const got = await within(creating, limits.createMs, `creating the WebGPU session for ${what}`);
      const ms = (t: number) => Math.round(t);
      console.debug(`[DuelLens] ${what} runs on WebGPU (${gpu.adapter}; adapter and build ${ms(ready - start)} ms, session ${ms(performance.now() - ready)} ms)`);
      return got;
    } catch (e) {
      if (e instanceof WebGpuTimeout) {
        stuckGpu.add(gpu.ort);
        creating.then((o) => o.session.release?.()).catch(() => {});
      }
      console.warn(`[DuelLens] the WebGPU session for ${what} could not be created (${gpu.adapter}: ${errorText(e)}); it runs on WASM`, e);
      return null;
    }
  }

  const gpu = await openWebGpu();
  let active: Opened = gpu ?? (await openWasm());
  let ep: ModelSession['ep'] = gpu ? 'webgpu' : 'wasm';
  let runs = 0;
  model = null;

  /** The feeds as `ort`'s own Tensors: each ORT build only takes its own (the data is not copied). */
  const feedsFor = (ort: WebOrt, feeds: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(feeds).map(([k, t]) => [k, ort === wasm.ort ? t : new ort.Tensor('float32', (t as FeedTensor).data, [...(t as FeedTensor).dims])]));

  /** WASM from now on. A failed WebGPU session is released; a stuck one only once its run comes back, if ever. */
  async function toWasm(why: string, e: unknown, stuckRun?: Promise<unknown>): Promise<void> {
    console.warn(`[DuelLens] WebGPU ${why} for ${what} (${errorText(e)}); it runs on WASM from now on`, e);
    const dropped = active;
    active = await openWasm();
    ep = 'wasm';
    if (stuckRun) {
      stuckGpu.add(dropped.ort);
      void stuckRun.then(
        () => dropped.session.release?.(),
        () => dropped.session.release?.(),
      ).catch(() => {});
    } else {
      dropped.session.release?.().catch(() => {});
    }
  }

  const session: ModelSession = {
    get ep() {
      return ep;
    },
    async run(feeds) {
      if (ep === 'webgpu' && stuckGpu.has(active.ort)) await toWasm('got stuck on another model', new Error('stuck'));
      if (ep === 'webgpu') {
        const running = active.session.run(feedsFor(active.ort, feeds));
        try {
          const start = performance.now();
          const out = await within(running, limits.runMs, 'a run');
          if (runs++ === 0) console.debug(`[DuelLens] ${what}: first WebGPU run ${Math.round(performance.now() - start)} ms`);
          if (Object.values(out).every(isFinite32)) return out;
          throw new Error('an output that is not finite');
        } catch (e) {
          if (e instanceof WebGpuTimeout) await toWasm('got stuck', e, running);
          else await toWasm('failed', e);
        }
      }
      return active.session.run(feeds);
    },
    release: async () => {
      await active.session.release?.();
    },
  };
  return { session, Tensor: wasm.ort.Tensor as unknown as TensorCtor };
}
