// The local half of the self-updating artwork index: artwork the bundled index doesn't
// cover yet, embedded on this computer and kept in its own IndexedDB database
// (`duel-lens-index`, separate from the background's `duel-lens` DB - this one is written
// from the offscreen document, and background/index-update.ts also reads its entry count
// directly for the Options page, so its schema below is kept in sync with the small reader
// there). Surviving in IndexedDB (not memory) is what makes a run resumable across a worker
// restart or an offscreen document reload: load-engine.ts merges it back in on every load.
import type { LoadedIndex } from '../shared/index-format';

const DB_NAME = 'duel-lens-index';
const DB_VERSION = 1;
const STORE = 'entries';
const MODEL_INDEX = 'modelId';

export interface DeltaEntry {
  modelId: string;
  imageId: number;
  cardId: number;
  /** Same quantisation as the bundled index: round(v * 127) of an L2-normalised vector. */
  vector: Int8Array;
}

function requestPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * Opens (creating if needed) the `duel-lens-index` database. Safe to call repeatedly and
 * concurrently, like card-store.ts's openDb.
 */
export function openDeltaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: ['modelId', 'imageId'] });
        store.createIndex(MODEL_INDEX, 'modelId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Every delta entry embedded so far for `modelId` (other models' entries are ignored). */
export async function loadDelta(modelId: string): Promise<DeltaEntry[]> {
  const db = await openDeltaDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  return requestPromise<DeltaEntry[]>(store.index(MODEL_INDEX).getAll(modelId));
}

/** Adds (or replaces, by (modelId, imageId)) entries. A no-op for an empty list. */
export async function appendDelta(modelId: string, entries: DeltaEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDeltaDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const e of entries) {
    if (e.modelId !== modelId) {
      throw new Error(`Delta entry for imageId ${e.imageId} has modelId "${e.modelId}", expected "${modelId}"`);
    }
    store.put(e);
  }
  await txDone(tx);
}

/**
 * Deletes every delta entry for a model other than `keepModelId`. The active model can
 * change (a new default shipped, a user override); a stale delta from a previous model
 * would be silently useless there (wrong vector space) while still taking up storage.
 */
export async function clearOtherModels(keepModelId: string): Promise<void> {
  const db = await openDeltaDb();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  await new Promise<void>((resolve, reject) => {
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve();
        return;
      }
      const value = cursor.value as DeltaEntry;
      if (value.modelId !== keepModelId) cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  await txDone(tx);
}

/**
 * Deletes every delta entry of `modelId`: load-engine.ts clears a delta that no longer fits the
 * bundled index (mergeIndex throws on it), so that one bad entry doesn't fail every later load.
 * The self-updating index then finds those artworks missing again and re-embeds them.
 */
export async function clearDelta(modelId: string): Promise<void> {
  const db = await openDeltaDb();
  const tx = db.transaction(STORE, 'readwrite');
  // Keys are [modelId, imageId], so this range holds every key of this model and no other.
  tx.objectStore(STORE).delete(IDBKeyRange.bound([modelId, -Infinity], [modelId, Infinity]));
  await txDone(tx);
}

/**
 * Concatenates `delta` onto `base` (the bundled/loaded index): skips any imageId already
 * in `base` (the bundled index always wins), and keeps `meta.count`/`meta.entries`
 * consistent with the concatenated vectors. Returns `base` itself, unchanged, when there
 * is nothing new to add.
 */
export function mergeIndex(base: LoadedIndex, delta: DeltaEntry[]): LoadedIndex {
  if (delta.length === 0) return base;
  const baseVectors = base.vectors;
  if (!(baseVectors instanceof Int8Array)) {
    throw new Error(`mergeIndex only supports an int8 base index (this one is "${base.meta.quant}")`);
  }
  const known = new Set(base.meta.entries.map((e) => e.imageId));
  const fresh = delta.filter((d) => !known.has(d.imageId));
  if (fresh.length === 0) return base;

  const dim = base.meta.dim;
  const combined = new Int8Array(baseVectors.length + fresh.length * dim);
  combined.set(baseVectors, 0);
  fresh.forEach((d, i) => {
    if (d.vector.length !== dim) {
      throw new Error(`Delta vector for imageId ${d.imageId} has ${d.vector.length} dims, the index has ${dim}`);
    }
    combined.set(d.vector, baseVectors.length + i * dim);
  });

  const entries = [...base.meta.entries, ...fresh.map((d) => ({ imageId: d.imageId, cardId: d.cardId }))];
  return {
    meta: { ...base.meta, count: entries.length, entries },
    vectors: combined,
  };
}
