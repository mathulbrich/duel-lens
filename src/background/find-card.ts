// "Find a card by name", from anywhere: the shortcut (manifest command find-card, Alt+Shift+F by default) and the
// toolbar icon's right-click menu open the side panel with its search box focused (sidepanel/search.tsx). The panel
// opens first, inside the user's gesture (sidePanel.open needs it; Firefox's sidebar too); then the request to focus
// the box is left for the panel (shared/panel-focus.ts), which may still be loading.
import { t } from '../shared/i18n';
import { PANEL_FOCUS_KEY, type PanelFocus } from '../shared/panel-focus';
import { openPanel } from './panel';

export const FIND_CARD_COMMAND = 'find-card';
export const FIND_CARD_MENU = 'find-card';

export function openFindCard(windowId: number, tabId?: number): Promise<void> {
  const opening = openPanel({ windowId, ...(tabId !== undefined ? { tabId } : {}) });
  const focus: PanelFocus = { what: 'search', at: Date.now() };
  void chrome.storage.session.set({ [PANEL_FOCUS_KEY]: focus }).catch(() => {});
  return opening;
}

/** The toolbar icon's menu item (again on every install and update: the menu holds it until then). */
export function createFindCardMenu(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: FIND_CARD_MENU, title: t('menu_find_card'), contexts: ['action'] }, () => void chrome.runtime.lastError);
  });
}
