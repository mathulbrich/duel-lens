// Settings live in chrome.storage.local.settings (Options page writes them; the AI
// check, the router and the scan read them). Always returns a complete Settings object, filling
// in anything missing (a fresh install, or a shape from an older version) with defaults.
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

const KEY = 'settings';

type RevealMode = Settings['display']['reveal'];

/** Whether `value` is a way to show card details that this version knows ("Show card details" in Options). */
export function isRevealMode(value: unknown): value is RevealMode {
  return value === 'hover' || value === 'click';
}

/**
 * The display settings with a reveal mode this version knows: a missing or unknown one (a damaged value,
 * a newer version's mode) is the default, 'hover'. The content script gets it with begin-selection (scan.ts).
 */
function withKnownReveal(display: Partial<Settings['display']> | undefined): Settings['display'] {
  const merged = { ...DEFAULT_SETTINGS.display, ...display };
  return { ...merged, reveal: isRevealMode(merged.reveal) ? merged.reveal : DEFAULT_SETTINGS.display.reveal };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY] as Partial<Settings> | undefined;
  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...raw?.ai },
    debug: { ...DEFAULT_SETTINGS.debug, ...raw?.debug },
    display: withKnownReveal(raw?.display),
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    ai: { ...current.ai, ...patch.ai },
    debug: { ...current.debug, ...patch.debug },
    display: withKnownReveal({ ...current.display, ...patch.display }),
  };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
