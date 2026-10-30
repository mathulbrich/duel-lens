import { afterEach, describe, expect, it, vi } from 'vitest';
import { getModel } from '../shared/models';
import type { RGBAImage } from '../shared/preprocess';
import { createWebEmbedder, type WebEmbedderDeps } from './web-embedder';

const spec = getModel();
const MODEL_BYTES = [7, 7, 7];

interface Created {
  eps: string[];
  model: Uint8Array;
  runs: number;
  released: boolean;
}

interface FakeOpts {
  failCreate?: boolean;
  /** create() never settles until `resolveHung()` is called. */
  hangCreate?: boolean;
  failRun?: boolean;
  /** Runs return NaN. */
  nanRun?: boolean;
}

/** A fake onnxruntime-web build: records sessions; the options make them fail. */
function fakeOrt(opts: FakeOpts = {}) {
  const created: Created[] = [];
  const env = { wasm: {} as { wasmPaths?: unknown; numThreads?: number } };
  class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  }
  let resolveHung = () => {};
  const InferenceSession = {
    async create(model: Uint8Array, options: { executionProviders: string[] }) {
      const eps = options.executionProviders;
      if (opts.failCreate) throw new Error('no backend found');
      if (opts.hangCreate) await new Promise<void>((r) => (resolveHung = r));
      const record: Created = { eps, model, runs: 0, released: false };
      created.push(record);
      return {
        async run(feeds: Record<string, Tensor>) {
          record.runs++;
          if (opts.failRun) throw new Error('Session already started');
          const input = feeds[spec.inputName];
          const n = input.dims[0];
          const tokens = spec.pooling === 'none' ? 1 : 2;
          const data = new Float32Array(n * tokens * spec.dim).map((_, i) => (opts.nanRun ? NaN : (i % 5) + 1));
          const dims = spec.pooling === 'none' ? [n, spec.dim] : [n, tokens, spec.dim];
          return { [spec.outputName]: { data, dims } };
        },
        async release() {
          record.released = true;
        },
      };
    },
  };
  return { ort: { env, InferenceSession, Tensor } as unknown as NonNullable<WebEmbedderDeps['ort']>, created, env, resolveHung: () => resolveHung() };
}

/** navigator.gpu with an adapter (or none). */
const gpuWith = (adapter: boolean) => ({ requested: 0, async requestAdapter() {
  this.requested++;
  return adapter ? { info: { vendor: 'apple', architecture: 'metal-3' } } : null;
} });

function deps(ort: WebEmbedderDeps['ort'], over: Partial<WebEmbedderDeps> = {}) {
  const fetched: string[] = [];
  const d: WebEmbedderDeps = {
    ort,
    getURL: (p) => `chrome-extension://abc/${p}`,
    fetch: (async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(MODEL_BYTES).buffer } as Response;
    }) as typeof fetch,
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    gpu: null,
    ...over,
  };
  return { d, fetched };
}

const image = (): RGBAImage => ({ data: new Uint8ClampedArray(8 * 8 * 4).fill(128), width: 8, height: 8 });

describe('createWebEmbedder', () => {
  it('loads ONNX Runtime from the extension and the model from its models folder', async () => {
    const { ort, created, env } = fakeOrt();
    const { d, fetched } = deps(ort);
    const embedder = await createWebEmbedder(spec, d);
    expect(env.wasm.wasmPaths).toBe('chrome-extension://abc/ort/');
    expect(fetched).toEqual([`chrome-extension://abc/models/${spec.file}`]);
    expect(Array.from(created[0].model)).toEqual(MODEL_BYTES);
    expect(embedder.modelId).toBe(spec.id);
  });

  it('uses half the cores (one to four threads) when cross-origin isolated, one otherwise', async () => {
    const threads = async (crossOriginIsolated: boolean, hardwareConcurrency: number) => {
      const { ort, env } = fakeOrt();
      await createWebEmbedder(spec, deps(ort, { crossOriginIsolated, hardwareConcurrency }).d);
      return env.wasm.numThreads;
    };
    expect(await threads(true, 12)).toBe(4);
    expect(await threads(true, 8)).toBe(4);
    expect(await threads(true, 6)).toBe(3);
    expect(await threads(true, 4)).toBe(2);
    expect(await threads(true, 2)).toBe(1);
    expect(await threads(true, 1)).toBe(1);
    expect(await threads(false, 12)).toBe(1);
  });

  it('runs on the WASM execution provider when the browser has no WebGPU', async () => {
    const { ort, created } = fakeOrt();
    await createWebEmbedder(spec, deps(ort).d);
    expect(created.map((c) => c.eps)).toEqual([['wasm']]);
  });

  it('reports an embedding error as it is, without opening another session', async () => {
    const { ort, created } = fakeOrt({ failRun: true });
    const embedder = await createWebEmbedder(spec, deps(ort).d);
    await expect(embedder.embed([image()])).rejects.toThrow('Session already started');
    expect(created).toHaveLength(1);
  });

  it('reports a session that cannot be created', async () => {
    const { ort } = fakeOrt({ failCreate: true });
    await expect(createWebEmbedder(spec, deps(ort).d)).rejects.toThrow('no backend found');
  });

  it('returns one L2-normalised vector per image', async () => {
    const { ort } = fakeOrt();
    const embedder = await createWebEmbedder(spec, deps(ort).d);
    const vectors = await embedder.embed([image(), image(), image()]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) {
      expect(v).toHaveLength(spec.dim);
      expect(Math.hypot(...v)).toBeCloseTo(1, 5);
    }
  });

  it('says which file is missing when the model cannot be fetched', async () => {
    const { ort } = fakeOrt();
    const notFound = (async () => ({ ok: false, status: 404 }) as Response) as typeof fetch;
    await expect(createWebEmbedder(spec, deps(ort, { fetch: notFound }).d)).rejects.toThrow(spec.file);
  });
});

