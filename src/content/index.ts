// Content script entry. The background injects it on demand (activeTab) with
// chrome.scripting.executeScript({ files: ['content.js'] }), possibly more than once,
// so it registers its listener only once per page (window.__duelLens).
//
// Messages (ToContent), answered with { ok: true }, from Duel Lens itself only (another extension
// that shares the tab can't show a toast or a frozen frame: security review M2/L3):
// - ping: "are you there?"
// - prepare-capture: take all Duel Lens UI off the page before the background captures it
//   (answered once the page has repainted without it), and grab the video frames just before the
//   screenshot, for the begin-selection that follows
// - begin-selection: freeze the page on the screenshot and let the user draw a box
// - cards-detected: the cards the detector found on that screenshot (matched by capturedAt; a
//   stale one is ignored), outlined so a click scans one
// - show-error: show a one-line notice
// Anything else is not for us: no response (only the background answers ToBackground).
//
// While Duel Lens is open it has focus (a11y review B1) and the videos that were playing are paused
// (live check m1). When it closes, focus goes back to the page's element that had it, and those
// videos play again; when it closes for a new scan (prepare-capture, begin-selection), both wait for
// that scan's close instead, so the new screenshot shows the page as the user left it.
import { h, render } from 'preact';
// The one constant used from the background's module (a plain string; the bundle keeps nothing else).
import { NO_CARD_DETECTOR } from '../background/offscreen-client';
import type { CardDetection, ToContent } from '../shared/messages';
import { App } from './app';
import { cropDetectedCard, cropSelection, decodeScreenshot, grabVideoFrames, type VideoFrameGrab } from './capture';
import { ensureFonts } from './fonts';
import { HOST_ID, mirrorState, mountHost, type Host } from './host';
import { pausePlaying, resume } from './playback';
import { createToastStore, Toast, type ToastStore } from './toast';

declare global {
  interface Window {
    __duelLens?: boolean;
  }
}

interface Session {
  host: Host;
  toasts: ToastStore;
  /** Identifies the screenshot this session froze on (begin-selection's capturedAt). */
  capturedAt: number;
  /** Hands the detector's answer for that screenshot to the UI. */
  detected(detection: CardDetection): void;
  /** Takes Duel Lens off the page. `forNextScan`: a new scan follows at once (see the top). */
  close(forNextScan?: boolean): void;
}

/** What a session closed for a new scan leaves to the next one: the videos it paused, and where focus goes back to. */
interface HandOver {
  videos: HTMLVideoElement[];
  opener: Focusable | null;
}

type Focusable = HTMLElement | SVGElement;

let session: Session | null = null;
/** A toast shown on its own (show-error with no session open). */
let toastOnly: { close(): void } | null = null;
/** A detection that came before its own begin-selection (kept for that screenshot only). */
let early: { capturedAt: number; detection: CardDetection } | null = null;
/**
 * A detection said this build has no card detector: later scans in this page start on the drag
 * hint instead of "Finding cards…", though they still outline any cards a detection brings. Only
 * that answer sets it (any detection's, a stale one's too: it holds for every screenshot); any
 * other failure is its own scan's, and the next shortcut waits for cards again (review M2).
 */
let detectorDown = false;

/** Safety net for prepare-capture if animation frames stall (e.g. an occluded window). */
const PREPARE_TIMEOUT_MS = 250;
/** How long what prepare-capture keeps (the video frames, a hand-over) waits for its begin-selection. */
const NEXT_SCAN_MS = 5000;

/** Video frames grabbed at prepare-capture, for the begin-selection that follows (released if none does). */
let grabbed: { grabs: VideoFrameGrab[]; timer: ReturnType<typeof setTimeout> } | null = null;
/** A session closed for a new scan: its hand-over, until that scan's begin-selection takes it (else it is let go). */
let handedOver: { h: HandOver; timer: ReturnType<typeof setTimeout> } | null = null;

function releaseGrabs(grabs: VideoFrameGrab[]) {
  for (const grab of grabs) {
    if (!grab?.canvas) continue;
    grab.canvas.width = 0;
    grab.canvas.height = 0;
  }
}

