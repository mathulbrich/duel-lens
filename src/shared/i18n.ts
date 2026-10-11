// The interface's words in Chrome's language: chrome.i18n over extension/_locales/<locale>/messages.json.
// English (en) is the default locale and the source; docs/DEVELOPMENT.md, "Adding a string", says how to add one.
// Works the same in the content script, the extension pages, the offscreen document and the service worker.
// - In the extension: Chrome picks the locale (its UI language, else en). A key with no message shows as the
//   key itself, never as a blank, and is logged once.
// - In the tests (vitest; test/setup-i18n.ts): keys resolve from en/messages.json with Chrome's own rules, and a
//   missing key or substitution throws, so a typo fails the test instead of showing up in the page.
// Card data (names, text, types, attributes from YGOPRODeck) and the legal pages stay in English: they never
// go through here.
import type EN from '../../extension/_locales/en/messages.json';

/** Every message key: the English catalog's (a key missing from it fails the type check). */
export type MessageKey = keyof typeof EN;

/** One entry of a messages.json. */
export interface MessageEntry {
  message: string;
  description?: string;
  placeholders?: Record<string, { content: string; example?: string }>;
}

/**
 * The locales Duel Lens ships, as extension/_locales names them (i18n.test.ts checks the folder against this).
 * uiLang() needs the list: chrome.i18n says which language Chrome runs in, not which of ours it picked.
 */
export const UI_LOCALES = ['en', 'de', 'es', 'fr', 'it', 'ja', 'ko', 'pt_BR', 'zh_CN'] as const;

/** Where the tests put the English catalog (test/setup-i18n.ts). Never set in the extension. */
const TEST_MESSAGES = Symbol.for('duel-lens.i18n.test-messages');

function testMessages(): Record<string, MessageEntry> | undefined {
  return (globalThis as Record<symbol, Record<string, MessageEntry> | undefined>)[TEST_MESSAGES];
}

/** The tests' catalog (test/setup-i18n.ts): t() then resolves from it and throws on a missing key. */
export function useTestMessages(messages: Record<string, MessageEntry> | undefined): void {
  (globalThis as Record<symbol, unknown>)[TEST_MESSAGES] = messages;
}

/**
 * A message with its substitutions, the way chrome.i18n.getMessage builds it: each $name$ placeholder takes its
 * content (usually $1 to $9), then $1 to $9 take the substitutions, and $$ is a dollar sign. Throws when the
 * message names a placeholder it doesn't define, or needs a substitution it didn't get.
 */
export function formatMessage(entry: MessageEntry, subs: readonly string[], key = 'message'): string {
  const contents = new Map(Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), p.content]));
  const placed = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (_, name: string) => {
    const content = contents.get(name.toLowerCase());
    if (content === undefined) throw new Error(`i18n: ${key} uses $${name}$, which has no placeholder`);
    return content;
  });
  return placed.replace(/\$(\$|[1-9])/g, (_, d: string) => {
    if (d === '$') return '$';
    const value = subs[Number(d) - 1];
    if (value === undefined) throw new Error(`i18n: ${key} needs substitution $${d} but got ${subs.length}`);
    return value;
  });
}

const warned = new Set<string>();

/**
 * The message for `key` in the interface's language, with `subs` in its placeholders ($1 is the first).
 * Plurals are two keys (`…_one`, `…_other`) the caller picks between, so every key stays a literal in the code.
 */
export function t(key: MessageKey, ...subs: Array<string | number>): string {
  const args = subs.map(String);
  const table = testMessages();
  if (table) {
    const entry = table[key];
    if (!entry) throw new Error(`i18n: no message "${key}" in extension/_locales/en/messages.json`);
    return formatMessage(entry, args, key);
  }
  let text = '';
  try {
    text = chrome.i18n.getMessage(key, args);
  } catch {
    // No chrome.i18n here: the key stands in.
  }
  if (text) return text;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`Duel Lens: no message for "${key}"`);
  }
  return key;
}

/**
 * Which of `available` Chrome reads messages from for its UI language `ui` ("de-AT", "pt-BR"): the exact
 * locale, else its base language, else the default, en.
 */
export function pickLocale(ui: string, available: readonly string[] = UI_LOCALES): string {
  const [base = '', region] = ui.replace('-', '_').split('_');
  const exact = region ? `${base.toLowerCase()}_${region.toUpperCase()}` : base.toLowerCase();
  return available.find((l) => l === exact) ?? available.find((l) => l === base.toLowerCase()) ?? 'en';
}

/**
 * The interface's language as a BCP 47 tag ("en", "de", "pt-BR"), for `lang` attributes and for formatting
 * dates and numbers (Intl). English in the tests.
 */
export function uiLang(): string {
  if (testMessages()) return 'en';
  let ui = 'en';
  try {
    ui = chrome.i18n.getUILanguage() || 'en';
  } catch {
    // No chrome.i18n here: English.
  }
  return pickLocale(ui).replace('_', '-');
}

/** A number as the interface's language writes it ("14,117", "14.117"). */
export const formatNumber = (n: number): string => n.toLocaleString(uiLang());

/** A date as the interface's language writes it, `dateStyle` "medium" unless said otherwise. */
export const formatDate = (at: number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string =>
  new Date(at).toLocaleDateString(uiLang(), options);
