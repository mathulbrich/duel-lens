// "Interface language" (shared/ui-language.ts, i18n.ts setUiMessages): Duel Lens's words in the language Options picks,
// whatever the browser's (the user's ask: Portuguese or English without changing the card text).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserLocale, setUiMessages, t, UI_LOCALES, uiLang, type MessageEntry, type UiWords } from './i18n';
import { initPageUiLanguage, isUiLanguage, loadUiWords, mergeCatalogs, storedUiLanguage, UI_LANGUAGE_NAMES } from './ui-language';

const localesDir = path.resolve(__dirname, '../../extension/_locales');
const read = (locale: string): Record<string, MessageEntry & { description?: string }> =>
  JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));

/** fetch over the real catalogs on disk, as chrome.runtime.getURL names them. */
const diskFetch = vi.fn(async (url: string) => {
  const locale = /_locales\/([^/]+)\/messages\.json$/.exec(url)?.[1];
  try {
    return new Response(readFileSync(path.join(localesDir, locale ?? 'none', 'messages.json'), 'utf8'), { status: 200 });
  } catch {
    return new Response('', { status: 404 });
  }
}) as unknown as typeof fetch;

function stubChrome(stored: unknown, ui = 'en-US') {
  const listeners: Array<(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void> = [];
  vi.stubGlobal('chrome', {
    runtime: { getURL: (p: string) => `chrome-extension://id/${p}` },
    i18n: { getUILanguage: () => ui },
    storage: { local: { get: async () => ({ settings: stored }) }, onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) } },
  });
  return listeners;
}

afterEach(() => {
  setUiMessages(null);
  vi.unstubAllGlobals();
  vi.mocked(diskFetch).mockClear();
});

describe('t() in a chosen language (setUiMessages)', () => {
  it("speaks the chosen catalog, reads a key it lacks in English, and names its language for lang and Intl", async () => {
    stubChrome(undefined);
    const words = (await loadUiWords('pt_BR', diskFetch))!;
    setUiMessages(words);
    expect(t('options_card_language_title')).toBe(read('pt_BR').options_card_language_title.message);
    expect(t('bar_card_count_other', 3)).toBe(read('pt_BR').bar_card_count_other.message.replace(/\$\w+\$/, '3'));
    expect(uiLang()).toBe('pt-BR');
    setUiMessages({ locale: 'de', messages: { options_section_banlist: { message: 'Verbotsliste' } } });
    expect(t('options_section_banlist')).toBe('Verbotsliste');
    expect(t('options_card_language_title')).toBe('Card text language'); // not in this catalog: English
    setUiMessages(null);
    expect(t('options_section_banlist')).toBe('Banlist');
    expect(uiLang()).toBe('en');
  });

  it('refuses words for a language it does not ship, or without messages', () => {
    setUiMessages({ locale: 'xx', messages: { options_section_banlist: { message: 'Nope' } } } as unknown as UiWords);
    expect(t('options_section_banlist')).toBe('Banlist');
    setUiMessages({ locale: 'de', messages: null } as unknown as UiWords);
    expect(t('options_section_banlist')).toBe('Banlist');
  });

  it('a broken translation (a placeholder it does not define) falls back instead of throwing', () => {
    setUiMessages({ locale: 'de', messages: { bar_card_count_other: { message: '$count$ Karten' } } });
    expect(t('bar_card_count_other', 3)).toBe('3 cards');
  });
});

