import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type HistoryEntry } from '../shared/types';
import { addEntry, clearHistory, getHistory, getThumb } from './history';
import { API_KEY, HISTORY_KEY, migrateLegacyStorage, SECURE_DB_NAME, secureGet, secureSet } from './secure-store';
import { getSettings, setSettings } from './settings';

/** chrome.storage.{local,session}, promise-based, with get(key | keys | null) as in MV3. */
function fakeStorageArea(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = structuredClone(initial);
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
  return {
    get: vi.fn(async (keys: string | string[] | null) => (keys === null ? structuredClone(data) : pick(Array.isArray(keys) ? keys : [keys]))),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(items) };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
    /** Everything it holds: what a content script could read with chrome.storage.local.get(null) in Firefox. */
    dump: () => structuredClone(data),
  };
}

function entry(id: string, at: number): HistoryEntry {
  return { id, cardId: at, imageId: at, score: 0.9, confident: true, at, pageUrl: 'https://www.youtube.com/watch?v=x', pageTitle: 't', source: 'video', videoTime: at * 100 };
}

const KEY = 'sk-ant-api03-from-0.9.2';
const HISTORY = [entry('e2', 2), entry('e1', 1)];
const THUMB_E2 = 'data:image/jpeg;base64,E2';
const THUMB_E1 = 'data:image/jpeg;base64,E1';
const SETTINGS = {
  ai: { enabled: true, apiKey: KEY, model: 'claude-sonnet-5' },
  debug: { saveCrops: false },
  display: { reveal: 'click', banlist: 'ocg', cardLanguage: 'fr' },
  corrections: { save: true },
};
/** chrome.storage.local as Duel Lens 0.9.2 left it (the crop build: a picture per entry). */
const STORED_092 = {
  settings: SETTINGS,
  history: HISTORY,
  'thumb:e2': THUMB_E2,
  'thumb:e1': THUMB_E1,
  consentedAt: 1_790_000_000_000,
  indexUpdate: { lastRunAt: 1_790_000_000_000, indexed: 12 },
};
/** What stays in chrome.storage.local after the move: the same, but no key, no history and no pictures. */
const LOCAL_AFTER = {
  settings: { ...SETTINGS, ai: { enabled: true, model: 'claude-sonnet-5' } },
  consentedAt: STORED_092.consentedAt,
  indexUpdate: STORED_092.indexUpdate,
};

let local: ReturnType<typeof fakeStorageArea>;

function setUp(stored: Record<string, unknown> = STORED_092): void {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  local = fakeStorageArea(stored);
  vi.stubGlobal('chrome', { storage: { local, session: fakeStorageArea() } });
}

beforeEach(() => setUp());

/** What the user sees through the modules' own APIs. */
async function seen() {
  return { settings: await getSettings(), history: await getHistory(), thumbs: [await getThumb('e2'), await getThumb('e1')] };
}

