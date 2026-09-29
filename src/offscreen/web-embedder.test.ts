import { describe, expect, it } from 'vitest';
import { getModel } from '../shared/models';
import type { RGBAImage } from '../shared/preprocess';
import { createWebEmbedder, type WebEmbedderDeps } from './web-embedder';

const spec = getModel();
const MODEL_BYTES = [7, 7, 7];

interface Created {
  eps: string[];
  model: Uint8Array;
  runs: number;
}

/** A fake onnxruntime-web: records sessions; `failCreate`/`failRun` make them fail. */
function fakeOrt(opts: { failCreate?: boolean; failRun?: boolean } = {}) {
  const created: Created[] = [];
  const env = { wasm: {} as { wasmPaths?: unknown; numThreads?: number } };
  class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  }
  const InferenceSession = {
    async create(model: Uint8Array, options: { executionProviders: string[] }) {
      const eps = options.executionProviders;
      if (opts.failCreate) throw new Error('no backend found');
      const record: Created = { eps, model, runs: 0 };
      created.push(record);
      return {
        async run(feeds: Record<string, Tensor>) {
          record.runs++;
          if (opts.failRun) throw new Error('Session already started');
          const input = feeds[spec.inputName];
          const n = input.dims[0];
          const tokens = spec.pooling === 'none' ? 1 : 2;
          const data = new Float32Array(n * tokens * spec.dim).map((_, i) => (i % 5) + 1);
          const dims = spec.pooling === 'none' ? [n, spec.dim] : [n, tokens, spec.dim];
          return { [spec.outputName]: { data, dims } };
        },
        async release() {},
      };
    },
  };
  return { ort: { env, InferenceSession, Tensor } as unknown as WebEmbedderDeps['ort'], created, env };
}

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

  it('uses up to four threads when cross-origin isolated, one otherwise', async () => {
    const threads = async (crossOriginIsolated: boolean, hardwareConcurrency: number) => {
      const { ort, env } = fakeOrt();
      await createWebEmbedder(spec, deps(ort, { crossOriginIsolated, hardwareConcurrency }).d);
      return env.wasm.numThreads;
    };
    expect(await threads(true, 12)).toBe(4);
    expect(await threads(true, 2)).toBe(2);
    expect(await threads(false, 12)).toBe(1);
  });

  it('runs on the WASM execution provider only', async () => {
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
