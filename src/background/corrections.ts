// "Wrong card?" (the popover): a local, capped record of each correction the user makes - the crop
// exactly as the engine cut it, the card they said is right, and the engine's own top-5 for that crop -
// kept so it can seed future retraining. Off the same switch as everything else here
// (Settings.corrections.save, "Save my corrections" in Options): never sent anywhere, and Options can
// read the count, export it as a file, or delete it all (src/options/app.tsx).
//
// Its own IndexedDB database, separate from card-store.ts's `duel-lens` one (which that file owns):
// this feature only needs one small object store, and keeping it separate means no migration of
// card-store.ts's schema/version just for this.
import type { Candidate } from '../shared/types';

const DB_NAME = 'duel-lens-corrections';
const DB_VERSION = 2;
const STORE = 'corrections';
/** Sorted by `at`, so trimming the store can walk oldest-first without an all-records scan (`getAll`). */
const BY_AT_INDEX = 'by_at';
/** One small key/value store: just the running total of every record's `dataUrl` length, kept in
 * step with STORE so trimming never has to add up every record's image to know when to stop. */
const META_STORE = 'meta';
const TOTAL_BYTES_KEY = 'totalBytes';
/** Latest N corrections kept; the oldest (by `at`) are dropped past this. */
const MAX_CORRECTIONS = 500;
/** Total size kept, besides the count above: crops add up fast, so the count alone doesn't bound
 * how much space this feature can use. Approximate (dataUrl.length, i.e. characters, not exact
 * bytes) - precise enough for a soft cap like this one. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** How many in-flight scans' crop/candidates/model are remembered at once, waiting for a possible
 * correction (see `stage`); well past any real session's open scans, just a sanity cap. */
const MAX_STAGED = 50;

export interface CorrectionRecord {
  /** The history entry (src/background/history.ts) this correction was made from; also its IndexedDB key. */
  entryId: string;
  /** PNG data URL of the crop, exactly as the engine cut it (CropPayload.dataUrl). */
  dataUrl: string;
  /** The card the user said is the right one. */
  cardId: number;
  /** Which artwork to show for it (already resolved for an alt-artwork match: src/shared/alt-artwork.ts). */
  imageId: number;
  /** The engine's own best guesses for this crop, best first, at most 5 (RecognitionResult.candidates). */
  topCandidates: Candidate[];
  /** Embedding model id that produced `topCandidates` (RecognitionResult.modelId). */
  modelId: string;
  /** Epoch ms when the correction was made. */
  at: number;
}

/** What `recognize` stages for a possible later correction of the same history entry (see `stage`). */
export interface StagedScan {
  dataUrl: string;
  candidates: Candidate[];
  modelId: string;
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

/** Opens (creating if needed) the `duel-lens-corrections` database. Safe to call repeatedly/concurrently. */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const store = db.objectStoreNames.contains(STORE) ? req.transaction!.objectStore(STORE) : db.createObjectStore(STORE, { keyPath: 'entryId' });
      if (!store.indexNames.contains(BY_AT_INDEX)) store.createIndex(BY_AT_INDEX, 'at');
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Approximate size of one record's stored image: its data URL's length (characters, not exact bytes). */
function byteSize(record: Pick<CorrectionRecord, 'dataUrl'>): number {
  return record.dataUrl.length;
}

async function readTotalBytes(meta: IDBObjectStore): Promise<number> {
  const v = await requestPromise<number | undefined>(meta.get(TOTAL_BYTES_KEY));
  return typeof v === 'number' ? v : 0;
}

/** Removes `entryId`'s correction, if it has one, and keeps the total-size tally in step. Used both
 * by "re-confirmed the engine's own top guess" (maybeSaveCorrection) and could be reused for a future
 * per-entry "undo". A no-op when there is nothing saved for it. */
async function removeCorrection(entryId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE, META_STORE], 'readwrite');
  const store = tx.objectStore(STORE);
  const meta = tx.objectStore(META_STORE);
  const existing = await requestPromise<CorrectionRecord | undefined>(store.get(entryId));
  if (existing) {
    store.delete(entryId);
    meta.put(Math.max(0, (await readTotalBytes(meta)) - byteSize(existing)), TOTAL_BYTES_KEY);
  }
  await txDone(tx);
}

