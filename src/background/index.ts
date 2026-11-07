// Background service worker entry point: wires the real chrome.* events to the pure
// router (router.ts) and the scan flow (scan.ts). Kept thin - the logic it calls is
// unit-tested in its own module; this file just does the wiring plus the `runtime.onInstalled`
// welcome tab and seed/alarm setup, and the E2E debug hook below.
import { isKeepAlive } from '../shared/keep-alive';
import { backgroundAccepts, isToOffscreen, senderKind, type OkResponse, type ToBackground } from '../shared/messages';
import { ensureSeeded, loadBundledCards, refreshIfChanged } from './card-store';
import { refreshCardText } from './card-text';
import { runIndexUpdate, runIndexUpdateIfStale } from './index-update';
import { runUpdateCheck, scheduleUpdateCheck, UPDATE_ALARM } from './update-check';
import { closeOffscreenIfIdle, OFFSCREEN_IDLE_ALARM, warmLiveOffscreen } from './offscreen-client';
import { handleMessage } from './router';
import { installDebugHook } from './debug-hook';
import { FIND_CARD_COMMAND, FIND_CARD_MENU, openFindCard } from './find-card';
import { LIVE_COMMAND, liveBackground } from './live';
import { ALL_SITES, applyLiveCheck, liveCheckDeps, setLiveCheck } from './live-check';
import { createActionMenus, LIVE_MENU, setLiveCheckMenu } from './menus';
import { openPanel } from './panel';
import { startScan } from './scan';
import { getSettings } from './settings';
import { migrateLegacyStorage } from './secure-store';

const REFRESH_ALARM = 'refresh-cards';
const WEEKLY_MINUTES = 7 * 24 * 60;

// The settings (not the Claude API key, nor the scan history: secure-store.ts) live in chrome.storage.local,
// which content scripts can read by default, and content scripts run in page renderers. Only
// extension pages and this worker may read it. Idempotent, so it runs at every worker start.
// Message handling waits for it (onMessage below), so no settings read can race it (security
// review L1). It never rejects: a Chrome that can't restrict chrome.storage.local (every supported
// one can: minimum_chrome_version 124) logs an error and still works. Firefox has no setAccessLevel at
// all (its content scripts can always read chrome.storage.local), so there it is skipped quietly.
let storageLockSettled = false;
const storageLocked: Promise<void> = Promise.resolve()
  .then(() => {
    if (__DUEL_LENS_FIREFOX__ && typeof chrome.storage.local.setAccessLevel !== 'function') return;
    return chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  })
  .catch((err: unknown) => console.error('Duel Lens: could not restrict chrome.storage.local to extension pages', err))
  .finally(() => {
    storageLockSettled = true;
  });

// Decision D-FF2: the API key and the scan history live in the extension's own IndexedDB (secure-store.ts),
// which no content script can open in any browser. This moves 0.9.2's copies there from chrome.storage.local.
// Idempotent and crash-safe, so it runs at every worker start (an install, an update, or a run cut short
// before); until it has, settings.ts and history.ts still read the old copies.
migrateLegacyStorage().catch((err: unknown) => console.error('Duel Lens: could not move the API key and history out of chrome.storage.local', err));

/** When the weekly card refresh is next due (ms since the epoch), in chrome.storage.local. */
const REFRESH_DUE_KEY = 'refreshDueAt';

// The weekly card refresh's alarm, at every worker start, not only onInstalled: Firefox keeps no alarm across a
// browser restart, and Chrome may drop one too (its docs say so). Only created when none exists, so a Chrome update
// (onInstalled fires for those too) or a worker waking up doesn't reset its weekly timer (review Important 1 /
// ledger M8). Created for when the refresh is due, not a week from now: a browser restarted every day would
// otherwise never reach it (audit M1).
chrome.alarms
  .get(REFRESH_ALARM)
  .then(async (existing) => {
    if (existing) return;
    const now = Date.now();
    const stored: unknown = (await chrome.storage.local.get(REFRESH_DUE_KEY))[REFRESH_DUE_KEY];
    const due = typeof stored === 'number' && Number.isFinite(stored) ? stored : now + WEEKLY_MINUTES * 60_000;
    if (due !== stored) await chrome.storage.local.set({ [REFRESH_DUE_KEY]: due });
    chrome.alarms.create(REFRESH_ALARM, { when: Math.max(due, now + 60_000), periodInMinutes: WEEKLY_MINUTES });
  })
  .catch((err) => console.error('Duel Lens: failed to check the refresh alarm', err));

