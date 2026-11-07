// Live, the background's side: one session at a time. The content script's loop (content/live) reads frames and
// reports; this keeps the LiveLog in chrome.storage.session (LIVE_KEY, which the side panel follows), starts and
// stops the loop on a tab, shows "LIVE" on that tab's toolbar badge and in the icon's menu, and passes Options
// changes on. Started by the live-toggle command (Alt+Shift+L), the icon's menu, the side panel's button and the
// `duelLensDebug` E2E hook; the user's consent comes first, as for a scan (scan.ts).
import { t } from '../shared/i18n';
import { LIVE, LIVE_KEY, applyProgress, isLiveLog, startLog, type LiveLog, type LiveProgress, type LiveStopReason } from '../shared/live';
import type { LiveQueryReply, LiveShowCardReply, LiveStartReply, LiveStartResponse, ToContent } from '../shared/messages';
import type { Settings } from '../shared/types';
import { getConsent } from './consent';
import { warmLiveOffscreen } from './offscreen-client';
import { getSettings } from './settings';
import { CONSENT_HASH, openWelcome } from './welcome-tab';

export const LIVE_COMMAND = 'live-toggle';

export interface LiveBackgroundDeps {
  /** The log in chrome.storage.session, or null when there is none. */
  getLog: () => Promise<LiveLog | null>;
  /** Writes the log; null removes it. */
  setLog: (log: LiveLog | null) => Promise<void>;
  sendMessageToTab: (tabId: number, message: unknown) => Promise<unknown>;
  /** Whether the tab's content script answers (scan.ts pings the same way). */
  ping: (tabId: number) => Promise<boolean>;
  injectContentScript: (tabId: number) => Promise<void>;
  /** Whether the user gave the first-run consent (consent.ts); Live does not start before it. */
  hasConsent: () => Promise<boolean>;
  /** Shows the welcome page's consent step instead of starting (welcome-tab.ts). */
  openConsent: (tab: chrome.tabs.Tab) => Promise<void>;
  /** "LIVE" on the tab's toolbar icon, or back to the default. */
  setBadge: (tabId: number, on: boolean) => Promise<void>;
  /** Told when Live starts or stops on a tab (the icon's menu now ticks Live check instead: menus.ts). */
  setMenuRunning: (running: boolean) => void;
  getSettings: () => Promise<Settings>;
  warmup: () => Promise<void>;
  now: () => number;
}

export interface LiveBackground {
  /** The shortcut and the menu item: stops Live on this tab if it runs there, otherwise starts it. */
  toggle(tab: chrome.tabs.Tab): Promise<void>;
  /** The toolbar menu's item: its title is one for all tabs, so it stops Live when it runs anywhere and starts it on `tab` otherwise. */
  toggleAnywhere(tab: chrome.tabs.Tab): Promise<void>;
  start(tab: chrome.tabs.Tab): Promise<LiveStartResponse>;
  /** Stops the running session, if any: tells its tab and marks the log stopped with `reason` at once. With `onlyTabId`, only when that tab is the live one. */
  stop(reason: LiveStopReason, onlyTabId?: number): Promise<void>;
  /** A report from the tab's loop (also the echo of a stop asked for here, which changes nothing more). Resolves to the list's entry count, undefined when the report is not for the log's tab. */
  progress(tabId: number, p: LiveProgress): Promise<number | undefined>;
  /** A click on a time in the side panel: seek the logged tab's video, also after Live stopped (not once the tab left the page). */
  seek(videoTime: number): Promise<void>;
  /** A click on a logged card in the side panel: show it over the live tab's video. `shown: false` when Live is not running (the panel shows it alone). */
  showCard(cardId: number, imageId: number): Promise<LiveShowCardReply>;
  /** The tab finished loading: if it no longer runs Live (it navigated or reloaded), the session ended. */
  tabUpdated(tabId: number, info: { status?: string }): Promise<void>;
  tabRemoved(tabId: number): Promise<void>;
  settingsChanged(s: Settings['live'], reveal?: Settings['display']['reveal']): Promise<void>;
}

