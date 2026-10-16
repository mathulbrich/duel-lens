// Kicks off a scan: ask the content script to hide its own UI, capture the tab, get
// the content script running, hand it the screenshot, and warm up the offscreen
// recognizer in parallel; then find every card on the screenshot (click to scan) and send
// them to the tab. When the tab shows a readable video whose native frame gives the detector more pixels of
// the picture, that frame is detected too and adds the cards the screenshot's run missed (small cards:
// frame-detect.ts). Triggered by the scan-card command, the toolbar action, and the
// `duelLensDebug` E2E hook (index.ts). Pressed while scan mode is open in the tab, the same
// trigger leaves scan mode instead: the tab says so in its answer to prepare-capture.
import { t } from '../shared/i18n';
import type { CardDetection, PrepareCaptureReply, ToContent } from '../shared/messages';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { getConsent } from './consent';
import { FRAME_SKIPPED_ON_WASM, frameOf, mergeFrameDetection, type DetectFrame } from './frame-detect';
import { detectCards, knownNoCardDetector, NO_CARD_DETECTOR, warmupOffscreen } from './offscreen-client';
import { getSettings } from './settings';
import { CONSENT_HASH, openWelcome } from './welcome-tab';

export interface ScanDeps {
  captureVisibleTab: (windowId: number) => Promise<string>;
  sendMessageToTab: (tabId: number, message: unknown) => Promise<unknown>;
  injectContentScript: (tabId: number) => Promise<void>;
  setBadgeText: (text: string, tabId: number) => Promise<void>;
  setBadgeTitle: (title: string, tabId: number) => Promise<void>;
  warmup: () => Promise<void>;
  /**
   * Every card on a screenshot (offscreen-client.ts), or with `frame` on a native video frame; never throws, a
   * failure is an empty detection with `error`.
   */
  detectCards: (image: string, opts?: { frame?: boolean }) => Promise<CardDetection>;
  /**
   * The tab's native video frame for the screenshot taken at `capturedAt` (grab-frame, content/index.ts), when a
   * readable one gives the detector more pixels than the screenshot; undefined otherwise or on any failure.
   */
  grabFrame: (tabId: number, capturedAt: number) => Promise<DetectFrame | undefined>;
  /**
   * Set once the offscreen document said its detector runs on WASM (FRAME_SKIPPED_ON_WASM): later scans ask the tab
   * for no frame (no JPEG encode in the page). Kept for the service worker's life; a restarted one asks once more.
   */
  frameRuns?: { off: boolean };
  /** Whether an earlier detection said this build has no card detector (offscreen-client.ts). */
  noCardDetector: () => Promise<boolean>;
  /** Whether the user gave the first-run consent (consent.ts); no scan happens before it. */
  hasConsent: () => Promise<boolean>;
  /** Shows the welcome page's consent step instead of scanning (welcome-tab.ts). */
  openConsent: (tab: chrome.tabs.Tab) => Promise<void>;
  /** How card details show in scan mode ("Show card details" in Options: Settings.display.reveal, settings.ts). */
  reveal: () => Promise<Settings['display']['reveal']>;
  /** Which banlist the card chip shows ("Banlist" in Options: Settings.display.banlist, settings.ts). */
  banlist: () => Promise<Settings['display']['banlist']>;
  now: () => number;
}

export const DEFAULT_TITLE = t('bg_action_title_default');
export const RESTRICTED_PAGE_TITLE = t('bg_restricted_page_title');
/**
 * A scan that failed on a page Duel Lens runs on (its content script took the show-error): the capture
 * itself failed (Chrome allows two captures a second), or the selection couldn't start. The page can
 * be read, so the badge doesn't say it can't (final review M1).
 */
