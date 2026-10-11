import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { getSettings, isBanlistMode, isCardLanguage, isRevealMode, setSettings } from './settings';

function fakeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

/** Puts `value` in storage as the stored settings object, as an older (or newer) version may have left it. */
const store = (value: unknown) => chrome.storage.local.set({ settings: value });

beforeEach(() => {
  vi.stubGlobal('chrome', { storage: { local: fakeStorageArea() } });
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
      display: { reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' },
    });
  });
});

// "Show card details" (Options): how a card's details show in scan mode. The content script gets it with
// begin-selection (scan.ts), so what is stored must always be a mode this version knows.
describe('display.reveal', () => {
  it("is 'hover' (Hover or click) by default", async () => {
    expect((await getSettings()).display).toEqual({ reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' });
  });

  it("gives settings stored by an older version (no display) the default, keeping the rest", async () => {
    await store({ ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' }, debug: { saveCrops: true } });

    expect(await getSettings()).toEqual({
      ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' },
      debug: { saveCrops: true },
      display: { reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' },
    });
  });

  it("keeps a stored 'click'", async () => {
    await store({ display: { reveal: 'click' } });
    expect((await getSettings()).display.reveal).toBe('click');
  });

  it.each([['always'], ['Hover'], [''], [42], [null], [true], [{ mode: 'click' }]])(
    "reads an unknown stored mode (%j) as 'hover'",
    async (reveal) => {
      await store({ display: { reveal } });
      expect((await getSettings()).display.reveal).toBe('hover');
    },
  );

  it("reads a stored display without a mode as 'hover'", async () => {
    await store({ display: {} });
    expect((await getSettings()).display).toEqual({ reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' });
  });

  it('saves a change of mode alone, and a later change elsewhere keeps it', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' } });
    await setSettings({ display: { reveal: 'click' } });
    await setSettings({ debug: { saveCrops: true } });

    expect(await getSettings()).toEqual({
      ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' },
      debug: { saveCrops: true },
      display: { reveal: 'click', banlist: 'tcg', cardLanguage: 'en' },
    });
  });

  it("never stores an unknown mode: setSettings saves (and answers) 'hover' instead", async () => {
    await setSettings({ display: { reveal: 'click' } });
    const answer = await setSettings({ display: { reveal: 'always' as Settings['display']['reveal'] } });

    expect(answer.display.reveal).toBe('hover');
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ display: { reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });

  it('a later write repairs an unknown stored mode', async () => {
    await store({ display: { reveal: 'always' } });
    await setSettings({ debug: { saveCrops: true } });

    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      settings: expect.objectContaining({ display: { reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });
});

describe('isRevealMode', () => {
  it("accepts only 'hover' and 'click'", () => {
    expect(['hover', 'click'].filter(isRevealMode)).toEqual(['hover', 'click']);
    for (const v of ['always', 'HOVER', '', undefined, null, 1, {}]) expect(isRevealMode(v)).toBe(false);
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
      settings: expect.objectContaining({ display: { reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' } }),
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
      settings: expect.objectContaining({ display: { reveal: 'hover', banlist: 'tcg', cardLanguage: 'en' } }),
    });
  });

  it('saves a change of language alone, keeping the other display settings', async () => {
    await setSettings({ display: { reveal: 'click', banlist: 'ocg' } });
    const answer = await setSettings({ display: { cardLanguage: 'ja' } });
    expect(answer.display).toEqual({ reveal: 'click', banlist: 'ocg', cardLanguage: 'ja' });
  });
});

describe('isCardLanguage', () => {
  it('accepts only the offered codes', () => {
    expect(['en', 'fr', 'de', 'it', 'pt', 'ja', 'ko'].every(isCardLanguage)).toBe(true);
    expect([undefined, 'es', 'zh', 'ja-JP', 'EN', 1].some(isCardLanguage)).toBe(false);
  });
});
