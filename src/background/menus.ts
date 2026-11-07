// The toolbar icon's right-click menu: "Find a card by name" (find-card.ts) and the "Live check" switch
// (live-check.ts, D-L14). Made again on every install and update: the browser keeps the menu until then. The switch's
// tick follows the setting (setLiveCheckMenu).
import { t } from '../shared/i18n';
import { FIND_CARD_MENU } from './find-card';

export const LIVE_MENU = 'live-toggle';

export function createActionMenus(check = false): void {
  chrome.contextMenus.removeAll(() => {
    const done = () => void chrome.runtime.lastError;
    chrome.contextMenus.create({ id: FIND_CARD_MENU, title: t('menu_find_card'), contexts: ['action'] }, done);
    chrome.contextMenus.create({ id: LIVE_MENU, type: 'checkbox', checked: check, title: t('menu_live_check'), contexts: ['action'] }, done);
  });
}

/** Ticks the "Live check" item or not. Best-effort: before the menu exists, nothing happens. */
export function setLiveCheckMenu(on: boolean): void {
  try {
    chrome.contextMenus.update(LIVE_MENU, { checked: on }, () => void chrome.runtime.lastError);
  } catch {
    // No such item yet: onInstalled makes it.
  }
}
