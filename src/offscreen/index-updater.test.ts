import { describe, expect, it, vi } from 'vitest';
import type { IndexMeta } from '../shared/index-format';
import type { RGBAImage } from '../shared/preprocess';
import type { DeltaEntry } from './delta-index';
import type { OffscreenEmbedArtworksResponse } from '../shared/messages';
import { createIndexUpdater, type EmbedArtworkItem, type IndexUpdaterDeps } from './index-updater';

/** `handle()`'s return type is a union of both answers; every embed-artworks call in this file
 * is known (by the message it sends) to get an OffscreenEmbedArtworksResponse. */
const asEmbedResponse = (res: unknown) => res as OffscreenEmbedArtworksResponse;

const IMG = (n: number): RGBAImage => ({ data: new Uint8ClampedArray([n]), width: 1, height: 1 });

/** The bundled index covers artworks 1 and 2. */
const META: Pick<IndexMeta, 'entries'> = {
  entries: [
    { imageId: 1, cardId: 10 },
    { imageId: 2, cardId: 20 },
  ],
};

function setup(
  overrides: Partial<IndexUpdaterDeps> & { embed?: (images: RGBAImage[]) => Promise<Float32Array[]>; cardBack?: Float32Array | null } = {},
) {
  const { embed: embedOverride, cardBack = null, ...rest } = overrides;
  const calls = {
    decoded: [] as string[],
    embedded: [] as RGBAImage[][],
    persisted: [] as DeltaEntry[][],
    added: [] as DeltaEntry[][],
    embeddingLoads: 0,
  };
  /** The local delta, as persisted so far. */
  const delta: DeltaEntry[] = [];
  const embed =
    embedOverride ??
    (async (images: RGBAImage[]) => {
      calls.embedded.push(images);
      return images.map(() => Float32Array.from([1, 0])); // L2-normalised already
    });
  const deps: IndexUpdaterDeps = {
    modelId: 'm1',
    loadIndexMeta: async () => META,
    loadDelta: async (modelId) => delta.filter((e) => e.modelId === modelId),
    loadEmbedding: async () => {
      calls.embeddingLoads++;
      return { embed, cardBack };
    },
    decode: vi.fn(async (dataUrl: string) => {
      calls.decoded.push(dataUrl);
      return IMG(calls.decoded.length);
    }),
    appendDelta: vi.fn(async (_modelId: string, entries: DeltaEntry[]) => {
      calls.persisted.push(entries);
      delta.push(...entries);
    }),
    onAdded: (entries) => void calls.added.push(entries),
    ...rest,
  };
  const updater = createIndexUpdater(deps);
  return { updater, deps, calls, delta };
}

const missing = (imageIds: number[]) => ({ target: 'offscreen' as const, type: 'index-missing' as const, imageIds });
const embedArtworks = (items: EmbedArtworkItem[]) => ({ target: 'offscreen' as const, type: 'embed-artworks' as const, items });

describe('index-missing', () => {
  it('returns ids in neither the bundled index nor the local delta, without loading the embedding model', async () => {
    const { updater, delta, calls } = setup();
    delta.push({ modelId: 'm1', imageId: 3, cardId: 30, vector: Int8Array.from([127, 0]) });
    delta.push({ modelId: 'other-model', imageId: 4, cardId: 40, vector: Int8Array.from([127, 0]) });
    const res = await updater.handle(missing([1, 2, 3, 4, 5]));
    expect(res).toEqual({ modelId: 'm1', missing: [4, 5] });
    expect(calls.embeddingLoads).toBe(0);
  });

  it('returns an empty list when everything asked about is already covered', async () => {
    const { updater } = setup();
    expect(await updater.handle(missing([1, 2]))).toEqual({ modelId: 'm1', missing: [] });
  });

  it("rejects when the bundled index's metadata can't be read, so the caller can say so", async () => {
    const { updater } = setup({ loadIndexMeta: () => Promise.reject(new Error('meta.json is missing')) });
    await expect(updater.handle(missing([1]))).rejects.toThrow(/meta\.json is missing/);
  });
});

const item = (imageId: number, cardId: number): EmbedArtworkItem => ({ imageId, cardId, dataUrl: `data:image/jpeg;base64,${imageId}` });