describe('createWebEmbedder: WebGPU, with WASM taking over', () => {
  /** A WASM build and a WebGPU build, and the deps that load them; `gpu` is navigator.gpu. */
  function both(gpuOpts: FakeOpts = {}, over: Partial<WebEmbedderDeps> = {}, gpu = gpuWith(true)) {
    const wasm = fakeOrt();
    const webgpu = fakeOrt(gpuOpts);
    let imported = 0;
    const ortWebGpu = async () => (imported++, webgpu.ort);
    const { d, fetched } = deps(wasm.ort, { gpu, ortWebGpu, ...over });
    return { wasm, webgpu, d, fetched, gpu, imported: () => imported };
  }
  const silence = () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  };
  afterEach(() => vi.restoreAllMocks());

  it('runs on the WebGPU build when the browser has an adapter, its files from the extension, on one thread', async () => {
    silence();
    const { wasm, webgpu, d, fetched } = both();
    const embedder = await createWebEmbedder(spec, d);
    expect(webgpu.created.map((c) => c.eps)).toEqual([['webgpu']]);
    expect(wasm.created).toEqual([]);
    expect(webgpu.env.wasm.wasmPaths).toBe('chrome-extension://abc/ort/');
    expect(webgpu.env.wasm.numThreads).toBe(1);
    expect(fetched).toEqual([`chrome-extension://abc/models/${spec.file}`]);
    const vectors = await embedder.embed([image(), image()]);
    expect(vectors).toHaveLength(2);
    expect(webgpu.created[0].runs).toBe(1);
  });

  it('uses WASM without loading the WebGPU build when there is no adapter, or no navigator.gpu', async () => {
    silence();
    for (const gpu of [gpuWith(false), null]) {
      const { wasm, webgpu, d, imported } = both({}, { gpu });
      await createWebEmbedder(spec, d);
      expect(wasm.created.map((c) => c.eps)).toEqual([['wasm']]);
      expect(webgpu.created).toEqual([]);
      expect(imported()).toBe(0);
    }
  });

  it('never tries WebGPU when told not to', async () => {
    const { wasm, d, gpu } = both({}, { webgpu: false });
    await createWebEmbedder(spec, d);
    expect(wasm.created.map((c) => c.eps)).toEqual([['wasm']]);
    expect(gpu.requested).toBe(0);
  });

  it('uses WASM when the WebGPU build fails to load', async () => {
    silence();
    const { wasm, d } = both({}, { ortWebGpu: async () => Promise.reject(new Error('import failed')) });
    await createWebEmbedder(spec, d);
    expect(wasm.created.map((c) => c.eps)).toEqual([['wasm']]);
  });

  it('uses WASM when the WebGPU session cannot be created, with the model fetched once', async () => {
    silence();
    const { wasm, d, fetched } = both({ failCreate: true });
    const embedder = await createWebEmbedder(spec, d);
    expect(wasm.created.map((c) => c.eps)).toEqual([['wasm']]);
    expect(Array.from(wasm.created[0].model)).toEqual(MODEL_BYTES);
    expect(fetched).toHaveLength(1);
    expect(await embedder.embed([image()])).toHaveLength(1);
  });

  it('uses WASM when the WebGPU session takes too long, and releases it if it turns up', async () => {
    silence();
    const { wasm, webgpu, d } = both({ hangCreate: true }, { webgpuTimeouts: { createMs: 5 } });
    await createWebEmbedder(spec, d);
    expect(wasm.created.map((c) => c.eps)).toEqual([['wasm']]);
    webgpu.resolveHung();
    await vi.waitFor(() => expect(webgpu.created[0]?.released).toBe(true));
  });

  it('runs a call again on WASM when WebGPU fails it, and stays on WASM, the WebGPU session released', async () => {
    silence();
    const { wasm, webgpu, d, fetched } = both({ failRun: true });
    const embedder = await createWebEmbedder(spec, d);
    const vectors = await embedder.embed([image()]);
    expect(vectors).toHaveLength(1);
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 5);
    expect(wasm.created.map((c) => c.eps)).toEqual([['wasm']]);
    expect(webgpu.created[0].released).toBe(true);
    // The model was fetched again for WASM (the first load's bytes aren't kept).
    expect(fetched).toHaveLength(2);
    await embedder.embed([image()]);
    expect(webgpu.created[0].runs).toBe(1);
    expect(wasm.created[0].runs).toBe(2);
  });

  it('treats a vector that is not finite as a WebGPU failure', async () => {
    silence();
    const { wasm, webgpu, d } = both({ nanRun: true });
    const embedder = await createWebEmbedder(spec, d);
    const [v] = await embedder.embed([image()]);
    expect(v.every(Number.isFinite)).toBe(true);
    expect(webgpu.created[0].released).toBe(true);
    expect(wasm.created).toHaveLength(1);
  });

  it('reports a WASM error as it is, once WASM has taken over', async () => {
    silence();
    const wasm = fakeOrt({ failRun: true });
    const webgpu = fakeOrt({ failRun: true });
    const embedder = await createWebEmbedder(spec, deps(wasm.ort, { gpu: gpuWith(true), ortWebGpu: async () => webgpu.ort }).d);
    await expect(embedder.embed([image()])).rejects.toThrow('Session already started');
  });
});
