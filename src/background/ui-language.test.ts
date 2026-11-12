// The service worker's interface language (ui-language.ts): its own words follow the setting, and it hands the
// same words to the page's script.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUiMessages, t } from '../shared/i18n';
import { loadWorkerUiLanguage, workerUiSettled, workerUiWords } from './ui-language';

const localesDir = path.resolve(__dirname, '../../extension/_locales');
const diskFetch = (async (url: string) => {
  const locale = /_locales\/([^/]+)\//.exec(url)![1];
  return new Response(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'), { status: 200 });
}) as unknown as typeof fetch;
const fr = JSON.parse(readFileSync(path.join(localesDir, 'fr', 'messages.json'), 'utf8')) as Record<string, { message: string }>;

afterEach(() => {
  setUiMessages(null);
  vi.unstubAllGlobals();
});

describe('the worker’s interface language', () => {
  it('speaks the chosen language (its menu, its titles) and gives the page’s script the same words; auto goes back', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://id/${p}` } });
    await loadWorkerUiLanguage('fr', diskFetch);
    expect(t('menu_find_card')).toBe(fr.menu_find_card.message);
    expect((await workerUiWords())?.locale).toBe('fr');
    await loadWorkerUiLanguage('auto', diskFetch);
    expect(await workerUiWords()).toBeNull();
    expect(t('menu_find_card')).not.toBe(fr.menu_find_card.message);
  });

  it('answers the page’s script only once the latest load is in', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://id/${p}` } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (url: string) => {
      await gate;
      return diskFetch(url);
    }) as unknown as typeof fetch;
    void loadWorkerUiLanguage('it', slow);
    let answered = false;
    const words = workerUiWords().then((w) => ((answered = true), w));
    await Promise.resolve();
    expect(answered).toBe(false);
    release();
    expect((await words)?.locale).toBe('it');
  });

  it('keeps the latest choice when an older load finishes after it (a quick German, then French)', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://id/${p}` } });
    let releaseGerman!: () => void;
    const german = new Promise<void>((r) => (releaseGerman = r));
    const slowGerman = (async (url: string) => {
      await german;
      return diskFetch(url);
    }) as unknown as typeof fetch;
    const first = loadWorkerUiLanguage('de', slowGerman);
    expect(workerUiSettled()).toBe(false);
    await loadWorkerUiLanguage('fr', diskFetch);
    releaseGerman();
    await first;
    expect((await workerUiWords())?.locale).toBe('fr');
    expect(t('menu_find_card')).toBe(fr.menu_find_card.message);
    expect(workerUiSettled()).toBe(true);
  });

  it('is not ready while the settings are still being read at the worker’s start (the choice as a promise)', async () => {
    vi.stubGlobal('chrome', { runtime: { getURL: (p: string) => `chrome-extension://id/${p}` } });
    let give!: (c: string) => void;
    void loadWorkerUiLanguage(new Promise<string>((r) => (give = r)), diskFetch);
    expect(workerUiSettled()).toBe(false);
    const words = workerUiWords();
    give('fr');
    expect((await words)?.locale).toBe('fr');
    // A settings read that fails is the browser's language.
    await loadWorkerUiLanguage(Promise.reject(new Error('no storage')), diskFetch);
    expect(await workerUiWords()).toBeNull();
  });
});
