// Scan mode: the content UI's state (UX-1, UX-2). It stays open until the user leaves it.
// - The layer (selection.tsx) is up the whole time: the frozen frame, the cards the detector found
//   outlined once its answer comes (`detection`, matched to this screenshot by index.ts), and the bar.
// - The pin (`pin`): the full popover of the card or box read last, beside it: "Matching artwork…"
//   (the box or card shows the foil sweep), then the answer or an error. Reading another card or box
//   replaces it; Esc, its ×, or a click on no card closes it, and scan mode stays. Every read the user
//   asks for (a click, Enter, a drag, two corners) goes to the history, as before.
// - The hover preview (`preview`, reveal 'hover' only: "Show card details: Hover or click"): the pointer
//   resting HOVER_MS on an outline, or keyboard focus on it, shows a compact preview (preview.tsx). It
//   comes from a peek (`recognize` with `record: false`: no history entry, no correction, never the AI),
//   one at a time, the latest wanted first, kept per outline for the session (`cache`). A click on a
//   previewed card pins it from the cache at once, and a `recognize` of the same crop records it (its
//   history entry comes to the pin when it answers).
// - The whole board (B, or the bar's "Read all cards"; `reading`): the side panel opens at once, while the
//   key press or click is still the user's gesture, and says "Reading the board…"; every outlined card is
//   read in turn, one at a time, the way a preview is (a peek, from the same per-outline cache: a card read
//   before isn't read again), then the cards read go to the panel by player (`show-board`; board.ts).
//   Nothing is recorded: a board is a peek. The bar says how far it got; Esc or its Stop stops it, and the
//   panel gets the cards read so far (as it does when scan mode is left mid-read).
// - Leaving (onDone, index.ts: focus back to the page, the paused videos play again): Esc with nothing
//   open, the bar's ✕, K or Space, a right-click, the shortcut again (index.ts), a click outside the
//   frozen frame, and a change of the page's layout (fullscreen, a resized window).
// One status region says each read's outcome in words, from "Matching artwork…" to the answer (a11y
// review B2); the layer's own ones say the mode and a focused card's preview. The overlay is in English
// whatever the page's language (M4).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { displayCandidates } from '../shared/alt-artwork';
import { t, uiLang } from '../shared/i18n';
import {
  sendToBackground,
  type AskAiResponse,
  type BoardCard,
  type CardDetection,
  type OkResponse,
  type RecognizeResponse,
  type RecordFoundResponse,
} from '../shared/messages';
import type { CropPayload, ScanContext } from '../shared/types';
import { BOARD_PANEL_CLOSED, boardCardOf, boardFrame, boardSide, boardSummary, MAX_BOARD } from './board';
import type { CropResult } from './capture';
import { FindPanel } from './find-panel';
import type { WrongCardMatch } from './wrong-card';
import type { OrientedBox, Rect } from './geometry';
import type { HostState } from './host';
import { outlinesFrom, type CardOutline } from './outlines';
import {
  alternativeIndices,
  announcement,
  displayedCard,
  Popover,
  viewableIndices,
  type AiStatus,
  type PopoverHandle,
  type PopoverState,
} from './popover';
import { Preview, PREVIEW_ID, previewText, previewWords } from './preview';
import { SelectionLayer, type Active, type LayerHandle, type PopoverKeys } from './selection';
import { Toast, type ToastStore } from './toast';
import { fromUser } from './trusted';

export const MESSAGES = {
  videoBlocked: t('content_video_blocked'),
  cropFailed: t('content_crop_failed'),
  disconnected: t('content_disconnected'),
  noAnswer: t('content_no_answer'),
  panelFailed: t('content_panel_failed'),
  matcherFailed: (detail: string) => t('content_matcher_failed', detail),
  boardNone: t('content_board_none'),
  boardStopped: t('content_board_stopped'),
  boardDone: (board: BoardCard[], unread: number) =>
    t('content_board_done', unread ? `${boardSummary(board)} ${t('content_board_unread_suffix', unread)}` : boardSummary(board)),
} as const;

/** How long the bar says "Finding cards…" while the detector hasn't answered. */
export const FINDING_MS = 1500;
/** How long the pointer rests on an outline (or focus stays on it) before its preview shows. */
export const HOVER_MS = 250;
/** How long a preview stays once the pointer left its card, for the pointer to reach it (WCAG 1.4.13). */
export const GRACE_MS = 150;
/** After Keep opened the side panel, the page's resize (the panel takes room beside it) doesn't close scan mode. */
export const PANEL_RESIZE_MS = 1500;

/** What is read: a dragged box, or a detected card (its bounds, its turned shape, its index among the outlines). */
interface Target {
  rect: Rect;
  shape?: OrientedBox;
  card?: number;
}

/** The popover of the last read: under way, answered, or failed. `seq` tells reads apart. */
type Pin =
  | ({ kind: 'scanning'; seq: number } & Target)
  | ({
      kind: 'result';
      seq: number;
      response: RecognizeResponse;
      /** None for a card looked up by name (the bar's "Find card"). */
      crop?: CropPayload;
      selected: number;
      /** Where the read was (the page, the video's time under the crop), for "Report". */
      context?: ScanContext;
      /** Pinned from its preview: the read's history entry is on its way. */
      recording?: boolean;
    } & Target)
  | ({ kind: 'error'; seq: number; message: string; showOptions?: boolean } & Target);

/** A card's read, kept for the session: what its preview shows, and the crop a click records it from. */
type Cached = { response: RecognizeResponse; crop: CropPayload; context: ScanContext } | { failed: true };