const defaultDeps: LiveBackgroundDeps = {
  getLog: async () => {
    const stored = (await chrome.storage.session.get(LIVE_KEY))[LIVE_KEY];
    return isLiveLog(stored) ? stored : null;
  },
  setLog: async (log) => {
    if (log) await chrome.storage.session.set({ [LIVE_KEY]: log });
    else await chrome.storage.session.remove(LIVE_KEY);
  },
  sendMessageToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  ping: async (tabId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'ping' } satisfies ToContent);
      return true;
    } catch {
      return false;
    }
  },
  injectContentScript: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  },
  hasConsent: async () => (await getConsent()) !== undefined,
  openConsent: (tab) => openWelcome({ hash: CONSENT_HASH, nextTo: tab }),
  setBadge: async (tabId, on) => {
    await chrome.action.setBadgeText({ text: on ? LIVE.badgeText : '', tabId });
    if (on) await chrome.action.setBadgeBackgroundColor({ color: LIVE.badgeColor, tabId });
    await chrome.action.setTitle({ title: on ? t('bg_live_badge_title') : t('bg_action_title_default'), tabId });
  },
  setMenuRunning: () => {},
  getSettings,
  warmup: warmLiveOffscreen,
  now: () => Date.now(),
};

const isRunning = (log: LiveLog | null): log is LiveLog => log !== null && log.status !== 'stopped';

