// Opens Duel Lens's panel for a tab/window: chrome.sidePanel.open() where the browser has it (every
// supported Chrome and Edge); Firefox's sidebar (sidebar_action, build.mjs --target firefox) where it
// can open, which is only inside a user input handler (the open-panel shortcut, the toolbar button);
// otherwise a small popup window on sidepanel.html (Opera, as of writing - see compat-chromium.md - and
// Firefox when the sidebar refuses: a content script's message, as for "Keep in side panel", carries no
// user input there, so Firefox opens the popup). Feature-detected once, in defaultDeps below, never by sniffing the
// browser: a future Opera that ships chrome.sidePanel takes the first path automatically.
//
// The popup is reused and focused rather than reopened (mirrors welcome-tab.ts's openWelcome), so
// pressing the shortcut, or "Keep in side panel"/"Read the whole board", twice doesn't stack windows.
// sidepanel.html itself needs nothing extra to work this way: its board and scan history both live in
// chrome.storage (session/local), read with chrome.storage.onChanged already wired up (src/sidepanel/app.tsx),
// so a reused popup picks up a later board/entry the same way the real side panel does, no reload needed.
// The popup's URL still carries the opening tab as `?tabId=`, for parity with chrome.sidePanel.open's own
// options and in case a future panel feature becomes per-tab; sidepanel.html does not read it today.
export interface PanelOpenOptions {
  windowId?: number;
  tabId?: number;
}

export interface PanelDeps {
  /** Only set when this browser has chrome.sidePanel.open (feature-detected in defaultDeps, not sniffed). */
  sidePanelOpen?: (opts: PanelOpenOptions) => Promise<void>;
  /**
   * Only set when this browser has Firefox's browser.sidebarAction.open (feature-detected too). It must be
   * called before anything is awaited, within the user input; it rejects otherwise ("may only be called
   * from a user input handler"), and the popup window opens instead.
   */
  sidebarOpen?: () => Promise<void>;
  /** chrome-extension://<id>/sidepanel.html */
  panelUrl: () => string;
  /** The extension's own pages open in tabs (chrome.runtime.getContexts), to find a popup already open. */
  openTabs: () => Promise<{ tabId: number; windowId: number; documentUrl?: string }[]>;
  createWindow: (props: chrome.windows.CreateData) => Promise<{ id?: number } | undefined>;
  focusWindow: (windowId: number) => Promise<unknown>;
}

const defaultDeps: PanelDeps = {
  // A getter, not a precomputed value: `chrome` isn't declared at all in a plain unit-test environment
  // (unlike `typeof chrome === 'undefined'`, `typeof chrome.sidePanel` would throw there), so the
  // feature check has to wait until something actually reads `sidePanelOpen` - which only happens
  // inside openPanel(), i.e. never in a test that supplies its own deps (every router.test.ts/
  // panel.test.ts case does).
  get sidePanelOpen() {
    return typeof chrome !== 'undefined' && typeof chrome.sidePanel?.open === 'function'
      ? (opts: PanelOpenOptions) => chrome.sidePanel.open(opts as chrome.sidePanel.OpenOptions)
      : undefined;
  },
  get sidebarOpen() {
    const sidebar = (globalThis as { browser?: { sidebarAction?: { open?: () => Promise<void> } } }).browser?.sidebarAction;
    return typeof sidebar?.open === 'function' ? () => sidebar.open!() : undefined;
  },
  panelUrl: () => chrome.runtime.getURL('sidepanel.html'),
  openTabs: () => chrome.runtime.getContexts({ contextTypes: ['TAB'] }),
  createWindow: (props) => chrome.windows.create(props),
  focusWindow: (windowId) => chrome.windows.update(windowId, { focused: true }),
};

/** The fallback popup's size (Chrome/Edge's real side panel has no fixed size to match). */
const POPUP_WIDTH = 420;
const POPUP_HEIGHT = 640;

/**
 * Opens the panel for `opts.tabId`/`opts.windowId`. With chrome.sidePanel, this is a straight passthrough -
 * same gesture rules as calling chrome.sidePanel.open() directly (it must be the first thing awaited in a
 * user-gesture handler; callers rely on that, and on a rejection when the gesture's gone - see router.ts's
 * show-in-panel/show-board). Without it, opens (or focuses an existing) sidepanel.html popup window instead;
 * that path isn't gesture-gated, so it rejects only when the window itself can't be created.
 */
export async function openPanel(opts: PanelOpenOptions, deps: PanelDeps = defaultDeps): Promise<void> {
  if (deps.sidePanelOpen) {
    await deps.sidePanelOpen(opts);
    return;
  }
  const sidebarOpen = deps.sidebarOpen;
  if (sidebarOpen) {
    try {
      await sidebarOpen(); // called before anything is awaited: a shortcut's user input still holds
      return;
    } catch {
      // No user input (a content script's message): the popup window instead.
    }
  }
  const base = deps.panelUrl();
  const open = await deps.openTabs().then(
    (tabs) => tabs.find((tb) => tb.tabId >= 0 && tb.documentUrl?.split('?')[0] === base),
    () => undefined, // can't tell: open another one
  );
  if (open) {
    await deps.focusWindow(open.windowId).catch(() => undefined);
    return;
  }
  const url = opts.tabId !== undefined ? `${base}?tabId=${opts.tabId}` : base;
  const created = await deps.createWindow({ url, type: 'popup', width: POPUP_WIDTH, height: POPUP_HEIGHT });
  if (created?.id !== undefined) await deps.focusWindow(created.id).catch(() => undefined);
}