export const SCAN_FAILED_TITLE = t('bg_scan_failed_title');
/** The notice a page shows when a scan fails there (show-error). */
export const SCAN_FAILED_MESSAGE = t('bg_scan_failed_message');
const PREPARE_CAPTURE_TIMEOUT_MS = 300;
/** How long the tab gets to hand over its video frame (a JPEG encode of the grab it already holds). */
const GRAB_FRAME_TIMEOUT_MS = 1000;
/**
 * How long the outlines wait for the frame's detection once the screenshot's has come: past this, the
 * screenshot's cards go alone (a slow WASM run, a busy queue). Measured: features4-fullres.md.
 */
export const FRAME_DETECT_WAIT_MS = 1000;
/** How long a failed scan waits for the tab to take its show-error before setting the badge. */
const SHOW_ERROR_TIMEOUT_MS = 300;

const defaultDeps: ScanDeps = {
  captureVisibleTab: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
  sendMessageToTab: (tabId, message) => chrome.tabs.sendMessage(tabId, message),
  injectContentScript: async (tabId) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  },
  // Per tab (review Critical 1 / Minor 3): a global badge would say "can't read this
  // page" on every tab just because one chrome:// scan failed.
  setBadgeText: (text, tabId) => chrome.action.setBadgeText({ text, tabId }),
  setBadgeTitle: (title, tabId) => chrome.action.setTitle({ title, tabId }),
  warmup: warmupOffscreen,
  detectCards,
  grabFrame: async (tabId, capturedAt) => {
    try {
      const ask: ToContent = { type: 'grab-frame', capturedAt };
      return frameOf(await withTimeout(Promise.resolve(chrome.tabs.sendMessage(tabId, ask)), GRAB_FRAME_TIMEOUT_MS));
    } catch {
      return undefined; // no answer (an older content script), a tab that has gone, or no answer in time
    }
  },
  frameRuns: { off: false },
  noCardDetector: knownNoCardDetector,
  hasConsent: async () => (await getConsent()) !== undefined,
  openConsent: (tab) => openWelcome({ hash: CONSENT_HASH, nextTo: tab }),
  reveal: async () => (await getSettings()).display.reveal,
  banlist: async () => (await getSettings()).display.banlist,
  now: () => Date.now(),
};

/**
 * A scan that failed after prepare-capture: at the capture, or before its selection started. It first
 * tells the tab, best-effort (harmless when the tab has no content script): a content script that
 * handed its paused videos and focus over to this scan gets them back at once, rather than after its
 * 5 s wait (content/index.ts), and says why on the page. Then the badge: the tab taking the message
 * means Duel Lens runs on this page, so the scan failed on a page it can read (SCAN_FAILED_TITLE);
 * otherwise it is taken for a page Duel Lens can't script, like chrome:// or the Web Store.
 */
async function reportScanFailure(deps: ScanDeps, tabId: number): Promise<void> {
  let told = false;
  try {
    const failed: ToContent = { type: 'show-error', message: SCAN_FAILED_MESSAGE };
    await withTimeout(Promise.resolve(deps.sendMessageToTab(tabId, failed)), SHOW_ERROR_TIMEOUT_MS);
    told = true;
  } catch {
    // No content script (a restricted page, or none injected yet), a tab that has gone, or no answer in time.
  }
  await deps.setBadgeText('!', tabId);
  await deps.setBadgeTitle(told ? SCAN_FAILED_TITLE : RESTRICTED_PAGE_TITLE, tabId);
}

/** Races `promise` against a `ms` timer; rejects on whichever comes first. Doesn't
 * cancel `promise` itself - there is nothing to cancel a chrome.tabs.sendMessage
 * call with - it just stops waiting on it. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Tells the content script to hide its own UI before the screenshot is taken, so a
 * visible popover/toast never ends up baked into the capture. Best-effort: there may
 * be no content script yet (nothing has scanned this tab before), it may not answer in
 * time, or the page may be one Duel Lens can't script at all - every failure (a
 * rejection or the 300ms timeout) is swallowed, and the scan proceeds regardless.
 * Resolves 'closed' only when the tab answers that scan mode was open and this press
 * closed it (PrepareCaptureReply.closed === true): then no capture follows. Any other
 * answer, none, or none in time means 'capture'.
 */
