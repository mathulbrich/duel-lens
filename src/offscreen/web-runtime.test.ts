// createModelSession (WebGPU, with WASM taking over) and webGpuRuntime, on fake ONNX Runtime builds. The
// embedder's own cases are in web-embedder.test.ts; these are the ones a detector-like model adds: its
// own Tensor class per ORT build, several outputs, and which of them are checked.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelSession, WEBGPU_TIMEOUTS, webGpuRuntime, type WebOrt, type WebRuntimeDeps } from './web-runtime';

/** A fake ORT build whose sessions only take its own Tensors, and answer `outputs`. */
function fakeBuild(outputs: () => Record<string, { data: ArrayLike<number> | BigInt64Array; dims: number[] }>, opts: { failRun?: boolean; hangRun?: boolean } = {}) {
  class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  }
  const sessions: { eps: string[]; runs: number; released: boolean }[] = [];
  const InferenceSession = {
    async create(_model: Uint8Array, options: { executionProviders: string[] }) {
      const s = { eps: options.executionProviders, runs: 0, released: false };
      sessions.push(s);
      return {
        async run(feeds: Record<string, unknown>) {
          s.runs++;
          for (const t of Object.values(feeds)) if (!(t instanceof Tensor)) throw new Error("'feeds' must be this build's Tensors");
          if (opts.failRun) throw new Error('device lost');
          if (opts.hangRun) await new Promise(() => {}); // a GPU that never answers
          return outputs();
        },
        async release() {
          s.released = true;
        },
      };
    },
  };
  return { ort: { env: { wasm: {} }, InferenceSession, Tensor } as unknown as WebOrt, sessions, Tensor };
}

const adapter = { info: { vendor: 'apple', architecture: 'metal-3' } };
const fine = () => ({ heat: { data: new Float32Array([0.1, 0.9]), dims: [1, 2] }, count: { data: new BigInt64Array([2n]), dims: [1] } });

function deps(wasm: WebOrt, webgpu: WebOrt, over: Partial<WebRuntimeDeps> = {}): WebRuntimeDeps {
  return {
    ort: wasm,
    ortWebGpu: async () => webgpu,
    gpu: { requestAdapter: async () => adapter },
    getURL: (p) => `chrome-extension://abc/${p}`,
    fetch: (async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }) as Response) as typeof fetch,
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());
const silence = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
};

describe('createModelSession', () => {
  it("hands the WebGPU build its own Tensors, built from the WASM build's Tensor class the callers use", async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine);
    const { session, Tensor } = await createModelSession('models/detector/card-detector.onnx', 'the detector', deps(wasm.ort, webgpu.ort));
    expect(Tensor).toBe(wasm.Tensor);
    const out = await session.run({ image: new Tensor('float32', new Float32Array(4), [1, 1, 2, 2]) });
    expect(Array.from(out.heat!.data)).toEqual([Math.fround(0.1), Math.fround(0.9)]);
    expect(session.ep).toBe('webgpu');
    expect(webgpu.sessions.map((s) => s.eps)).toEqual([['webgpu']]);
    expect(wasm.sessions).toEqual([]);
  });

  it('takes over on WASM when a float output holds an infinity, and says so in `ep`', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(() => ({ ...fine(), heat: { data: new Float32Array([0.1, Infinity]), dims: [1, 2] } }));
    const { session, Tensor } = await createModelSession('m.onnx', 'a model', deps(wasm.ort, webgpu.ort));
    const out = await session.run({ image: new Tensor('float32', new Float32Array(4), [1, 1, 2, 2]) });
    expect(Array.from(out.heat!.data)).toEqual([Math.fround(0.1), Math.fround(0.9)]);
    expect(session.ep).toBe('wasm');
    expect(webgpu.sessions[0].released).toBe(true);
    await session.run({ image: new Tensor('float32', new Float32Array(4), [1, 1, 2, 2]) });
    expect([webgpu.sessions[0].runs, wasm.sessions[0].runs]).toEqual([1, 2]);
  });

  it('checks only float outputs (an int64 count is not a float)', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine);
    const { session, Tensor } = await createModelSession('m.onnx', 'a model', deps(wasm.ort, webgpu.ort));
    await session.run({ image: new Tensor('float32', new Float32Array(1), [1]) });
    expect(session.ep).toBe('webgpu');
  });

  it('runs on WASM alone with webgpu: false', async () => {
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine);
    const { session } = await createModelSession('m.onnx', 'a model', deps(wasm.ort, webgpu.ort, { webgpu: false }));
    expect(session.ep).toBe('wasm');
    expect(webgpu.sessions).toEqual([]);
  });
});

describe('webGpuRuntime', () => {
  it('names the adapter, and sets the WebGPU build up from the extension on one thread', async () => {
    const webgpu = fakeBuild(fine);
    const got = await webGpuRuntime(deps(fakeBuild(fine).ort, webgpu.ort));
    expect(got).toEqual({ ort: webgpu.ort, adapter: 'apple metal-3' });
    expect(webgpu.ort.env.wasm).toEqual({ wasmPaths: 'chrome-extension://abc/ort/', numThreads: 1 });
  });

  it('says why when WebGPU is out of reach, and never throws', async () => {
    const wasm = fakeBuild(fine).ort;
    const gpu = fakeBuild(fine).ort;
    expect(await webGpuRuntime(deps(wasm, gpu, { gpu: null }))).toEqual({ ort: null, why: 'this browser has no WebGPU' });
    expect(await webGpuRuntime(deps(wasm, gpu, { gpu: { requestAdapter: async () => null } }))).toEqual({ ort: null, why: 'no WebGPU adapter' });
    const broken = deps(wasm, gpu, { gpu: { requestAdapter: async () => Promise.reject(new Error('GPU process crashed')) } });
    expect(await webGpuRuntime(broken)).toEqual({ ort: null, why: 'WebGPU is unavailable (GPU process crashed)' });
    const noBuild = deps(wasm, gpu, { ortWebGpu: async () => Promise.reject(new Error('Failed to fetch')) });
    expect(await webGpuRuntime(noBuild)).toEqual({ ort: null, why: 'WebGPU is unavailable (Failed to fetch)' });
  });
});

