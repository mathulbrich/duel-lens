// Messages with components in them, for the pages and the overlay (Preact): a keycap, a link or an icon takes
// its placeholder's place, so each sentence stays whole for the translators (src/shared/i18n.ts).
import { Fragment, type ComponentChildren } from 'preact';
import { t, type MessageKey } from './i18n';

/** A part's stand-in while the message is looked up: private-use characters no translation contains. */
const MARK = /(\d+)/;

/**
 * The key names a sentence mentions, as keycaps: Esc, Enter, Tab, Space, the arrows, and the letter keys B, C, K
 * and S standing alone. Only next to a Latin letter is a name part of a word, so "Escで" (Japanese) still counts.
 */
const KEY_NAME = /((?<![A-Za-zÀ-ɏ'’])(?:Esc|Enter|Tab|Space|[BCKS])(?![A-Za-zÀ-ɏ'’])|[←→↑↓])/;

/** `text` with the keys it names as <kbd>s ("Esc closes a card" → <kbd>Esc</kbd> closes a card). */
export function withKeys(text: string): ComponentChildren[] {
  return text
    .split(KEY_NAME)
    .map((s, i) => (i % 2 ? <kbd key={`k${i}`}>{s}</kbd> : s))
    .filter((s) => s !== '');
}

function fill(key: MessageKey, parts: ComponentChildren[], text: (s: string) => ComponentChildren): ComponentChildren[] {
  const subs = parts.map((p, i) => (typeof p === 'string' || typeof p === 'number' ? String(p) : `${i}`));
  return t(key, ...subs)
    .split(MARK)
    .map((s, i) => (i % 2 ? <Fragment key={`p${i}`}>{parts[Number(s)]}</Fragment> : s === '' ? null : <Fragment key={`t${i}`}>{text(s)}</Fragment>))
    .filter((s) => s !== null);
}

/** The message for `key` with `parts` in its placeholders: strings and numbers as text, anything else (<Keys>, a link) as itself. */
export function tRich(key: MessageKey, ...parts: ComponentChildren[]): ComponentChildren[] {
  return fill(key, parts, (s) => s);
}

/** tRich, with the key names in the message's own words as keycaps (withKeys). */
export function tRichKeys(key: MessageKey, ...parts: ComponentChildren[]): ComponentChildren[] {
  return fill(key, parts, withKeys);
}
