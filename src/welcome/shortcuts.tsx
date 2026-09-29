// Keyboard shortcuts as Chrome has them right now, shown as keycaps on Duel Lens's pages. The
// user can change them (or another extension can take one first) at chrome://extensions/shortcuts,
// so the pages read them from chrome.commands instead of repeating the manifest's defaults.
import type { ComponentChildren } from 'preact';
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';

export interface Command {
  name: string;
  description: string;
  /** '' when the command has no shortcut: the user removed it, or another extension had it first. */
  shortcut: string;
}

export type ShortcutsState =
  | { status: 'loading' }
  | { status: 'ready'; commands: Command[] }
  /** chrome.commands couldn't be read: the manifest's suggested keys stand in (show them as defaults). */
  | { status: 'fallback'; commands: Command[] };

const LABELS: Record<string, string> = {
  'scan-card': 'Scan a card',
  'open-panel': 'Open the side panel',
  // Chrome lists the toolbar icon's own command too; for Duel Lens, clicking the icon scans.
  _execute_action: 'Scan a card (same as clicking the toolbar icon)',
};

/** What a command does, in the pages' own words (Chrome's description for any other command). */
export function commandLabel(c: Command): string {
  return LABELS[c.name] ?? (c.description || c.name);
}

/** How macOS names the modifier symbols Chrome reports there ("⌥⇧Y"). */
const MAC_MODIFIERS: Record<string, string> = { '⌃': 'Control', '⌥': 'Option', '⇧': 'Shift', '⌘': 'Command' };

/**
 * The keys of a shortcut as Chrome reports it: "Alt+Shift+Y" on Windows, Linux and ChromeOS,
 * "⌥⇧Y" (modifier symbols, then the key) on macOS. None for a shortcut that isn't set.
 */
export function shortcutKeys(shortcut: string): string[] {
  const s = shortcut.trim();
  if (!s) return [];
  if (s.includes('+')) return s.split('+').filter(Boolean);
  const keys: string[] = [];
  let i = 0;
  while (i < s.length && s[i] in MAC_MODIFIERS) keys.push(s[i++]);
  if (i < s.length) keys.push(s.slice(i));
  return keys;
}

/** A shortcut as keycaps: "Alt + Shift + Y", or "⌥ Option + ⇧ Shift + Y" on a Mac. */
export function Keys({ shortcut }: { shortcut: string }) {
  return (
    <kbd class="combo">
      {shortcutKeys(shortcut).map((k, i) => (
        <Fragment key={i}>
          {i > 0 ? <span class="plus">+</span> : null}
          <kbd>{MAC_MODIFIERS[k] ? `${k} ${MAC_MODIFIERS[k]}` : k}</kbd>
        </Fragment>
      ))}
    </kbd>
  );
}

async function readCommands(): Promise<Command[]> {
  const all = await chrome.commands.getAll();
  return all.map((c) => ({ name: c.name ?? '', description: c.description ?? '', shortcut: c.shortcut ?? '' }));
}

/** The manifest's suggested shortcuts: a stand-in for when Chrome can't say which are active. */
function manifestCommands(): Command[] {
  try {
    const commands = chrome.runtime.getManifest().commands ?? {};
    return Object.entries(commands).map(([name, c]) => ({
      name,
      description: c.description ?? '',
      shortcut: (typeof c.suggested_key === 'string' ? c.suggested_key : c.suggested_key?.default) ?? '',
    }));
  } catch {
    return [];
  }
}

/**
 * The extension's commands and their current shortcuts. Read again whenever the page comes back
 * into view, so a shortcut changed at chrome://extensions/shortcuts in another tab shows up here.
 */
export function useShortcuts(): ShortcutsState {
  const [state, setState] = useState<ShortcutsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    const read = () => {
      readCommands().then(
        (commands) => alive && setState({ status: 'ready', commands }),
        () => alive && setState({ status: 'fallback', commands: manifestCommands() }),
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') read();
    };
    read();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', read);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', read);
    };
  }, []);
  return state;
}

/** One command's shortcut: '' when it has none, null while the shortcuts are still being read. */
export function shortcutOf(state: ShortcutsState, name: string): string | null {
  if (state.status === 'loading') return null;
  return state.commands.find((c) => c.name === name)?.shortcut ?? '';
}

/** Opens Chrome's shortcuts page in a new tab: extension pages can't navigate to chrome:// URLs. */
export function openShortcutsPage(ev?: Event) {
  ev?.preventDefault();
  try {
    void Promise.resolve(chrome.tabs.create({ url: SHORTCUTS_PAGE })).catch((err: unknown) =>
      console.error('Duel Lens: could not open the shortcuts page', err),
    );
  } catch (err) {
    console.error('Duel Lens: could not open the shortcuts page', err);
  }
}

/** A link to chrome://extensions/shortcuts that works from an extension page. */
export function ShortcutsPageLink({ children }: { children?: ComponentChildren }) {
  return (
    <a href={SHORTCUTS_PAGE} onClick={openShortcutsPage}>
      {children ?? SHORTCUTS_PAGE}
    </a>
  );
}