describe('migrateLegacyStorage: the move from a stored 0.9.2', () => {
  it('moves the key, the history and the pictures to the private store, and leaves the rest in chrome.storage.local', async () => {
    const before = await seen();

    expect(await migrateLegacyStorage()).toEqual({
      copied: [API_KEY, HISTORY_KEY, 'thumb:e2', 'thumb:e1'],
      removed: ['settings.ai.apiKey', 'thumb:e2', 'thumb:e1', HISTORY_KEY],
    });

    expect(await secureGet(API_KEY)).toBe(KEY);
    expect(await secureGet(HISTORY_KEY)).toEqual(HISTORY);
    expect([await secureGet('thumb:e2'), await secureGet('thumb:e1')]).toEqual([THUMB_E2, THUMB_E1]);
    expect(local.dump()).toEqual(LOCAL_AFTER);
    // Nothing changes for the user: the same settings, key, history and pictures.
    expect(await seen()).toEqual(before);
    expect(before.settings).toEqual({ ...SETTINGS, ai: { ...SETTINGS.ai }, updates: { check: true } }); // a later setting, at its default
  });

  // The question D-FF2 answers: Firefox can't close chrome.storage.local to content scripts, and a content script
  // can't open the extension's IndexedDB (it runs in the page's origin), so the test is that no copy is left.
  it('leaves a content script nothing to read: no key, no history, no picture in chrome.storage.local', async () => {
    await migrateLegacyStorage();
    await setSettings({ ai: { apiKey: 'sk-ant-api03-typed-later' } });
    await addEntry(entry('e3', 3));

    const readable = JSON.stringify(local.dump());
    for (const secret of [KEY, 'sk-ant-api03-typed-later', 'thumb:', THUMB_E1, 'watch?v=x', '"e3"']) expect(readable).not.toContain(secret);
    expect(Object.keys(local.dump()).sort()).toEqual(['consentedAt', 'indexUpdate', 'settings']);
  });

  it('a second run does nothing: no write anywhere', async () => {
    await migrateLegacyStorage();
    local.set.mockClear();
    local.remove.mockClear();
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');

    expect(await migrateLegacyStorage()).toEqual({ copied: [], removed: [] });

    expect(local.set).not.toHaveBeenCalled();
    expect(local.remove).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(local.dump()).toEqual(LOCAL_AFTER);
    put.mockRestore();
  });

  it('does nothing on a fresh install, and creates no database', async () => {
    setUp({});
    expect(await migrateLegacyStorage()).toEqual({ copied: [], removed: [] });
    expect(await indexedDB.databases()).toEqual([]);
  });

  it('settings with no key (the AI check never set up) keep their shape; only the history moves', async () => {
    const { apiKey: _none, ...ai } = SETTINGS.ai;
    setUp({ settings: { ...SETTINGS, ai }, history: HISTORY });

    expect(await migrateLegacyStorage()).toEqual({ copied: [HISTORY_KEY], removed: [HISTORY_KEY] });
    expect(local.dump()).toEqual({ settings: { ...SETTINGS, ai } });
    expect(await secureGet(API_KEY)).toBeUndefined();
  });

  it('a damaged history moves as an empty one, and a damaged key is dropped', async () => {
    setUp({ settings: { ...SETTINGS, ai: { ...SETTINGS.ai, apiKey: 42 } }, history: 'not a list', 'thumb:x': 7 });

    await migrateLegacyStorage();

    expect(await secureGet(HISTORY_KEY)).toEqual([]);
    expect(await secureGet(API_KEY)).toBeUndefined();
    expect(await secureGet('thumb:x')).toBeUndefined();
    expect(local.dump()).toEqual({ settings: LOCAL_AFTER.settings });
  });
});

