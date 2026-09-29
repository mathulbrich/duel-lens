// Background service worker entry point: wires the real chrome.* events to the pure
// router (router.ts) and the scan flow (scan.ts). Kept thin - the logic it calls is
// unit-tested in its own module; this file just does the wiring plus the `runtime.onInstalled`
// welcome tab and seed/alarm setup, and the E2E debug hook below.
import { backgroundAccepts, isToOffscreen, senderKind, type OkResponse, type ToBackground } from '../shared/messages';
import { ensureSeeded, loadBundledCards, refreshIfChanged } from './card-store';
import { runIndexUpdate, runIndexUpdateIfStale } from './index-update';
import { closeOffscreenIfIdle, OFFSCREEN_IDLE_ALARM } from './offscreen-client';
import { handleMessage } from './router';
import { installDebugHook } from './debug-hook';
import { startScan } from './scan';

const REFRESH_ALARM = 'refresh-cards';
const WEEKLY_MINUTES = 7 * 24 * 60;

// The settings (the user's Claude API key) and the scan history live in chrome.storage.local,
// which content scripts can read by default, and content scripts run in page renderers. Only
// extension pages and this worker may read it. Idempotent, so it runs at every worker start.
// Message handling waits for it (onMessage below), so no settings read can race it (security
// review L1). It never rejects: a Chrome that can't restrict chrome.storage.local (every supported
// one can: minimum_chrome_version 124) logs an error and still works.
let storageLockSettled = false;
const storageLocked: Promise<void> = Promise.resolve()
  .then(() => chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }))
  .catch((err: unknown) => console.error('Duel Lens: could not restrict chrome.storage.local to extension pages', err))
  .finally(() => {
    storageLockSettled = true;
  });

chrome.runtime.onInstalled.addListener((details) => {
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
  // Chrome update (see the alarm comment below) doesn't force a redundant run every time.
  // The crop build (`--no-remote-images`) downloads no artwork (__DUEL_LENS_REMOTE_IMAGES__): the bundled index only.
  // ensureSeeded is shared with the welcome page's get-status (card-store.ts): one load, not two.
  ensureSeeded(loadBundledCards)
    .then(() => {
      if (__DUEL_LENS_REMOTE_IMAGES__) return runIndexUpdateIfStale();
    })
    .catch((err) => console.error('Duel Lens: failed to seed the card database', err));
  // onInstalled also fires for a plain Chrome update (not just a fresh install or an
  // extension update) - only create the alarm when none exists yet, so that doesn't
  // reset its weekly timer (review Important 1 / ledger M8).
  chrome.alarms
    .get(REFRESH_ALARM)
    .then((existing) => {
      if (!existing) chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: WEEKLY_MINUTES });
    })
    .catch((err) => console.error('Duel Lens: failed to check the refresh alarm', err));
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
    // No scan or embed for a while: free the offscreen document's memory (offscreen-client.ts).
    closeOffscreenIfIdle().catch((err) => console.error('Duel Lens: could not close the idle offscreen document', err));
    return;
  }
  if (alarm.name !== REFRESH_ALARM) return;
  refreshIfChanged()
    .then((status) => {
      // The weekly card-data refresh finding new cards is the third trigger for the
      // self-updating artwork index: no staleness gate here, unlike onInstalled/onStartup -
      // new cards always deserve an index update, whenever they show up. The crop build
      // (`--no-remote-images`) downloads no artwork: new cards reach its bundled index with an update.
      if (status === 'updated' && __DUEL_LENS_REMOTE_IMAGES__) return runIndexUpdate();
    })
    .catch((err) => console.error('Duel Lens: card refresh failed', err));
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'scan-card' && tab) {
    startScan(tab).catch((err) => console.error('Duel Lens: scan failed', err));
  } else if (command === 'open-panel' && tab?.windowId !== undefined) {
    // The keyboard command is itself a user gesture, so this is allowed to open directly.
    chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error('Duel Lens: could not open the side panel', err));
  }
});

chrome.action.onClicked.addListener((tab) => {
  startScan(tab).catch((err) => console.error('Duel Lens: scan failed', err));
});

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
