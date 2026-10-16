// The private store (decision D-FF2): the user's Claude API key and the scan history (with the crop build's
// small pictures) live in the extension origin's own IndexedDB, `duel-lens-private`, in every browser. A content
// script runs in the web page's origin, so its `indexedDB` is the page's: it can't open this database, in Chrome
// or in Firefox. chrome.storage.local is weaker there: Chrome can close it to content scripts
// (setAccessLevel, index.ts), Firefox can't, so anything left in it is readable by the scripts Duel Lens runs on
// web pages. settings.ts and history.ts keep their own APIs on top of this; the non-secret settings (switches,
// display choices) stay in chrome.storage.local, where the side panel's storage.onChanged follows them.
//
// 0.9.2 and earlier kept the key (settings.ai.apiKey), the history and the pictures in chrome.storage.local:
// migrateLegacyStorage, run at every background start (index.ts), moves them here. It writes the new copy
// first and only then deletes the old one, and never overwrites a value this store already has, so it is
// idempotent and an interrupted run is finished by the next one without losing or reviving anything. Until it
// has run, settings.ts and history.ts read the old copy when this store has none.

export const SECURE_DB_NAME = 'duel-lens-private';
/** One key-value object store (out-of-line keys). */
export const SECURE_STORE = 'kv';

/** The keys: the Claude API key, the history list, and one small picture per entry (thumb:<entry id>). */
export const API_KEY = 'apiKey';
export const HISTORY_KEY = 'history';
export const THUMB_PREFIX = 'thumb:';

/** chrome.storage.local key of the settings (settings.ts), from which 0.9.2's ai.apiKey moves out. */
const LEGACY_SETTINGS_KEY = 'settings';

export function request<T>(req: IDBRequest<T>): Promise<T> {
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

function open(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(SECURE_DB_NAME) : indexedDB.open(SECURE_DB_NAME, version);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SECURE_STORE)) req.result.createObjectStore(SECURE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Opens the database at whatever version it has (security review M1: a fixed version would fail for good, with
 * VersionError, once the repair below had raised it). A new database is made at version 1, with its store. One
 * without the store (someone opened the name before Duel Lens did: DevTools, a debugging read) is repaired: it is
 * reopened one version up, which adds the store; any later open then finds it there.
 */
async function connect(): Promise<IDBDatabase> {
  const db = await open();
  if (db.objectStoreNames.contains(SECURE_STORE)) return db;
  db.close();
  return open(db.version + 1);
}

/** One connection per context (and per `indexedDB`, so a test's fresh factory gets its own). */
let cached: { factory: IDBFactory; db: Promise<IDBDatabase> } | undefined;

function openSecureDb(): Promise<IDBDatabase> {
  if (cached?.factory === indexedDB) return cached.db;
  const entry = { factory: indexedDB, db: connect() };
  cached = entry;
  const forget = () => {
    if (cached === entry) cached = undefined; // the next call opens again
  };
  entry.db.then((db) => {
    // A newer version opening elsewhere (an update) must not wait for this connection.
    db.onversionchange = () => {
      db.close();
      forget();
    };
    db.onclose = forget;
  }, forget);
  return entry.db;
}

/**
 * Runs `run` in one transaction of the store and resolves with its result once the transaction has committed.
 * `run` may await only requests on `store` (request()), or the transaction commits early; a throw aborts it.
 */
export async function withSecureStore<R>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => Promise<R> | R): Promise<R> {
  const tx = (await openSecureDb()).transaction(SECURE_STORE, mode);
  const done = txDone(tx);
  let result: R;
  try {
    result = await run(tx.objectStore(SECURE_STORE));
  } catch (err) {
    done.catch(() => undefined);
    try {
      tx.abort();
    } catch {
      // already finished
    }
    throw err;
  }
  await done;
  return result;
}

export function secureGet<T = unknown>(key: string): Promise<T | undefined> {
  return withSecureStore('readonly', (store) => request(store.get(key)) as Promise<T | undefined>);
}