/**
 * The crop/candidates/model of a scan not yet corrected, keyed by its history entry id, kept in memory
 * only (never IndexedDB): `maybeSaveCorrection` reads it so the content script doesn't have to resend the
 * crop when the user later says "Wrong card?". Best-effort: a service-worker restart between the scan and
 * the correction simply loses it (the history update itself still succeeds either way - router.ts). Not
 * deleted once used, so correcting the same entry twice (the user picks one card, then another) still
 * finds the original top guess and crop both times; it ages out on its own past `MAX_STAGED`.
 */
const staged = new Map<string, StagedScan>();

export function stage(entryId: string, snapshot: StagedScan): void {
  staged.set(entryId, snapshot);
  if (staged.size > MAX_STAGED) {
    const oldest = staged.keys().next().value;
    if (oldest !== undefined) staged.delete(oldest);
  }
}

/** Test-only: clears the in-memory staging map between tests. */
export function clearStaged(): void {
  staged.clear();
}

/**
 * Saves a correction for `entryId`, if one was staged for it (a scan from before this feature existed,
 * or after a worker restart, stages nothing: a silent no-op) and `enabled` (Settings.corrections.save).
 *
 * Re-confirming the engine's own top guess for that crop (`cardId` matches it) is never a save: if an
 * earlier, different pick was saved for this entry, it is removed instead - so changing your mind back
 * never leaves a stale "wrong" label behind - and this cleanup runs even when `enabled` is false (it's
 * removing bad data, not adding new data, so the setting doesn't gate it).
 *
 * Caps the store at MAX_CORRECTIONS and MAX_TOTAL_BYTES, oldest (`at`) dropped first via the `by_at`
 * index: an ascending cursor visits only the handful of records actually being dropped at the margin,
 * never every record's image the way `getAll()` would.
 */
export async function maybeSaveCorrection(entryId: string, cardId: number, imageId: number, enabled: boolean): Promise<void> {
  const snap = staged.get(entryId);
  if (!snap) return;
  if (snap.candidates[0]?.cardId === cardId) {
    await removeCorrection(entryId);
    return;
  }
  if (!enabled) return;

  const record: CorrectionRecord = {
    entryId,
    dataUrl: snap.dataUrl,
    cardId,
    imageId,
    topCandidates: snap.candidates.slice(0, 5),
    modelId: snap.modelId,
    at: Date.now(),
  };
  const db = await openDb();
  const tx = db.transaction([STORE, META_STORE], 'readwrite');
  const store = tx.objectStore(STORE);
  const meta = tx.objectStore(META_STORE);

  const existing = await requestPromise<CorrectionRecord | undefined>(store.get(entryId));
  store.put(record);
  let total = (await readTotalBytes(meta)) - (existing ? byteSize(existing) : 0) + byteSize(record);
  let count = await requestPromise<number>(store.count());

  if (count > MAX_CORRECTIONS || total > MAX_TOTAL_BYTES) {
    await new Promise<void>((resolve, reject) => {
      const cursorReq = store.index(BY_AT_INDEX).openCursor(); // ascending: oldest first
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || (count <= MAX_CORRECTIONS && total <= MAX_TOTAL_BYTES)) {
          resolve();
          return;
        }
        const value = cursor.value as CorrectionRecord;
        // Never the record just saved: it's always the newest, so an ascending cursor only reaches
        // it once everything else is gone - this is just a defensive guard against an `at` tie.
        if (value.entryId !== entryId) {
          total -= byteSize(value);
          count -= 1;
          cursor.delete();
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
  }
  meta.put(Math.max(0, total), TOTAL_BYTES_KEY);
  await txDone(tx);
}

/** Every saved correction, oldest first (Options' count and "Export"). */
export async function getAllCorrections(): Promise<CorrectionRecord[]> {
  const db = await openDb();
  const store = db.transaction(STORE, 'readonly').objectStore(STORE);
  const all = await requestPromise<CorrectionRecord[]>(store.getAll());
  return all.sort((a, b) => a.at - b.at);
}

/** How many corrections are saved (Options, without loading every crop image). */
export async function countCorrections(): Promise<number> {
  const db = await openDb();
  return requestPromise(db.transaction(STORE, 'readonly').objectStore(STORE).count());
}

/** Options' "Delete all": every saved correction, and the size tally they were counted against. The
 * in-memory staging map (not yet corrected) is untouched. */
export async function clearCorrections(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE, META_STORE], 'readwrite');
  tx.objectStore(STORE).clear();
  tx.objectStore(META_STORE).put(0, TOTAL_BYTES_KEY);
  await txDone(tx);
}
