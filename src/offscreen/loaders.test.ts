import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeIndexBinary, quantizeInt8, type IndexMeta } from '../shared/index-format';
import { getModel, type EmbeddingModelSpec } from '../shared/models';
import { CARD_BACK_ID } from '../shared/types';
import type { CardDetector } from './detect-cards';
import type { Embedder } from './engine';
import { createLoaders, type LoaderSources } from './loaders';

const SPEC: EmbeddingModelSpec = { ...getModel(), id: 'fake-3d', dim: 3, thresholds: { score: 0.5, margin: 0.1, floor: 0.2 } };

/** The bundled index: artworks 1 and 2, and the card back. */
const META: IndexMeta = {
  modelId: SPEC.id,
  dim: 3,
  count: 3,
  quant: 'int8',
  builtAt: '2026-09-28T00:00:00Z',
  entries: [
    { imageId: 1, cardId: 1 },
    { imageId: 2, cardId: 2 },
    { imageId: CARD_BACK_ID, cardId: CARD_BACK_ID },
  ],
};
const BIN = encodeIndexBinary(
  3,
  3,
  'int8',
  Int8Array.from([...quantizeInt8(Float32Array.of(1, 0, 0)), ...quantizeInt8(Float32Array.of(0, 1, 0)), ...quantizeInt8(Float32Array.of(0, 0.6, 0.8))]),
);

/** Counts every load that creates an ONNX session (the embedder, the card detector). */
function sources(over: Partial<LoaderSources> = {}) {
  const calls = { fetched: [] as string[], embedders: 0, detectors: 0 };
  const embedder: Embedder = { modelId: SPEC.id, embed: async (images) => images.map(() => Float32Array.of(1, 0, 0)) };
  const src: LoaderSources = {
    spec: SPEC,
    packaged: async (path) => {
      calls.fetched.push(path);
      if (path === `data/index-${SPEC.id}.meta.json`) return new Response(JSON.stringify(META));
      if (path === `data/index-${SPEC.id}.bin`) return new Response(BIN.slice());
      throw new Error(`${path} is missing from the extension`);
    },
    createEmbedder: async () => (calls.embedders++, embedder),
    loadCardDetector: async () => {
      calls.detectors++;
      throw new Error('no card detector in this test');
    },
    delta: { load: async () => [], clearOtherModels: async () => {}, clear: async () => {} },
    ...over,
  };
  return { src, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLoaders: each message loads only what it needs', () => {
  it("reads index-missing's answer from the index metadata alone: no model session, no card detector", async () => {
    const { src, calls } = sources();
    const loaders = createLoaders(src);
    expect((await loaders.loadIndexMeta()).entries.map((e) => e.imageId)).toEqual([1, 2, CARD_BACK_ID]);
    expect(calls.fetched).toEqual([`data/index-${SPEC.id}.meta.json`]);
    expect(calls).toMatchObject({ embedders: 0, detectors: 0 });
    // Read once, then remembered.
    await loaders.loadIndexMeta();
    expect(calls.fetched).toHaveLength(1);
  });

  it('loads only the embedding model for embed-artworks, and the engine then reuses that session', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { src, calls } = sources();
    const loaders = createLoaders(src);
    await loaders.loadEmbedder();
    expect(calls).toMatchObject({ embedders: 1, detectors: 0 });
    expect(calls.fetched).toEqual([]);

    const engine = await loaders.loadEngine();
    expect(calls).toMatchObject({ embedders: 1, detectors: 1 });
    expect(engine.getIndex().meta.entries.map((e) => e.imageId)).toEqual([1, 2, CARD_BACK_ID]);
  });

  it("reads the card back's vector from the bundled index once, for the placeholder check, without loading a model", async () => {
    const { src, calls } = sources();
    const loaders = createLoaders(src);
    const back = (await loaders.loadCardBack())!;
    expect(Array.from(back).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.6, 0.8]);
    expect(await loaders.loadCardBack()).toBe(back);
    expect(calls.fetched.filter((f) => f.endsWith('.bin'))).toHaveLength(1);
    expect(calls).toMatchObject({ embedders: 0, detectors: 0 });
  });

  it('loads one card detector for click to scan and scans alike: the handler and the engine share it', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const seen: string[] = [];
    const detector: CardDetector = {
      detect: async (img) => (seen.push(`${img.width}x${img.height}`), []),
    };
    const { src, calls } = sources({ loadCardDetector: async () => (calls.detectors++, detector) });
    const loaders = createLoaders(src);
    // What the handler loads for detect-cards...
    expect(await loaders.loadCardDetector!()).toBe(detector);
    // ...is what the engine's scans use, without a second load.
    const engine = await loaders.loadEngine();
    expect(calls.detectors).toBe(1);
    const crop = { data: new Uint8ClampedArray(64 * 48 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 13) % 256)), width: 64, height: 48 };
    await engine.recognize(crop);
    expect(seen).toEqual(['64x48']);
  });

  it('offers no card detector when none is registered (click to scan then says so)', () => {
    const { src } = sources();
    delete src.loadCardDetector;
    expect(createLoaders(src).loadCardDetector).toBeUndefined();
  });

  it('tries the card detector again after a failed load', async () => {
    let attempt = 0;
    const detector: CardDetector = { detect: async () => [] };
    const { src } = sources({
      loadCardDetector: async () => {
        if (++attempt === 1) throw new Error('models/detector/card-detector.onnx: HTTP 404');
        return detector;
      },
    });
    const loaders = createLoaders(src);
    await expect(loaders.loadCardDetector!()).rejects.toThrow(/HTTP 404/);
    await expect(loaders.loadCardDetector!()).resolves.toBe(detector);
    expect(attempt).toBe(2);
  });

  it('tries the embedding model again after a failed load', async () => {
    let attempt = 0;
    const { src } = sources({
      createEmbedder: async () => {
        if (++attempt === 1) throw new Error('models/fake.onnx: HTTP 404');
        return { modelId: SPEC.id, embed: async () => [] };
      },
    });
    const loaders = createLoaders(src);
    await expect(loaders.loadEmbedder()).rejects.toThrow(/HTTP 404/);
    await expect(loaders.loadEmbedder()).resolves.toMatchObject({ modelId: SPEC.id });
    expect(attempt).toBe(2);
  });

  it('reads the index metadata again after a failed read', async () => {
    let attempt = 0;
    const { src } = sources({
      packaged: async () => {
        if (++attempt === 1) throw new Error('data/index-fake-3d.meta.json is missing from the extension');
        return new Response(JSON.stringify(META));
      },
    });
    const loaders = createLoaders(src);
    await expect(loaders.loadIndexMeta()).rejects.toThrow(/missing/);
    await expect(loaders.loadIndexMeta()).resolves.toMatchObject({ count: 3 });
  });
});