export function secureSet(items: Record<string, unknown>): Promise<void> {
  return withSecureStore('readwrite', (store) => {
    for (const [key, value] of Object.entries(items)) store.put(value, key);
  });
}

/** Every key from `prefix` up (thumb:…), in one key range. */
export function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}\uffff`);
}

/** What migrateLegacyStorage did: the keys it copied here, and the chrome.storage.local copies it removed. */
export interface MigrationResult {
  copied: string[];
  removed: string[];
}

/**
 * Moves 0.9.2's key, history and pictures from chrome.storage.local into this store (see the top of the file).
 * Step 1 copies each one this store lacks, in one transaction; a value already here (an earlier, interrupted
 * run's copy, or a newer one written since) wins, and a picture goes only with an entry of the store's history. Step 2 then removes the key from the stored settings, and
 * step 3 the pictures and, last, the history, so a crash in between leaves the history key to say "not done".
 * A failure rejects, leaving the old copies (settings.ts and history.ts still read them); the next start retries.
 */
export async function migrateLegacyStorage(): Promise<MigrationResult> {
  const head = await chrome.storage.local.get([LEGACY_SETTINGS_KEY, HISTORY_KEY]);
  const legacyKey = (head[LEGACY_SETTINGS_KEY] as { ai?: { apiKey?: unknown } } | undefined)?.ai?.apiKey;
  const hasKey = legacyKey !== undefined;
  const hasHistory = head[HISTORY_KEY] !== undefined;
  if (!hasKey && !hasHistory) return { copied: [], removed: [] }; // migrated already (or nothing to move)

  // 0.9.2 kept a picture only for an entry in the list, so no history key means no pictures to look for.
  const all: Record<string, unknown> = hasHistory ? ((await chrome.storage.local.get(null)) ?? {}) : {};
  const thumbs = Object.keys(all).filter((k) => k.startsWith(THUMB_PREFIX));
  const copied = await withSecureStore('readwrite', async (store) => {
    const written: string[] = [];
    const addMissing = async (key: string, value: unknown): Promise<boolean> => {
      if ((await request(store.count(key))) > 0) return false;
      store.put(value, key);
      written.push(key);
      return true;
    };
    if (typeof legacyKey === 'string') await addMissing(API_KEY, legacyKey);
    if (!hasHistory) return written;
    const legacyHistory = Array.isArray(all[HISTORY_KEY]) ? all[HISTORY_KEY] : [];
    const history = (await addMissing(HISTORY_KEY, legacyHistory)) ? legacyHistory : await request(store.get(HISTORY_KEY));
    // A picture is copied only for an entry the store's history still has (security review L3): one whose entry
    // went meanwhile (Clear history, a rescan, the cap) was deleted by the user, and must not come back.
    const ids = new Set((Array.isArray(history) ? history : []).map((e: { id?: unknown } | null) => e?.id));
    for (const k of thumbs) {
      if (typeof all[k] === 'string' && ids.has(k.slice(THUMB_PREFIX.length))) await addMissing(k, all[k]);
    }
    return written;
  });

  const removed: string[] = [];
  if (hasKey) {
    // Read again just before writing back, so a settings change made meanwhile (Options) isn't undone. One landing
    // between this read and the write still is (security review L4, accepted): at start-up only, non-secret
    // settings only, and the key is never put back.
    const settings = (await chrome.storage.local.get(LEGACY_SETTINGS_KEY))[LEGACY_SETTINGS_KEY] as { ai?: Record<string, unknown> } | undefined;
    if (settings?.ai && API_KEY in settings.ai) {
      const ai = { ...settings.ai };
      delete ai[API_KEY];
      await chrome.storage.local.set({ [LEGACY_SETTINGS_KEY]: { ...settings, ai } });
      removed.push(`${LEGACY_SETTINGS_KEY}.ai.${API_KEY}`);
    }
  }
  if (thumbs.length > 0) {
    await chrome.storage.local.remove(thumbs);
    removed.push(...thumbs);
  }
  if (hasHistory) {
    await chrome.storage.local.remove(HISTORY_KEY);
    removed.push(HISTORY_KEY);
  }
  return { copied, removed };
}