describe('the setting and its catalogs', () => {
  it("knows 'auto' and the nine languages Duel Lens ships, each by its own name", () => {
    expect(UI_LOCALES.every(isUiLanguage)).toBe(true);
    expect(isUiLanguage('auto')).toBe(true);
    for (const bad of ['pt', 'zh', 'xx', '', null, 3]) expect(isUiLanguage(bad)).toBe(false);
    expect(Object.keys(UI_LANGUAGE_NAMES).sort()).toEqual([...UI_LOCALES].sort());
    expect(UI_LANGUAGE_NAMES.pt_BR).toBe('Português (Brasil)');
  });

  it('merges a catalog over English and keeps only what t() reads', () => {
    const merged = mergeCatalogs(
      { a: { message: 'A-de', description: 'note' } },
      { a: { message: 'A' }, b: { message: 'B $x$', placeholders: { x: { content: '$1' } }, description: 'note' } },
    );
    expect(merged).toEqual({ a: { message: 'A-de' }, b: { message: 'B $x$', placeholders: { x: { content: '$1' } } } });
  });

  it("loads nothing for 'auto' or an unknown value: the browser's language stays", async () => {
    expect(await loadUiWords('auto', diskFetch)).toBeNull();
    expect(await loadUiWords('xx', diskFetch)).toBeNull();
    expect(diskFetch).not.toHaveBeenCalled();
  });

  it('loads every shipped language from the extension, with every English key, and English alone for en', async () => {
    stubChrome(undefined);
    const enKeys = Object.keys(read('en')).sort();
    for (const locale of UI_LOCALES) {
      const words = await loadUiWords(locale, diskFetch);
      expect(words?.locale).toBe(locale);
      expect(Object.keys(words!.messages).sort()).toEqual(enKeys);
    }
    vi.mocked(diskFetch).mockClear();
    await loadUiWords('en', diskFetch);
    expect(vi.mocked(diskFetch).mock.calls.map(([u]) => u)).toEqual(['chrome-extension://id/_locales/en/messages.json']);
  });

  it("a catalog that can't be read gives the browser's language, not an error", async () => {
    stubChrome(undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await loadUiWords('de', (async () => new Response('', { status: 404 })) as unknown as typeof fetch)).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("reads the stored choice, and 'auto' for none or a damaged one", async () => {
    stubChrome({ display: { uiLanguage: 'ko' } });
    expect(await storedUiLanguage()).toBe('ko');
    stubChrome({ display: { uiLanguage: 'klingon' } });
    expect(await storedUiLanguage()).toBe('auto');
    stubChrome(undefined);
    expect(await storedUiLanguage()).toBe('auto');
  });

  it("names the browser's own language as one of Duel Lens's (the default option says it)", () => {
    stubChrome(undefined, 'pt-BR');
    expect(browserLocale()).toBe('pt_BR');
    stubChrome(undefined, 'de-AT');
    expect(browserLocale()).toBe('de');
    stubChrome(undefined, 'tr');
    expect(browserLocale()).toBe('en');
  });
});

describe('an extension page (initPageUiLanguage)', () => {
  it('speaks the stored language before its app loads, and reloads only when the choice changes', async () => {
    const listeners = stubChrome({ display: { uiLanguage: 'de' } });
    vi.stubGlobal('fetch', diskFetch);
    const reload = vi.fn();
    await initPageUiLanguage(reload);
    expect(t('options_section_banlist')).toBe(read('de').options_section_banlist.message);
    expect(uiLang()).toBe('de');
    const change = (uiLanguage: unknown) => listeners.forEach((l) => l({ settings: { newValue: { display: { uiLanguage } } } }, 'local'));
    change('de'); // another setting changed: same language
    expect(reload).not.toHaveBeenCalled();
    change('ja');
    expect(reload).toHaveBeenCalledTimes(1);
    listeners.forEach((l) => l({ settings: { newValue: { display: { uiLanguage: 'auto' } } } }, 'sync'));
    expect(reload).toHaveBeenCalledTimes(1); // not chrome.storage.local
  });

  it('loads again for a change made while its words were loading (another open page)', async () => {
    let stored: unknown = { display: { uiLanguage: 'de' } };
    const listeners: Array<(c: Record<string, { newValue?: unknown }>, a: string) => void> = [];
    vi.stubGlobal('chrome', {
      runtime: { getURL: (p: string) => `chrome-extension://id/${p}` },
      storage: { local: { get: async () => ({ settings: stored }) }, onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l) } },
    });
    let first = true;
    vi.stubGlobal('fetch', (async (url: string) => {
      if (first) {
        first = false;
        stored = { display: { uiLanguage: 'ja' } };
        listeners.forEach((l) => l({ settings: { newValue: stored } }, 'local'));
      }
      return diskFetch(url);
    }) as unknown as typeof fetch);
    const reload = vi.fn();
    await initPageUiLanguage(reload);
    expect(uiLang()).toBe('ja');
    expect(reload).not.toHaveBeenCalled();
  });
});