describe('embed-artworks', () => {
  it('decodes and embeds every item one image at a time, not as one batched call', async () => {
    const { updater, calls } = setup();
    const items = [item(3, 30), item(4, 40), item(5, 50)];

    await updater.handle(embedArtworks(items));

    expect(calls.embeddingLoads).toBe(1);
    expect(calls.decoded).toEqual(items.map((i) => i.dataUrl));
    // Three separate one-image calls, in order - never a single call with all three images.
    expect(calls.embedded).toEqual([[IMG(1)], [IMG(2)], [IMG(3)]]);
  });

  it('quantises the embedded vector to int8 before persisting it', async () => {
    const { updater, calls } = setup({ embed: async (images) => images.map(() => Float32Array.from([1, -0.5])) });

    await updater.handle(embedArtworks([item(3, 30)]));

    expect(calls.persisted).toEqual([[{ modelId: 'm1', imageId: 3, cardId: 30, vector: Int8Array.from([127, -63]) }]]);
  });

  it('persists new entries, hands them to the live index, and index-missing then counts them', async () => {
    const { updater, calls } = setup();

    const res = await updater.handle(embedArtworks([item(3, 30), item(4, 40)]));

    expect(res).toEqual({ modelId: 'm1', added: 2, failed: [] });
    const entries = [
      { modelId: 'm1', imageId: 3, cardId: 30, vector: Int8Array.from([127, 0]) },
      { modelId: 'm1', imageId: 4, cardId: 40, vector: Int8Array.from([127, 0]) },
    ];
    expect(calls.persisted).toEqual([entries]);
    expect(calls.added).toEqual([entries]);
    expect(await updater.handle(missing([3, 4, 5]))).toEqual({ modelId: 'm1', missing: [5] });
  });

  it("rejects, before decoding anything, when the embedding model can't load (the caller answers with an error)", async () => {
    const { updater, calls } = setup({ loadEmbedding: () => Promise.reject(new Error('no WebAssembly')) });
    await expect(updater.handle(embedArtworks([item(3, 30)]))).rejects.toThrow(/no WebAssembly/);
    expect(calls.decoded).toEqual([]);
  });

  it('still answers when handing the entries to the live index fails: they are persisted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { updater, calls } = setup({
      onAdded: () => {
        throw new Error('The index was built for model "x"');
      },
    });
    const res = await updater.handle(embedArtworks([item(3, 30)]));
    expect(res).toEqual({ modelId: 'm1', added: 1, failed: [] });
    expect(calls.persisted).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports a decode failure for one item without throwing, and still embeds the rest', async () => {
    const { updater, calls } = setup({
      decode: vi.fn(async (dataUrl: string) => {
        if (dataUrl.endsWith('4')) throw new Error('bad JPEG');
        calls.decoded.push(dataUrl);
        return IMG(1);
      }),
    });

    const res = asEmbedResponse(await updater.handle(embedArtworks([item(3, 30), item(4, 40), item(5, 50)])));

    expect(res.added).toBe(2);
    expect(res.failed).toEqual([{ imageId: 4, error: 'bad JPEG' }]);
  });

  it('reports an embed failure for one item without throwing, and still embeds the rest', async () => {
    const { updater } = setup({
      embed: async (images) => {
        if (images[0].data[0] === 2) throw new Error('session is busy');
        return [Float32Array.from([1, 0])];
      },
    });

    const res = asEmbedResponse(await updater.handle(embedArtworks([item(3, 30), item(4, 40)])));

    expect(res.added).toBe(1);
    expect(res.failed).toEqual([{ imageId: 4, error: 'session is busy' }]);
  });

  it('does not touch persistence or the live index when every item fails', async () => {
    const { updater, calls } = setup({
      decode: vi.fn(async () => {
        throw new Error('network error');
      }),
    });

    const res = await updater.handle(embedArtworks([item(3, 30)]));

    expect(res).toEqual({ modelId: 'm1', added: 0, failed: [{ imageId: 3, error: 'network error' }] });
    expect(calls.persisted).toEqual([]);
    expect(calls.added).toEqual([]);
  });

  it("leaves out an artwork that is still YGOPRODeck's card-back placeholder, and reports it", async () => {
    // Artwork 3 embeds onto the card back itself; artwork 4 is a real one.
    const { updater, calls } = setup({
      cardBack: Float32Array.from([1, 0]),
      embed: async (images) => images.map((img) => (img.data[0] === 1 ? Float32Array.from([1, 0]) : Float32Array.from([0, 1]))),
    });

    const res = await updater.handle(embedArtworks([item(3, 30), item(4, 40)]));

    expect(res).toEqual({ modelId: 'm1', added: 1, failed: [], placeholders: [3] });
    expect(calls.persisted).toEqual([[{ modelId: 'm1', imageId: 4, cardId: 40, vector: Int8Array.from([0, 127]) }]]);
    expect(calls.added.flat().map((e) => e.imageId)).toEqual([4]);
  });

  it('indexes every artwork when there is no card back to compare with', async () => {
    const { updater } = setup({ cardBack: null, embed: async (images) => images.map(() => Float32Array.from([1, 0])) });
    expect(await updater.handle(embedArtworks([item(3, 30), item(4, 40)]))).toEqual({ modelId: 'm1', added: 2, failed: [] });
  });

  it('reports a missing vector from the embedder as a per-item failure', async () => {
    const { updater } = setup({ embed: async () => [] });

    const res = asEmbedResponse(await updater.handle(embedArtworks([item(3, 30)])));

    expect(res.failed).toEqual([{ imageId: 3, error: 'the embedder returned no vector for this artwork' }]);
  });
});