// "Crash-safe": the new copy is written before the old one is deleted, and a value already in the private
// store wins over the old copy, so a run cut short anywhere is finished by the next start, losing nothing and
// bringing back nothing.
describe('migrateLegacyStorage: an interrupted move', () => {
  it('cut short while writing the private store: nothing is deleted, the user still sees everything, the next start moves it', async () => {
    const before = await seen();
    const realPut = IDBObjectStore.prototype.put;
    let puts = 0;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (++puts === 3) throw new Error('quota exceeded'); // the third item: the key and the history went in
      return realPut.apply(this, args);
    });

    await expect(migrateLegacyStorage()).rejects.toThrow('quota exceeded');

    expect(local.dump()).toEqual(STORED_092);
    expect([await secureGet(API_KEY), await secureGet(HISTORY_KEY)]).toEqual([undefined, undefined]); // all or nothing
    expect(await seen()).toEqual(before);
    put.mockRestore();

    await migrateLegacyStorage();
    expect(local.dump()).toEqual(LOCAL_AFTER);
    expect(await seen()).toEqual(before);
  });

  it.each([
    ['after the copy, before any delete', 'set'],
    ['after the key was removed from the settings, before the history and pictures', 'remove'],
  ] as const)('cut short %s: the next start finishes it', async (_when, failing) => {
    const before = await seen();
    local[failing].mockRejectedValueOnce(new Error('the browser closed'));

    await expect(migrateLegacyStorage()).rejects.toThrow('the browser closed');
    expect(Object.keys(local.dump())).toContain(HISTORY_KEY); // the history key, removed last, says "not done"

    expect((await migrateLegacyStorage()).removed).toContain(HISTORY_KEY);
    expect(local.dump()).toEqual(LOCAL_AFTER);
    expect(await seen()).toEqual(before);
  });

  it('never lets the old copy overwrite what changed in between: a new scan, a newer key', async () => {
    local.set.mockRejectedValueOnce(new Error('the browser closed')); // after the copy, before any delete
    await expect(migrateLegacyStorage()).rejects.toThrow('the browser closed');
    await addEntry(entry('e3', 3));
    await secureSet({ [API_KEY]: 'sk-ant-newer' });

    await migrateLegacyStorage();

    expect((await getHistory()).map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
    expect(await secureGet(API_KEY)).toBe('sk-ant-newer');
    expect(local.dump()).toEqual(LOCAL_AFTER);
  });

  it('never brings back a history cleared in between', async () => {
    local.set.mockRejectedValueOnce(new Error('the browser closed'));
    await expect(migrateLegacyStorage()).rejects.toThrow('the browser closed');
    await clearHistory();

    await migrateLegacyStorage();

    expect(await getHistory()).toEqual([]);
    expect([await getThumb('e2'), await getThumb('e1')]).toEqual([undefined, undefined]);
    expect(local.dump()).toEqual(LOCAL_AFTER);
  });

  // Security review L3: a picture whose entry the store no longer has was deleted by the user (Clear history, a
  // rescan, the cap); the old copy must not bring it back.
  it("never brings back a picture whose entry went before the move: Clear history whose old-copy delete failed", async () => {
    local.remove.mockRejectedValueOnce(new Error('the browser closed')); // clearHistory's removal of the old copy
    await expect(clearHistory()).rejects.toThrow('the browser closed');

    await migrateLegacyStorage();

    expect(await getHistory()).toEqual([]);
    expect([await secureGet('thumb:e2'), await secureGet('thumb:e1')]).toEqual([undefined, undefined]);
    expect(local.dump()).toEqual(LOCAL_AFTER);
  });

  it('never brings back a picture whose entry a rescan replaced before the move', async () => {
    // A rescan of e2 (same card, page and moment) replaces it: the store's history starts from the old copy.
    await addEntry({ ...entry('e2', 2), id: 'e3', at: 3 });

    expect((await migrateLegacyStorage()).copied).toEqual([API_KEY, 'thumb:e1']);

    expect((await getHistory()).map((e) => e.id)).toEqual(['e3', 'e1']);
    expect(await secureGet('thumb:e2')).toBeUndefined();
    expect(await secureGet('thumb:e1')).toBe(THUMB_E1);
  });

  it('runs safely twice at once (the background and an extension page)', async () => {
    const before = await seen();
    await Promise.all([migrateLegacyStorage(), migrateLegacyStorage()]);
    expect(local.dump()).toEqual(LOCAL_AFTER);
    expect(await seen()).toEqual(before);
  });
});

describe('the private store', () => {
  it('lives in its own IndexedDB database', async () => {
    await secureSet({ x: 1 });
    expect((await indexedDB.databases()).map((d) => d.name)).toEqual([SECURE_DB_NAME]);
  });

  // Security review M1: a database someone else made first (DevTools, a support instruction) must never leave the
  // store unopenable: the repair raises its version, and every later open (a worker restart, a page) must still work.
  describe('a database of its name made by someone else first', () => {
    /** Opens the name as DevTools would, at `version` (none: the current one, or a new version 1), with no store. */
    const openByHand = (version?: number) =>
      new Promise<void>((resolve, reject) => {
        const req = version === undefined ? indexedDB.open(SECURE_DB_NAME) : indexedDB.open(SECURE_DB_NAME, version);
        req.onsuccess = () => {
          req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    /** This module as a new context loads it (a worker restart, Options): no cached connection. */
    const restarted = async () => {
      vi.resetModules();
      return import('./secure-store');
    };

    it.each([
      ['opened by DevTools first (an empty version 1)', undefined],
      ['already at version 2 with no store', 2],
    ])('%s: repaired, and it opens again after a restart', async (_case, version) => {
      await openByHand(version);

      await secureSet({ [API_KEY]: 'sk-ant-x' });
      expect(await secureGet(API_KEY)).toBe('sk-ant-x');

      const again = await restarted();
      expect(await again.secureGet(API_KEY)).toBe('sk-ant-x');
      await again.secureSet({ [HISTORY_KEY]: [] });
      const third = await restarted();
      expect(await third.secureGet(HISTORY_KEY)).toEqual([]);
    });

    it('a database Duel Lens made opens at its version after a restart too', async () => {
      await secureSet({ [API_KEY]: 'sk-ant-x' });
      expect(await (await restarted()).secureGet(API_KEY)).toBe('sk-ant-x');
    });
  });

  it('answers the defaults when nothing was ever stored', async () => {
    setUp({});
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(await getHistory()).toEqual([]);
  });
});
