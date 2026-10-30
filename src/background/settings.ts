// Settings (the Options page writes them; the AI check, the router and the scan read them). Always returns a
// complete Settings object, filling in anything missing (a fresh install, or a shape from an older version) with
// defaults. The Claude API key lives apart, in the private IndexedDB store (secure-store.ts, decision D-FF2),
// which the scripts Duel Lens runs on web pages can't open in any browser; everything else, none of it secret,
// stays in chrome.storage.local.settings, where the side panel's storage.onChanged follows it.
import { isCardLanguage } from '../shared/card-languages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { API_KEY, secureGet, secureSet } from './secure-store';

export { isCardLanguage };

const KEY = 'settings';

type RevealMode = Settings['display']['reveal'];
type BanlistMode = Settings['display']['banlist'];

/** Whether `value` is a way to show card details that this version knows ("Show card details" in Options). */
export function isRevealMode(value: unknown): value is RevealMode {
  return value === 'full' || value === 'preview' || value === 'click';
}

/**
 * A stored reveal mode as this version reads it: 'hover' (before 0.9.4: "Hover or click", whose hover was the quick
 * preview) is 'preview'; an unknown one is the default.
 */
export function revealModeOf(value: unknown): RevealMode {
  if (value === 'hover') return 'preview';
  return isRevealMode(value) ? value : DEFAULT_SETTINGS.display.reveal;
}

/** Whether `value` is a banlist this version knows ("Banlist" in Options: the TCG's or the OCG's). */
export function isBanlistMode(value: unknown): value is BanlistMode {
  return value === 'tcg' || value === 'ocg';
}

/**
 * The display settings with a reveal mode, a banlist and a card text language this version knows: a missing or
 * unknown one (a damaged value, a newer version's mode) is the default, 'preview' / 'tcg' / 'en' (0.9.3's 'hover' is 'preview'). The content script
 * gets the first two with begin-selection (scan.ts); the side panel reads this directly; the card language is
 * applied by the background itself (card-text.ts, router.ts), so neither needs it.
 */
function withKnownDisplay(display: Partial<Settings['display']> | undefined): Settings['display'] {
  const merged = { ...DEFAULT_SETTINGS.display, ...display };
  return {
    ...merged,
    reveal: revealModeOf(merged.reveal),
    banlist: isBanlistMode(merged.banlist) ? merged.banlist : DEFAULT_SETTINGS.display.banlist,
    cardLanguage: isCardLanguage(merged.cardLanguage) ? merged.cardLanguage : DEFAULT_SETTINGS.display.cardLanguage,
  };
}

/** The settings as chrome.storage.local holds them: no API key since D-FF2 (0.9.2's copy still may have one). */
type StoredSettings = Partial<Omit<Settings, 'ai'>> & { ai?: Partial<Settings['ai']> };

async function readStored(): Promise<StoredSettings | undefined> {
  return (await chrome.storage.local.get(KEY))[KEY] as StoredSettings | undefined;
}

/**
 * The API key: the private store's, else (before migrateLegacyStorage has moved it) the copy in the stored
 * settings, else none. A store that can't be read leaves the rest of the settings working (a scan reads them
 * too): it logs, and answers that copy or none.
 */
async function readApiKey(stored: StoredSettings | undefined): Promise<string> {
  const legacy = typeof stored?.ai?.apiKey === 'string' ? stored.ai.apiKey : undefined;
  try {
    const key = await secureGet(API_KEY);
    if (typeof key === 'string') return key;
  } catch (err) {
    console.error('Duel Lens: could not read the API key', err);
  }
  return legacy ?? DEFAULT_SETTINGS.ai.apiKey;
}

/** The settings without the API key, as chrome.storage.local keeps them. */
function withoutKey(settings: Settings): StoredSettings {
  const { apiKey: _key, ...ai } = settings.ai;
  return { ...settings, ai };
}

function fromStored(raw: StoredSettings | undefined, apiKey: string): Settings {
  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...raw?.ai, apiKey },
    debug: { ...DEFAULT_SETTINGS.debug, ...raw?.debug },
    display: withKnownDisplay(raw?.display),
    corrections: { ...DEFAULT_SETTINGS.corrections, ...raw?.corrections },
    updates: { ...DEFAULT_SETTINGS.updates, ...raw?.updates },
  };
}

export async function getSettings(): Promise<Settings> {
  const raw = await readStored();
  return fromStored(raw, await readApiKey(raw));
}

/** A patch for setSettings: each group's fields are optional. */
export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

/**
 * Saves a patch. The key goes to the private store first, and only then are the settings written to
 * chrome.storage.local without it, so a crash in between leaves a copy, never none. A patch without a key leaves
 * the stored one alone, unless 0.9.2's copy is still in chrome.storage.local, which this write moves.
 */
export async function setSettings(patch: SettingsPatch): Promise<Settings> {
  const raw = await readStored();
  const current = fromStored(raw, await readApiKey(raw));
  const next: Settings = {
    ai: { ...current.ai, ...patch.ai },
    debug: { ...current.debug, ...patch.debug },
    display: withKnownDisplay({ ...current.display, ...patch.display }),
    corrections: { ...current.corrections, ...patch.corrections },
    updates: { ...current.updates, ...patch.updates },
  };
  if (patch.ai?.apiKey !== undefined || raw?.ai?.apiKey !== undefined) await secureSet({ [API_KEY]: next.ai.apiKey });
  await chrome.storage.local.set({ [KEY]: withoutKey(next) });
  return next;
}
