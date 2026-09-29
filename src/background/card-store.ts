// IndexedDB-backed card store: the bundled card snapshot, seeded on install and kept
// fresh by a weekly refresh (see `refreshIfChanged`). Also owns the `crops` object
// store used by the debug "save crops for a test set" feature (see index.ts/router.ts).
import { mergeGenesysPoints, trimCard, type ApiCard, type GenesysApiCard } from '../shared/cards';
import type { CardRecord } from '../shared/types';

const DB_NAME = 'duel-lens';
const DB_VERSION = 1;
export const CARDS_STORE = 'cards';
const META_STORE = 'meta';
const CROPS_STORE = 'crops';
const HISTORY_STORE = 'history'; // reserved, unused: history lives in chrome.storage.local instead.
const MAX_CROPS = 300;

const CHECK_VERSION_URL = 'https://db.ygoprodeck.com/api/v7/checkDBVer.php';
const CARD_INFO_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes';
/** The same card list, with each card's points in the Genesys format (mergeGenesysPoints). */
const GENESYS_URL = 'https://db.ygoprodeck.com/api/v7/cardinfo.php?format=genesys&misc=yes';
/**
 * Meta key, true once the stored cards have the bundle's Genesys points or newer ones. A store seeded
 * before the points existed gets them from the bundle once (ensureSeeded), after the extension's
 * update, instead of at YGOPRODeck's next database change.
 */
const GENESYS_META_KEY = 'genesysPoints';

export interface BundledCards {
  dbVersion: string;
  updatedAt: string;
  cards: CardRecord[];
}

export interface CardMeta {
  dbVersion?: string;
  updatedAt?: string;
  cardCount: number;
}