async function prepareCapture(deps: ScanDeps, tabId: number): Promise<'capture' | 'closed'> {
  try {
    const prepare: ToContent = { type: 'prepare-capture' };
    const reply = await withTimeout(deps.sendMessageToTab(tabId, prepare), PREPARE_CAPTURE_TIMEOUT_MS);
    return (reply as Partial<PrepareCaptureReply> | undefined)?.closed === true ? 'closed' : 'capture';
  } catch {
    // No content script, "Receiving end does not exist", a timeout, anything else:
    // capture the frame as-is rather than delaying or failing the scan over this.
    return 'capture';
  }
}

/**
 * Full resolution (frame-detect.ts): the tab's video frame for this screenshot, and the detector's cards on it.
 * Undefined when the tab has no frame to give (no readable video, or one that adds no pixels) or anything fails.
 */
async function detectOnFrame(deps: ScanDeps, tabId: number, capturedAt: number): Promise<{ frame: DetectFrame; detection: CardDetection } | undefined> {
  if (deps.frameRuns?.off) return undefined;
  try {
    const frame = await deps.grabFrame(tabId, capturedAt);
    if (!frame) return undefined;
    const detection = await deps.detectCards(frame.dataUrl, { frame: true });
    if (detection.error === FRAME_SKIPPED_ON_WASM && deps.frameRuns) deps.frameRuns.off = true;
    return { frame, detection };
  } catch {
    return undefined;
  }
}

/**
 * The screenshot's cards, plus the frame's that it missed (mergeFrameDetection). Waits for the frame's at most
 * FRAME_DETECT_WAIT_MS after the screenshot's; without it, or when the screenshot's detection failed, the
 * screenshot's detection goes as it is.
 */
async function withFrameCards(detecting: Promise<CardDetection>, framing: Promise<{ frame: DetectFrame; detection: CardDetection } | undefined>): Promise<CardDetection> {
  const shot = await detecting;
  if (shot.error) return shot;
  const onFrame = await withTimeout(framing, FRAME_DETECT_WAIT_MS).catch(() => undefined);
  if (!onFrame) return shot;
  try {
    return mergeFrameDetection(shot, onFrame.detection, onFrame.frame);
  } catch {
    return shot; // the merge failing never costs the screenshot's own outlines
  }
}

/**
 * Click to scan: once the detector has found the cards on the screenshot, sends them to the tab,
 * which outlines them for the user to click (matched to its selection by `capturedAt`). Sent
 * also when there are none, with the reason, so the tab can stop waiting. Dropped silently when
 * the tab has gone (closed, navigated away).
 */
async function sendDetection(deps: ScanDeps, tabId: number, capturedAt: number, detecting: Promise<CardDetection>): Promise<void> {
  let detection: CardDetection;
  try {
    detection = await detecting;
  } catch (e) {
    detection = { boxes: [], width: 0, height: 0, ms: 0, error: e instanceof Error ? e.message : String(e) };
  }
  const message: ToContent = { type: 'cards-detected', capturedAt, detection };
  try {
    await deps.sendMessageToTab(tabId, message);
  } catch {
    // The tab is gone, or no longer has the content script: nobody to outline the cards for.
  }
}

