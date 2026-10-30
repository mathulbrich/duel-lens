// The toolbar icon's right-click menu: "Find a card by name" (find-card.ts) and "Start Live on this tab" / "Stop Live"
// (live.ts). Made again on every install and update: the browser keeps the menu until then. The Live item's title
// follows whether Live runs (setLiveMenuRunning).
import { t } from '../shared/i18n';
import { FIND_CARD_MENU } from './find-card';

export const LIVE_MENU = 'live-toggle';

export function createActionMenus(): void {
  chrome.contextMenus.removeAll(() => {
    const done = () => void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: FIND_CARD_MENU, title: t('menu_find_card'), contexts: ['action'] }, done);
    chrome.contextMenus.create({ id: LIVE_MENU, title: t('menu_live_start'), contexts: ['action'] }, done);
  });
}

/** Flips the Live item between "Start Live on this tab" and "Stop Live". Best-effort: before the menu exists, nothing happens. */
export function setLiveMenuRunning(running: boolean): void {
  try {
    chrome.contextMenus.update(LIVE_MENU, { title: t(running ? 'menu_live_stop' : 'menu_live_start') }, () => void chrome.runtime.lastError);
  } catch {
    // No such item yet: onInstalled makes it.
  }
}
