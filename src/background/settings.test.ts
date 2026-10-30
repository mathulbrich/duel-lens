import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { API_KEY, secureGet, secureSet } from './secure-store';
import { getSettings, isBanlistMode, isCardLanguage, isRevealMode, setSettings } from './settings';

function fakeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

/** Puts `value` in storage as the stored settings object, as an older (or newer) version may have left it. */
const store = (value: unknown) => chrome.storage.local.set({ settings: value });

beforeEach(() => {
  // The API key's own store (secure-store.ts), fresh for each test.
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  vi.stubGlobal('chrome', { storage: { local: fakeStorageArea() } });
});

/** Everything chrome.storage.local holds, as text: what a content script could read there in Firefox. */
const localText = async () => JSON.stringify(await chrome.storage.local.get(null));

// Decision D-FF2: the key lives in the private IndexedDB store, which the scripts Duel Lens runs on web pages
// can't open in any browser; the other settings, none of them secret, stay in chrome.storage.local.
describe('the API key', () => {
  it('is saved to the private store only: chrome.storage.local keeps the other settings, without it', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'sk-ant-new', model: 'claude-opus-5' }, display: { banlist: 'ocg' } });

    expect(await secureGet(API_KEY)).toBe('sk-ant-new');
    expect(await chrome.storage.local.get('settings')).toEqual({
      settings: { ...DEFAULT_SETTINGS, ai: { enabled: true, model: 'claude-opus-5' }, display: { ...DEFAULT_SETTINGS.display, banlist: 'ocg' } },
    });
    expect(await localText()).not.toContain('sk-ant-new');
    expect((await getSettings()).ai).toEqual({ enabled: true, apiKey: 'sk-ant-new', model: 'claude-opus-5' });
  });

  it('is kept by a change of anything else', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'sk-ant-new', model: 'claude-opus-5' } });
    await setSettings({ display: { reveal: 'click' } });
    await setSettings({ ai: { enabled: false } });
    expect((await getSettings()).ai).toEqual({ enabled: false, apiKey: 'sk-ant-new', model: 'claude-opus-5' });
  });

  it('is deleted by an empty key field', async () => {
    await setSettings({ ai: { apiKey: 'sk-ant-new' } });
    await setSettings({ ai: { apiKey: '' } });
    expect(await secureGet(API_KEY)).toBe('');
    expect((await getSettings()).ai.apiKey).toBe('');
  });

  it("reads 0.9.2's copy in chrome.storage.local until it has been moved, and any write moves it", async () => {
    await store({ ai: { enabled: true, apiKey: 'sk-ant-old', model: 'claude-opus-5' } });
    expect((await getSettings()).ai.apiKey).toBe('sk-ant-old');

    await setSettings({ display: { reveal: 'click' } });

    expect(await secureGet(API_KEY)).toBe('sk-ant-old');
    expect(await localText()).not.toContain('sk-ant-old');
    expect((await getSettings()).ai).toEqual({ enabled: true, apiKey: 'sk-ant-old', model: 'claude-opus-5' });
  });

  it("prefers the private store's key to a copy left in chrome.storage.local", async () => {
    await secureSet({ [API_KEY]: 'sk-ant-newer' });
    await store({ ai: { enabled: true, apiKey: 'sk-ant-old', model: 'claude-opus-5' } });
    expect((await getSettings()).ai.apiKey).toBe('sk-ant-newer');
  });

  it("saves the key before removing chrome.storage.local's copy: a failed save leaves that copy", async () => {
    await store({ ai: { enabled: true, apiKey: 'sk-ant-old', model: 'claude-opus-5' } });
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('IndexedDB is unavailable'); } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setSettings({ ai: { apiKey: 'sk-ant-new' } })).rejects.toThrow('IndexedDB is unavailable');

    expect(await localText()).toContain('sk-ant-old');
    error.mockRestore();
  });

  it("still answers the other settings when the private store can't be read, and says so as an error", async () => {
    await store({ ai: { enabled: true, model: 'claude-opus-5' }, display: { reveal: 'click' } });
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('IndexedDB is unavailable'); } });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, ai: { enabled: true, apiKey: '', model: 'claude-opus-5' }, display: { ...DEFAULT_SETTINGS.display, reveal: 'click' } });
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not read the API key/), expect.anything());
    error.mockRestore();
  });
});

