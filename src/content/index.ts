// Content script entry. The background injects it on demand (activeTab) with
// chrome.scripting.executeScript({ files: ['content.js'] }), possibly more than once,
// so it registers its listener only once per page (window.__duelLens).
//
// Messages (ToContent), answered with { ok: true }, from Duel Lens itself only (another extension
// that shares the tab can't show a toast or a frozen frame: security review M2/L3):
// - ping: "are you there?"
// - prepare-capture: the shortcut (or the toolbar icon) was pressed. While scan mode is open, that
//   closes it: answered { ok: true, closed: true } at once, and no capture follows (PrepareCaptureReply).
//   Otherwise take all Duel Lens UI off the page before the background captures it (answered once the
//   page has repainted without it), and grab the video frames just before the screenshot, for the
//   begin-selection that follows
// - begin-selection: freeze the page on the screenshot: scan mode, until the user leaves it (app.tsx)
// - cards-detected: the cards the detector found on that screenshot (matched by capturedAt; a
//   stale one is ignored), outlined so a click reads one
// - show-error: show a one-line notice
// - grab-frame: hand over the open session's video frame (the one grabbed with its screenshot) for the
//   detector, when a readable one gives it more pixels than the screenshot (capture.ts frameForDetection);
//   answered GrabFrameReply, without a frame otherwise (background/frame-detect.ts)
// Anything else is not for us: no response (only the background answers ToBackground).
//
// In the Firefox build, while scan mode is open the content script pings the background so its event
// page, where the engine runs, isn't suspended under the user (keep-alive.ts, decision D-FF3).
//
// While Duel Lens is open it has focus (a11y review B1) and the videos that were playing are paused
// (live check m1). When it closes, focus goes back to the page's element that had it, and those
// videos play again; when a begin-selection replaces an open session, the new one takes both over and
// gives them back when it closes.
import type { CardRecord, Settings } from '../shared/types';
import { isLiveEffort, type LiveEffort } from '../shared/live';
import { setUiMessages, t, uiLang } from '../shared/i18n';
import { h, render } from 'preact';
// The one constant used from the background's module (a plain string; the bundle keeps nothing else).
import { NO_CARD_DETECTOR } from '../background/offscreen-client';
import { displayImageId } from '../shared/alt-artwork';
import { sendToBackground, WARM_STEPS, type CardDetection, type GrabFrameReply, type LiveQueryReply, type LiveShowCardReply, type LiveStartReply, type PrepareCaptureReply, type RecognizeResponse, type ToContent } from '../shared/messages';
import { App, GRACE_MS } from './app';
import { cropDetectedCard, cropSelection, decodeScreenshot, encodeFrame, frameForDetection, grabVideoFrames, type VideoFrameGrab } from './capture';
import { ensureFonts } from './fonts';
import type { Rect } from './geometry';
import { cardTextCss } from '../shared/card-text';
import { HOST_ID, mirrorState, mountHost, setHostPrefs, type Host } from './host';
import { createLiveController, type LiveController, type LiveView } from './live/controller';
import { createLiveArm } from './live/arm';
import { createWarmPoll } from './live/warm-poll';
import { createPictureReader } from './live/pictures';
import { LiveCardBox } from './live/card-box';
import { trackNoLongerShows } from './live/stale';
import { cardAt, LiveHoverCard, LiveOutlines } from './live/outlines';
import { viewportRectOf } from './live/video';
import { fromUser } from './trusted';
import { LivePill } from './live/pill';
import { startKeepAlive } from './keep-alive';
import { pausePlaying, resume } from './playback';
import { setBanlist } from './prefs';
import { createToastStore, Toast, type ToastStore } from './toast';

/** The host of Live's pill: its own, so the scan's host never removes it and it never removes the scan's. */
const LIVE_HOST_ID = 'duel-lens-live';

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
  /** The video frame grabbed with that screenshot, for the detector (grab-frame), when it gives it more pixels. */
  frame(): GrabFrameReply['frame'];
  /**
   * Takes Duel Lens off the page: focus goes back to the page, and the videos it paused play again. For a
   * new scan (`forNextScan`), it hands both over to that scan instead (returned).
   */
  close(forNextScan?: boolean): HandOver;
}

/** What a session closed for a new scan leaves to the next one: the videos it paused, and where focus goes back to. */
interface HandOver {
  videos: HTMLVideoElement[];
  opener: Focusable | null;
}

type Focusable = HTMLElement | SVGElement;

let session: Session | null = null;
/** Live's loop for this page, created on first use. */
let liveController: LiveController | null = null;
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
/** How long the video frames prepare-capture grabbed wait for their begin-selection. */
const NEXT_SCAN_MS = 5000;