export interface CropRecord {
  dataUrl: string;
  cardId: number;
  at: number;
  /** History entry this crop was saved for, so `correct` can relabel it. */
  entryId?: string;
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
 * Opens (creating if needed) the `duel-lens` database. Safe to call repeatedly and
 * concurrently: IndexedDB only runs `onupgradeneeded` once per version, and every
 * later call just resolves with a connection to the same database.
 */
export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CARDS_STORE)) db.createObjectStore(CARDS_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(CROPS_STORE)) db.createObjectStore(CROPS_STORE, { autoIncrement: true });
      if (!db.objectStoreNames.contains(HISTORY_STORE)) db.createObjectStore(HISTORY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putCards(
  db: IDBDatabase,
  cards: CardRecord[],
  meta: { dbVersion: string; updatedAt: string; genesysPoints: boolean },
): Promise<void> {
  const tx = db.transaction([CARDS_STORE, META_STORE], 'readwrite');
  const cardsStore = tx.objectStore(CARDS_STORE);
  cardsStore.clear();
  for (const c of cards) cardsStore.put(c);
  const metaStore = tx.objectStore(META_STORE);
  metaStore.put(meta.dbVersion, 'dbVersion');
  metaStore.put(meta.updatedAt, 'updatedAt');
  if (meta.genesysPoints) metaStore.put(true, GENESYS_META_KEY);
  await txDone(tx);
}

/** The seed in progress in this worker, shared by every caller until it settles (ensureSeeded). */
let seeding: Promise<void> | null = null;

/**
 * Seeds the store from the bundled `cards.json` exactly once; later calls are a no-op, except the
 * first one to find a store seeded before Genesys points existed, which adds the bundle's points
 * (addBundledGenesysPoints). Callers at the same time share one attempt: on a first install,
 * onInstalled seeds while the welcome page it opens asks get-status (router.ts), and each would
 * otherwise find the store empty and load the bundle again. A failed attempt isn't remembered: the
 * next call tries again.
 */
export function ensureSeeded(loadBundled: () => Promise<BundledCards>): Promise<void> {
  seeding ??= seedIfEmpty(loadBundled).finally(() => {
    seeding = null;
  });
  return seeding;
}

async function seedIfEmpty(loadBundled: () => Promise<BundledCards>): Promise<void> {
  const db = await openDb();
  const count = await requestPromise(db.transaction(CARDS_STORE, 'readonly').objectStore(CARDS_STORE).count());
  if (count > 0) return addBundledGenesysPoints(db, loadBundled);
  const bundled = await loadBundled();
  await putCards(db, bundled.cards, { dbVersion: bundled.dbVersion, updatedAt: bundled.updatedAt, genesysPoints: true });
}

/**
 * Gives a store seeded before Genesys points existed the bundle's points, once: each is copied onto the
 * stored card with the same id, whose other data (maybe newer than the bundle's) stays as it is.
 */
async function addBundledGenesysPoints(db: IDBDatabase, loadBundled: () => Promise<BundledCards>): Promise<void> {
  const done = await requestPromise(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(GENESYS_META_KEY));
  if (done) return;
  const bundled = await loadBundled();
  const tx = db.transaction([CARDS_STORE, META_STORE], 'readwrite');
  const cardsStore = tx.objectStore(CARDS_STORE);
  for (const { id, genesysPoints } of bundled.cards) {
    if (!genesysPoints) continue;
    const req = cardsStore.get(id);
    req.onsuccess = () => {
      const card = req.result as CardRecord | undefined;
      if (card && card.genesysPoints === undefined) cardsStore.put({ ...card, genesysPoints });
    };
  }
  tx.objectStore(META_STORE).put(true, GENESYS_META_KEY);
  await txDone(tx);
}

/** Loads the card snapshot bundled with the extension (`data/cards.json`), for `ensureSeeded`. */
export async function loadBundledCards(): Promise<BundledCards> {
  const res = await fetch(chrome.runtime.getURL('data/cards.json'));
  return res.json();
}

export async function getCards(ids: number[]): Promise<Record<number, CardRecord>> {
  const db = await openDb();
  const store = db.transaction(CARDS_STORE, 'readonly').objectStore(CARDS_STORE);
  const out: Record<number, CardRecord> = {};
  await Promise.all(
    ids.map(async (id) => {
      const card = await requestPromise<CardRecord | undefined>(store.get(id));
      if (card) out[id] = card;
    }),
  );
  return out;
}

export async function getAllNames(): Promise<{ id: number; name: string }[]> {
  const db = await openDb();
  const store = db.transaction(CARDS_STORE, 'readonly').objectStore(CARDS_STORE);
  const all = await requestPromise<CardRecord[]>(store.getAll());
  return all.map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Entries that are not real cards: "???" (149694341) stands in for unrevealed cards in
 * tournament deck profiles, and its artworks are the card back with a question mark, which
 * would compete with the card-back (face-down) entry. Mirrors tools/lib/artworks.ts's
 * NOT_CARDS, which is what the bundled index was built to exclude - the self-updating
 * index must exclude the same things, or it would add noise the build deliberately left out.
 */
const NOT_INDEXABLE_CARDS = new Set([149694341]);

/**
 * Every artwork id backing at least one real card, paired with that card's id (a repeated
 * image id keeps its first card - same rule as tools/lib/artworks.ts's listArtworks, so
 * this lines up with what the bundled index covers). Skill cards are skipped: their "art"
 * is a character portrait, not card art.
 */
export async function getAllImageIds(): Promise<{ imageId: number; cardId: number }[]> {
  const db = await openDb();
  const store = db.transaction(CARDS_STORE, 'readonly').objectStore(CARDS_STORE);
  const all = await requestPromise<CardRecord[]>(store.getAll());
  const seen = new Set<number>();
  const out: { imageId: number; cardId: number }[] = [];
  for (const card of all) {
    if (card.frameType === 'skill' || NOT_INDEXABLE_CARDS.has(card.id)) continue;
    for (const imageId of card.imageIds) {
      if (seen.has(imageId)) continue;
      seen.add(imageId);
      out.push({ imageId, cardId: card.id });
    }
  }
  return out;
}

export async function getMeta(): Promise<CardMeta> {
  const db = await openDb();
  const tx = db.transaction([CARDS_STORE, META_STORE], 'readonly');
  const [cardCount, dbVersion, updatedAt] = await Promise.all([
    requestPromise(tx.objectStore(CARDS_STORE).count()),
    requestPromise<string | undefined>(tx.objectStore(META_STORE).get('dbVersion')),
    requestPromise<string | undefined>(tx.objectStore(META_STORE).get('updatedAt')),
  ]);
  const meta: CardMeta = { cardCount };
  if (dbVersion !== undefined) meta.dbVersion = dbVersion;
  if (updatedAt !== undefined) meta.updatedAt = updatedAt;
  return meta;
}

interface CheckDbVerEntry {
  database_version?: string;
}

/**
 * Checks YGOPRODeck's database version and re-downloads the full card list, then the
 * Genesys points, only when it changed. Never throws: a network problem returns
 * `'failed'` and leaves the previously stored cards untouched. Without the Genesys
 * points, the new cards still replace the old ones (withGenesysPoints).
 */
export async function refreshIfChanged(fetchFn: typeof fetch = fetch): Promise<'updated' | 'unchanged' | 'failed'> {
  try {
    const verRes = await fetchFn(CHECK_VERSION_URL);
    if (!verRes.ok) return 'failed';
    const verBody = (await verRes.json()) as CheckDbVerEntry[] | CheckDbVerEntry;
    const remoteVersion = Array.isArray(verBody) ? verBody[0]?.database_version : verBody?.database_version;
    if (!remoteVersion) return 'failed';

    const current = await getMeta();
    if (current.dbVersion === remoteVersion) return 'unchanged';

    const trimmed = await downloadCards(fetchFn);
    if (!trimmed) return 'failed';

    const db = await openDb();
    const cards = await withGenesysPoints(trimmed, db, fetchFn);
    const genesysPoints = cards.some((c) => c.genesysPoints !== undefined);
    await putCards(db, cards, { dbVersion: remoteVersion, updatedAt: new Date().toISOString(), genesysPoints });
    return 'updated';
  } catch {
    return 'failed';
  }
}

/** The full card list, trimmed (in its own function, so the raw list can go before the next download). */
async function downloadCards(fetchFn: typeof fetch): Promise<CardRecord[] | undefined> {
  const res = await fetchFn(CARD_INFO_URL);
  if (!res.ok) return undefined;
  const body = (await res.json()) as { data: ApiCard[] };
  return body.data.map(trimCard);
}

/**
 * `cards` with the points of YGOPRODeck's Genesys list. Without them (the request fails, or the answer
 * gives no card any points, which would mean it changed shape), the refresh goes ahead anyway: each
 * card keeps the points the store has for it, so a failed request never wipes them. The next database
 * change tries again.
 */
async function withGenesysPoints(cards: CardRecord[], db: IDBDatabase, fetchFn: typeof fetch): Promise<CardRecord[]> {
  try {
    const res = await fetchFn(GENESYS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body?.data)) throw new Error('the answer has no card list');
    const merged = mergeGenesysPoints(cards, body.data as GenesysApiCard[]);
    if (merged.withPoints === 0) throw new Error('the answer gives no card any points');
    return merged.cards;
  } catch (err) {
    console.warn('Duel Lens: could not get the Genesys points; the cards keep the ones stored', err);
    const stored = await storedGenesysPoints(db);
    return cards.map((c) => {
      const points = c.genesysPoints ?? stored.get(c.id);
      return points === c.genesysPoints ? c : { ...c, genesysPoints: points };
    });
  }
}

/** The stored cards' Genesys points, by card id. */
async function storedGenesysPoints(db: IDBDatabase): Promise<Map<number, number>> {
  const all = await requestPromise<CardRecord[]>(db.transaction(CARDS_STORE, 'readonly').objectStore(CARDS_STORE).getAll());
  const points = new Map<number, number>();
  for (const c of all) if (c.genesysPoints) points.set(c.id, c.genesysPoints);
  return points;
}

/** Saves a debug crop (see `settings.debug.saveCrops`), keeping only the last `MAX_CROPS`. */
export async function saveCrop(record: CropRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(CROPS_STORE, 'readwrite');
  const store = tx.objectStore(CROPS_STORE);
  store.put(record);
  const keys = await requestPromise<IDBValidKey[]>(store.getAllKeys());
  const excess = keys.length - MAX_CROPS;
  for (let i = 0; i < excess; i++) store.delete(keys[i]);
  await txDone(tx);
}

/** Relabels the most recent debug crop saved for `entryId`, if any (see `correct`). */
export async function relabelCrop(entryId: string, cardId: number): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(CROPS_STORE, 'readwrite');
  const store = tx.objectStore(CROPS_STORE);
  const cursorReq = store.openCursor();
  await new Promise<void>((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      const value = cursor.value as CropRecord;
      if (value.entryId === entryId) {
        cursor.update({ ...value, cardId });
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  await txDone(tx);
}

/** All saved debug crops, oldest first, for "Export test set" on the options page. */
export async function getAllCrops(): Promise<CropRecord[]> {
  const db = await openDb();
  const store = db.transaction(CROPS_STORE, 'readonly').objectStore(CROPS_STORE);
  return requestPromise<CropRecord[]>(store.getAll());
}