export interface AppProps {
  /** The captureVisibleTab screenshot (PNG data URL) shown as the frozen frame. */
  screenshot: string;
  /** innerWidth x innerHeight when the screenshot was taken (the frozen frame's size). */
  viewport?: { w: number; h: number };
  /** Cut the box out of the best source (video frame or screenshot). */
  crop(rect: Rect): Promise<CropResult>;
  /** Cut a detected card out of the best source (click to scan); `at`, where a pointer clicked it (CSS px), goes with it. */
  cropCard?(card: CardOutline, at?: [number, number]): Promise<CropResult>;
  /** The detector's cards on this screenshot. It may come mid-drag, or never (then dragging is all there is). */
  detection?: Promise<CardDetection>;
  /** False when the last detection couldn't run: no "Finding cards…" (cards that do come are still outlined). */
  expectCards?: boolean;
  /** The visible videos' pictures on the page (CSS px) when the frame froze: a big one keeps the outlines to itself. */
  videos?: Rect[];
  /**
   * How card details show (Settings.display.reveal): hovering a card (or focus on it) shows its full details ('full')
   * or a quick preview ('preview'); 'click' shows nothing until a click.
   */
  reveal?: 'full' | 'preview' | 'click';
  toasts: ToastStore;
  /** Receives the UI state, for the host element's data attributes. */
  onState?(s: HostState): void;
  /** Leave scan mode (unmounts the host). */
  onDone(): void;
}

function hostStateOf(pin: Pin | null, cards: CardOutline[] | null, preview: string | null): HostState {
  let s: HostState;
  if (!pin) s = { state: 'selecting' };
  else if (pin.kind !== 'result') s = { state: pin.kind };
  else s = { state: 'result', card: displayedCard(pin.response, pin.selected)?.card.name, confident: pin.response.result.confident };
  if (cards) s.cards = cards.length;
  if (preview !== null) s.preview = preview;
  return s;
}

function popoverState(pin: Pin): PopoverState {
  switch (pin.kind) {
    case 'scanning':
      return { kind: 'scanning' };
    case 'result':
      return { kind: 'result', response: pin.response, crop: pin.crop, selected: pin.selected, context: pin.context };
    case 'error':
      return { kind: 'error', message: pin.message, showOptions: pin.showOptions };
  }
}

/** A card image from the background; null when there is none (or Duel Lens can't be reached: it throws then). */
const getImage = (imageId: number, size: 'full' | 'small'): Promise<string | null> => {
  try {
    return sendToBackground({ type: 'get-image', imageId, size }).then(
      (r) => r?.dataUrl ?? null,
      () => null,
    );
  } catch {
    return Promise.resolve(null);
  }
};

/**
 * The answer with every candidate's imageId a YGOPRODeck image: a match on an artwork YGOPRODeck lacks (a synthetic
 * id, src/shared/alt-artwork.ts) shows its card's own first image, in the card view and in the "Not sure" and
 * "Low match" lists alike. The background already answers so; this keeps the popover right whatever it gets.
 */
export function withDisplayImages(response: RecognizeResponse): RecognizeResponse {
  const candidates = displayCandidates(response.result.candidates, response.cards);
  return candidates.every((c, i) => c === response.result.candidates[i]) ? response : { ...response, result: { ...response.result, candidates } };
}

/** The page's context for a read: where it was, and the video's time under the crop. */
function contextOf(cropped: CropResult): ScanContext {
  return {
    pageUrl: location.href,
    pageTitle: document.title,
    ...(cropped.videoTime !== undefined ? { videoTime: cropped.videoTime } : {}),
  };
}

/** Whether a press at (x, y) lands on a video, under whatever sits on top of it (a player's controls). */
function onVideo(x: number, y: number): boolean {
  return document.elementsFromPoint?.(x, y).some((el) => el instanceof HTMLVideoElement) ?? false;
}

/**
 * Keeps the rest of a press from the page: its mousedown, mouseup and click, and the pointerup that
 * ends it. A click on YouTube's video that leaves Duel Lens would also toggle playback (live check M2).
 * Mouse events that don't come (the pointerdown was cancelled) leave nothing behind: it all ends right
 * after this press's pointerup, or after 3 s for a press released outside the window.
 */