/** Video frames grabbed at prepare-capture, for the begin-selection that follows (released if none does). */
let grabbed: { grabs: VideoFrameGrab[]; timer: ReturnType<typeof setTimeout> } | null = null;

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

/** Leaving: the videos Duel Lens paused play again, and focus goes back to the page. */
function letGo(h: HandOver) {
  resume(h.videos);
  restoreFocus(h.opener);
}

/** Live's host: the pill and the outlines on the video while Live runs and its label is on, and the card box a click opened. */
let livePill: Host | null = null;
let liveView: LiveView | null = null;
/** The card box over the video (live/card-box.tsx): a Live row's or an outline's click; it stays where it opened. */
let liveBox: { seq: number; trackId?: number; cardId: number; response: RecognizeResponse; anchor: Rect; images: Record<number, string | null> } | null = null;
let liveBoxSeq = 0;
/** How card details show on hover over the video ("Show card details" in Options, passed with live-start and live-settings). */
let liveReveal: RevealMode = 'click';
/** The card records Live has fetched, for the outlines' names, the preview and the box. */
const liveRecords = new Map<number, CardRecord>();
/** What the pointer on a listed outline shows (the quick preview or the passive box): the card read by name, where, and its artwork. */
/** `reading`: the pointed card has no answer yet, and the box shows its loading state (`response` null, ids -1). */
let liveHover: { seq: number; trackId?: number; picture?: boolean; reading?: true; cardId: number; imageId: number; response: RecognizeResponse | null; anchor: Rect; images: Record<number, string | null> } | null = null;
let liveHoverSeq = 0;
let liveHoverHide: ReturnType<typeof setTimeout> | undefined;
let overLivePreview = false;
/** The pointer's last point over the page, the track under it on Live's video (cardAt), and that track's card when
 *  listed: only it is outlined, and the pointer on a listed one shows its card at once. */
let livePointer: { x: number; y: number } | null = null;
let livePointed: number | null = null;
let livePointedKey = '';

function closeLiveBox() {
  liveBox = null;
  paintLive();
}

function hideLiveHover() {
  liveHoverSeq++;
  clearTimeout(liveHoverHide);
  liveHoverHide = undefined;
  overLivePreview = false;
  if (!liveHover) return;
  liveHover = null;
  paintLive();
}

/** Whether the pointer is on the card Live's box shows. A box that grows (its loading state taking the card) can pass
 *  under a still pointer before it is placed again; on a slow computer it then gets a leave though the pointer never
 *  left the card. */
function pointerOnShown(): boolean {
  const v = liveView;
  if (!liveHover || liveHover.picture || !v?.running || !v.video || !livePointer) return false;
  return cardAt(v.cards, v.video, livePointer.x, livePointer.y)?.trackId === liveHover.trackId;
}

/** The pointer left the outline (or the preview): what it showed goes after GRACE_MS, unless the pointer is on the
 *  preview, or still on the card it shows, by then. */
function leaveLiveHover() {
  if (!liveHover) {
    liveHoverSeq++; // a lookup still under way is no longer wanted
    return;
  }
  if (liveHoverHide) return;
  liveHoverHide = setTimeout(() => {
    liveHoverHide = undefined;
    if (!overLivePreview && !pointerOnShown()) hideLiveHover();
  }, GRACE_MS);
}