/** Grabs the video frames now, just before the screenshot (live check m1), for the next begin-selection. */
function grabForNextScan() {
  if (grabbed) {
    clearTimeout(grabbed.timer);
    releaseGrabs(grabbed.grabs);
  }
  const grabs = grabVideoFrames();
  const timer = setTimeout(() => {
    if (grabbed?.grabs !== grabs) return;
    grabbed = null;
    releaseGrabs(grabs);
  }, NEXT_SCAN_MS);
  grabbed = { grabs, timer };
}

/** The frames prepare-capture grabbed, or a grab now when there are none (the first scan in a tab). */
function takeGrabs(): VideoFrameGrab[] {
  const g = grabbed;
  grabbed = null;
  if (!g) return grabVideoFrames();
  clearTimeout(g.timer);
  return g.grabs;
}

/** The element that has focus on the page (inside open shadow roots too), or null when none has. */
function focusedElement(): Focusable | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el || el === document.body || el === document.documentElement || el.id === HOST_ID) return null;
  return el as Focusable;
}

/**
 * Gives focus back to the page's element that had it before Duel Lens opened (a11y review B1), so the
 * page's own keys (YouTube's space, K, F) work at once. Only when focus is nowhere (it was in the
 * overlay, now gone): never away from where the user moved it on the page.
 */
function restoreFocus(el: Focusable | null) {
  const now = document.activeElement;
  if (!el || !el.isConnected || (now && now !== document.body && now !== document.documentElement)) return;
  el.focus({ preventScroll: true });
}

/** Lets a hand-over go: its videos play again and focus goes back, as a plain close would have done. */
function letGo(h: HandOver) {
  resume(h.videos);
  restoreFocus(h.opener);
}

function handOver(h: HandOver) {
  const earlier = takeHandOver();
  const all = { videos: [...(earlier?.videos ?? []), ...h.videos], opener: earlier?.opener ?? h.opener };
  const timer = setTimeout(() => {
    if (handedOver?.h !== all) return;
    handedOver = null;
    letGo(all);
  }, NEXT_SCAN_MS);
  handedOver = { h: all, timer };
}

function takeHandOver(): HandOver | null {
  const t = handedOver;
  handedOver = null;
  if (!t) return null;
  clearTimeout(t.timer);
  return t.h;
}

function isToContent(msg: unknown): msg is ToContent {
  if (typeof msg !== 'object' || msg === null || 'target' in msg) return false;
  const type = (msg as { type?: unknown }).type;
  return (
    type === 'ping' || type === 'begin-selection' || type === 'cards-detected' || type === 'show-error' || type === 'prepare-capture'
  );
}

/**
 * Before the background captures the tab: remove every Duel Lens element (popover, frozen
 * frame, toasts, a host left by a reloaded extension), then answer once the page has
 * repainted without them: two animation frames, or a short timeout if frames stall.
 * Returns true when the answer is sent later.
 */
function prepareCapture(sendResponse: (r: unknown) => void): boolean {
  const shown = session !== null || toastOnly !== null || document.getElementById(HOST_ID) !== null;
  session?.close(true);
  toastOnly?.close();
  document.querySelectorAll(`#${HOST_ID}`).forEach((el) => el.remove());
  if (!shown) {
    grabForNextScan();
    sendResponse({ ok: true });
    return false;
  }
  let answered = false;
  const answer = () => {
    if (answered) return;
    answered = true;
    clearTimeout(timer);
    grabForNextScan(); // the page has repainted: the grab and the screenshot are milliseconds apart
    sendResponse({ ok: true });
  };
  const timer = setTimeout(answer, PREPARE_TIMEOUT_MS);
  requestAnimationFrame(() => requestAnimationFrame(answer));
  return true;
}

