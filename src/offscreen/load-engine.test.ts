import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeIndex, encodeIndexBinary, quantizeInt8, type LoadedIndex } from '../shared/index-format';
import { getModel, type EmbeddingModelSpec } from '../shared/models';
import type { RGBAImage } from '../shared/preprocess';
import { appendDelta, loadDelta, type DeltaEntry } from './delta-index';
import type { CardDetector } from './detect-cards';
import type { Embedder } from './engine';
import { boxCorners } from './geometry';
import { loadEngine, type EngineSources } from './load-engine';

// A three-dimensional fake model: every image embeds to [1, 0, 0], which is card 1 in the index.
const SPEC: EmbeddingModelSpec = { ...getModel(), id: 'fake-3d', dim: 3, thresholds: { score: 0.5, margin: 0.1, floor: 0.2 } };

function index(): LoadedIndex {
  const vectors = new Int8Array([...quantizeInt8(new Float32Array([1, 0, 0])), ...quantizeInt8(new Float32Array([0, 1, 0]))]);
  const meta = {
    modelId: SPEC.id,
    dim: 3,
    count: 2,
    quant: 'int8' as const,
    builtAt: '2026-09-28T00:00:00Z',
    entries: [
      { imageId: 1, cardId: 1 },
      { imageId: 2, cardId: 2 },
    ],
  };
  return decodeIndex(encodeIndexBinary(3, 2, 'int8', vectors).buffer, meta);
}

function sources(over: Partial<EngineSources> = {}) {
  const embedded: RGBAImage[][] = [];
  const embedder: Embedder = {
    modelId: SPEC.id,
    async embed(images) {
      embedded.push(images);
      return images.map(() => new Float32Array([1, 0, 0]));
    },
  };
  const src: EngineSources = {
    spec: SPEC,
    createEmbedder: async () => embedder,
    loadIndex: async () => index(),
    // No local additions by default (the real store is IndexedDB; see the delta tests below).
    delta: { load: async () => [], clearOtherModels: async () => {}, clear: async () => {} },
    ...over,
  };
  return { src, embedded };
}

/** A delta entry for SPEC's 3-d space. */
const entry = (imageId: number, cardId: number, v: number[]): DeltaEntry => ({
  modelId: SPEC.id,
  imageId,
  cardId,
  vector: quantizeInt8(new Float32Array(v)),
});

/** A non-blank crop (a gradient). */
const crop = (): RGBAImage => ({
  data: new Uint8ClampedArray(120 * 120 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256)),
  width: 120,
  height: 120,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadEngine', () => {
  it("recognises from the user's box alone when no card detector is registered (a --no-detector build)", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { src } = sources();
    const engine = await loadEngine(src);
    const res = await engine.recognize(crop());
    expect(res.error).toBeUndefined();
    expect(res.candidates[0].cardId).toBe(1);
    expect(res.best?.hypothesis).not.toBe('quad');
    expect(res.timings.cardDetect).toBeUndefined();
    expect(JSON.stringify(debug.mock.calls)).toMatch(/"detector":"off"/); // none registered
  });

  it('leaves priming out of the load: the engine hands it over as separate steps', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { src, embedded } = sources();
    const engine = await loadEngine(src);
    expect(embedded).toHaveLength(0); // a scan waiting for the load must not also wait for priming
    const steps = engine.primeSteps();
    expect(steps).toHaveLength(1);
    await steps[0]();
    expect(embedded).toHaveLength(1);
    expect(embedded[0]).toHaveLength(1);
  });

  it('fails when the model or the index cannot be loaded', async () => {
    const missing = new Error('data/index-fake-3d.bin is missing from the extension');
    await expect(loadEngine(sources({ loadIndex: () => Promise.reject(missing) }).src)).rejects.toBe(missing);
    await expect(
      loadEngine(sources({ createEmbedder: () => Promise.reject(new Error('models/x.onnx: HTTP 404')) }).src),
    ).rejects.toThrow(/HTTP 404/);
  });
});

/** A card detector that finds one card filling the crop, recording each crop it saw. */
function fakeDetector() {
  const seen: RGBAImage[] = [];
  const calls = { release: 0 };
  const detector: CardDetector = {
    async detect(img) {
      seen.push(img);
      const { width: w, height: h } = img;
      const pts = boxCorners(w / 2, h / 2, w * 0.8, h * 0.9, 0).map((p) => [p.x, p.y] as [number, number]);
      return [{ cx: w / 2, cy: h / 2, w: w * 0.8, h: h * 0.9, angle: 0, conf: 0.9, pts }];
    },
    async release() {
      calls.release++;
    },
  };
  return { detector, seen, calls };
}

describe('loadEngine with a card detector', () => {
  it("loads the card detector with the rest, and scans straighten the detector's card", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const { detector, seen } = fakeDetector();
    const { src } = sources({ loadCardDetector: async () => detector });
    const engine = await loadEngine(src);
    expect(seen).toHaveLength(0); // loading runs nothing
    const res = await engine.recognize(crop());
    expect(res.error).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(res.best?.hypothesis).toBe('quad');
    expect(JSON.stringify(debug.mock.calls)).toMatch(/"detector":"on"/);
  });

  it("still loads when the card detector fails to load: scans match the user's box as drawn", async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { src } = sources({ loadCardDetector: () => Promise.reject(new Error('models/detector/card-detector.onnx: HTTP 404')) });
    const engine = await loadEngine(src);
    const res = await engine.recognize(crop());
    expect(res.error).toBeUndefined();
    expect(res.candidates[0].cardId).toBe(1);
    expect(res.best?.hypothesis).not.toBe('quad');
    expect(JSON.stringify(warn.mock.calls)).toMatch(/card detector failed to load/);
    expect(JSON.stringify(debug.mock.calls)).toMatch(/"detector":"off"/);
  });

  it("keeps the card detector when the engine can't load: click to scan shares it", async () => {
    const { detector, calls } = fakeDetector();
    const missing = new Error('data/index-fake-3d.bin is missing from the extension');
    await expect(loadEngine(sources({ loadCardDetector: async () => detector, loadIndex: () => Promise.reject(missing) }).src)).rejects.toBe(missing);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.release).toBe(0);
  });
});