/** Draws what Live shows now; the host goes when there is nothing to show. */
function paintLive() {
  const v = liveView;
  const label = !!v && v.running && v.showLabel && !!v.video;
  if (!label && !liveBox && !liveHover) {
    if (!livePill) return;
    render(null, livePill.root);
    livePill.destroy();
    livePill = null;
    return;
  }
  // A host removed by the page or by prepare-capture is mounted again.
  if (!livePill?.host.isConnected) livePill = mountHost({ id: LIVE_HOST_ID });
  render(
    h(
      'div',
      { class: 'dl', lang: uiLang() },
      label
        ? h(LivePill, {
            view: v,
            warm: { done: warmPoll.done, total: WARM_STEPS.length },
            onStop: () => void sendToBackground({ type: 'live-stop' }).catch(() => undefined),
            // Chrome may not carry the click's gesture to the background: then the reply says how to open the panel.
            onOpen: () =>
              void sendToBackground({ type: 'live-open-panel' }).then(
                (r) => {
                  if (!r.ok && r.error) showError(r.error);
                },
                () => undefined,
              ),
          })
        : null,
      label ? h(LiveOutlines, { cards: v.cards, video: v.video as HTMLVideoElement, pointed: livePointed }) : null,
      liveHover && !liveBox
        ? h(LiveHoverCard, {
            reveal: liveReveal,
            shown: liveHover,
            onEnter: () => {
              overLivePreview = true;
              clearTimeout(liveHoverHide);
              liveHoverHide = undefined;
            },
            onLeave: (e: PointerEvent) => {
              overLivePreview = false;
              if (fromUser(e) && liveHover?.picture) {
                // Back on its card (or the box moved off a still pointer): it stays, and the picture reader lets it
                // go when the pointer leaves the card (pictures.ts).
                const a = liveHover.anchor;
                if (e.clientX >= a.x && e.clientX <= a.x + a.w && e.clientY >= a.y && e.clientY <= a.y + a.h) {
                  pictures.own(a); // it may have let the card go on the way to the box (the gap between them)
                  return;
                }
              } else if (fromUser(e) && liveView?.running) {
                // Where the pointer went: a frame (an ad, a chat) keeps its moves from the page, so this may be the
                // last point Live sees. On another card, that card's box takes over (pointLive).
                const before = livePointedKey;
                pointerAt(e.clientX, e.clientY);
                if (livePointedKey !== before) return;
              }
              leaveLiveHover(); // the timer keeps the box while the pointer is on its card (pointerOnShown)
            },
            onPick: () => {
              const picked = liveHover;
              hideLiveHover();
              if (picked) void openLiveBox(picked.cardId, picked.imageId, picked.anchor, picked.trackId, picked.picture === true);
            },
            onClose: hideLiveHover,
          })
        : null,
      liveBox ? h(LiveCardBox, { key: liveBox.seq, response: liveBox.response, anchor: liveBox.anchor, images: liveBox.images, onClose: closeLiveBox }) : null,
    ),
    livePill.root,
  );
}

/** Live's "getting ready" (warm-poll.ts): the engine's start steps done, while a run waits for its first detection. */
const warmPoll = createWarmPoll({ doc: document, ask: () => sendToBackground({ type: 'live-warm-state' }), onChange: () => paintLive() });

function showLivePill(v: LiveView) {
  liveView = v;
  warmPoll.follow(v.running && !v.ready);
  if (!v.running) liveBox = null; // Live stopped: its box goes with it
  // Its card is no longer outlined, or its track is read again; a card still being read: its track is gone.
  if (liveHover?.reading && !liveHover.picture) {
    if (!v.cards.some((c) => c.trackId === liveHover!.trackId)) hideLiveHover();
  } else if (liveHover && !liveHover.picture && (!v.cards.some((c) => c.cardId === liveHover!.cardId) || trackNoLongerShows(v.cards, liveHover.trackId, liveHover.cardId))) hideLiveHover();
  if (liveBox && trackNoLongerShows(v.cards, liveBox.trackId, liveBox.cardId)) liveBox = null; // its track is read again: the name may be stale
  if (!v.running) livePointer = null; // a later start begins with no pointer, as the loop does
  pointLive(); // a card listed under a resting pointer shows now
  paintLive();
  // The outlines are named by their cards: fetch the records not held yet.
  const missing = [...new Set(v.cards.flatMap((c) => (c.cardId !== undefined && !liveRecords.has(c.cardId) ? [c.cardId] : [])))];
  if (missing.length) {
    void sendToBackground({ type: 'get-cards', ids: missing })
      .then((got) => {
        for (const id of missing) if (got?.cards?.[id]) liveRecords.set(id, got.cards[id]);
        paintLive();
      })
      .catch(() => undefined);
  }
}

/** A card record, from what Live holds or the background. */
async function liveRecord(cardId: number): Promise<CardRecord | undefined> {
  const held = liveRecords.get(cardId);
  if (held) return held;
  const got = await sendToBackground({ type: 'get-cards', ids: [cardId] }).catch(() => undefined);
  const card = got?.cards?.[cardId];
  if (card) liveRecords.set(cardId, card);
  return card;
}

/** A card found by name, as the popover and the preview take it: one candidate, no crop, no history entry, no AI. */
/** The box's answer for a card Live read: sure (shown as found by name), or `unsure` ("Not sure", with the read's score). */
function liveResponse(card: CardRecord, imageId: number, unsure?: { score?: number }): RecognizeResponse {
  return {
    result: {
      candidates: [{ cardId: card.id, imageId, score: unsure?.score ?? 0, source: unsure ? 'embedding' : 'name' }],
      confident: !unsure,
      faceDown: false,
      modelId: '',
      timings: {},
    },
    cards: { [card.id]: card },
    aiEnabled: false,
  };
}