// "A new version is out" for a copy installed by hand (Load unpacked), which never updates itself (update-check.ts).
// Not in the E2E build: the harness loads it unpacked too, and a test run asks nothing of GitHub.
if (!__DUEL_LENS_E2E__) scheduleUpdateCheck().catch((err) => console.error('Duel Lens: could not schedule the update check', err));

chrome.runtime.onInstalled.addListener((details) => {
  // The Live check item ticked as the setting is (followLiveCheck may run before the menu exists).
  getSettings()
    .then((s) => createActionMenus(s.live.check))
    .catch(() => createActionMenus());
  // A fresh install opens the welcome page: how to scan, and the first-run consent the Chrome Web
  // Store requires before the first scan (scan.ts waits for it). Not for updates of the extension
  // or of Chrome. (`details?.`: the tests call the listener without them.)
  if (details?.reason === 'install') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('welcome.html') })
      .catch((err) => console.error('Duel Lens: could not open the welcome page', err));
  }
  // The self-updating artwork index's "first run after install" trigger: only once
  // seeding actually succeeded (an index update needs the card store to know what's
  // missing), and only via runIndexUpdateIfStale so onInstalled firing again for a plain
  // Chrome update (see the alarm comment above) doesn't force a redundant run every time.
  // The crop build (`--no-remote-images`) downloads no artwork (__DUEL_LENS_REMOTE_IMAGES__): the bundled index only.
  // ensureSeeded is shared with the welcome page's get-status (card-store.ts): one load, not two.
  ensureSeeded(loadBundledCards)
    .then(() => {
      if (__DUEL_LENS_REMOTE_IMAGES__) return runIndexUpdateIfStale();
    })
    .catch((err) => console.error('Duel Lens: failed to seed the card database', err));
});

// The other side of "first run after install": a long-idle service worker restarting
// (Chrome start-up, not just an install/update) also gets a chance to catch up, but only
// when it's actually been a while (runIndexUpdateIfStale), not on every worker restart.
chrome.runtime.onStartup.addListener(() => {
  // The crop build (`--no-remote-images`): the bundled artwork index only. (An `if`, not an early
  // return: esbuild then leaves the artwork downloads out of its background.js.)
  if (__DUEL_LENS_REMOTE_IMAGES__) {
    runIndexUpdateIfStale().catch((err) => console.error('Duel Lens: index update failed', err));
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === OFFSCREEN_IDLE_ALARM) {
    // No scan or embed for a while: free the offscreen document's memory (offscreen-client.ts), unless Live check is
    // on: its models stay loaded for the next rest on a card.
    getSettings()
      .then((s) => s.live.check, () => false)
      .then((keep) => closeOffscreenIfIdle(keep))
      .catch((err) => console.error('Duel Lens: could not close the idle offscreen document', err));
    return;
  }
  if (alarm.name === UPDATE_ALARM) {
    runUpdateCheck().catch((err) => console.error('Duel Lens: the update check failed', err));
    return;
  }
  if (alarm.name !== REFRESH_ALARM) return;
  chrome.storage.local
    .set({ [REFRESH_DUE_KEY]: Date.now() + WEEKLY_MINUTES * 60_000 })
    .catch((err) => console.error('Duel Lens: could not store when the card refresh is next due', err));
  refreshIfChanged()
    .then((status) => {
      // The weekly card-data refresh finding new cards is the third trigger for the
      // self-updating artwork index: no staleness gate here, unlike onInstalled/onStartup -
      // new cards always deserve an index update, whenever they show up. The crop build
      // (`--no-remote-images`) downloads no artwork: new cards reach its bundled index with an update.
      if (status === 'updated' && __DUEL_LENS_REMOTE_IMAGES__) return runIndexUpdate();
    })
    .catch((err) => console.error('Duel Lens: card refresh failed', err))
    // Then the card text language pack, if one is chosen (Options): downloaded again only when YGOPRODeck's
    // database changed since it was stored, so at most once a week. Never throws (card-text.ts).
    .then(() => refreshCardText());
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'scan-card' && tab) {
    startScan(tab).catch((err) => console.error('Duel Lens: scan failed', err));
  } else if (command === FIND_CARD_COMMAND && tab?.windowId !== undefined) {
    openFindCard(tab.windowId, tab.id).catch((err) => console.error('Duel Lens: could not open the card search', err));
  } else if (command === LIVE_COMMAND) {
    flipLiveCheck();
  } else if (command === 'open-panel' && tab?.windowId !== undefined) {
    // The keyboard command is itself a user gesture, so this is allowed to open directly.
    // openPanel (panel.ts) falls back to a popup window where chrome.sidePanel doesn't exist (Opera).
    openPanel({ windowId: tab.windowId, tabId: tab.id }).catch((err) => console.error('Duel Lens: could not open the panel', err));
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === LIVE_MENU) {
    // The menu ticks its box itself; the setting decides (a refused permission or missing consent leaves it off).
    setCheckFromClick(info.checked === true);
    return;
  }
  if (info.menuItemId !== FIND_CARD_MENU) return;
  openFindCard(tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT, tab?.id).catch((err) => console.error('Duel Lens: could not open the card search', err));
});

