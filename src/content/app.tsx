// The content UI state machine: selecting → scanning → result (or error).
// - selecting: the frozen frame; the cards the detector found are outlined once its answer comes
//   (`detection`, matched to this screenshot by index.ts). The user clicks a card or drags a box.
// - scanning: the frame stays frozen, the box (or the clicked card) shows the foil sweep and
//   "Matching artwork…".
// - result: the frozen frame goes, the popover sits beside the box or card, images load (in the
//   crop build, `--no-remote-images`, the popover shows the user's own crop instead).
// One status region says each outcome in words, from "Matching artwork…" to the answer (a11y review
// B2). The overlay is in English whatever the page's language (M4).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { sendToBackground, type AskAiResponse, type CardDetection, type RecognizeResponse } from '../shared/messages';
import type { CropPayload } from '../shared/types';
import type { CropResult } from './capture';
import type { OrientedBox, Rect } from './geometry';
import type { HostState } from './host';
import { outlinesFrom, type CardOutline } from './outlines';
import { alternativeIndices, announcement, displayedCard, Popover, viewableIndices, type AiStatus, type PopoverState } from './popover';
import { SelectionBox, SelectionLayer } from './selection';
import { Toast, type ToastStore } from './toast';
import { fromUser } from './trusted';

export const MESSAGES = {
  videoBlocked: 'This video blocks screenshots',
  cropFailed: "Couldn't read that part of the screen. Try again.",
  disconnected: 'Duel Lens was updated or restarted. Reload the page to scan again.',
  noAnswer: "Duel Lens didn't answer. Try again.",
  panelFailed: "Couldn't open the side panel.",
  matcherFailed: (detail: string) => `Duel Lens couldn't load its card matcher (${detail}).`,
} as const;

/** How long the hint says "Finding cards…" while the detector hasn't answered. */
export const FINDING_MS = 1500;

/** What is being scanned: a dragged box, or a detected card (its bounds, and its turned shape). */
interface Target {
  rect: Rect;
  shape?: OrientedBox;
}

type Phase =
  | { kind: 'selecting' }
  | ({ kind: 'scanning' } & Target)
  | ({ kind: 'result'; response: RecognizeResponse; crop: CropPayload; selected: number } & Target)
  | ({ kind: 'error'; message: string; showOptions?: boolean } & Target);

export interface AppProps {
  /** The captureVisibleTab screenshot (PNG data URL) shown as the frozen frame. */
  screenshot: string;
  /** innerWidth x innerHeight when the screenshot was taken (the frozen frame's size). */
  viewport?: { w: number; h: number };
  /** Cut the box out of the best source (video frame or screenshot). */
  crop(rect: Rect): Promise<CropResult>;
  /** Cut a detected card out of the best source (click to scan). */
  cropCard?(card: CardOutline): Promise<CropResult>;
  /** The detector's cards on this screenshot. It may come mid-drag, or never (then dragging is all there is). */
  detection?: Promise<CardDetection>;
  /** False when the last detection couldn't run: no "Finding cards…" (cards that do come are still outlined). */
  expectCards?: boolean;
  /** The visible videos' pictures on the page (CSS px) when the frame froze: a big one keeps the outlines to itself. */
  videos?: Rect[];
  toasts: ToastStore;
  /** Receives the UI state, for the host element's data attributes. */
  onState?(s: HostState): void;
  /** Close everything (unmounts the host). */
  onDone(): void;
}

function hostStateOf(phase: Phase, cards: CardOutline[] | null): HostState {
  if (phase.kind === 'selecting') return cards ? { state: 'selecting', cards: cards.length } : { state: 'selecting' };
  if (phase.kind !== 'result') return { state: phase.kind };
  const shown = displayedCard(phase.response, phase.selected);
  return { state: 'result', card: shown?.card.name, confident: phase.response.result.confident };
}

function popoverState(phase: Exclude<Phase, { kind: 'selecting' }>): PopoverState {
  switch (phase.kind) {
    case 'scanning':
      return { kind: 'scanning' };
    case 'result':
      return { kind: 'result', response: phase.response, crop: phase.crop, selected: phase.selected };
    case 'error':
      return { kind: 'error', message: phase.message, showOptions: phase.showOptions };
  }
}

const getImage = (imageId: number, size: 'full' | 'small') =>
  sendToBackground({ type: 'get-image', imageId, size }).then(
    (r) => r?.dataUrl ?? null,
    () => null,
  );

