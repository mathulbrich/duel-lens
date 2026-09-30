import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { altArtworkId } from '../shared/alt-artwork';
import type { LoadedIndex } from '../shared/index-format';
import { appendDelta, clearDelta, clearOtherModels, loadDelta, mergeIndex, openDeltaDb, type DeltaEntry } from './delta-index';

// Fresh in-memory database for every test, so tests don't see each other's data
// (mirrors card-store.test.ts's setup for the same reason).
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

function entry(imageId: number, cardId: number, modelId = 'm1', vector: number[] = [1, 2]): DeltaEntry {
  return { modelId, imageId, cardId, vector: Int8Array.from(vector) };
}

describe('openDeltaDb', () => {
  it('creates the duel-lens-index database with an `entries` store', async () => {
    const db = await openDeltaDb();
    expect(db.name).toBe('duel-lens-index');
    expect(Array.from(db.objectStoreNames)).toEqual(['entries']);
  });
});

describe('loadDelta', () => {
  it('returns an empty array when nothing has been embedded yet', async () => {
    expect(await loadDelta('m1')).toEqual([]);
  });

  it('returns only entries for the requested model', async () => {
    await appendDelta('m1', [entry(1, 10, 'm1'), entry(2, 20, 'm1')]);
    await appendDelta('m2', [entry(3, 30, 'm2')]);

    const m1 = await loadDelta('m1');
    expect(m1.map((e) => e.imageId).sort()).toEqual([1, 2]);
    expect(await loadDelta('m2')).toHaveLength(1);
    expect(await loadDelta('m3')).toEqual([]);
  });
});

describe('appendDelta', () => {
  it('is a no-op for an empty list', async () => {
    await appendDelta('m1', []);
    expect(await loadDelta('m1')).toEqual([]);
  });

  it('persists the vector as an Int8Array, byte for byte', async () => {
    await appendDelta('m1', [entry(1, 10, 'm1', [1, -2, 127, -128])]);
    const [saved] = await loadDelta('m1');
    expect(saved.vector).toBeInstanceOf(Int8Array);
    expect(Array.from(saved.vector)).toEqual([1, -2, 127, -128]);
  });

  it('replaces an existing entry for the same (modelId, imageId) rather than duplicating it', async () => {
    await appendDelta('m1', [entry(1, 10, 'm1', [1, 1])]);
    await appendDelta('m1', [entry(1, 10, 'm1', [9, 9])]);

    const all = await loadDelta('m1');
    expect(all).toHaveLength(1);
    expect(Array.from(all[0].vector)).toEqual([9, 9]);
  });

  it('rejects an entry whose modelId does not match the call', async () => {
    await expect(appendDelta('m1', [entry(1, 10, 'm2')])).rejects.toThrow(/modelId/);
  });
});

describe('clearOtherModels', () => {
  it('deletes every entry for a model other than the one kept', async () => {
    await appendDelta('m1', [entry(1, 10, 'm1'), entry(2, 20, 'm1')]);
    await appendDelta('m2', [entry(3, 30, 'm2')]);

    await clearOtherModels('m2');

    expect(await loadDelta('m1')).toEqual([]);
    expect(await loadDelta('m2')).toHaveLength(1);
  });

  it('does nothing when every entry already belongs to the kept model', async () => {
    await appendDelta('m1', [entry(1, 10, 'm1')]);
    await clearOtherModels('m1');
    expect(await loadDelta('m1')).toHaveLength(1);
  });
});

describe('clearDelta', () => {
  it("deletes every entry of one model and leaves the other models' entries alone", async () => {
    await appendDelta('m1', [entry(1, 10, 'm1'), entry(2, 20, 'm1')]);
    await appendDelta('m2', [entry(1, 10, 'm2')]);

    await clearDelta('m1');

    expect(await loadDelta('m1')).toEqual([]);
    expect(await loadDelta('m2')).toHaveLength(1);
  });
});

function baseIndex(overrides: Partial<LoadedIndex['meta']> = {}): LoadedIndex {
  const entries = [
    { imageId: 1, cardId: 10 },
    { imageId: 2, cardId: 20 },
  ];
  return {
    meta: { modelId: 'm1', dim: 2, count: entries.length, quant: 'int8', builtAt: '2026-01-01', entries, ...overrides },
    vectors: Int8Array.from([1, 1, 2, 2]),
  };
}