// Live follows its tab: a finished load that no longer runs it ends the session, a closed tab clears it, and an
// Options change reaches the loop (live.ts). Registered at the top level, like every listener, so Firefox's event page wakes for them.
const onTabUpdated = (tabId: number, info: { status?: string }) => {
  liveBackground.tabUpdated(tabId, info).catch((err) => console.error('Duel Lens: Live could not follow the tab', err));
};
if (__DUEL_LENS_FIREFOX__) {
  // Firefox can filter tabs.onUpdated to the changes Live reads (Chrome's takes no filter): its event page wakes
  // for a load, not for every title, favicon and audio change of every tab.
  (chrome.tabs.onUpdated as unknown as { addListener(cb: typeof onTabUpdated, filter: { properties: string[] }): void }).addListener(onTabUpdated, {
    properties: ['status'],
  });
} else {
  chrome.tabs.onUpdated.addListener(onTabUpdated);
}
chrome.tabs.onRemoved.addListener((tabId) => {
  liveBackground.tabRemoved(tabId).catch((err) => console.error('Duel Lens: Live could not follow the tab', err));
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  getSettings()
    .then(async (settings) => {
      await liveBackground.settingsChanged(settings.live, settings.display.reveal);
      const was = (changes.settings.oldValue as { live?: { check?: unknown } } | undefined)?.live?.check === true;
      // Switched on: load the models now, while the user goes to a video (offscreen-client.ts warmLiveOffscreen).
      if (!was && settings.live.check) void warmLiveOffscreen(settings.live.effort === 'light');
      // Switched to Light while on: its own reader loads now.
      const wasEffort = (changes.settings.oldValue as { live?: { effort?: unknown } } | undefined)?.live?.effort;
      if (was && settings.live.check && settings.live.effort === 'light' && wasEffort !== 'light') void warmLiveOffscreen(true);
      if (was !== settings.live.check) await followLiveCheck(settings.live.check);
    })
    .catch((err) => console.error('Duel Lens: Live could not pass on the settings', err));
});