describe('createModelSession: one WebGPU session created at a time', () => {
  it('creates the second WebGPU session only once the first is created (the WebGPU build refuses two at once)', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine);
    let underWay = 0;
    let most = 0;
    const create = webgpu.ort.InferenceSession.create.bind(webgpu.ort.InferenceSession);
    (webgpu.ort.InferenceSession as { create: unknown }).create = async (...args: Parameters<typeof create>) => {
      most = Math.max(most, ++underWay);
      if (underWay > 1) throw new Error('another WebGPU EP inference session is being created.');
      await new Promise((r) => setTimeout(r, 5));
      underWay--;
      return create(...args);
    };
    const d = deps(wasm.ort, webgpu.ort);
    const [a, b] = await Promise.all([createModelSession('a.onnx', 'a', d), createModelSession('b.onnx', 'b', d)]);
    expect([a.session.ep, b.session.ep, most]).toEqual(['webgpu', 'webgpu', 1]);
  });
});

// Review W1/W2: a GPU or driver that hangs must never hang the extension. Each case would wait forever
// (and time out vitest) without the timeouts.
describe('WebGPU that hangs: WASM takes over', () => {
  const never = <T>() => new Promise<T>(() => {});
  const short = { adapterMs: 20, importMs: 20, createMs: 20, runMs: 20 };
  const image = (T: unknown) => ({ image: new (T as new (...a: unknown[]) => unknown)('float32', new Float32Array(4), [1, 1, 2, 2]) });

  it('keeps every limit generous next to the cold start measured (session 0.4 s, first run 0.6 s)', () => {
    expect(WEBGPU_TIMEOUTS.adapterMs).toBeGreaterThanOrEqual(3_000);
    expect(WEBGPU_TIMEOUTS.importMs).toBeGreaterThanOrEqual(3_000);
    expect(WEBGPU_TIMEOUTS.createMs).toBeGreaterThanOrEqual(10_000);
    expect(WEBGPU_TIMEOUTS.runMs).toBeGreaterThanOrEqual(10_000);
  });

  it('an adapter request that never answers', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine);
    const d = deps(wasm.ort, webgpu.ort, { gpu: { requestAdapter: never }, webgpuTimeouts: short });
    expect(await webGpuRuntime(d)).toEqual({ ort: null, why: 'WebGPU is unavailable (the WebGPU adapter took over 20 ms)' });
    const { session } = await createModelSession('m.onnx', 'a model', d);
    expect(session.ep).toBe('wasm');
    expect(webgpu.sessions).toEqual([]);
  });

  it('a WebGPU build that never loads', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const { session } = await createModelSession('m.onnx', 'a model', deps(wasm.ort, fakeBuild(fine).ort, { ortWebGpu: never, webgpuTimeouts: short }));
    expect(session.ep).toBe('wasm');
  });

  it('a WebGPU session that is never created: WASM, and the next model skips that build', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine);
    (webgpu.ort.InferenceSession as { create: unknown }).create = never;
    const d = deps(wasm.ort, webgpu.ort, { webgpuTimeouts: short });
    expect((await createModelSession('a.onnx', 'a', d)).session.ep).toBe('wasm');
    expect(await webGpuRuntime(d)).toEqual({ ort: null, why: 'WebGPU got stuck earlier' });
  });

  it('a WebGPU run that never comes back: the job gets its answer from WASM, and so does every later one', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const webgpu = fakeBuild(fine, { hangRun: true });
    const { session, Tensor } = await createModelSession('m.onnx', 'a model', deps(wasm.ort, webgpu.ort, { webgpuTimeouts: short }));
    expect(session.ep).toBe('webgpu');
    const out = await session.run(image(Tensor));
    expect(Array.from(out.heat!.data)).toEqual([Math.fround(0.1), Math.fround(0.9)]);
    expect(session.ep).toBe('wasm');
    await session.run(image(Tensor));
    expect([webgpu.sessions[0].runs, wasm.sessions[0].runs]).toEqual([1, 2]);
    // Dropped, not released: its run is still inside the WebGPU build.
    expect(webgpu.sessions[0].released).toBe(false);
  });

  it('a stuck run takes the other models on that WebGPU build to WASM too, at their next run', async () => {
    silence();
    const wasm = fakeBuild(fine);
    const gpuState = { hangRun: false };
    const webgpu = fakeBuild(fine, gpuState);
    const d = deps(wasm.ort, webgpu.ort, { webgpuTimeouts: short });
    const a = await createModelSession('a.onnx', 'a', d);
    const b = await createModelSession('b.onnx', 'b', d);
    expect([a.session.ep, b.session.ep]).toEqual(['webgpu', 'webgpu']);
    gpuState.hangRun = true;
    await a.session.run(image(a.Tensor));
    expect(a.session.ep).toBe('wasm');
    gpuState.hangRun = false; // even a GPU that answers again isn't trusted
    await b.session.run(image(b.Tensor));
    expect(b.session.ep).toBe('wasm');
    expect(webgpu.sessions[1].runs).toBe(0);
    expect(webgpu.sessions[1].released).toBe(true);
  });
});