describe('getSettings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in missing fields of a partially-stored settings object', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'sk-123', model: DEFAULT_SETTINGS.ai.model } });
    const settings = await getSettings();
    expect(settings.ai).toEqual({ enabled: true, apiKey: 'sk-123', model: DEFAULT_SETTINGS.ai.model });
    expect(settings.debug).toEqual(DEFAULT_SETTINGS.debug);
  });
});

describe('setSettings', () => {
  it('merges a partial patch onto the current settings and persists it', async () => {
    await setSettings({ debug: { saveCrops: true } });
    await setSettings({ ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' } });
    const settings = await getSettings();
    expect(settings).toEqual({
      ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' },
      debug: { saveCrops: true },
      display: { reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' },
      corrections: { save: true },
      updates: { check: true },
    });
  });
});

// "Show card details" (Options): how a card's details show in scan mode. The content script gets it with
// begin-selection (scan.ts), so what is stored must always be a mode this version knows.
// "Tell me when a new version is out" (Options, a copy installed by hand only): on unless turned off.
describe('updates.check', () => {
  it('is on by default, also for settings stored before it existed, and saves a change', async () => {
    await store({ ai: { enabled: false, model: 'claude-opus-5' } });
    expect((await getSettings()).updates).toEqual({ check: true });
    await setSettings({ updates: { check: false } });
    expect((await getSettings()).updates).toEqual({ check: false });
  });
});

describe('display.reveal', () => {
  it("is 'preview' (Quick preview on hover) by default", async () => {
    expect((await getSettings()).display).toEqual({ reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' });
  });

  it("gives settings stored by an older version (no display) the default, keeping the rest", async () => {
    await store({ ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' }, debug: { saveCrops: true } });

    expect(await getSettings()).toEqual({
      ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' },
      debug: { saveCrops: true },
      display: { reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' },
      corrections: { save: true },
      updates: { check: true },
    });
  });

  it("reads 0.9.3's 'hover' (its quick preview) as 'preview'", async () => {
    await store({ display: { reveal: 'hover' } });
    expect((await getSettings()).display.reveal).toBe('preview');
  });

  it("keeps a stored 'full'", async () => {
    await store({ display: { reveal: 'full' } });
    expect((await getSettings()).display.reveal).toBe('full');
  });

  it("keeps a stored 'click'", async () => {
    await store({ display: { reveal: 'click' } });
    expect((await getSettings()).display.reveal).toBe('click');
  });

  it.each([['always'], ['Hover'], [''], [42], [null], [true], [{ mode: 'click' }]])(
    "reads an unknown stored mode (%j) as 'preview'",
    async (reveal) => {
      await store({ display: { reveal } });
      expect((await getSettings()).display.reveal).toBe('preview');
    },
  );

  it("reads a stored display without a mode as 'preview'", async () => {
    await store({ display: {} });
    expect((await getSettings()).display).toEqual({ reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' });
  });

  it('saves a change of mode alone, and a later change elsewhere keeps it', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' } });
    await setSettings({ display: { reveal: 'click' } });
    await setSettings({ debug: { saveCrops: true } });

    expect(await getSettings()).toEqual({
      ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' },
      debug: { saveCrops: true },
      display: { reveal: 'click', banlist: 'tcg', cardLanguage: 'en' },
      corrections: { save: true },
      updates: { check: true },
    });
  });

  it("never stores an unknown mode: setSettings saves (and answers) 'hover' instead", async () => {
    await setSettings({ display: { reveal: 'click' } });
    const answer = await setSettings({ display: { reveal: 'always' as Settings['display']['reveal'] } });

    expect(answer.display.reveal).toBe('preview');
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ display: { reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });

  it('a later write repairs an unknown stored mode', async () => {
    await store({ display: { reveal: 'always' } });
    await setSettings({ debug: { saveCrops: true } });

    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ display: { reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });
});

describe('isRevealMode', () => {
  it("accepts only 'full', 'preview' and 'click'", () => {
    expect(['full', 'preview', 'click', 'hover'].filter(isRevealMode)).toEqual(['full', 'preview', 'click']);
    for (const v of ['always', 'FULL', '', undefined, null, 1, {}]) expect(isRevealMode(v)).toBe(false);
  });
});

// "Banlist" (Options): which list the card chip shows. The content script gets it with begin-selection
// (scan.ts), so what is stored must always be a mode this version knows; the side panel reads it itself.
describe('display.banlist', () => {
  it("is 'tcg' (the default) when nothing is stored", async () => {
    expect((await getSettings()).display.banlist).toBe('tcg');
  });

  it("keeps a stored 'ocg'", async () => {
    await store({ display: { banlist: 'ocg' } });
    expect((await getSettings()).display.banlist).toBe('ocg');
  });

  it.each([['always'], ['OCG'], [''], [42], [null], [true], [{ mode: 'ocg' }]])(
    "reads an unknown stored banlist (%j) as 'tcg'",
    async (banlist) => {
      await store({ display: { banlist } });
      expect((await getSettings()).display.banlist).toBe('tcg');
    },
  );

  it('saves a change of banlist alone, keeping reveal as it is', async () => {
    await setSettings({ display: { reveal: 'click' } });
    const answer = await setSettings({ display: { banlist: 'ocg' } });

    expect(answer.display).toEqual({ reveal: 'click', banlist: 'ocg', cardLanguage: 'en' });
    expect(await getSettings()).toEqual({ ...DEFAULT_SETTINGS, display: { reveal: 'click', banlist: 'ocg', cardLanguage: 'en' } });
  });

  it("never stores an unknown banlist: setSettings saves (and answers) 'tcg' instead", async () => {
    await setSettings({ display: { banlist: 'ocg' } });
    const answer = await setSettings({ display: { banlist: 'always' as Settings['display']['banlist'] } });

    expect(answer.display.banlist).toBe('tcg');
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ display: { reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });
});

describe('isBanlistMode', () => {
  it("accepts only 'tcg' and 'ocg'", () => {
    expect(['tcg', 'ocg'].filter(isBanlistMode)).toEqual(['tcg', 'ocg']);
    for (const v of ['always', 'TCG', '', undefined, null, 1, {}]) expect(isBanlistMode(v)).toBe(false);
  });
});

describe('display.cardLanguage (TEXT-LANG)', () => {
  it("is 'en' (the bundled English) by default, and for settings stored before it existed", async () => {
    expect((await getSettings()).display.cardLanguage).toBe('en');
    await store({ display: { reveal: 'click', banlist: 'ocg' } });
    expect((await getSettings()).display).toEqual({ reveal: 'click', banlist: 'ocg', cardLanguage: 'en' });
  });

  it('keeps every language this version offers', async () => {
    for (const lang of ['en', 'fr', 'de', 'it', 'pt', 'ja', 'ko'] as const) {
      await store({ display: { cardLanguage: lang } });
      expect((await getSettings()).display.cardLanguage).toBe(lang);
    }
  });

  it("reads a language it doesn't offer (Spanish, Chinese, a damaged value) as 'en', and never stores one", async () => {
    for (const bad of ['es', 'zh', 'zh-CN', 'FR', '', 42, null, { lang: 'fr' }]) {
      await store({ display: { cardLanguage: bad } });
      expect((await getSettings()).display.cardLanguage).toBe('en');
    }
    const answer = await setSettings({ display: { cardLanguage: 'es' as Settings['display']['cardLanguage'] } });
    expect(answer.display.cardLanguage).toBe('en');
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ display: { reveal: 'preview', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });

  it('saves a change of language alone, keeping the other display settings', async () => {
    await setSettings({ display: { reveal: 'click', banlist: 'ocg' } });
    const answer = await setSettings({ display: { cardLanguage: 'ja' } });
    expect(answer.display).toEqual({ reveal: 'click', banlist: 'ocg', cardLanguage: 'ja' });
  });
});

// "Save my corrections" (Options, "Wrong card?"): default true, local only.
describe('corrections.save', () => {
  it('is true by default', async () => {
    expect((await getSettings()).corrections).toEqual({ save: true });
  });

  it('keeps a stored false, and a later change elsewhere leaves it alone', async () => {
    await setSettings({ corrections: { save: false } });
    await setSettings({ debug: { saveCrops: true } });
    expect((await getSettings()).corrections).toEqual({ save: false });
  });

  it("gives settings stored by an older version (no corrections) the default", async () => {
    await store({ ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' } });
    expect((await getSettings()).corrections).toEqual({ save: true });
  });
});

describe('isCardLanguage', () => {
  it('accepts only the offered codes', () => {
    expect(['en', 'fr', 'de', 'it', 'pt', 'ja', 'ko'].every(isCardLanguage)).toBe(true);
    expect([undefined, 'es', 'zh', 'ja-JP', 'EN', 1].some(isCardLanguage)).toBe(false);
  });
});
