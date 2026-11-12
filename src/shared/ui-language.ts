// "Interface language" (Options; Settings.display.uiLanguage): Duel Lens's own words in a language the user picks,
// whatever the browser's. chrome.i18n can only speak the browser's, so the chosen language's catalog is read here
// (extension/_locales/<locale>/messages.json) and handed to i18n.ts's setUiMessages; 'auto' leaves Chrome's.
// - Extension pages (Options, side panel, popup, welcome) read the setting and the catalog themselves before their
//   app loads (initPageUiLanguage), and reload when the setting changes: every word they show follows at once.
// - The service worker loads it at start and on a change (background/ui-language.ts), and gives it to the page's
//   script, which can read neither chrome.storage nor the extension's files (live-check-state, ui-language).
// Card names and text follow "Card text language" instead; the extension's name in the browser's own menus and its
// shortcuts page always follow the browser.
import { setUiMessages, UI_LOCALES, type MessageEntry, type UiLocale, type UiWords } from './i18n';

export type UiLanguage = 'auto' | UiLocale;

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === 'auto' || (UI_LOCALES as readonly unknown[]).includes(value);
}

/** Each language by its own name, as a speaker looks for it in the list (Options' select). */
export const UI_LANGUAGE_NAMES: Record<UiLocale, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  pt_BR: 'Português (Brasil)',
  zh_CN: '简体中文',
};

type RawCatalog = Record<string, MessageEntry & { description?: string }>;

/** `own` over English, each entry kept to what t() reads (the message and its placeholders): a key `own` lacks reads in English. */
export function mergeCatalogs(own: RawCatalog, english: RawCatalog): Record<string, MessageEntry> {
  const out: Record<string, MessageEntry> = {};
  for (const [key, e] of [...Object.entries(english), ...Object.entries(own)]) {
    if (!e || typeof e.message !== 'string') continue;
    out[key] = e.placeholders ? { message: e.message, placeholders: e.placeholders } : { message: e.message };
  }
  return out;
}

async function readCatalog(locale: UiLocale, fetcher: typeof fetch): Promise<RawCatalog> {
  const res = await fetcher(chrome.runtime.getURL(`_locales/${locale}/messages.json`));
  if (!res.ok) throw new Error(`Duel Lens: no ${locale} catalog (${res.status})`);
  return (await res.json()) as RawCatalog;
}

/** The words for `choice`, or null for 'auto' (Chrome's language) or a catalog that can't be read. */
export async function loadUiWords(choice: unknown, fetcher: typeof fetch = fetch): Promise<UiWords | null> {
  if (!isUiLanguage(choice) || choice === 'auto') return null;
  try {
    const [own, english] = await Promise.all([readCatalog(choice, fetcher), choice === 'en' ? null : readCatalog('en', fetcher)]);
    return { locale: choice, messages: mergeCatalogs(own, english ?? {}) };
  } catch (err) {
    console.error('Duel Lens: could not load the interface language; the browser’s is used', err);
    return null;
  }
}

/** The setting as chrome.storage.local holds it (extension pages only: a page's script can't read it). */
export async function storedUiLanguage(): Promise<UiLanguage> {
  try {
    const stored = (await chrome.storage.local.get('settings')).settings as { display?: { uiLanguage?: unknown } } | undefined;
    return isUiLanguage(stored?.display?.uiLanguage) ? stored.display.uiLanguage : 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * An extension page's first step, before its app's modules load (some build their words when they load): speak the
 * chosen language, and reload the page when Options changes it, so every word on it follows. A change made while the
 * words load (another open page) is caught: they load again for it.
 */
export async function initPageUiLanguage(reload: () => void = () => location.reload()): Promise<void> {
  let settled: UiLanguage | null = null;
  let changed = false;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.settings) return;
      const raw = (changes.settings.newValue as { display?: { uiLanguage?: unknown } } | undefined)?.display?.uiLanguage;
      const next = isUiLanguage(raw) ? raw : 'auto';
      if (settled === null) changed = true;
      else if (next !== settled) reload();
    });
  } catch {
    // No chrome.storage here: nothing to follow.
  }
  for (;;) {
    changed = false;
    const choice = await storedUiLanguage();
    const words = await loadUiWords(choice);
    if (changed) continue;
    setUiMessages(words);
    settled = choice;
    return;
  }
}
