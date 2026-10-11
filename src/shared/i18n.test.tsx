// @vitest-environment happy-dom
// The interface's strings (src/shared/i18n.ts): Chrome's substitution rules, the locale files' key sets, and
// the English catalog against the code.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { render } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { formatMessage, pickLocale, t, UI_LOCALES, uiLang, type MessageEntry, type MessageKey } from './i18n';
import { tRich, withKeys } from './i18n-rich';

const root = path.resolve(__dirname, '../..');
const localesDir = path.join(root, 'extension/_locales');
const read = (locale: string): Record<string, MessageEntry> =>
  JSON.parse(readFileSync(path.join(localesDir, locale, 'messages.json'), 'utf8'));
const en = read('en');

/** The $name$ placeholders a message uses, lower-cased and sorted (Chrome ignores their case). */
const used = (message: string) => [...new Set([...message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1].toLowerCase()))].sort();
/** A key's placeholders: name → content ($1…), names lower-cased. */
const placeholders = (e: MessageEntry) =>
  Object.fromEntries(Object.entries(e.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), p.content]));

describe('t(): chrome.i18n.getMessage, as the tests resolve it', () => {
  it('fills placeholders the way Chrome does: $name$ → its content → the substitution; $$ is a dollar', () => {
    const entry: MessageEntry = { message: '$Who$ owes $$$amount$ ($who$)', placeholders: { who: { content: '$1' }, amount: { content: '$2' } } };
    expect(formatMessage(entry, ['Kaiba', '5'])).toBe('Kaiba owes $5 (Kaiba)');
  });

  it('resolves English from en/messages.json, with numbers as text', () => {
    expect(t('bar_card_count_other', 3)).toBe('3 cards');
    expect(t('popover_announce_match_result', 'Not sure', 'Dark Magician', '')).toBe('Not sure. Closest: Dark Magician.');
  });

  it('is loud about a missing key or a missing substitution in the tests', () => {
    expect(() => t('no_such_key' as MessageKey)).toThrow(/no message "no_such_key"/);
    expect(() => t('bar_card_count_other')).toThrow(/needs substitution \$1/);
    expect(() => formatMessage({ message: 'Hi $name$' }, ['x'])).toThrow(/no placeholder/);
  });

  it("picks the locale Chrome reads messages from: the exact one, its base language, else en", () => {
    expect(pickLocale('de-AT')).toBe('de');
    expect(pickLocale('pt-BR')).toBe('pt_BR');
    expect(pickLocale('pt-PT')).toBe('en');
    expect(pickLocale('zh-CN')).toBe('zh_CN');
    expect(pickLocale('zh-TW')).toBe('en');
    expect(pickLocale('es-419')).toBe('es');
    expect(pickLocale('ja')).toBe('ja');
    expect(pickLocale('nl')).toBe('en');
    expect(uiLang()).toBe('en');
  });
});

describe('tRich() and withKeys(): components inside a whole sentence', () => {
  it('puts a component in its placeholder, keeping the sentence in one message', () => {
    const { container } = render(<p>{tRich('welcome_press_to_scan', <kbd>Alt+Shift+Y</kbd>)}</p>);
    expect(container.innerHTML).toBe('<p>Press <kbd>Alt+Shift+Y</kbd> to scan a card</p>');
  });

  it('shows the key names a sentence mentions as keycaps, in any script around them', () => {
    const { container } = render(<p>{withKeys('Esc closes, ← → show others, C copies; Escで閉じる. Escape, Cards, Kaiba stay text.')}</p>);
    expect([...container.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Esc', '←', '→', 'C', 'Esc']);
  });
});

describe('the locale files (extension/_locales)', () => {
  const locales = readdirSync(localesDir).filter((d) => statSync(path.join(localesDir, d)).isDirectory());

  it('are folders of the locales Duel Lens ships (UI_LOCALES), with en, the default', () => {
    expect(locales).toContain('en');
    for (const l of locales) expect(UI_LOCALES as readonly string[]).toContain(l);
    expect(JSON.parse(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).default_locale).toBe('en');
  });

  it('en: every key has a message and a description, a name Chrome accepts, and placeholders it uses exactly', () => {
    for (const [key, e] of Object.entries(en)) {
      expect(key, key).toMatch(/^[A-Za-z0-9_]+$/);
      expect(e.message, key).toBeTruthy();
      expect(e.description, key).toBeTruthy();
      expect(used(e.message), key).toEqual(Object.keys(placeholders(e)).sort());
    }
  });

  // A translation that is missing is skipped until its translator delivers it; one with the wrong keys fails.
  for (const locale of UI_LOCALES.filter((l) => l !== 'en')) {
    const file = path.join(localesDir, locale, 'messages.json');
    it.skipIf(!existsSync(file))(`${locale}: exactly en's keys, each with en's placeholders, and a message`, () => {
      const messages = read(locale);
      const extra = Object.keys(messages).filter((k) => !(k in en));
      const missing = Object.keys(en).filter((k) => !(k in messages));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      for (const [key, e] of Object.entries(en)) {
        const theirs = messages[key];
        expect(theirs.message, `${locale} ${key}`).toBeTruthy();
        expect(placeholders(theirs), `${locale} ${key}: placeholders`).toEqual(placeholders(e));
        expect(used(theirs.message), `${locale} ${key}: $placeholders$ in the message`).toEqual(used(e.message));
      }
    });
  }

  it("keeps each language's store description within the Web Store's 132 characters", () => {
    for (const locale of locales) {
      const description = read(locale).extDescription?.message ?? '';
      expect(description.length, locale).toBeGreaterThan(0);
      expect(description.length, locale).toBeLessThanOrEqual(132);
    }
  });
});

describe('the English catalog against the code', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === '__measure__' ? [] : sources(full);
      return /\.tsx?$/.test(name) && !/\.test\.|test-fixtures/.test(name) ? [full] : [];
    });
  }
  const code = sources(path.join(root, 'src')).map((f) => readFileSync(f, 'utf8'));
  code.push(readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  const all = code.join('\n');

  it('has no unused key: each one appears in the code as a literal, or in the manifest as __MSG_key__', () => {
    const unused = Object.keys(en).filter((key) => !all.includes(`'${key}'`) && !all.includes(`"${key}"`) && !all.includes(`__MSG_${key}__`));
    expect(unused).toEqual([]);
  });

  it('has every key the code asks for', () => {
    const asked = [...all.matchAll(/\b(?:t|tRich|tRichKeys)\(\s*'([A-Za-z0-9_]+)'/g), ...all.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map((m) => m[1]);
    expect(asked.length).toBeGreaterThan(300);
    expect(asked.filter((key) => !(key in en))).toEqual([]);
  });
});
