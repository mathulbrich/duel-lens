import { render } from 'preact';
import { getMeta } from '../background/card-store';
import { getSettings } from '../background/settings';
import { priceAsOfLabel } from '../content/card-view';
import { ensureFonts } from '../content/fonts';
import { setBanlist, setPriceAsOf } from '../content/prefs';
import { uiLang } from '../shared/i18n';
import { App } from './app';

// The popover's bundled fonts, for the card's details (app.tsx); until they load, or if they can't,
// the CSS font stacks fall back to system fonts.
void ensureFonts();

// The panel in the interface's language (src/shared/i18n.ts); card names and text carry their own lang.
document.documentElement.lang = uiLang();

const root = document.getElementById('app');

/**
 * The side panel's own display prefs for the card view (card-view.tsx's `./prefs`): which banlist
 * the chip shows (Settings.display.banlist) and the price chip's "as of" date (the card store's
 * metadata). The content script instead gets the banlist choice with begin-selection, and has no
 * date to show, because chrome.storage and the card store's IndexedDB are closed to a content
 * script in an arbitrary page; this page, privileged, can just read them. Best effort: a failed
 * read leaves the defaults (TCG, no date).
 */
async function loadDisplayPrefs(): Promise<void> {
  const [settings, meta] = await Promise.all([getSettings().catch(() => undefined), getMeta().catch(() => undefined)]);
  setBanlist(settings?.display.banlist);
  setPriceAsOf(meta ? priceAsOfLabel(meta) : undefined);
}

function renderApp(): void {
  if (root) render(<App />, root);
}

void loadDisplayPrefs().finally(renderApp);

// Keeps the banlist chip in step with a later change in Options, without needing the panel reopened.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  getSettings()
    .then((s) => {
      setBanlist(s.display.banlist);
      renderApp();
    })
    .catch(() => undefined);
});
