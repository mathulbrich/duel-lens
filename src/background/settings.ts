// Settings live in chrome.storage.local.settings (Options page writes them; the AI
// check, the router and the scan read them). Always returns a complete Settings object, filling
// in anything missing (a fresh install, or a shape from an older version) with defaults.
import { isCardLanguage } from '../shared/card-languages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';

export { isCardLanguage };

const KEY = 'settings';

type RevealMode = Settings['display']['reveal'];
type BanlistMode = Settings['display']['banlist'];

/** Whether `value` is a way to show card details that this version knows ("Show card details" in Options). */
export function isRevealMode(value: unknown): value is RevealMode {
  return value === 'hover' || value === 'click';
}

/** Whether `value` is a banlist this version knows ("Banlist" in Options: the TCG's or the OCG's). */
export function isBanlistMode(value: unknown): value is BanlistMode {
  return value === 'tcg' || value === 'ocg';
}

/**
 * The display settings with a reveal mode, a banlist and a card text language this version knows: a missing or
 * unknown one (a damaged value, a newer version's mode) is the default, 'hover' / 'tcg' / 'en'. The content script
 * gets the first two with begin-selection (scan.ts); the side panel reads this directly; the card language is
 * applied by the background itself (card-text.ts, router.ts), so neither needs it.
 */
function withKnownDisplay(display: Partial<Settings['display']> | undefined): Settings['display'] {
  const merged = { ...DEFAULT_SETTINGS.display, ...display };
  return {
    ...merged,
    reveal: isRevealMode(merged.reveal) ? merged.reveal : DEFAULT_SETTINGS.display.reveal,
    banlist: isBanlistMode(merged.banlist) ? merged.banlist : DEFAULT_SETTINGS.display.banlist,
    cardLanguage: isCardLanguage(merged.cardLanguage) ? merged.cardLanguage : DEFAULT_SETTINGS.display.cardLanguage,
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(KEY);
  const raw = stored[KEY] as Partial<Settings> | undefined;
  return {
    ai: { ...DEFAULT_SETTINGS.ai, ...raw?.ai },
    debug: { ...DEFAULT_SETTINGS.debug, ...raw?.debug },
    display: withKnownDisplay(raw?.display),
  };
}

/** A patch for setSettings: each group's fields are optional. */
export type SettingsPatch = { [K in keyof Settings]?: Partial<Settings[K]> };

export async function setSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    ai: { ...current.ai, ...patch.ai },
    debug: { ...current.debug, ...patch.debug },
    display: withKnownDisplay({ ...current.display, ...patch.display }),
  };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}