function beginSelection(screenshot: string, capturedAt: number) {
  session?.close(true);
  const before = takeHandOver();
  // Where focus goes back to when Duel Lens closes: where it was when the user first pressed the shortcut.
  const opener = before ? before.opener : focusedElement();
  let detected!: (d: CardDetection) => void;
  const detection = new Promise<CardDetection>((resolve) => (detected = resolve));
  if (early?.capturedAt === capturedAt) detected(early.detection);
  early = null;
  // The screenshot covers innerWidth x innerHeight, scrollbars included. Record that now: the
  // frozen frame is drawn at this size and the crop is scaled by it, even if the window changes.
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  // The video frames grabbed just before the screenshot (prepare-capture), else grabbed first thing
  // now: the video keeps playing until it is paused below.
  const grabs = takeGrabs();
  const shot = decodeScreenshot(screenshot);
  shot.catch(() => undefined); // reported by crop() if it is ever needed
  void ensureFonts();

  const host = mountHost();
  const toasts = createToastStore();
  let paused: HTMLVideoElement[] = before?.videos ?? [];
  const s: Session = {
    host,
    toasts,
    capturedAt,
    detected,
    close(forNextScan = false) {
      if (session !== s) return;
      session = null;
      toasts.dispose();
      render(null, host.root); // unmount: removes the key handler and listeners
      host.destroy();
      if (forNextScan) handOver({ videos: paused, opener });
      else letGo({ videos: paused, opener });
      // Release the pixels rather than wait for GC: a decoded 4K screenshot is tens of
      // MB, and so is each native video canvas (review C minor: "screenshot never
      // close()d; native canvases held"). A crop() call already in flight when this runs
      // already registered its own `await shot`/read of `grabs` first, so it still sees
      // live pixels (JS run-to-completion; this only closes/zeroes on the next tick).
      shot.then((bitmap) => bitmap.close()).catch(() => undefined);
      for (const grab of grabs) {
        if (!grab.canvas) continue;
        grab.canvas.width = 0;
        grab.canvas.height = 0;
      }
    },
  };
  session = s;
  render(
    h(App, {
      screenshot,
      viewport,
      crop: async (rect) => cropSelection(rect, await shot, grabs, { viewportWidth: viewport.w }),
      // The card's corners go with its crop: the engine straightens it from them (click-regression-report.md).
      cropCard: async (card) =>
        cropDetectedCard(card.shotRect, await shot, grabs, { viewportWidth: viewport.w, shotWidth: card.shotWidth, shotPts: card.shotPts }),
      detection,
      expectCards: !detectorDown,
      // The visible videos' pictures, where the outlines are kept when one is big (live check m4).
      videos: grabs.flatMap((g) => (g?.contentBox ? [g.contentBox] : [])),
      toasts,
      // E2E builds only: page-readable attributes would tell any site which card was scanned.
      onState: __DUEL_LENS_E2E__ ? (st) => mirrorState(host.host, st) : undefined,
      onDone: () => s.close(),
    }),
    host.root,
  );
  // The screenshot is taken, and the frozen frame now hides the page: the video stops running on
  // under it (live check m1), and plays again when Duel Lens closes.
  if (session === s) paused = [...paused, ...pausePlaying()];
}

/** The detector's cards for the screenshot taken at `capturedAt`: for the open session, or kept until its begin-selection comes. */
function cardsDetected(capturedAt: number, detection: CardDetection) {
  if (detection?.error === NO_CARD_DETECTOR) detectorDown = true;
  else if (detection?.boxes?.length > 0) detectorDown = false;
  if (session?.capturedAt === capturedAt) session.detected(detection);
  else early = { capturedAt, detection };
}

function showError(message: string) {
  if (session) {
    session.toasts.show(message);
    return;
  }
  // A scan that failed after prepare-capture (a restricted page, the capture quota): no
  // begin-selection comes, so the videos play again and focus goes back now.
  const left = takeHandOver();
  if (left) letGo(left);
  toastOnly?.close();
  const host = mountHost();
  const own = {
    close() {
      if (toastOnly !== own) return;
      toastOnly = null;
      toasts.dispose();
      render(null, host.root);
      host.destroy();
    },
  };
  const toasts = createToastStore(4000, () => own.close());
  toastOnly = own;
  render(h('div', { class: 'dl', lang: 'en' }, h(Toast, { store: toasts })), host.root);
  toasts.show(message);
}

if (!window.__duelLens) {
  window.__duelLens = true;
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    // Only Duel Lens itself talks to this script, not another extension that shares the tab.
    if (sender?.id !== chrome.runtime.id || !isToContent(msg)) return;
    try {
      if (msg.type === 'prepare-capture') return prepareCapture(sendResponse);
      if (msg.type === 'begin-selection') beginSelection(msg.screenshot, msg.capturedAt);
      else if (msg.type === 'cards-detected') cardsDetected(msg.capturedAt, msg.detection);
      else if (msg.type === 'show-error') showError(msg.message);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
