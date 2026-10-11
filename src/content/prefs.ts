// Live display prefs that affect how a card's facts render (CardFacts/CardView, card-view.tsx).
// Plain module state, not a React prop: card-view.tsx is shared by the popover, the hover preview and
// the side panel's card view, and this way none of those callers need a new prop threaded through them
// for a setting that only changes how the chips read, not what card is shown.
//
// Set by whichever context has the value: the content script, from begin-selection.banlist (index.ts,
// scan.ts); the side panel, from its own settings read (sidepanel/index.tsx: chrome.storage and the
// card store are open to every extension page, just not to a content script in an arbitrary page).
import type { Settings } from '../shared/types';

type BanlistMode = Settings['display']['banlist'];

let banlist: BanlistMode = 'tcg';
/** A short "as of" label for the price chip (card-view.tsx's `priceAsOfLabel`), or undefined where
 * it isn't available: the content script can't read the card store's metadata (no messaging for it). */
let priceAsOf: string | undefined;

/** Sets which banlist the chip shows. An unknown value (a damaged message, a newer mode) is 'tcg'. */
export function setBanlist(mode: BanlistMode | undefined): void {
  banlist = mode === 'ocg' ? 'ocg' : 'tcg';
}

export function getBanlist(): BanlistMode {
  return banlist;
}

export function setPriceAsOf(label: string | undefined): void {
  priceAsOf = label;
}

export function getPriceAsOf(): string | undefined {
  return priceAsOf;
}