/** The card's artwork for the box (not the preview: it has no image), handed to `apply` with the image ids it shows under. */
function loadLiveImage(card: CardRecord, imageId: number, apply: (images: Record<number, string>) => void) {
  if (!__DUEL_LENS_REMOTE_IMAGES__) return;
  const shownImage = displayImageId(imageId, card);
  void sendToBackground({ type: 'get-image', imageId: shownImage, size: 'full' })
    .then((r) => r?.dataUrl && apply({ [imageId]: r.dataUrl, [shownImage]: r.dataUrl }))
    .catch(() => undefined);
}

/** The card box over the video at `anchor`, replacing any open one. Live reads on. */
/** `picture`: a picture's card (pictures.ts), which needs no video session running. */
async function openLiveBox(cardId: number, imageId: number, anchor: Rect | ((cardId: number) => Rect), trackId?: number, picture = false): Promise<LiveShowCardReply> {
  const running = () => picture || liveController?.query().running === true;
  if (!running()) return { shown: false };
  const card = await liveRecord(cardId);
  if (!card || !running()) return { shown: false };
  if (liveView && trackNoLongerShows(liveView.cards, trackId, cardId)) return { shown: false }; // its track was reset while the record loaded
  const seq = ++liveBoxSeq;
  liveBox = { seq, trackId, cardId, response: liveResponse(card, imageId), anchor: typeof anchor === 'function' ? anchor(cardId) : anchor, images: {} };
  hideLiveHover();
  paintLive();
  loadLiveImage(card, imageId, (images) => {
    if (liveBox?.seq !== seq) return;
    liveBox = { ...liveBox, images };
    paintLive();
  });
  return { shown: true };
}

/** A Live row's click: the card over the playing video, beside its track or at the video's corner. */
function showLiveCard(cardId: number, imageId: number): Promise<LiveShowCardReply> {
  return openLiveBox(cardId, imageId, (id) => liveController!.anchorFor(id));
}

/** A trusted pointer move: the loop reads the card there first, and the card under it is outlined (pointLive). Moves on
 *  Live's own preview or card box (its host) don't count: the preview stays the one the pointer went to. */
function onLivePointer(e: PointerEvent) {
  if (!fromUser(e) || !liveView?.running || (livePill && e.target === livePill.host)) return;
  pointerAt(e.clientX, e.clientY);
}

/** The pointer is at (x, y) on the page: the loop reads the card there first, and its box follows (pointLive). */
function pointerAt(x: number, y: number) {
  livePointer = { x, y };
  live().pointer(x, y);
  pointLive();
}

/** The card under the pointer now: outline it; once listed its card shows at once (no rest, as a sweep over the
 *  cards shows each in turn), and leaving it lets its card go after GRACE_MS. */
function pointLive() {
  if (overLivePreview) return; // on Live's preview or box: its last point under it says nothing (a scroll, a new cycle)
  const v = liveView;
  const card = v?.running && v.video && livePointer ? cardAt(v.cards, v.video, livePointer.x, livePointer.y) : null;
  // Listed, or read sure once (the list waits for a second read): its box shows either way.
  const named = card && card.cardId !== undefined && card.imageId !== undefined ? { cardId: card.cardId, imageId: card.imageId } : null;
  const key = card ? `${card.trackId}:${named?.cardId ?? ''}:${card.unsure ? 'unsure' : ''}` : '';
  if (key === livePointedKey) {
    // Back on the shown card from its preview (moves over Live's host don't count): it stays.
    if (liveHoverHide && liveHover && card && liveHover.trackId === card.trackId) {
      clearTimeout(liveHoverHide);
      liveHoverHide = undefined;
    }
    return;
  }
  const was = livePointed;
  livePointedKey = key;
  livePointed = card?.trackId ?? null;
  const anchor = card && named && v?.video ? viewportRectOf(v.video, card.box) : null;
  if (named && anchor && card) hoverLiveCard(named.cardId, named.imageId, anchor, card.trackId, card.unsure ? { score: card.score } : undefined);
  else if (card && v?.video && !liveBox && viewportRectOf(v.video, card.box)) showLiveReading(viewportRectOf(v.video, card.box) as Rect, card.trackId); // still being read: its box says so at once
  else if (!liveHover?.picture) leaveLiveHover(); // a picture's card is the picture reader's to let go
  if (livePointed !== was) paintLive();
}

/** The pointer left the page (or the page lost focus): nothing is under it any more. */
function dropLivePointer() {
  liveController?.pointerGone();
  if (!livePointer) return;
  livePointer = null;
  pointLive();
}