export function createLiveBackground(overrides: Partial<LiveBackgroundDeps> = {}): LiveBackground {
  const deps: LiveBackgroundDeps = { ...defaultDeps, ...overrides };

  // Every operation reads the log, changes it and writes it back, and the worker handles messages in parallel: one
  // chain keeps two of them from reading the same log and the second write undoing the first.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(job: () => Promise<T>): Promise<T> {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  }

  /** Badge and menu are best-effort: a tab that has gone must not fail the session. */
  async function show(tabId: number, on: boolean): Promise<void> {
    await deps.setBadge(tabId, on).catch(() => {});
    deps.setMenuRunning(on);
  }

  async function tell(tabId: number, message: ToContent): Promise<void> {
    try {
      await deps.sendMessageToTab(tabId, message);
    } catch {
      // The tab has gone or has no content script left; nothing to tell.
    }
  }

  async function stopNow(reason: LiveStopReason, onlyTabId?: number): Promise<void> {
    const log = await deps.getLog();
    if (!isRunning(log) || (onlyTabId !== undefined && log.tabId !== onlyTabId)) return;
    await tell(log.tabId, { type: 'live-stop', reason });
    await deps.setLog({ ...log, status: 'stopped', stopReason: reason });
    await show(log.tabId, false);
  }

  /**
   * A start on `tabId` was refused after the page may have ended its own run quietly (a changed page restarts): a log
   * for this tab still saying it runs is stopped with `reason`, and the badge and menu go off. Never creates a log.
   */
  async function endStale(tabId: number, reason: LiveStopReason): Promise<void> {
    const log = await deps.getLog();
    if (!log || log.tabId !== tabId || log.status === 'stopped') return;
    await deps.setLog({ ...log, status: 'stopped', stopReason: reason });
    await show(tabId, false);
  }

  async function startNow(tab: chrome.tabs.Tab): Promise<LiveStartResponse> {
    if (tab.id === undefined) return { ok: false, reason: 'needs-shortcut' };
    const tabId = tab.id;

    if (!(await deps.hasConsent().catch(() => false))) {
      await deps.openConsent(tab).catch((err) => console.error('Duel Lens: could not open the consent page', err));
      return { ok: false, reason: 'no-consent' };
    }

    // Scripting needs the permission a shortcut or the toolbar icon gives (activeTab); the side panel's button has
    // none, so on a page Duel Lens has not run on yet, the injection is refused and the user is pointed at the shortcut.
    if (!(await deps.ping(tabId))) {
      try {
        await deps.injectContentScript(tabId);
      } catch {
        return { ok: false, reason: 'needs-shortcut' };
      }
    }

    // Warm the engine while the page sets up; the loop's first frame waits for it anyway. Never throws (offscreen-client.ts).
    void deps.warmup();

    // The page answers with its page key, which says whether this is the page the log already holds. Its first
    // report (even an early "stopped") queues behind this start, so it finds the log written below.
    let reply: LiveStartReply;
    try {
      const settings = await deps.getSettings();
      const message: ToContent = { type: 'live-start', effort: settings.live.effort, showLabel: settings.live.showLabel, reveal: settings.display.reveal };
      reply = (await deps.sendMessageToTab(tabId, message)) as LiveStartReply;
    } catch {
      await endStale(tabId, 'left');
      return { ok: false, reason: 'needs-shortcut' };
    }
    if (!reply?.ok) {
      await endStale(tabId, reply?.reason ?? 'left');
      return { ok: false, reason: reply?.reason ?? 'needs-shortcut' };
    } // a refused start leaves the other tab's session as it was

    const prev = await deps.getLog();
    await deps.setLog(startLog(prev, { tabId, pageKey: reply.pageKey, pageUrl: tab.url ?? '', pageTitle: tab.title ?? '' }, deps.now()));
    // One session at a time: another tab's Live ends once this one has started.
    if (isRunning(prev) && prev.tabId !== tabId) {
      await tell(prev.tabId, { type: 'live-stop', reason: 'other-tab' });
      await deps.setBadge(prev.tabId, false).catch(() => {});
    }
    await show(tabId, true);
    return { ok: true };
  }

  return {
    start: (tab) => serial(() => startNow(tab)),
    stop: (reason, onlyTabId) => serial(() => stopNow(reason, onlyTabId)),

    toggle: (tab) =>
      serial(async () => {
        if (tab.id === undefined) return;
        const log = await deps.getLog();
        if (isRunning(log) && log.tabId === tab.id) await stopNow('user');
        else await startNow(tab);
      }),

    toggleAnywhere: (tab) =>
      serial(async () => {
        if (isRunning(await deps.getLog())) await stopNow('user');
        else await startNow(tab);
      }),

    progress: (tabId, p) =>
      serial(async () => {
        const log = await deps.getLog();
        if (!log || log.tabId !== tabId) return undefined;
        if (log.status === 'stopped') {
          // The echo of a stop asked for here (or a late report): its sightings still count, its status does not.
          const next = { ...applyProgress(log, p), status: 'stopped' as const, stopReason: log.stopReason };
          await deps.setLog(next);
          return next.entries.length;
        }
        const next = applyProgress(log, p);
        await deps.setLog(next);
        if (next.status === 'stopped') await show(tabId, false);
        return next.entries.length;
      }),

    seek: (videoTime) =>
      serial(async () => {
        // A stopped session keeps its list and its times; they work while the page is still the one that was logged.
        const log = await deps.getLog();
        if (log && log.stopReason !== 'left') await tell(log.tabId, { type: 'live-seek', videoTime });
      }),

    showCard: (cardId, imageId) =>
      serial(async () => {
        try {
          const log = await deps.getLog();
          if (!isRunning(log)) return { shown: false };
          const reply = (await deps.sendMessageToTab(log.tabId, { type: 'live-show-card', cardId, imageId } satisfies ToContent)) as LiveShowCardReply | undefined;
          return { shown: reply?.shown === true };
        } catch {
          return { shown: false };
        }
      }),

    tabUpdated: (tabId, info) =>
      serial(async () => {
        if (info.status !== 'complete') return;
        const log = await deps.getLog();
        if (!isRunning(log) || log.tabId !== tabId) return;
        let reply: LiveQueryReply | undefined;
        try {
          reply = (await deps.sendMessageToTab(tabId, { type: 'live-query' } satisfies ToContent)) as LiveQueryReply | undefined;
        } catch {
          reply = undefined;
        }
        if (reply?.running) return;
        const now = await deps.getLog(); // it may have changed while the tab answered
        if (!isRunning(now) || now.tabId !== tabId) return;
        await deps.setLog({ ...now, status: 'stopped', stopReason: 'left' });
        await show(tabId, false);
      }),

    tabRemoved: (tabId) =>
      serial(async () => {
        const log = await deps.getLog();
        if (!log || log.tabId !== tabId) return;
        await deps.setLog(null);
        deps.setMenuRunning(false);
      }),

    settingsChanged: (s, reveal) =>
      serial(async () => {
        const log = await deps.getLog();
        if (isRunning(log)) await tell(log.tabId, { type: 'live-settings', effort: s.effort, showLabel: s.showLabel, reveal });
      }),
  };
}

/** The one session of this worker: the router (side panel's button, content script's reports) and index.ts (command, menu, tabs) share it. */
export const liveBackground: LiveBackground = createLiveBackground();
