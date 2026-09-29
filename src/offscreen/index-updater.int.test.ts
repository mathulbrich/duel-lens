// Integration: the self-updating index's embed path (index-updater.ts, wired up exactly as
// handler.ts's updateIndex does) with the REAL default embedder, on real local artworks
// (data/artworks): embed -> persist to the local delta (fake-indexeddb, like delta-index.test.ts)
// -> merge onto a trimmed copy of the shipped index (mergeIndex, the same call handler.ts's
// addToLiveIndex and load-engine.ts make) -> the engine finds the merged-in cards. Also checks
// that an artwork which is still YGOPRODeck's card-back placeholder is embedded and skipped, not
// persisted (placeholder-art.ts). ab-review.md: "Draft brief A.7, the self-updating index with
// the new default" - never exercised before this. Skips when the model, the shipped index or the
// local artwork files are missing.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadDataUrl, loadRGBA } from '../../tools/lib/image';
import { createNodeEmbedder, modelPath, type NodeEmbedder } from '../../tools/lib/ort-node';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../shared/index-format';
import { DEFAULT_MODEL_ID, getModel } from '../shared/models';
import { loadDelta, mergeIndex } from './delta-index';
import { createEngine, type Embedder, type Engine } from './engine';
import { createIndexUpdater, type EmbedArtworkItem } from './index-updater';
import { cardBackVector } from './placeholder-art';

const ROOT = path.resolve(import.meta.dirname, '../..');
const spec = getModel(DEFAULT_MODEL_ID);
const art = (imageId: number) => path.join(ROOT, 'data/artworks', `${imageId}.jpg`);
const indexFile = (ext: string) => path.join(ROOT, 'extension/data', `index-${spec.id}.${ext}`);
const CARD_BACK_FILE = path.join(ROOT, 'data/card-back.jpg');

/**
 * 3 real local artworks of 3 different cards, already in the shipped index: this test removes
 * them from a copy of it (trimmedIndex) so the delta path, not the bundled rows, is what
 * supplies them - otherwise "the engine finds those cards" would be true even without the
 * self-updating index doing anything.
 */
const TEST_ARTWORKS = [
  { imageId: 10000, cardId: 10000, name: 'Ten Thousand Dragon' },
  { imageId: 10000010, cardId: 10000010, name: 'The Winged Dragon of Ra' },
  { imageId: 10000000, cardId: 10000000, name: 'Obelisk the Tormentor' },
];

const ready =
  existsSync(modelPath(spec)) &&
  existsSync(indexFile('bin')) &&
  existsSync(indexFile('meta.json')) &&
  existsSync(CARD_BACK_FILE) &&
  TEST_ARTWORKS.every((a) => existsSync(art(a.imageId)));

// Fresh in-memory IndexedDB per test (delta-index.test.ts's pattern): the local delta must start
// empty, since embed-artworks skips nothing already in loadIndexMeta's list, only what the delta
// (or the bundled index) already has.
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

/** The shipped index, minus TEST_ARTWORKS' rows and vectors: what a computer would have before
 * the self-updating index catches up (index-missing would report these as missing there). */
function trimmedIndex(shipped: LoadedIndex): LoadedIndex {
  const drop = new Set(TEST_ARTWORKS.map((a) => a.imageId));
  const keep = shipped.meta.entries.map((e, i) => [e, i] as const).filter(([e]) => !drop.has(e.imageId));
  const dim = shipped.meta.dim;
  const vectors = new Int8Array(keep.length * dim);
  keep.forEach(([, i], k) => vectors.set((shipped.vectors as Int8Array).subarray(i * dim, (i + 1) * dim), k * dim));
  const entries = keep.map(([e]) => e);
  return { meta: { ...shipped.meta, count: entries.length, entries }, vectors };
}

const dataUrlOf = (file: string) => `data:image/jpeg;base64,${readFileSync(file).toString('base64')}`;