/**
 * Captures the visible tab, ensures the content script is running, tells it to start
 * the selection over the frozen screenshot, and warms up the offscreen recognizer.
 * Right after begin-selection goes out, the detector looks for every card on the same
 * screenshot; the cards follow as `cards-detected` when it has finished (not awaited here).
 * When an earlier detection said this build has no card detector, that answer goes to the tab
 * just before begin-selection instead, and nothing is detected.
 * Never throws: on a restricted page (chrome://, the Web Store, ...) `captureVisibleTab`
 * itself can succeed (per Chrome's activeTab docs), but the ping and injection that
 * follow it then fail - so *any* failure from there through `begin-selection` is
 * reported on that tab's badge, exactly like a capture failure (review Critical 1: the
 * previous version only caught the capture step, so a chrome:// scan failed silently).
 * Both failures are also told to the tab (show-error, reportScanFailure), for a content script
 * that is waiting on this scan.
 * Before the first-run consent (the Chrome Web Store's rule: legal-audit.md B4), it only opens the
 * welcome page's consent step: no message, capture or script reaches the page.
 * Scan mode stays open after a read (UX-1), so a press while it is open leaves it: the tab closes it
 * and answers prepare-capture with `closed: true`, and nothing more happens (no capture, no badge).
 * begin-selection carries how card details show (`reveal`, "Show card details" in Options) and which
 * banlist the chip shows (`banlist`), both read while the tab is captured; the defaults, 'hover' and
 * 'tcg', when the settings can't be read.
 */
export async function startScan(tab: chrome.tabs.Tab, deps: ScanDeps = defaultDeps): Promise<void> {
  if (tab.id === undefined) return;
  const tabId = tab.id;

  if (!(await deps.hasConsent().catch(() => false))) {
    await deps.openConsent(tab).catch((err) => console.error('Duel Lens: could not open the consent page', err));
    return;
  }

  if ((await prepareCapture(deps, tabId)) === 'closed') return;

  // Read alongside the capture below, so it never delays the selection.
  const reveal = deps.reveal().catch(() => DEFAULT_SETTINGS.display.reveal);
  const banlist = deps.banlist().catch(() => DEFAULT_SETTINGS.display.banlist);

  let screenshot: string;
  try {
    screenshot = await deps.captureVisibleTab(tab.windowId);
  } catch {
    await reportScanFailure(deps, tabId);
    return;
  }
  const capturedAt = deps.now();
  // Clear any stale error badge from a previous restricted-page attempt.
  await deps.setBadgeText('', tabId);
  await deps.setBadgeTitle(DEFAULT_TITLE, tabId);

  // Fire-and-forget, started as early as possible and run alongside messaging the
  // tab below (review Minor 4) - not awaited here, so a slow model/index load never
  // delays showing the selection overlay.
  void deps.warmup();
  const noDetector = deps.noCardDetector().catch(() => false); // unknown: ask the detector below

  let detecting: Promise<CardDetection> | undefined;
  let framing: Promise<{ frame: DetectFrame; detection: CardDetection } | undefined> | undefined;
  try {
    try {
      await deps.sendMessageToTab(tabId, { type: 'ping' });
    } catch {
      await deps.injectContentScript(tabId);
    }
    const begin: ToContent = { type: 'begin-selection', screenshot, capturedAt, reveal: await reveal, banlist: await banlist };
    if (await noDetector) {
      // An earlier detection said this build has no card detector (click-review.md M1). The tab
      // hears it before the selection starts, so it opens on the drag hint without a "Finding
      // cards…" flash, and the screenshot isn't sent to the offscreen document for a known answer.
      const none: ToContent = { type: 'cards-detected', capturedAt, detection: { boxes: [], width: 0, height: 0, ms: 0, error: NO_CARD_DETECTOR } };
      await deps.sendMessageToTab(tabId, none);
      await deps.sendMessageToTab(tabId, begin);
      return;
    }
    const begun = deps.sendMessageToTab(tabId, begin);
    // Asked for only once begin-selection is on its way (both carry the screenshot, so this never
    // delays the overlay), but without waiting for the tab to take it.
    detecting = deps.detectCards(screenshot);
    await begun;
    // Asked for once the tab has its selection (the frame is the session's own grab), while the screenshot's
    // detection runs: the frame's JPEG and its decoding overlap that run, and only its own model run follows it.
    framing = detectOnFrame(deps, tabId, capturedAt);
  } catch {
    detecting?.catch(() => {}); // no selection to outline the cards on
    await reportScanFailure(deps, tabId);
    return;
  }
  void sendDetection(deps, tabId, capturedAt, withFrameCards(detecting, framing));
}