/** Whether a press at (x, y) lands on a video, under whatever sits on top of it (a player's controls). */
function onVideo(x: number, y: number): boolean {
  return document.elementsFromPoint?.(x, y).some((el) => el instanceof HTMLVideoElement) ?? false;
}

/**
 * Keeps the rest of a press from the page: its mousedown, mouseup and click, and the pointerup that
 * ends it. The click on YouTube's video that closes the popover would also toggle playback (live
 * check M2). Mouse events that don't come (the pointerdown was cancelled) leave nothing behind: it
 * all ends right after this press's pointerup, or after 3 s for a press released outside the window.
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

export function App({ screenshot, viewport, crop, cropCard, detection, expectCards = true, videos, toasts, onState, onDone }: AppProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'selecting' });
  /** The detected cards, outlined; null until the detector answers. */
  const [cards, setCards] = useState<CardOutline[] | null>(null);
  /** The detector answered and found no card to outline (not the same as a detection that failed). */
  const [noneFound, setNoneFound] = useState(false);
  const [finding, setFinding] = useState(detection !== undefined && expectCards);
  const [ai, setAi] = useState<AiStatus>({ status: 'idle' });
  const [images, setImages] = useState<Record<number, string | null>>({});
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({});
  const requested = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  useLayoutEffect(() => onState?.(hostStateOf(phase, cards)), [phase, cards]);

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

  // ---------- scanning ----------
  const fail = (target: Target, message: string, showOptions = false) => {
    if (live.current) setPhase({ kind: 'error', ...target, message, showOptions });
  };

  const scan = async (target: Target, cut: () => Promise<CropResult>) => {
    setPhase({ kind: 'scanning', ...target });
    let cropped: CropResult;
    try {
      cropped = await cut();
    } catch {
      // A crop/decode failure (e.g. the screenshot didn't decode) is local and often
      // transient - distinct from the restricted-page copy, which means the whole page
      // is off-limits.
      return fail(target, MESSAGES.cropFailed);
    }
    if (!live.current) return;
    // An unreadable video (DRM/cross-origin) comes out black: say so rather than "no
    // match". A readable video's own dark frame (e.g. a fade-to-black) is not a block -
    // let it through to normal recognition.
    if (cropped.black && cropped.overVideo && !cropped.videoReadable) return fail(target, MESSAGES.videoBlocked);
    let response: RecognizeResponse | undefined;
    try {
      response = await sendToBackground({
        type: 'recognize',
        crop: cropped.crop,
        context: {
          pageUrl: location.href,
          pageTitle: document.title,
          ...(cropped.videoTime !== undefined ? { videoTime: cropped.videoTime } : {}),
        },
      });
    } catch {
      return fail(target, MESSAGES.disconnected);
    }
    if (!live.current) return;
    if (!response?.result) return fail(target, MESSAGES.noAnswer);
    if (response.result.error) return fail(target, MESSAGES.matcherFailed(response.result.error), true);
    setPhase({ kind: 'result', ...target, response, crop: cropped.crop, selected: viewableIndices(response)[0] ?? 0 });
  };

  const scanBox = (rect: Rect) => void scan({ rect }, () => crop(rect));

  const scanCard = (index: number) => {
    const card = cards?.[index];
    if (card && cropCard) void scan({ rect: card.rect, shape: card.shape }, () => cropCard(card));
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
    if (phase.kind !== 'result') return;
    const shown = displayedCard(phase.response, phase.selected);
    if (!shown) return;
    const cands = phase.response.result.candidates;
    load(cands[shown.index].imageId, 'full');
    // The matches the popover offers (the top one's image is loaded in full above, when it is shown).
    for (const i of alternativeIndices(phase.response)) load(cands[i].imageId, 'small');
  }, [phase]);

  // ---------- popover actions ----------
  const select = (p: Extract<Phase, { kind: 'result' }>, response: RecognizeResponse, index: number) => {
    const current = displayedCard(p.response, p.selected)?.index;
    setPhase({ ...p, response, selected: index });
    const c = response.result.candidates[index];
    if (index !== current && response.entry) {
      sendToBackground({ type: 'correct', entryId: response.entry.id, cardId: c.cardId, imageId: c.imageId }).catch(() => {});
    }
  };

  const correct = (cardId: number) => {
    const p = phaseRef.current;
    if (p.kind !== 'result') return;
    const index = p.response.result.candidates.findIndex((c) => c.cardId === cardId);
    if (index >= 0) select(p, p.response, index);
  };

  const keep = async () => {
    const p = phaseRef.current;
    if (p.kind !== 'result' || !p.response.entry) return;
    try {
      const r = await sendToBackground({ type: 'show-in-panel', entryId: p.response.entry.id });
      if (r?.ok) onDone();
      else toasts.show(r?.error || MESSAGES.panelFailed);
    } catch {
      toasts.show(MESSAGES.disconnected);
    }
  };

  const askAi = async () => {
    const p = phaseRef.current;
    if (p.kind !== 'result') return;
    setAi({ status: 'asking' });
    let r: AskAiResponse | undefined;
    try {
      r = await sendToBackground({ type: 'ask-ai', crop: p.crop, candidates: p.response.result.candidates });
    } catch {
      if (live.current) setAi({ status: 'failed', message: MESSAGES.disconnected });
      return;
    }
    if (!live.current) return;
    if (!r || r.error) return setAi({ status: 'failed', message: r?.error || MESSAGES.noAnswer });
    const answer = r.answer ?? '';
    if (r.confident === false) {
      // The AI isn't sure either: say so and keep the local result (no switch, no correction).
      const named = r.cardId !== undefined ? p.response.cards[r.cardId]?.name : undefined;
      return setAi({ status: 'answered', answer: answer || named || '', cardId: r.cardId, confident: false });
    }
    if (r.cardId === undefined) return setAi({ status: 'answered', answer });

    const now = phaseRef.current;
    if (now.kind !== 'result') return;
    let response = now.response;
    let index = response.result.candidates.findIndex((c) => c.cardId === r.cardId);
    if (index < 0) {
      // The AI named a card outside the matches: fetch it and add it to the list.
      const got = await sendToBackground({ type: 'get-cards', ids: [r.cardId] }).catch(() => undefined);
      const card = got?.cards?.[r.cardId];
      if (!live.current) return;
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
    select(phaseRef.current.kind === 'result' ? phaseRef.current : now, response, index);
  };

  const openOptions = () => {
    sendToBackground({ type: 'open-options' }).catch(() => {});
  };

  // A click anywhere on the page outside the popover closes it, and still reaches the page, except on
  // a video: there it only closes the popover (live check M2: YouTube would toggle playback). The
  // page's own script can't close it this way (security review M1).
  useLayoutEffect(() => {
    if (phase.kind !== 'result' && phase.kind !== 'error') return;
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
  }, [phase.kind]);

  // The popover sits beside a box on the frozen frame. Once the page's layout changes under it
  // (fullscreen, a resized or zoomed window), it would point at the old place, so it closes (live
  // check m2; while the frame is frozen, the selection keeps F, T and I from the page instead).
  // Only the browser's own fullscreenchange counts: the page's script can't close it that way
  // (security review M1). A resize is checked against the window's real size instead.
  const popoverShown = phase.kind !== 'selecting';
  useLayoutEffect(() => {
    if (!popoverShown) return;
    const base = viewport ?? { w: window.innerWidth, h: window.innerHeight };
    const onResize = () => {
      if (Math.abs(window.innerWidth - base.w) > 2 || Math.abs(window.innerHeight - base.h) > 2) onDone();
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
  }, [popoverShown]);

  const anchor = phase.kind === 'selecting' ? null : phase.rect;
  const shape = phase.kind === 'selecting' ? undefined : phase.shape;
  const said = phase.kind === 'selecting' ? '' : announcement(popoverState(phase), ai);
  return (
    <div class="dl" lang="en" ref={rootRef}>
      {phase.kind === 'selecting' || phase.kind === 'scanning' ? (
        <SelectionLayer
          screenshot={screenshot}
          viewport={viewport}
          onSelect={scanBox}
          onCancel={onDone}
          busy={phase.kind === 'scanning' ? phase.rect : null}
          busyShape={shape}
          cards={cropCard ? cards : null}
          finding={finding}
          noneFound={!!cropCard && noneFound}
          onPick={scanCard}
        />
      ) : anchor ? (
        <SelectionBox rect={anchor} mode="done" shape={shape} />
      ) : null}
      {phase.kind !== 'selecting' && anchor ? (
        <Popover
          anchor={anchor}
          state={popoverState(phase)}
          images={images}
          thumbs={thumbs}
          cropImage={!__DUEL_LENS_REMOTE_IMAGES__ && phase.kind === 'result' ? phase.crop.dataUrl : undefined}
          ai={ai}
          picked={!!shape}
          onClose={onDone}
          onKeep={() => void keep()}
          onCorrect={correct}
          onAskAi={() => void askAi()}
          onOpenOptions={openOptions}
        />
      ) : null}
      <Toast store={toasts} />
      <p class="sr-only announce" role="status">
        {said}
      </p>
    </div>
  );
}
