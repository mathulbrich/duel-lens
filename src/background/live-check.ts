// Live check (spec D-L14): one switch, on every site. On, content.js is registered on every page's top frame and
// injected into the open tabs; each page then waits for the pointer to go over a playing video before Live starts
// there (content/live/arm.ts). The switch is the setting `live.check`; this module turns it on from a click (the
// popup's switch, the icon's menu, the shortcut) and makes the browser follow the setting (apply).
import type { ToContent } from '../shared/messages';
import { getConsent } from './consent';
import { getSettings, setSettings } from './settings';
import { CONSENT_HASH, openWelcome } from './welcome-tab';

/** Every site: what Live check needs to run its script on any page and to read the tab. */
export const ALL_SITES = ['<all_urls>'];
/** The registered content script's id. */
export const LIVE_CHECK_SCRIPT = 'live-check';

export interface LiveCheckDeps {
  /** Asks for ALL_SITES; must run in a click's gesture (Firefox refuses it after an await). */
  requestSites: () => Promise<boolean>;
  hasSites: () => Promise<boolean>;
  hasConsent: () => Promise<boolean>;
  openConsent: () => Promise<void>;
  saveCheck: (on: boolean) => Promise<void>;
  /** Registers content.js on every page (once; a second call changes nothing). */
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  /** Injects content.js into the open tabs' top frames (the pages loaded before the switch went on). */
  injectOpenTabs: () => Promise<void>;
  /** Tells every open tab's script (best effort). */
  tellOpenTabs: (message: ToContent) => Promise<void>;
  /** Stops Live wherever it runs (live.ts). */
  stopLive: () => Promise<void>;
}

export type LiveCheckResult = { on: boolean; reason?: 'no-permission' | 'no-consent' };

/**
 * The switch flipped by a click. On: every site is asked for first, before anything is awaited, so the click's
 * gesture is still there; then the data consent (without it, its page opens and the switch stays off).
 */
export async function setLiveCheck(on: boolean, deps: LiveCheckDeps): Promise<LiveCheckResult> {
  if (!on) {
    await deps.saveCheck(false);
    return { on: false };
  }
  const granted = await deps.requestSites().catch(() => false);
  if (!granted) return { on: false, reason: 'no-permission' };
  if (!(await deps.hasConsent().catch(() => false))) {
    await deps.openConsent().catch((err) => console.error('Duel Lens: could not open the consent page', err));
    return { on: false, reason: 'no-consent' };
  }
  await deps.saveCheck(true);
  return { on: true };
}

/**
 * The browser follows the setting: on (with every site still granted), the script is registered and the open tabs get
 * it and are armed; off, it goes, Live stops and every tab is disarmed. On without the permission (removed in the
 * browser's settings) reads as off and is saved so.
 */
export async function applyLiveCheck(on: boolean, deps: LiveCheckDeps): Promise<void> {
  if (on && (await deps.hasSites().catch(() => false))) {
    await deps.register();
    await deps.injectOpenTabs();
    await deps.tellOpenTabs({ type: 'live-check', on: true });
    return;
  }
  if (on) await deps.saveCheck(false);
  await deps.unregister();
  await deps.stopLive();
  await deps.tellOpenTabs({ type: 'live-check', on: false });
}

const webTab = (tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & { id: number } => tab.id !== undefined && /^(https?|file):/.test(tab.url ?? '');

export function liveCheckDeps(stopLive: () => Promise<void>): LiveCheckDeps {
  return {
    requestSites: () => chrome.permissions.request({ origins: ALL_SITES }),
    hasSites: () => chrome.permissions.contains({ origins: ALL_SITES }),
    hasConsent: async () => (await getConsent()) !== undefined,
    openConsent: () => openWelcome({ hash: CONSENT_HASH }),
    // Only the switch's own field: the rest of the live group as read here could be stale by the write.
    saveCheck: async (on) => {
      const { live } = await getSettings();
      if (live.check !== on) await setSettings({ live: { check: on } });
    },
    register: async () => {
      const held = await chrome.scripting.getRegisteredContentScripts({ ids: [LIVE_CHECK_SCRIPT] });
      if (held.length) return;
      await chrome.scripting.registerContentScripts([
        { id: LIVE_CHECK_SCRIPT, js: ['content.js'], matches: ALL_SITES, runAt: 'document_idle', allFrames: false, persistAcrossSessions: true },
      ]);
    },
    unregister: async () => {
      const held = await chrome.scripting.getRegisteredContentScripts({ ids: [LIVE_CHECK_SCRIPT] });
      if (held.length) await chrome.scripting.unregisterContentScripts({ ids: [LIVE_CHECK_SCRIPT] });
    },
    injectOpenTabs: async () => {
      const tabs = (await chrome.tabs.query({})).filter(webTab);
      // A page that refuses scripts (the stores, PDF viewers) is skipped; content.js runs once per page (__duelLens).
      await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => undefined)));
    },
    tellOpenTabs: async (message) => {
      const tabs = (await chrome.tabs.query({})).filter(webTab);
      await Promise.all(tabs.map((tab) => chrome.tabs.sendMessage(tab.id, message).catch(() => undefined)));
    },
    stopLive,
  };
}