describe('mergeIndex', () => {
  it('returns the same base reference when the delta is empty', () => {
    const base = baseIndex();
    expect(mergeIndex(base, [])).toBe(base);
  });

  it('returns the same base reference when every delta imageId is already in base', () => {
    const base = baseIndex();
    expect(mergeIndex(base, [entry(1, 10, 'm1', [9, 9])])).toBe(base);
  });

  it('concatenates new vectors and entries, keeping meta.count consistent', () => {
    const base = baseIndex();
    const merged = mergeIndex(base, [entry(3, 30, 'm1', [3, 3])]);

    expect(merged).not.toBe(base);
    expect(merged.meta.count).toBe(3);
    expect(merged.meta.entries).toEqual([
      { imageId: 1, cardId: 10 },
      { imageId: 2, cardId: 20 },
      { imageId: 3, cardId: 30 },
    ]);
    expect(Array.from(merged.vectors as Int8Array)).toEqual([1, 1, 2, 2, 3, 3]);
    // The base index itself is untouched (a fresh array, not a mutation).
    expect(base.meta.count).toBe(2);
  });

  it('skips imageIds already in base while still adding the new ones', () => {
    const base = baseIndex();
    const merged = mergeIndex(base, [entry(1, 999, 'm1', [8, 8]), entry(4, 40, 'm1', [4, 4])]);

    expect(merged.meta.count).toBe(3);
    expect(merged.meta.entries.map((e) => e.imageId)).toEqual([1, 2, 4]);
    expect(Array.from(merged.vectors as Int8Array)).toEqual([1, 1, 2, 2, 4, 4]);
  });

  it('preserves other meta fields (modelId, dim, quant, builtAt, dbVersion)', () => {
    const base = baseIndex({ dbVersion: '1.2.3' });
    const merged = mergeIndex(base, [entry(3, 30, 'm1', [3, 3])]);
    expect(merged.meta.modelId).toBe('m1');
    expect(merged.meta.dim).toBe(2);
    expect(merged.meta.quant).toBe('int8');
    expect(merged.meta.builtAt).toBe('2026-01-01');
    expect(merged.meta.dbVersion).toBe('1.2.3');
  });

  it("keeps the bundled index's extra artworks (synthetic ids) and their provenance, adding the delta after them", () => {
    const alt = { imageId: altArtworkId(15619, 2), cardId: 10, source: 'konami' as const, konamiId: 15619, artwork: 2 };
    const base: LoadedIndex = {
      meta: {
        modelId: 'm1',
        dim: 2,
        count: 3,
        quant: 'int8',
        builtAt: '2026-01-01',
        altArtworks: { source: 'konami', via: 'test', count: 1, covered: { clearly: 0.95, closest: 0.85 }, decidedBy: 'm1', addedAt: '2026-09-30' },
        entries: [{ imageId: 1, cardId: 10 }, { imageId: 2, cardId: 20 }, alt],
      },
      vectors: Int8Array.from([1, 1, 2, 2, 7, 7]),
    };
    const merged = mergeIndex(base, [entry(3, 30, 'm1', [3, 3])]);

    expect(merged.meta.entries).toEqual([{ imageId: 1, cardId: 10 }, { imageId: 2, cardId: 20 }, alt, { imageId: 3, cardId: 30 }]);
    expect(Array.from(merged.vectors as Int8Array)).toEqual([1, 1, 2, 2, 7, 7, 3, 3]);
    expect(merged.meta.altArtworks).toEqual(base.meta.altArtworks);
  });

  it('throws when a delta vector has the wrong dimension', () => {
    const base = baseIndex();
    expect(() => mergeIndex(base, [entry(3, 30, 'm1', [1, 2, 3])])).toThrow(/dim/);
  });

  it('throws for a non-int8 base index', () => {
    const base: LoadedIndex = {
      meta: { modelId: 'm1', dim: 2, count: 1, quant: 'float32', builtAt: '2026-01-01', entries: [{ imageId: 1, cardId: 10 }] },
      vectors: Float32Array.from([0.5, 0.5]),
    };
    expect(() => mergeIndex(base, [entry(2, 20, 'm1')])).toThrow(/int8/);
  });
});
