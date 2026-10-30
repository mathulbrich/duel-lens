// The shortcut and the toolbar menu's "Find a card by name" (background/find-card.ts) open the side panel with its
// search box focused: they leave this in chrome.storage.session, and the panel (sidepanel/app.tsx) focuses the box
// when it sees it, at once if it is open or on loading, then removes it. Older than PANEL_FOCUS_TTL_MS, it is ignored.
export const PANEL_FOCUS_KEY = 'panelFocus';
export const PANEL_FOCUS_TTL_MS = 15_000;

export interface PanelFocus {
  what: 'search';
  at: number;
}

export function isPanelFocus(v: unknown, now = Date.now()): v is PanelFocus {
  const f = v as Partial<PanelFocus> | null;
  return !!f && f.what === 'search' && typeof f.at === 'number' && now - f.at < PANEL_FOCUS_TTL_MS && f.at <= now + 1000;
}