describe('loadEngine and the local artwork delta (self-updating index)', () => {
  it('merges the delta into the bundled index at load, so scans can find those artworks', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const loaded: string[] = [];
    const { src } = sources({
      createEmbedder: async () => ({ modelId: SPEC.id, embed: async (images: RGBAImage[]) => images.map(() => new Float32Array([0, 0, 1])) }),
      delta: { load: async (modelId) => (loaded.push(modelId), [entry(3, 30, [0, 0, 1])]), clearOtherModels: async () => {}, clear: async () => {} },
    });
    const engine = await loadEngine(src);
    expect(loaded).toEqual([SPEC.id]);
    expect(engine.getIndex().meta.count).toBe(3);
    expect(engine.getIndex().meta.entries.at(-1)).toEqual({ imageId: 3, cardId: 30 });
    expect((await engine.recognize(crop())).candidates[0].cardId).toBe(30);
  });

  it('loads with the bundled index alone when the delta cannot be read', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { src } = sources({
      delta: { load: () => Promise.reject(new Error('IndexedDB is broken')), clearOtherModels: async () => {}, clear: async () => {} },
    });
    const engine = await loadEngine(src);
    expect(engine.getIndex().meta.count).toBe(2);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/delta/);
  });

  it("prunes other models' delta entries once per load, without waiting for it or failing on it", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const kept: string[] = [];
    let finish!: () => void;
    const { src } = sources({
      delta: {
        load: async () => [],
        clearOtherModels: (keep) => {
          kept.push(keep);
          return new Promise<void>((_, reject) => (finish = () => reject(new Error('quota'))));
        },
        clear: async () => {},
      },
    });
    await loadEngine(src); // resolves while the pruning is still running
    expect(kept).toEqual([SPEC.id]);
    finish();
    await vi.waitFor(() => expect(JSON.stringify(warn.mock.calls)).toMatch(/prune/));
  });

  it("searches the bundled index alone when the delta doesn't fit it, and clears that model's delta", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleared: string[] = [];
    const { src } = sources({
      delta: {
        // A 2-d vector in a 3-d index: mergeIndex throws on it.
        load: async () => [entry(3, 30, [0, 0, 1]), { modelId: SPEC.id, imageId: 4, cardId: 40, vector: Int8Array.from([1, 2]) }],
        clearOtherModels: async () => {},
        clear: async (modelId) => void cleared.push(modelId),
      },
    });
    const engine = await loadEngine(src);
    expect(engine.getIndex().meta.count).toBe(2);
    expect((await engine.recognize(crop())).candidates[0].cardId).toBe(1);
    expect(cleared).toEqual([SPEC.id]);
    expect(JSON.stringify(error.mock.calls)).toMatch(/2 dims/);
  });

  it("still loads when the delta doesn't fit and clearing it fails too", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { src } = sources({
      delta: {
        load: async () => [{ modelId: SPEC.id, imageId: 4, cardId: 40, vector: Int8Array.from([1, 2]) }],
        clearOtherModels: async () => {},
        clear: () => Promise.reject(new Error('quota')),
      },
    });
    const engine = await loadEngine(src);
    expect(engine.getIndex().meta.count).toBe(2);
    await vi.waitFor(() => expect(JSON.stringify(warn.mock.calls)).toMatch(/could not clear the local artwork delta/));
  });

  it("clears a delta that doesn't fit from the real IndexedDB store, so the next load no longer fails over it", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    await appendDelta(SPEC.id, [{ modelId: SPEC.id, imageId: 4, cardId: 40, vector: Int8Array.from([1, 2]) }]);
    const { src } = sources();
    delete src.delta; // the default store
    expect((await loadEngine(src)).getIndex().meta.count).toBe(2);
    await vi.waitFor(async () => expect(await loadDelta(SPEC.id)).toEqual([]));
    error.mockClear();
    expect((await loadEngine(src)).getIndex().meta.count).toBe(2);
    expect(error).not.toHaveBeenCalled();
  });

  it("works with delta-index.ts's real IndexedDB store by default", async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    await appendDelta(SPEC.id, [entry(3, 30, [0, 0, 1])]);
    await appendDelta('old-model', [{ modelId: 'old-model', imageId: 9, cardId: 90, vector: Int8Array.from([1, 2]) }]);
    const { src } = sources();
    delete src.delta; // the default store
    const engine = await loadEngine(src);
    expect(engine.getIndex().meta.entries.at(-1)).toEqual({ imageId: 3, cardId: 30 });
    await vi.waitFor(async () => expect(await loadDelta('old-model')).toEqual([]));
    expect(await loadDelta(SPEC.id)).toHaveLength(1);
  });
});