// Live check (live-check.ts, D-L14): the setting is the switch; the browser follows it here, at every worker start
// too (a permission removed while the worker slept turns it off), and the icon's menu ticks it.
const checkDeps = liveCheckDeps(() => liveBackground.stop('user'));
/** The setting as last followed; undefined until this worker read it. */
let checkOn: boolean | undefined;
/** One change at a time: an "on" still injecting into many tabs must not broadcast after a later "off". */
let following: Promise<void> = Promise.resolve();
function followLiveCheck(on: boolean): Promise<void> {
  checkOn = on;
  setLiveCheckMenu(on);
  following = following.then(() =>
    applyLiveCheck(on, checkDeps).catch((err) => console.error('Duel Lens: Live check could not follow the setting', err)),
  );
  return following;
}
/** The menu or the shortcut: a click's gesture, so every site may be asked for (setLiveCheck asks before any await). */
function setCheckFromClick(on: boolean): void {
  setLiveCheck(on, checkDeps)
    .then((r) => setLiveCheckMenu(r.on))
    .catch((err) => console.error('Duel Lens: Live check failed', err));
}
/** The shortcut flips the switch from what this worker holds, so turning it on asks in the gesture. A worker just
 *  woken by the shortcut asks for every site at once, still in the gesture (granted already, nothing shows), and reads
 *  the setting after. */
function flipLiveCheck(): void {
  if (checkOn !== undefined) return setCheckFromClick(!checkOn);
  const asked = chrome.permissions.request({ origins: ALL_SITES });
  void getSettings()
    .then((s) => setLiveCheck(!s.live.check, { ...checkDeps, requestSites: () => asked }))
    .then((r) => setLiveCheckMenu(r.on))
    .catch((err) => console.error('Duel Lens: Live check failed', err));
}
getSettings()
  .then((s) => followLiveCheck(s.live.check))
  .catch(() => undefined);
chrome.permissions.onRemoved.addListener((p) => {
  if (p.origins?.includes('<all_urls>')) void checkDeps.saveCheck(false).catch(() => undefined); // the setting change follows
});

// The toolbar icon opens the popup (popup.html, D-L14): its "Scan this page" sends scan-active-tab (router.ts).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isToOffscreen(message)) return false; // not ours: the offscreen document answers this
  // sendResponse itself can throw (the tab/port closed mid-scan); guarded so it's tried
  // at most once, and a second throw from the .catch fallback never becomes an unhandled
  // rejection (review: src/background/index.ts:46).
  let responded = false;
  const respond = (r: unknown) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(r);
    } catch (err) {
      console.error('Duel Lens: could not deliver the response (the tab/port may be gone)', err);
    }
  };
  // Who may send what (security review M2 and L3; src/shared/messages.ts): another extension gets
  // no answer at all; a content script, which runs inside a web page, only the in-page overlay's
  // messages; Duel Lens's own pages everything.
  const from = senderKind(sender, { id: chrome.runtime.id, baseUrl: chrome.runtime.getURL('') });
  if (from === 'foreign') return false;
  // Firefox: scan mode's keep-alive ping (src/shared/keep-alive.ts). Receiving it is the point: the event
  // is what restarts Firefox's idle timer. Answered at once, past the router.
  if (__DUEL_LENS_FIREFOX__ && isKeepAlive(message)) {
    respond({ ok: true } satisfies OkResponse);
    return false;
  }
  // E2E builds for Firefox: the test bridge's calls are the debug hook's to answer (debug-hook.ts).
  if (__DUEL_LENS_E2E__ && __DUEL_LENS_FIREFOX__ && (message as { type?: unknown } | null)?.type === 'e2e-debug') return false;
  const type = (message as { type?: unknown } | null)?.type;
  if (!backgroundAccepts(type, from)) {
    const error = `Duel Lens accepts "${String(type)}" only from its own pages, not from a content script.`;
    console.warn(`Duel Lens: refused a message from a content script: ${error}`);
    respond({ ok: false, error } satisfies OkResponse);
    return false;
  }
  // Nothing is handled before chrome.storage.local is restricted (storageLocked, above). Once it
  // is, the router runs at once, not a turn later: show-in-panel's sidePanel.open() needs the user
  // gesture its message carries.
  const handle = () => handleMessage(message as ToBackground, sender);
  (storageLockSettled ? handle() : storageLocked.then(handle))
    .then(respond)
    .catch((err) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // keep the message channel open for the async sendResponse above
});

// --- E2E debug hook: E2E builds only (src/background/debug-hook.ts) ---------------
if (__DUEL_LENS_E2E__) installDebugHook();