/** The pointer rests on a card Live has no answer for yet: the box (or preview) shows its loading state until one comes. */
function showLiveReading(anchor: Rect, trackId: number) {
  clearTimeout(liveHoverHide);
  liveHoverHide = undefined;
  liveHover = { seq: ++liveHoverSeq, trackId, reading: true, cardId: -1, imageId: -1, response: null, anchor, images: {} };
  paintLive();
}

/** The pointer is on a listed card (or one read the same twice but not sure: `unsure`): "Full details" shows the card box, else the quick preview. */
function hoverLiveCard(cardId: number, imageId: number, anchor: Rect, trackId: number, unsure?: { score?: number }) {
  if (liveBox) return;
  clearTimeout(liveHoverHide);
  liveHoverHide = undefined;
  const seq = ++liveHoverSeq;
  void liveRecord(cardId).then((card) => {
    // Its own track (a second copy of the card is another), still listed as this card once the record is here.
    if (!card || seq !== liveHoverSeq || liveBox || !liveView?.cards.some((c) => c.trackId === trackId && c.cardId === cardId)) return;
    liveHover = { seq, trackId, cardId, imageId, response: liveResponse(card, imageId, unsure), anchor, images: {} };
    paintLive();
    if (liveReveal === 'full') {
      loadLiveImage(card, imageId, (images) => {
        if (liveHover?.seq !== seq) return;
        liveHover = { ...liveHover, images };
        paintLive();
      });
    }
  });
}

/** E2E builds only: the outlines drawn on the video (the Live host's root is closed to the page). */
function liveOutlines(): NonNullable<LiveQueryReply['outlines']> {
  return Array.from(livePill?.root.querySelectorAll<HTMLElement>('.live-outline') ?? []).map((el) => {
    const r = el.getBoundingClientRect();
    // The outline carries no name (aria-hidden): the name is the card its box or preview shows, when one shows.
    const shown = liveHover && !liveHover.picture && !liveBox ? liveHover.response?.cards[liveHover.cardId]?.name : undefined;
    const shows = liveHover && !liveHover.picture && !liveBox ? (liveHover.reading ? 'reading' : liveHover.response?.result.confident ? 'sure' : 'unsure') : undefined;
    return { state: el.classList.contains('promoted') ? 'promoted' : 'reading', rect: { x: r.x, y: r.y, w: r.width, h: r.height }, name: shown, shows };
  });
}

/** E2E builds only: the box (or quick preview) on the pointed card now: what it shows and where. */
function liveHoverBox(): NonNullable<LiveQueryReply['hoverBox']> | null {
  const el = liveHover && !liveBox ? livePill?.root.querySelector<HTMLElement>('.pop, .pv') : null;
  if (!el || !liveHover) return null;
  const r = el.getBoundingClientRect();
  const shows = liveHover.reading ? 'reading' : liveHover.response?.result.confident ? 'sure' : 'unsure';
  const rectOf = (e: Element | null | undefined) => {
    const b = e?.getBoundingClientRect();
    return b && b.width > 0 ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined;
  };
  const zoom = rectOf(el.querySelector('.dv-zoom'));
  const bigger = rectOf(el.querySelector('.dv-big'));
  const scroller = el.querySelector<HTMLElement>('.pop-scroll');
  // How far the user can scroll it: none when it shows all of itself, or does not scroll (the bigger picture showing).
  const scroll = scroller && getComputedStyle(scroller).overflowY !== 'hidden' ? scroller.scrollHeight - scroller.clientHeight : 0;
  return {
    shows,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    ...(liveHover.picture ? { picture: true as const } : {}),
    ...(zoom ? { zoom } : {}),
    ...(bigger ? { big: bigger } : {}),
    scroll,
  };
}

/** Live check's watch on the pointer (arm.ts): over a playing video, Live starts here. */
const liveArm = createLiveArm({
  doc: document,
  now: () => performance.now(),
  running: () => liveController?.query().running === true,
  start: async () => (await sendToBackground({ type: 'live-check-start' })).ok,
  warm: () => void sendToBackground({ type: 'live-check-warm' }).catch(() => undefined),
});

/** Live check on pictures (pictures.ts): the card under a resting pointer, shown as the video's cards are. */
/** Live check's Speed on this page (the background's), for the cards read on pictures. */
let pageEffort: LiveEffort = 'light';