function swallowPress(pointerId: number): void {
  const types = ['mousedown', 'mouseup', 'click'] as const;
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    swallow(e);
    setTimeout(done, 0); // its mouseup and click are dispatched right after its pointerup
  };
  const done = () => {
    clearTimeout(timer);
    for (const t of types) window.removeEventListener(t, swallow, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
  };
  for (const t of types) window.addEventListener(t, swallow, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  const timer = setTimeout(done, 3000);
}

export function App({ screenshot, viewport, crop, cropCard, detection, expectCards = true, videos, reveal = 'click', toasts, onState, onDone }: AppProps) {
  const [pin, setPinState] = useState<Pin | null>(null);
  /** The detected cards, outlined; null until the detector answers. */
  const [cards, setCardsState] = useState<CardOutline[] | null>(null);
  /** The detector answered and found no card to outline (not the same as a detection that failed). */
  const [noneFound, setNoneFound] = useState(false);
  const [finding, setFinding] = useState(detection !== undefined && expectCards);
  const [ai, setAi] = useState<AiStatus>({ status: 'idle' });
  // "Find a card by name" (the bar's "Find card", /): the search panel under the bar, where it is open.
  const [findAt, setFindAt] = useState<Rect | null>(null);
  const [images, setImages] = useState<Record<number, string | null>>({});
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({});
  /** The hover preview shown: which outline, what its read says, and whether keyboard focus brought it. */
  const [preview, setPreviewState] = useState<{ index: number; response: RecognizeResponse; by: Active['by'] } | null>(null);
  const requested = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const pinRef = useRef(pin);
  const cardsRef = useRef(cards);
  const previewRef = useRef(preview);
  const layer = useRef<LayerHandle | null>(null);
  const pop = useRef<PopoverHandle | null>(null);
  const seq = useRef(0);
  /** Until when a resize is the side panel opening (Keep), not a reason to leave. */
  const panelGrace = useRef(0);

  const setPin = (p: Pin | null) => {
    pinRef.current = p;
    setPinState(p);
  };
  const setCards = (c: CardOutline[]) => {
    cardsRef.current = c;
    setCardsState(c);
  };
  const setPreview = (p: typeof preview) => {
    previewRef.current = p;
    setPreviewState(p);
  };

  // ---------- the hover preview's bookkeeping (refs: timers and reads outlive renders) ----------
  const hoverOn = reveal !== 'click' && !!cropCard;
  /** Each outline's read, for its preview and for a click to pin it from (outline index → read). */
  const cache = useRef(new Map<number, Cached>());
  /** The lit card (under the pointer, or in keyboard focus), as the layer last said. */
  const hover = useRef<Active | null>(null);
  const intentTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  /** The outline whose preview is wanted now (its intent fired and the pointer or focus is still on it). */
  const want = useRef<number | null>(null);
  /** The pointer is over the preview itself. */
  const overPreview = useRef(false);
  /** The outline whose preview Esc hid (or whose popover Esc closed): none for it until the pointer or focus leaves it. */
  const dismissed = useRef<number | null>(null);
  /** The peek under way (one at a time): its outline and its read to come; and the latest one wanted meanwhile. */
  const peeking = useRef<number | null>(null);
  const peekRead = useRef<Promise<Cached | null> | null>(null);
  const nextPeek = useRef<number | null>(null);

  // ---------- the whole board ----------
  /** The board being read: the card read now (1-based), of how many, and its outline; null otherwise. */
  const [reading, setReading] = useState<{ current: number; total: number; index: number } | null>(null);
  /**
   * The run under way (one at a time), until its final board is sent; `stopped` once Esc or Stop ended it. A stopped
   * run still finishes the read under way and sends the cards read so far: B waits for it (no second run meanwhile).
   */
  const boardRun = useRef<{ stopped: boolean } | null>(null);

  useEffect(
    () => () => {
      live.current = false;
      clearTimeout(intentTimer.current);
      clearTimeout(hideTimer.current);
    },
    [],
  );
  useLayoutEffect(() => onState?.(hostStateOf(pin, cards, preview ? previewText(preview.response).head : null)), [pin, cards, preview]);

  // ---------- detected cards ----------
  // "Finding cards…" until the detector answers or FINDING_MS passes; its cards are outlined
  // whenever they come (a drag already under way carries on).
  useLayoutEffect(() => {
    if (!detection) return;
    const timer = setTimeout(() => setFinding(false), FINDING_MS);
    detection.then(
      (d) => {
        clearTimeout(timer);
        if (!live.current) return;
        const found = outlinesFrom(d, viewport ?? { w: window.innerWidth, h: window.innerHeight }, videos);
        setCards(found);
        setNoneFound(!d?.error && found.length === 0);
        setFinding(false);
      },
      () => undefined,
    );
    return () => clearTimeout(timer);
  }, []);

  // ---------- the hover preview ----------
  const pinnedCard = () => pinRef.current?.card;

  const hidePreview = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
    want.current = null;
    overPreview.current = false; // it goes from under the pointer without a pointerleave
    if (previewRef.current) setPreview(null);
  };

  const cancelHide = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  };

  /** The pointer or focus left the preview's card: it goes after GRACE_MS, unless the pointer is on it by then. */
  const scheduleHide = () => {
    if (!previewRef.current) {
      want.current = null;
      return;
    }
    if (hideTimer.current) return;
    hideTimer.current = setTimeout(() => {
      hideTimer.current = undefined;
      if (!overPreview.current) hidePreview();
    }, GRACE_MS);
  };

  const showPreview = (index: number) => {
    const read = cache.current.get(index);
    if (!read || 'failed' in read) return;
    cancelHide();
    setPreview({ index, response: read.response, by: hover.current?.index === index ? hover.current.by : 'pointer' });
  };

  /**
   * A card's read without a record (no history entry, no correction, no AI): a peek, for its preview or the
   * board. A card that can't be read (its crop failed, a blocked video, the matcher failed) is `failed`: no
   * preview, and its click reads it as usual (and says why). No answer at all (Duel Lens restarted, say): null.
   */
  const readCard = async (card: CardOutline, at?: [number, number]): Promise<Cached | null> => {
    try {
      const cropped = await cropCard!(card, at);
      if (cropped.black && cropped.overVideo && !cropped.videoReadable) return { failed: true };
      const context = contextOf(cropped);
      const response = await sendToBackground({ type: 'recognize', crop: cropped.crop, context, record: false }).catch(() => undefined);
      if (!response?.result) return null;
      return response.result.error ? { failed: true } : { response: withDisplayImages(response), crop: cropped.crop, context };
    } catch {
      return { failed: true };
    }
  };

  /** A peek for a card's preview: one at a time, kept in the cache. */
  const peek = async (index: number) => {
    const card = cardsRef.current?.[index];
    if (!card || !cropCard) return;
    peeking.current = index;
    // The point the pointer rests on goes with the crop, as a click's does (none from the keyboard).
    const h = hover.current;
    const at = h?.index === index && h.by === 'pointer' ? (layer.current?.pointer() ?? undefined) : undefined;
    const reading = readCard(card, at);
    peekRead.current = reading;
    const read = await reading;
    peeking.current = null;
    peekRead.current = null;
    if (!live.current) return;
    if (read && !cache.current.has(index)) cache.current.set(index, read);
    if (want.current === index) showPreview(index);
    // The latest card wanted while this one was read, if the pointer or focus is still on it.
    const next = nextPeek.current;
    nextPeek.current = null;
    if (next !== null && want.current === next && !cache.current.has(next)) void peek(next);
  };

  /** The pointer rested HOVER_MS on an outline (or focus stayed on it): its preview, from the cache or a peek. */
  const intend = (index: number) => {
    if (hover.current?.index !== index || boardRun.current) return; // no preview while the board is read
    want.current = index;
    const read = cache.current.get(index);
    if (read) return showPreview(index); // a failed read shows none; a click reads the card as usual
    if (peeking.current === null) void peek(index);
    else if (peeking.current !== index) nextPeek.current = index; // at most one at a time: the latest wins
  };

  /** The layer's lit card changed (the pointer, or keyboard focus): the hover intent. */
  const onActive = (a: Active | null) => {
    hover.current = a;
    clearTimeout(intentTimer.current);
    if (dismissed.current !== null && a?.index !== dismissed.current) dismissed.current = null;
    if (!hoverOn) return;
    const shown = previewRef.current;
    if (a && shown?.index === a.index) {
      cancelHide();
      want.current = a.index;
      if (shown.by !== a.by) setPreview({ ...shown, by: a.by });
      return;
    }
    scheduleHide();
    if (!a || a.index === pinnedCard() || a.index === dismissed.current) return;
    const index = a.index;
    intentTimer.current = setTimeout(() => intend(index), HOVER_MS);
  };

  /**
   * Esc: hides the preview first (WCAG 1.4.13: without moving the pointer). True when there was one. It stays
   * hidden while the pointer (or focus) stays on its card; from the preview itself, the card shows it again.
   */
  const onEscape = (): boolean => {
    if (stopBoard()) return true;
    clearTimeout(intentTimer.current);
    const shown = previewRef.current;
    const wanted = shown?.index ?? want.current;
    if (wanted !== null && hover.current?.index === wanted) dismissed.current = wanted;
    hidePreview();
    return !!shown;
  };

  // ---------- reads ----------
  const failRead = (n: number, target: Target, message: string, showOptions = false) => {
    if (live.current && seq.current === n) setPin({ kind: 'error', seq: n, ...target, message, showOptions });
  };

  /** A new read replaces the popover: focus in it goes to the layer first, not to the page's <body>. */
  const newRead = (): number => {
    const el = pop.current?.element();
    const root = rootRef.current?.getRootNode() as (Document | ShadowRoot) | undefined;
    if (el && root?.activeElement && el.contains(root.activeElement)) layer.current?.focus();
    clearTimeout(intentTimer.current);
    hidePreview();
    setAi({ status: 'idle' });
    setFindAt(null);
    return ++seq.current;
  };

  /** Reads a box or a card, recording it: "Matching artwork…", then the answer. */
  const scan = async (target: Target, cut: () => Promise<CropResult>) => {
    const n = newRead();
    setPin({ kind: 'scanning', seq: n, ...target });
    let cropped: CropResult;
    try {
      cropped = await cut();
    } catch {
      // A crop/decode failure (e.g. the screenshot didn't decode) is local and often
      // transient - distinct from the restricted-page copy, which means the whole page
      // is off-limits.
      return failRead(n, target, MESSAGES.cropFailed);
    }
    if (!live.current || seq.current !== n) return;
    // An unreadable video (DRM/cross-origin) comes out black: say so rather than "no
    // match". A readable video's own dark frame (e.g. a fade-to-black) is not a block -
    // let it through to normal recognition.
    if (cropped.black && cropped.overVideo && !cropped.videoReadable) return failRead(n, target, MESSAGES.videoBlocked);
    const context = contextOf(cropped);
    let response: RecognizeResponse | undefined;
    try {
      response = await sendToBackground({ type: 'recognize', crop: cropped.crop, context });
    } catch {
      return failRead(n, target, MESSAGES.disconnected);
    }
    if (!live.current || seq.current !== n) return;
    if (!response?.result) return failRead(n, target, MESSAGES.noAnswer);
    if (response.result.error) return failRead(n, target, MESSAGES.matcherFailed(response.result.error), true);
    const shown = withDisplayImages(response);
    // A card's read is its preview from now on, too.
    if (target.card !== undefined) cache.current.set(target.card, { response: shown, crop: cropped.crop, context });
    setPin({ kind: 'result', seq: n, ...target, response: shown, crop: cropped.crop, context, selected: viewableIndices(shown)[0] ?? 0 });
  };

  /**
   * A click on a card read before (its preview): the popover shows that read at once, and a `recognize` of
   * the same crop records it. Its history entry joins the popover when it comes; should that read name
   * another card (it shouldn't: same crop, same engine), the popover keeps the card it shows and gets no entry.
   */
  const pinCached = (target: Target, read: Extract<Cached, { response: RecognizeResponse }>) => {
    const n = newRead();
    const response: RecognizeResponse = { ...read.response, entry: undefined };
    setPin({ kind: 'result', seq: n, ...target, response, crop: read.crop, context: read.context, selected: viewableIndices(response)[0] ?? 0, recording: true });
    void (async () => {
      let r: RecognizeResponse | undefined;
      try {
        r = await sendToBackground({ type: 'recognize', crop: read.crop, context: read.context });
      } catch {
        r = undefined;
      }
      const p = pinRef.current;
      if (!live.current || p?.seq !== n || p.kind !== 'result') return;
      const top = p.response.result.candidates[0]?.cardId;
      const entry = r?.entry;
      if (!entry || entry.cardId !== top) {
        if (top !== undefined) {
          console.warn('Duel Lens: the recorded read of this card', r ? `named ${entry?.cardId ?? 'nothing'}` : 'got no answer', `(the preview showed ${top}); no history entry is attached.`);
        }
        return setPin({ ...p, recording: false });
      }
      const next: Pin = { ...p, recording: false, response: { ...p.response, entry, aiEnabled: r!.aiEnabled } };
      setPin(next);
      // The user picked another match before the entry came: that is the correction.
      const shown = displayedCard(next.response, next.selected);
      if (shown && shown.index !== viewableIndices(next.response)[0]) {
        const c = next.response.result.candidates[shown.index];
        sendToBackground({ type: 'correct', entryId: entry.id, cardId: c.cardId, imageId: c.imageId }).catch(() => {});
      }
    })();
  };

  const scanBox = (rect: Rect) => void scan({ rect }, () => crop(rect));

  /** A card clicked, or chosen with Enter (its outline index; `at`, where a pointer clicked it). */
  const pickCard = (index: number, at?: [number, number]) => {
    const card = cardsRef.current?.[index];
    if (!card || !cropCard) return;
    const p = pinRef.current;
    if (p?.card === index && p.kind !== 'error') return; // its details already show
    const target: Target = { rect: card.rect, shape: card.shape, card: index };
    const read = cache.current.get(index);
    if (read && 'response' in read) return pinCached(target, read);
    const pending = peeking.current === index ? peekRead.current : null;
    if (pending) {
      // Its preview's read is under way: "Matching artwork…" until it answers, then pinned from it (one read, not two).
      const n = newRead();
      setPin({ kind: 'scanning', seq: n, ...target });
      void pending.then((r) => {
        if (!live.current || seq.current !== n) return;
        if (r && 'response' in r) pinCached(target, r);
        else void scan(target, () => cropCard(card, at));
      });
      return;
    }
    void scan(target, () => cropCard(card, at));
  };

  /** Closes the popover; scan mode stays. Focus goes to the card's outline (Esc, the keyboard) or to the layer. */
  const closePin = (focusTo: 'card' | 'layer') => {
    const p = pinRef.current;
    if (!p) return;
    seq.current++; // a read still under way is dropped
    setPin(null);
    setAi({ status: 'idle' });
    // Never taken back from where the user moved it on the page: only from the popover, or from nowhere.
    const host = (rootRef.current?.getRootNode() as ShadowRoot | undefined)?.host;
    const now = document.activeElement;
    if (now && now !== document.body && now !== document.documentElement && now !== host) return;
    if (focusTo === 'card' && p.card !== undefined) {
      dismissed.current = p.card; // its outline gets focus back without showing its preview
      layer.current?.focusCard(p.card);
    } else {
      layer.current?.focus();
    }
  };

  // ---------- "Find a card by name" in scan mode (find-panel.tsx) ----------
  /** The bar's "Find card", or /: the search opens under the bar, in place of any card's details. */
  const openFind = (bar: Rect) => {
    if (pinRef.current) closePin('layer');
    hidePreview();
    setFindAt(bar);
  };
  const closeFind = () => {
    setFindAt(null);
    layer.current?.focus();
  };
  /** The card picked by name shows in the popover, under the bar: nothing of the page read, so no report and no AI. */
  const lookUp = async (m: WrongCardMatch) => {
    const bar = findAt;
    if (!bar) return;
    const n = newRead();
    const target: Target = { rect: bar };
    const got = await sendToBackground({ type: 'get-cards', ids: [m.cardId] }).catch(() => undefined);
    if (!live.current || seq.current !== n) return;
    const card = got?.cards?.[m.cardId];
    if (!card) return failRead(n, target, MESSAGES.noAnswer);
    const response: RecognizeResponse = {
      result: { candidates: [{ cardId: card.id, imageId: m.imageId, score: 0, source: 'name' }], confident: true, faceDown: false, modelId: '', timings: {} },
      cards: { [card.id]: card },
      aiEnabled: false,
    };
    setPin({ kind: 'result', seq: n, ...target, response, selected: 0 });
  };

  // ---------- the whole board ----------
  /**
   * "Read the whole board" (B, or the bar's "Read all cards"): every outlined card in reading order, one at a
   * time, from the cache when it was read before (a preview, a click), else with a peek that records nothing;
   * then the cards read go to the side panel by player. Not while a read is under way, or a board already is (one
   * stopped included, until its final board is sent). At most MAX_BOARD cards (the background takes no more).
   */
  const readBoard = async () => {
    const all = cardsRef.current?.slice(0, MAX_BOARD);
    if (!all?.length || !cropCard || boardRun.current || pinRef.current?.kind === 'scanning') return;
    const run = { stopped: false };
    boardRun.current = run;
    // The side panel opens now, before any await: sidePanel.open() needs the user's gesture (this key press or
    // click), and the reads take seconds. It says "Reading the board…" until the board comes. Its resize, beside
    // the page, doesn't close scan mode (as for Keep).
    panelGrace.current = Infinity;
    const opening = (async (): Promise<boolean> => {
      try {
        const r = await sendToBackground({ type: 'show-board', board: [], reading: true });
        panelGrace.current = r?.ok ? Date.now() + PANEL_RESIZE_MS : 0;
        return !!r?.ok;
      } catch {
        panelGrace.current = 0;
        return false;
      }
    })();
    // The popover and the preview go (focus in the popover goes to the layer); the bar says how far the board got.
    newRead();
    setPin(null);
    nextPeek.current = null;
    const frame = viewport ?? { w: window.innerWidth, h: window.innerHeight };
    const board: BoardCard[] = [];
    let unread = 0;
    for (let i = 0; i < all.length; i++) {
      // One read at a time: a preview's read still under way finishes first (and may be this card's).
      while (peekRead.current) await peekRead.current;
      if (!live.current || run.stopped) break;
      setReading({ current: i + 1, total: all.length, index: i });
      let read = cache.current.get(i) ?? null;
      if (!read) {
        read = await readCard(all[i]);
        if (read && !cache.current.has(i)) cache.current.set(i, read); // its preview from now on, too
      }
      const { cx, cy } = all[i].shape;
      const entry = read && 'response' in read ? boardCardOf(read.response, boardSide(cy, boardFrame(cx, cy, frame, videos))) : null;
      if (entry) board.push(entry);
      else unread++;
    }
    const ended = run.stopped || !live.current; // Esc or Stop (stopBoard said so), or scan mode left
    if (live.current) setReading(null);
    // However the run ended, the panel gets its board (the cards read so far), after the opening message. The run
    // ends once it is sent: a new one's "Reading the board…" can't come before this board.
    const opened = await opening;
    let r: OkResponse | undefined;
    try {
      r = await sendToBackground({ type: 'show-board', board });
    } catch {
      if (live.current && !ended) toasts.show(MESSAGES.disconnected);
      return;
    } finally {
      if (boardRun.current === run) boardRun.current = null;
    }
    if (!live.current || ended) return;
    if (!board.length) return toasts.show(MESSAGES.boardNone);
    // The final board's own sidePanel.open() has no gesture left: that's fine when the panel opened at the press.
    if (r?.ok || (opened && r?.error === BOARD_PANEL_CLOSED)) toasts.show(MESSAGES.boardDone(board, unread));
    else toasts.show(r?.error || MESSAGES.panelFailed);
  };

  /**
   * Esc or the bar's Stop while the board is read: no more cards are read, and the side panel gets the ones read so
   * far (once the read under way ends). True when it stopped one.
   */
  const stopBoard = (): boolean => {
    const run = boardRun.current;
    if (!run || run.stopped) return false;
    run.stopped = true;
    setReading(null);
    toasts.show(MESSAGES.boardStopped);
    return true;
  };

  // ---------- images: the shown card in full (else small, else text only), alternatives small ----------
  const load = (imageId: number, size: 'full' | 'small') => {
    const key = `${size}:${imageId}`;
    if (requested.current.has(key)) return;
    requested.current.add(key);
    if (size === 'small') {
      void getImage(imageId, 'small').then((url) => live.current && setThumbs((m) => ({ ...m, [imageId]: url })));
      return;
    }
    void getImage(imageId, 'full')
      .then((url) => url ?? getImage(imageId, 'small'))
      .then((url) => live.current && setImages((m) => ({ ...m, [imageId]: url })));
  };

  useEffect(() => {
    // The crop build (`--no-remote-images`) shows the user's own crop instead (legal-audit.md B2): no card image is requested.
    if (!__DUEL_LENS_REMOTE_IMAGES__) return;
    if (pin?.kind !== 'result') return;
    const shown = displayedCard(pin.response, pin.selected);
    if (!shown) return;
    const cands = pin.response.result.candidates;
    load(cands[shown.index].imageId, 'full');
    // The matches the popover offers (the top one's image is loaded in full above, when it is shown).
    for (const i of alternativeIndices(pin.response)) load(cands[i].imageId, 'small');
  }, [pin]);

  // "Full details on hover": the hovered card's small picture only (sweeping the pointer over a board asks for no full
  // image; a click, which pins the card, does). Cached, and polite toward YGOPRODeck (background/image-cache.ts).
  useEffect(() => {
    if (!__DUEL_LENS_REMOTE_IMAGES__ || reveal !== 'full' || !preview) return;
    const shown = displayedCard(preview.response, viewableIndices(preview.response)[0] ?? 0);
    if (shown) load(preview.response.result.candidates[shown.index].imageId, 'small');
  }, [preview]);

  /** The hovered card's details ("Full details on hover"): its peek, with the crop it was read from (for Report issue). */
  const hoverState = (index: number, response: RecognizeResponse): Extract<PopoverState, { kind: 'result' }> => {
    const read = cache.current.get(index);
    const own = read && !('failed' in read) ? read : null;
    return { kind: 'result', response, ...(own ? { crop: own.crop, context: own.context } : {}), selected: viewableIndices(response)[0] ?? 0 };
  };

  // ---------- popover actions ----------
  const select = (p: Extract<Pin, { kind: 'result' }>, response: RecognizeResponse, index: number) => {
    const current = displayedCard(p.response, p.selected)?.index;
    setPin({ ...p, response, selected: index });
    const c = response.result.candidates[index];
    if (index !== current && response.entry) {
      sendToBackground({ type: 'correct', entryId: response.entry.id, cardId: c.cardId, imageId: c.imageId }).catch(() => {});
    }
  };

  const correct = (cardId: number) => {
    const p = pinRef.current;
    if (p?.kind !== 'result') return;
    const index = p.response.result.candidates.findIndex((c) => c.cardId === cardId);
    if (index >= 0) select(p, p.response, index);
  };

  /** Keep in side panel: the side panel opens on the card, and scan mode stays. */
  const keep = async () => {
    const p = pinRef.current;
    if (p?.kind !== 'result' || !p.response.entry) return;
    panelGrace.current = Infinity; // the panel may open before the answer comes
    try {
      const r = await sendToBackground({ type: 'show-in-panel', entryId: p.response.entry.id });
      panelGrace.current = r?.ok ? Date.now() + PANEL_RESIZE_MS : 0;
      if (!r?.ok) toasts.show(r?.error || MESSAGES.panelFailed);
    } catch {
      panelGrace.current = 0;
      toasts.show(MESSAGES.disconnected);
    }
  };

  const askAi = async () => {
    const p = pinRef.current;
    if (p?.kind !== 'result' || !p.crop) return;
    const crop = p.crop;
    const mine = () => live.current && pinRef.current?.seq === p.seq;
    setAi({ status: 'asking' });
    let r: AskAiResponse | undefined;
    try {
      r = await sendToBackground({ type: 'ask-ai', crop, candidates: p.response.result.candidates });
    } catch {
      if (mine()) setAi({ status: 'failed', message: MESSAGES.disconnected });
      return;
    }
    if (!mine()) return;
    if (!r || r.error) return setAi({ status: 'failed', message: r?.error || MESSAGES.noAnswer });
    const answer = r.answer ?? '';
    if (r.confident === false) {
      // The AI isn't sure either: say so and keep the local result (no switch, no correction).
      const named = r.cardId !== undefined ? p.response.cards[r.cardId]?.name : undefined;
      return setAi({ status: 'answered', answer: answer || named || '', cardId: r.cardId, confident: false });
    }
    if (r.cardId === undefined) return setAi({ status: 'answered', answer });

    const now = pinRef.current;
    if (now?.kind !== 'result') return;
    let response = now.response;
    let index = response.result.candidates.findIndex((c) => c.cardId === r.cardId);
    if (index < 0) {
      // The AI named a card outside the matches: fetch it and add it to the list.
      const got = await sendToBackground({ type: 'get-cards', ids: [r.cardId] }).catch(() => undefined);
      const card = got?.cards?.[r.cardId];
      if (!mine()) return;
      if (!card) return setAi({ status: 'answered', answer: answer || `#${r.cardId}` });
      const candidate = { cardId: card.id, imageId: r.imageId ?? card.imageIds[0], score: 0 };
      response = {
        ...response,
        cards: { ...response.cards, [card.id]: card },
        result: { ...response.result, candidates: [...response.result.candidates, candidate] },
      };
      index = response.result.candidates.length - 1;
    }
    setAi({ status: 'answered', answer: answer || response.cards[r.cardId].name, cardId: r.cardId });
    const latest = pinRef.current;
    select(latest?.kind === 'result' ? latest : now, response, index);
  };

  /**
   * "Find card" (nothing matched): the card the user named shows as this read's card ("Found by name"), recorded as a
   * read of it (record-found: a history entry, so Keep in side panel works; the crop kept when corrections are on).
   */
  const findCard = async (m: WrongCardMatch) => {
    const p = pinRef.current;
    if (p?.kind !== 'result' || !p.crop) return;
    const crop = p.crop;
    const mine = () => live.current && pinRef.current?.seq === p.seq;
    let r: RecordFoundResponse | undefined;
    try {
      r = await sendToBackground({
        type: 'record-found',
        crop,
        context: p.context ?? { pageUrl: location.href, pageTitle: document.title },
        cardId: m.cardId,
        imageId: m.imageId,
        modelId: p.response.result.modelId,
      });
    } catch {
      if (mine()) toasts.show(MESSAGES.disconnected);
      return;
    }
    if (!mine()) return;
    const card = r?.cards?.[m.cardId];
    if (!card) return toasts.show(MESSAGES.noAnswer);
    const found = { cardId: m.cardId, imageId: m.imageId, score: 0, source: 'name' as const };
    const response: RecognizeResponse = {
      ...p.response,
      cards: { ...p.response.cards, [m.cardId]: card },
      ...(r?.entry ? { entry: r.entry } : {}),
      result: { ...p.response.result, confident: true, candidates: [found] },
    };
    setPin({ ...p, response, selected: 0 });
  };

  const openOptions = () => {
    sendToBackground({ type: 'open-options' }).catch(() => {});
  };

  // A click on the page outside Duel Lens (outside the frozen frame: rarely possible) leaves scan mode
  // and still reaches the page, except on a video: there it only leaves (live check M2: YouTube would
  // toggle playback). The page's own script can't close it this way (security review M1).
  useLayoutEffect(() => {
    const host = (rootRef.current?.getRootNode() as (Node & { host?: Element }) | undefined)?.host;
    if (!host) return;
    const onDown = (e: PointerEvent) => {
      if (!fromUser(e) || e.composedPath().includes(host)) return;
      if (onVideo(e.clientX, e.clientY)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        swallowPress(e.pointerId);
      }
      onDone();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, []);

  // The frozen frame covers the page as it was captured. Once the page's layout changes under it
  // (fullscreen, a resized or zoomed window), scan mode ends (live check m2; while it is open, the layer
  // keeps F, T and I from the page instead). Only the browser's own fullscreenchange counts: the page's
  // script can't close it that way (security review M1). A resize is checked against the window's real
  // size, and the side panel that Keep opens takes its room without ending scan mode.
  useLayoutEffect(() => {
    let base = viewport ?? { w: window.innerWidth, h: window.innerHeight };
    const onResize = () => {
      const now = { w: window.innerWidth, h: window.innerHeight };
      // The panel only takes width: a zoom or a height change still leaves, grace or not.
      if (Date.now() < panelGrace.current && now.w < base.w && Math.abs(now.h - base.h) <= 2) base = now;
      else if (Math.abs(now.w - base.w) > 2 || Math.abs(now.h - base.h) > 2) onDone();
    };
    const onFullscreen = (e: Event) => {
      if (fromUser(e)) onDone();
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  // ---------- render ----------
  const popoverKeys: PopoverKeys | null = pin
    ? {
        close: () => closePin('card'),
        copy: () => pop.current?.copy(),
        keep: () => pop.current?.keep(),
        step: (dir) => pop.current?.step(dir),
        scroll: (dir) => pop.current?.scroll(dir),
        element: () => pop.current?.element() ?? null,
      }
    : null;
  const shownCards = cropCard ? cards : null;
  /** The card the board read is on: it shows the foil sweep, and picks and drags wait (as for any read). */
  const boardCard = reading ? shownCards?.[reading.index] : undefined;
  const previewCard = preview ? shownCards?.[preview.index] : undefined;
  const previewSays = preview ? previewText(preview.response) : null;
  const said = pin ? announcement(popoverState(pin), ai) : '';
  return (
    <div class="dl" lang={uiLang()} ref={rootRef}>
      <SelectionLayer
        screenshot={screenshot}
        viewport={viewport}
        onSelect={scanBox}
        onCancel={onDone}
        busy={boardCard ? boardCard.rect : pin?.kind === 'scanning' ? pin.rect : null}
        busyShape={boardCard ? boardCard.shape : pin?.kind === 'scanning' ? pin.shape : undefined}
        cards={shownCards}
        finding={finding}
        noneFound={!!cropCard && noneFound}
        onPick={pickCard}
        current={pin && pin.kind !== 'scanning' ? { rect: pin.rect, shape: pin.shape } : null}
        popover={popoverKeys}
        onDismiss={() => closePin('layer')}
        onEscape={onEscape}
        onActive={onActive}
        onBoard={cropCard ? () => void readBoard() : undefined}
        onFind={openFind}
        reading={reading ? { current: reading.current, total: reading.total } : null}
        onStopBoard={stopBoard}
        said={preview?.by === 'key' && previewSays && previewCard ? previewWords(previewSays, previewCard.label) : ''}
        describedBy={preview && previewCard ? { index: preview.index, id: PREVIEW_ID } : null}
        handle={layer}
      />
      {findAt ? <FindPanel bar={findAt} onPick={(m) => void lookUp(m)} onClose={closeFind} /> : null}
      {pin ? (
        <Popover
          key={pin.seq}
          anchor={pin.rect}
          state={popoverState(pin)}
          images={images}
          thumbs={thumbs}
          cropImage={!__DUEL_LENS_REMOTE_IMAGES__ && pin.kind === 'result' && pin.crop ? pin.crop.dataUrl : undefined}
          ai={ai}
          picked={!!pin.shape}
          keepPending={pin.kind === 'result' && !!pin.recording}
          onClose={(how) => closePin(how === 'pointer' ? 'layer' : 'card')}
          onKeep={() => void keep()}
          onCorrect={correct}
          onAskAi={() => void askAi()}
          onFindCard={(m) => void findCard(m)}
          onOpenOptions={openOptions}
          handle={pop}
        />
      ) : null}
      {preview && previewCard && reveal === 'full' ? (
        <Popover
          key={`hover-${preview.index}`}
          anchor={previewCard.rect}
          state={hoverState(preview.index, preview.response)}
          thumbs={thumbs}
          cropImage={!__DUEL_LENS_REMOTE_IMAGES__ ? hoverState(preview.index, preview.response).crop?.dataUrl : undefined}
          hover={{
            id: PREVIEW_ID,
            onEnter: () => {
              overPreview.current = true;
              cancelHide();
            },
            onLeave: () => {
              overPreview.current = false;
              scheduleHide();
            },
          }}
          onClose={() => hidePreview()}
          onKeep={() => {}}
          onCorrect={() => {}}
          onAskAi={() => {}}
          onOpenOptions={openOptions}
        />
      ) : preview && previewCard && previewSays ? (
        <Preview
          anchor={previewCard.rect}
          text={previewSays}
          avoid={() => {
            const others = (shownCards ?? []).filter((_, i) => i !== preview.index).map((c) => c.rect);
            const r = pop.current?.element()?.getBoundingClientRect();
            return r && r.width > 0 ? [...others, { x: r.left, y: r.top, w: r.width, h: r.height }] : others;
          }}
          onEnter={() => {
            overPreview.current = true;
            cancelHide();
          }}
          onLeave={() => {
            overPreview.current = false;
            scheduleHide();
          }}
          onPick={() => pickCard(preview.index)}
        />
      ) : null}
      <Toast store={toasts} />
      <p class="sr-only announce" role="status">
        {said}
      </p>
    </div>
  );
}
