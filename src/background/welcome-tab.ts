// Opens the welcome page (welcome.html) in front: at install, and at its consent step (#consent) when
// someone tries to scan before agreeing (scan.ts). A welcome page that's already open is brought to
// the front rather than opened again, so pressing the shortcut twice doesn't stack tabs.

/** The welcome page's consent step (src/welcome/consent.tsx): welcome.html#consent. */
export const CONSENT_HASH = 'consent';

export interface WelcomeTabDeps {
  /** chrome-extension://<id>/welcome.html */
  welcomeUrl: () => string;
  /** The extension's own pages open in tabs (chrome.runtime.getContexts). */
  openTabs: () => Promise<{ tabId: number; windowId: number; documentUrl?: string }[]>;
  createTab: (props: chrome.tabs.CreateProperties) => Promise<unknown>;
  updateTab: (tabId: number, props: chrome.tabs.UpdateProperties) => Promise<unknown>;
  focusWindow: (windowId: number) => Promise<unknown>;
}

const defaultDeps: WelcomeTabDeps = {
  welcomeUrl: () => chrome.runtime.getURL('welcome.html'),
  openTabs: () => chrome.runtime.getContexts({ contextTypes: ['TAB'] }),
  createTab: (props) => chrome.tabs.create(props),
  updateTab: (tabId, props) => chrome.tabs.update(tabId, props),
  focusWindow: (windowId) => chrome.windows.update(windowId, { focused: true }),
};

/**
 * Shows the welcome page, at `#hash` when given: an open one is brought to the front at that step,
 * otherwise a new tab opens beside `nextTo` (the tab the user was on). Rejects only when no tab could
 * be shown; a window that can't be focused is ignored.
 */
export async function openWelcome(
  { hash, nextTo }: { hash?: string; nextTo?: chrome.tabs.Tab } = {},
  deps: WelcomeTabDeps = defaultDeps,
): Promise<void> {
  const base = deps.welcomeUrl();
  const url = hash ? `${base}#${hash}` : base;
  const open = await deps.openTabs().then(
    (tabs) => tabs.find((t) => t.tabId >= 0 && t.documentUrl?.split('#')[0] === base),
    () => undefined, // can't tell: open another one
  );
  if (open) {
    await deps.updateTab(open.tabId, { url, active: true });
    await deps.focusWindow(open.windowId).catch(() => undefined);
    return;
  }
  const beside = nextTo?.windowId !== undefined ? { windowId: nextTo.windowId, ...(nextTo.index !== undefined ? { index: nextTo.index + 1 } : {}) } : {};
  await deps.createTab({ url, active: true, ...beside });
  if (nextTo?.windowId !== undefined) await deps.focusWindow(nextTo.windowId).catch(() => undefined);
}