const pictures = createPictureReader({
  doc: document,
  send: sendToBackground,
  speed: () => pageEffort,
  shot: async () => {
    // Duel Lens's own box must not be in the picture it reads: hidden for the screenshot, shown again after.
    const host = livePill?.host;
    if (host) host.style.visibility = 'hidden';
    try {
      await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
      return (await sendToBackground({ type: 'live-check-shot' })).dataUrl ?? null;
    } finally {
      if (host) host.style.visibility = '';
    }
  },
  ours: (el) => !!livePill && el === livePill.host,
  show: (hit) => hoverPictureCard(hit.cardId, hit.imageId, hit.anchor),
  reading: (anchor) => showPictureReading(anchor),
  unread: (anchor) => {
    if (liveHover?.picture && liveHover.reading && liveHover.anchor === anchor) hideLiveHover();
  },
  leave: () => {
    if (liveHover?.picture) leaveLiveHover();
  },
});

/** A card found on a picture is being read: its box shows the loading state until the card comes (as showLiveReading). */
function showPictureReading(anchor: Rect) {
  if (liveBox) return;
  clearTimeout(liveHoverHide);
  liveHoverHide = undefined;
  liveHover = { seq: ++liveHoverSeq, picture: true, reading: true, cardId: -1, imageId: -1, response: null, anchor, images: {} };
  paintLive();
}

/** A card read on a picture: "Full details" shows the card box, else the quick preview (as hoverLiveCard). */
function hoverPictureCard(cardId: number, imageId: number, anchor: Rect) {
  if (liveBox) return;
  clearTimeout(liveHoverHide);
  liveHoverHide = undefined;
  const seq = ++liveHoverSeq;
  void liveRecord(cardId).then((card) => {
    if (!card || seq !== liveHoverSeq || liveBox) return;
    liveHover = { seq, picture: true, cardId, imageId, response: liveResponse(card, imageId), anchor, images: {} };
    paintLive();
    if (liveReveal === 'full') {
      loadLiveImage(card, imageId, (images) => {
        if (liveHover?.seq !== seq) return;
        liveHover = { ...liveHover, images };
        paintLive();
      });
    }
  });
}

function onArmPointer(e: PointerEvent) {
  if (!fromUser(e) || (livePill && e.target === livePill.host)) return;
  liveArm.pointer(e.clientX, e.clientY);
  pictures.pointer(e.clientX, e.clientY);
}

/** The page scrolled, lost the focus or the pointer left it: a picture's card goes (its box no longer lies over it). */
function picturesGone() {
  liveArm.gone(); // a rest on a video under way ends too: leaving the page never starts Live
  pictures.gone();
  if (liveHover?.picture) hideLiveHover();
}

function armLive(on: boolean) {
  if (on === liveArm.on) return;
  liveArm.setOn(on);
  pictures.setOn(on);
  if (!on && liveHover?.picture) hideLiveHover();
  if (on) {
    window.addEventListener('pointermove', onArmPointer, { capture: true, passive: true });
    window.addEventListener('scroll', picturesGone, { capture: true, passive: true });
    window.addEventListener('blur', picturesGone);
    document.documentElement.addEventListener('pointerleave', picturesGone);
  } else {
    window.removeEventListener('pointermove', onArmPointer, { capture: true });
    window.removeEventListener('scroll', picturesGone, { capture: true });
    window.removeEventListener('blur', picturesGone);
    document.documentElement.removeEventListener('pointerleave', picturesGone);
  }
}

function live(): LiveController {
  if (!liveController) {
    liveController = createLiveController({ doc: document, send: sendToBackground, onBlocked: () => liveArm.stoppedHere(), now: () => performance.now(), onView: showLivePill, toast: showError });
    liveController.setScanOpen(session !== null);
    window.addEventListener('pointermove', onLivePointer, { capture: true, passive: true });
    document.documentElement.addEventListener('pointerleave', dropLivePointer);
    window.addEventListener('blur', dropLivePointer);
    window.addEventListener('scroll', () => pointLive(), { capture: true, passive: true }); // the cards move under a still pointer
  }
  return liveController;
}

function isToContent(msg: unknown): msg is ToContent {
  if (typeof msg !== 'object' || msg === null || 'target' in msg) return false;
  const type = (msg as { type?: unknown }).type;
  return (
    type === 'ping' ||
    type === 'begin-selection' ||
    type === 'cards-detected' ||
    type === 'show-error' ||
    type === 'prepare-capture' ||
    type === 'grab-frame' ||
    type === 'live-start' ||
    type === 'live-stop' ||
    type === 'live-check' ||
    type === 'display-settings' ||
    type === 'live-settings' ||
    type === 'live-seek' ||
    type === 'live-query' ||
    type === 'live-show-card' ||
    type === 'ui-language'
  );
}

/**
 * The shortcut (or the toolbar icon) was pressed. While scan mode is open, that leaves it (focus back to
 * the page, the paused videos play again) and the answer says so at once: no capture follows. Otherwise,
 * before the background captures the tab: remove every Duel Lens element (toasts, a host left by a
 * reloaded extension), then answer once the page has repainted without them: two animation frames, or a
 * short timeout if frames stall. Returns true when the answer is sent later.
 */