describe.skipIf(!ready)('the self-updating index, with the real default model', () => {
  let embedder: NodeEmbedder;
  let shipped: LoadedIndex;
  let cardBack: Float32Array;

  beforeAll(async () => {
    const bin = readFileSync(indexFile('bin'));
    const meta = JSON.parse(readFileSync(indexFile('meta.json'), 'utf8')) as IndexMeta;
    shipped = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
    cardBack = cardBackVector(shipped)!;
    embedder = await createNodeEmbedder(spec);
  }, 60_000);

  afterAll(async () => {
    await embedder?.release();
  });

  it('embeds real artworks, persists them to the local delta, merges into the shipped index, and the engine finds those cards', async () => {
    const base = trimmedIndex(shipped);
    for (const a of TEST_ARTWORKS) expect(base.meta.entries.some((e) => e.imageId === a.imageId), a.name).toBe(false);

    const items: EmbedArtworkItem[] = TEST_ARTWORKS.map((a) => ({ imageId: a.imageId, cardId: a.cardId, dataUrl: dataUrlOf(art(a.imageId)) }));
    const updater = createIndexUpdater({
      modelId: spec.id,
      loadIndexMeta: async () => base.meta,
      decode: loadDataUrl,
      loadEmbedding: async () => ({ embed: embedder.embed, cardBack }),
    });

    const res = await updater.handle({ target: 'offscreen', type: 'embed-artworks', items });
    expect(res).toMatchObject({ modelId: spec.id, added: TEST_ARTWORKS.length, failed: [] });
    expect('placeholders' in res).toBe(false);

    // Persisted to the local delta (fake-indexeddb) - the same store load-engine.ts and
    // handler.ts's addToLiveIndex read - with the current model's id and vector dimension.
    const delta = await loadDelta(spec.id);
    expect(delta.map((e) => e.imageId).sort((x, y) => x - y)).toEqual(TEST_ARTWORKS.map((a) => a.imageId).sort((x, y) => x - y));
    for (const e of delta) {
      expect(e.modelId).toBe('dinov2-small-duel');
      expect(e.vector).toHaveLength(384);
    }
    expect(spec.dim).toBe(384);

    // mergeIndex (the same call addToLiveIndex and load-engine.ts make) restores them.
    const merged = mergeIndex(base, delta);
    expect(merged).not.toBe(base);
    expect(merged.meta.count).toBe(base.meta.count + TEST_ARTWORKS.length);
    for (const a of TEST_ARTWORKS) expect(merged.meta.entries).toContainEqual({ imageId: a.imageId, cardId: a.cardId });

    // The engine, built on the merged index, finds each artwork's own card. No card detector: these
    // are bare artwork crops (like data/artworks builds the index from), not a card lying in a frame,
    // which isn't what this test is about. With no card detected, the engine's 'art' hypothesis is
    // the crop's own centre square - here the whole (square) artwork itself, the very image just
    // embedded into the delta - so a confident self-match is exactly what proves the delta row
    // round-tripped correctly through mergeIndex and search.
    const engineEmbedder: Embedder = { modelId: spec.id, embed: embedder.embed };
    const engine: Engine = createEngine({ embedder: engineEmbedder, index: merged, spec });
    for (const a of TEST_ARTWORKS) {
      const img = await loadRGBA(art(a.imageId));
      const result = await engine.recognize(img, { x: 0, y: 0, w: img.width, h: img.height });
      expect(result.error, `${a.name}: ${result.error}`).toBeUndefined();
      expect(result.candidates[0]?.cardId, a.name).toBe(a.cardId);
      expect(result.confident, a.name).toBe(true);
    }
  }, 120_000);

  it("embeds a card-back placeholder image with the real model and skips it: it isn't added to the delta", async () => {
    const updater = createIndexUpdater({
      modelId: spec.id,
      loadIndexMeta: async () => shipped.meta,
      decode: loadDataUrl,
      loadEmbedding: async () => ({ embed: embedder.embed, cardBack }),
    });
    // A hypothetical new card whose downloaded artwork is still YGOPRODeck's card-back
    // placeholder (data/card-back.jpg; placeholder-art.ts's real scenario, and the three real
    // placeholder ids dropPlaceholders() already excludes from the shipped index).
    const placeholderImageId = 999999999;
    const res = await updater.handle({
      target: 'offscreen',
      type: 'embed-artworks',
      items: [{ imageId: placeholderImageId, cardId: 123456789, dataUrl: dataUrlOf(CARD_BACK_FILE) }],
    });
    expect(res).toMatchObject({ modelId: spec.id, added: 0, failed: [], placeholders: [placeholderImageId] });
    expect(await loadDelta(spec.id)).toEqual([]);
  }, 60_000);
});
