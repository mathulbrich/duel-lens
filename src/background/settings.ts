// Settings live in chrome.storage.local.settings (Options page writes them; the AI
// check and the router read them). Always returns a complete Settings object, filling
// in anything missing (a fresh install, or a shape from an older version) with defaults.
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY] as Partial<Settings> | undefined;
  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...raw?.ai },
    debug: { ...DEFAULT_SETTINGS.debug, ...raw?.debug },
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    ai: { ...current.ai, ...patch.ai },
    debug: { ...current.debug, ...patch.debug },
  };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