function prepareCapture(sendResponse: (r: PrepareCaptureReply) => void): boolean {
  // The pill stays out of the screenshot; it comes back if no scan opens (begin-selection hides it for good while one is).
  if (livePill) {
    liveBox = null; // a box would be in the screenshot, and a scan is about to read the page
    hideLiveHover();
    const before = liveView;
    liveView = null;
    paintLive();
    setTimeout(() => {
      const back = liveView ?? before;
      if (!session && back) showLivePill(back);
    }, NEXT_SCAN_MS);
  }
  if (session) {
    session.close();
    toastOnly?.close();
    document.querySelectorAll(`#${HOST_ID}`).forEach((el) => el.remove());
    sendResponse({ ok: true, closed: true });
    return false;
  }
  const shown = toastOnly !== null || document.getElementById(HOST_ID) !== null;
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

type RevealMode = Settings['display']['reveal'];

/** A message's reveal mode; absent (an older background) is 'click', and 'hover' (before 0.9.4) was the quick preview. */
function revealOf(raw: unknown): RevealMode {
  return raw === 'full' || raw === 'preview' ? raw : raw === 'hover' ? 'preview' : 'click';
}

function beginSelection(screenshot: string, capturedAt: number, reveal: RevealMode, banlist: 'tcg' | 'ocg') {
  setBanlist(banlist);
  const before = session ? session.close(true) : null;
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
  // Firefox only (keep-alive.ts): pings while this session is open; close() stops it.
  let stopKeepAlive: (() => void) | undefined;
  const s: Session = {
    host,
    toasts,
    capturedAt,
    detected,
    frame() {
      if (session !== s) return undefined; // closed: its grabs are released
      const grab = frameForDetection(grabs, { w: viewport.w, h: viewport.h, dpr: window.devicePixelRatio });
      return grab ? encodeFrame(grab, viewport) : undefined;
    },
    close(forNextScan?: boolean) {
      const mine = { videos: paused, opener };
      if (session !== s) return mine;
      session = null;
      liveController?.setScanOpen(false);
      stopKeepAlive?.();
      toasts.dispose();
      render(null, host.root); // unmount: removes the key handler and listeners
      host.destroy();
      if (!forNextScan) letGo(mine);
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
      return mine;
    },
  };
  session = s;
  live().setScanOpen(true); // a scan reads no Live frames and hides the label
  if (__DUEL_LENS_FIREFOX__) stopKeepAlive = startKeepAlive();
  render(
    h(App, {
      screenshot,
      viewport,
      crop: async (rect) => cropSelection(rect, await shot, grabs, { viewportWidth: viewport.w }),
      // The card's corners go with its crop: the engine straightens it from them (click-regression-report.md). So
      // does where a pointer clicked it: a card the engine finds in the crop must hold that point (click-stack-report.md).
      cropCard: async (card, at) =>
        cropDetectedCard(card.shotRect, await shot, grabs, {
          viewportWidth: viewport.w,
          shotWidth: card.shotWidth,
          shotPts: card.shotPts,
          ...(at ? { click: at } : {}),
        }),
      detection,
      expectCards: !detectorDown,
      reveal,
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

/** grab-frame: the frame for the session that froze on the screenshot taken at `capturedAt`; none for any other. */
function grabFrame(capturedAt: number): GrabFrameReply {
  if (session?.capturedAt !== capturedAt) return { ok: true };
  try {
    const frame = session.frame();
    return frame ? { ok: true, frame } : { ok: true };
  } catch {
    return { ok: true }; // the screenshot's cards alone
  }
}

function showError(message: string) {
  if (session) {
    session.toasts.show(message);
    return;
  }
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
  render(h('div', { class: 'dl', lang: uiLang() }, h(Toast, { store: toasts })), host.root);
  toasts.show(message);
}

/**
 * The interface language Options picked (shared/ui-language.ts), as words from the background: this script can read
 * neither the settings nor the extension's files. Settled once they are in, or after UI_WORDS_WAIT_MS without an
 * answer (the browser's language then). A scan's first box waits for it, so it opens in the chosen language.
 */
const UI_WORDS_WAIT_MS = 500;
let uiWordsIn = false;
let uiWordsSettle!: () => void;
const uiWordsReady = new Promise<void>((resolve) => (uiWordsSettle = resolve)).then(() => void (uiWordsIn = true));

if (!window.__duelLens) {
  window.__duelLens = true;

  setTimeout(() => uiWordsSettle(), UI_WORDS_WAIT_MS);
  // Live check (D-L14): armed when the switch is on; a page loaded with it on has this script for that reason. The same
  // answer brings the interface language's words.
  void sendToBackground({ type: 'live-check-state' }).then(
    (r) => {
      if (r?.ui !== undefined) setUiMessages(r.ui);
      uiWordsSettle();
      if (!r) return; // no answer (a worker that went away): Live check stays off here
      if (r.reveal) liveReveal = revealOf(r.reveal);
      if (r.display) setHostPrefs(cardTextCss(r.display));
      if (r.banlist) setBanlist(r.banlist); // Live's boxes show the chosen list from the start, not only after a scan
      if (isLiveEffort(r.effort)) pageEffort = r.effort;
      armLive(r.on);
    },
    () => uiWordsSettle(),
  );
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    // Only Duel Lens itself talks to this script, not another extension that shares the tab.
    if (sender?.id !== chrome.runtime.id || !isToContent(msg)) return;
    try {
      if (msg.type === 'prepare-capture') return prepareCapture(sendResponse);
      if (msg.type === 'grab-frame') {
        sendResponse(grabFrame(msg.capturedAt));
        return;
      }
      // How card details show ("Show card details" in Options); absent (an older background) is 'click'.
      // Which banlist the chip shows ("Banlist" in Options); absent (an older background) is 'tcg'.
      if (msg.type === 'live-start') {
        liveReveal = revealOf(msg.reveal);
        void live()
          .start({ effort: isLiveEffort(msg.effort) ? msg.effort : 'balanced', showLabel: msg.showLabel !== false, video: liveArm.video })
          .then((reply) => {
            if (!reply.ok && reply.reason === 'no-video') showError(t('content_live_no_video'));
            // The pointer that rested to start Live is still there: it is Live's first point (no move needed).
            const at = reply.ok ? liveArm.lastPointer : null;
            if (at && !livePointer) {
              livePointer = at;
              live().pointer(at.x, at.y);
              pointLive();
            }
            sendResponse(reply);
          })
          .catch((e) => {
            console.error('Duel Lens: Live could not start', e);
            sendResponse({ ok: false, reason: 'no-video' } satisfies LiveStartReply);
          });
        return true; // answered once the loop has started
      }
      if (msg.type === 'live-query') {
        sendResponse(__DUEL_LENS_E2E__ ? { ...live().query(), outlines: liveOutlines(), hoverBox: liveHoverBox() } : live().query());
        return;
      }
      if (msg.type === 'live-show-card') {
        void showLiveCard(msg.cardId, msg.imageId).then(sendResponse, () => sendResponse({ shown: false }));
        return true; // answered once the card is on the video
      }
      if (msg.type === 'begin-selection') {
        const begin = () => beginSelection(msg.screenshot, msg.capturedAt, revealOf(msg.reveal), msg.banlist === 'ocg' ? 'ocg' : 'tcg');
        // Just injected: the interface language's words may still be on their way (a few ms; at most UI_WORDS_WAIT_MS).
        // The answer waits for the selection: the background asks for its video frames (grab-frame) once it has it.
        if (!uiWordsIn) {
          void uiWordsReady.then(() => {
            try {
              begin();
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          });
          return true;
        }
        begin();
      }
      else if (msg.type === 'ui-language') setUiMessages(msg.words); // Options changed it: what renders next follows
      else if (msg.type === 'cards-detected') cardsDetected(msg.capturedAt, msg.detection);
      else if (msg.type === 'show-error') showError(msg.message);
      else if (msg.type === 'live-stop') {
        if (msg.reason === 'user' || msg.reason === 'blocked') liveArm.stoppedHere();
        live().stop(msg.reason);
      }
      else if (msg.type === 'live-check') armLive(msg.on);
      else if (msg.type === 'display-settings') {
        // Options changed how cards show: every tab follows, a picture-only one too (background/index.ts).
        liveReveal = revealOf(msg.reveal);
        if (liveReveal === 'click') hideLiveHover();
        setHostPrefs(cardTextCss(msg));
        if (msg.banlist) setBanlist(msg.banlist);
        if (isLiveEffort(msg.effort)) pageEffort = msg.effort;
      }
      else if (msg.type === 'live-settings') {
        liveReveal = revealOf(msg.reveal);
        if (liveReveal === 'click') hideLiveHover();
        if (isLiveEffort(msg.effort)) pageEffort = msg.effort;
        live().setSettings({ effort: isLiveEffort(msg.effort) ? msg.effort : 'balanced', showLabel: msg.showLabel !== false });
      }
      else if (msg.type === 'live-seek') live().seek(msg.videoTime);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
