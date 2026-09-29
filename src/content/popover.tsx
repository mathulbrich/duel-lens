// The popover beside the user's box: the matched card, how sure the match is, the next
// best matches ("Not it?"), and the actions. Always dark, with a foil top edge.
// - When the answer (or an error) comes it takes focus (a11y review B2); the overlay's status region
//   (app.tsx) says the outcome in words (announcement()).
// - Only the user's own clicks count (security review M1): a script's click on a button does nothing.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RecognizeResponse } from '../shared/messages';
import { CARD_BACK_ID, type Candidate, type CardRecord, type CropPayload, type RecognitionResult } from '../shared/types';
import { CardView, cardText, ygoprodeckUrl } from './card-view';
import { arrowOffset, placePopover, type Placement, type Rect } from './geometry';
import { LensIcon } from './icons';
import { installKeyHandler } from './keys';
import { byUser, fromUser } from './trusted';

export type PopoverState =
  | { kind: 'scanning' }
  | { kind: 'result'; response: RecognizeResponse; crop: CropPayload; selected: number /* index into candidates */ }
  | { kind: 'error'; message: string; showOptions?: boolean };

export type AiStatus =
  | { status: 'idle' }
  | { status: 'asking' }
  /** confident: the AI's own flag; false means it isn't sure either. */
  | { status: 'answered'; answer: string; cardId?: number; confident?: boolean }
  | { status: 'failed'; message: string };

export interface PopoverProps {
  anchor: Rect;
  state: PopoverState;
  /** Main image per imageId: a data URL, null when unavailable (text-only view); absent while loading. */
  images?: Record<number, string | null>;
  /** Small images per imageId, for the alternatives. */
  thumbs?: Record<number, string | null>;
  /**
   * The crop build (`--no-remote-images`): the user's own crop, shown as the card's picture
   * whichever match is shown; the other matches get no thumbnails.
   */
  cropImage?: string;
  ai?: AiStatus;
  /** The scan was a card picked from the outlines (click to scan), not a box the user drew. */
  picked?: boolean;
  onClose(): void;
  onKeep(): void;
  onCorrect(cardId: number, imageId: number): void;
  onAskAi(): void;
  onOpenOptions?(): void;
}

export const COPY = {
  scanning: 'Matching artwork…',
  faceDown: 'Face-down card: nothing to read yet.',
  nothing: "Couldn't match this. Frame the whole card, or just its artwork.",
  /** After a click on an outline (live check m6): the user framed nothing, so no framing advice. */
  nothingPicked: "Couldn't read this card. Pause on a sharper moment, raise the video quality, or drag a box around just its artwork.",
  /** The card runs off the edge of the picture and nothing matched (RecognitionResult.truncated). */
  nothingTruncated: "Part of this card is outside the picture. Try when it's fully in view, or box just its artwork.",
  /**
   * No match cleared the floor, but a card was picked (a click, or the detector's card in the box): the engine
   * offers its closest cards (RecognitionResult.suggested; click-regression-report.md).
   */
  suggested: 'Low match: could be one of these.',
  /** The same, when the engine suggests a single card. */
  suggestedOne: 'Low match: this could be it.',
  /** The status region's words for "nothing matched" (a11y review B2). */
  noCard: 'No card found.',
  lowQuality: 'Raise the video quality for a better match',
  copyBlocked: 'Copying is blocked here. Select the text instead.',
} as const;

/** On a confident answer, the chips ("Not it?") offer only matches this close to its score (live check p1). */
export const CLOSE_MATCH = 0.1;

/** Candidate indices that can be shown: real cards (not the card back) with card data. */
export function viewableIndices(res: RecognizeResponse): number[] {
  return res.result.candidates.flatMap((c, i) => (c.cardId !== CARD_BACK_ID && res.cards[c.cardId] ? [i] : []));
}

/**
 * Nothing plausible matched. The engine applies the model's floor and returns no candidates
 * below it (types.ts), so an empty list is the only signal; the UI doesn't re-decide.
 */
export function isNothingFound(result: RecognitionResult): boolean {
  return result.candidates.length === 0;
}

/**
 * The candidate the popover shows for `selected`: that index when it is viewable, else
 * the best viewable one. Null for face-down cards and when nothing was found.
 */
export function displayedCard(res: RecognizeResponse, selected: number): { index: number; card: CardRecord } | null {
  if (res.result.faceDown || isNothingFound(res.result)) return null;
  const viewable = viewableIndices(res);
  const index = viewable.includes(selected) ? selected : viewable[0];
  if (index === undefined) return null;
  return { index, card: res.cards[res.result.candidates[index].cardId] };
}

/**
 * The matches offered as chips beside the top one (the first viewable candidate): on a confident
 * answer only those within CLOSE_MATCH of its score, on an unsure one the next ones whatever their
 * scores; three at most. ← and → still step through every match.
 */
export function alternativeIndices(res: RecognizeResponse): number[] {
  const [top, ...rest] = viewableIndices(res);
  if (top === undefined) return [];
  const floor = res.result.confident ? res.result.candidates[top].score - CLOSE_MATCH : -Infinity;
  return rest.filter((i) => res.result.candidates[i].score >= floor).slice(0, 3);
}

/**
 * What the overlay's status region says for this state (a11y review B2): the card's name, "Not sure"
 * with the closest match and how many more are offered, "No card found.", the face-down note, the
 * error, or what the AI check answered.
 */
export function announcement(state: PopoverState, ai?: AiStatus): string {
  if (state.kind === 'scanning') return COPY.scanning;
  if (state.kind === 'error') return state.message;
  if (ai?.status === 'asking') return 'Asking AI…';
  if (ai?.status === 'failed') return `AI check failed: ${ai.message}`;
  if (ai?.status === 'answered') {
    if (ai.confident === false) return `AI isn't sure: ${ai.answer}.`;
    return ai.cardId === undefined ? `AI says "${ai.answer}", which isn't in the card data.` : `AI says: ${ai.answer}.`;
  }
  const res = state.response;
  if (res.result.faceDown) return COPY.faceDown;
  const shown = displayedCard(res, state.selected);
  if (!shown) return COPY.noCard;
  if (res.result.confident || shown.index !== viewableIndices(res)[0]) return `${shown.card.name}.`;
  const more = alternativeIndices(res).length;
  return `${res.result.suggested ? 'Low match' : 'Not sure'}. Closest: ${shown.card.name}${more ? `, ${more} more possible match${more === 1 ? '' : 'es'}` : ''}.`;
}

/**
 * A candidate's score as a percentage: every candidate is the embedding matcher's, so all share
 * one scale (its cosine). Null for a card with no score of ours (the AI's pick).
 */
function scoreOf(c: Candidate): number | null {
  return c.score > 0 ? Math.round(Math.min(1, c.score) * 100) : null;
}

const HOW = { quad: 'card outline', whole: 'whole box', fit: 'card-shaped fit', art: 'artwork only' } as const;

/** "card outline, upside-down · 720p video" */
function methodText(result: RecognitionResult, crop: CropPayload): string {
  const rot = result.best?.rotation;
  const turn = rot === 180 ? 'upside-down' : rot === 90 || rot === 270 ? 'sideways' : undefined;
  const how = [result.best ? HOW[result.best.hypothesis] : undefined, turn].filter(Boolean).join(', ');
  const from = crop.source === 'video' ? (crop.videoHeight ? `${crop.videoHeight}p video` : 'video') : 'screenshot';
  return [how, from].filter(Boolean).join(' · ');
}

async function writeClipboard(text: string, near: HTMLElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not allowed here (permissions policy, no focus): try the old way.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    (near ?? document.body).append(ta);
    const prev = document.activeElement as HTMLElement | null;
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    prev?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

function Thumb({ src }: { src: string | null | undefined }) {
  return src ? <img src={src} alt="" draggable={false} /> : <span class="thumb" />;
}

export function Popover(props: PopoverProps) {
  const { anchor, state, images, thumbs, cropImage, ai, picked, onClose, onKeep, onCorrect, onAskAi, onOpenOptions } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ p: Placement; arrow: number } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // ---------- what to show ----------
  const res = state.kind === 'result' ? state.response : null;
  const crop = state.kind === 'result' ? state.crop : null;
  const faceDown = !!res?.result.faceDown;
  const display = state.kind === 'result' ? displayedCard(state.response, state.selected) : null;
  const viewable = display && res ? viewableIndices(res) : [];
  const shownIndex = display?.index;
  const shown = res && shownIndex !== undefined ? res.result.candidates[shownIndex] : undefined;
  const card: CardRecord | undefined = display?.card;
  const topIndex = viewable[0];
  /** The user picked another card than the top match. */
  const ownPick = shownIndex !== topIndex;
  /**
   * Once the user has picked another match, the top match joins the chips and the shown one stays
   * among them, pressed (a11y review m4): the chip just pressed doesn't vanish from under the focus.
   */
  const comparing = useRef(false);
  if (display && ownPick) comparing.current = true;

  // ---------- actions ----------
  const copy = async () => {
    if (!card) return;
    const ok = await writeClipboard(cardText(card), ref.current);
    setCopyState(ok ? 'copied' : 'failed');
  };
  useEffect(() => {
    if (copyState !== 'copied') return;
    const t = setTimeout(() => setCopyState('idle'), 1600);
    return () => clearTimeout(t);
  }, [copyState]);

  const step = (dir: 1 | -1) => {
    if (!res || shownIndex === undefined || viewable.length < 2) return;
    const pos = viewable.indexOf(shownIndex);
    const next = res.result.candidates[viewable[(pos + dir + viewable.length) % viewable.length]];
    onCorrect(next.cardId, next.imageId);
  };

  // Keys (YouTube safety lives in installKeyHandler); handlers read the latest render.
  const keys = useRef({ close: onClose, keep: () => {}, copy: () => {}, prev: () => {}, next: () => {} });
  keys.current = {
    close: onClose,
    keep: () => {
      if (card && res?.entry) onKeep();
    },
    copy: () => {
      void copy();
    },
    prev: () => step(-1),
    next: () => step(1),
  };
  useLayoutEffect(
    () =>
      installKeyHandler(
        {
          onClose: () => keys.current.close(),
          onKeep: () => keys.current.keep(),
          onCopy: () => keys.current.copy(),
          onPrev: () => keys.current.prev(),
          onNext: () => keys.current.next(),
        },
        window,
        // The shadow host: same trick as app.tsx's click-outside listener. If it's ever
        // removed without our own cleanup running (a fresh world's mountHost() after an
        // extension reload), the key handler notices and uninstalls itself.
        (ref.current?.getRootNode() as (Node & { host?: Element }) | undefined)?.host,
      ),
    [],
  );

  // ---------- focus: the answer or the error, once placed (a hidden popover can't take focus) ----------
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (focused.current || !place || (state.kind !== 'result' && state.kind !== 'error')) return;
    focused.current = true;
    ref.current?.focus({ preventScroll: true });
  }, [state.kind, !!place]);

  // A control that had focus can go away (Ask AI once the AI has answered, the top match's chip once
  // it is shown again): focus then stays in the popover instead of falling to the page's <body>. It
  // is never taken back from where the user moved it on the page.
  const root = ref.current?.getRootNode() as (Node & { activeElement?: Element | null }) | undefined;
  const hadFocus = !!root?.activeElement && !!ref.current?.contains(root.activeElement);
  useLayoutEffect(() => {
    if (hadFocus && ref.current && (!document.activeElement || document.activeElement === document.body)) {
      ref.current.focus({ preventScroll: true });
    }
  });

  // ---------- placement: right of the box, else left, else below/above; clamped ----------
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const size = { w: r.width, h: r.height };
      const p = placePopover(anchor, size, { w: window.innerWidth, h: window.innerHeight });
      const arrow = arrowOffset(anchor, p, size);
      setPlace((prev) =>
        prev && prev.p.x === p.x && prev.p.y === p.y && prev.p.side === p.side && prev.arrow === arrow ? prev : { p, arrow },
      );
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [anchor.x, anchor.y, anchor.w, anchor.h]);

  // ---------- pieces ----------
  const lowQualityTip =
    crop && res && !res.result.confident && crop.source === 'video' && crop.videoHeight !== undefined && crop.videoHeight <= 480 ? (
      <p class="note tip">{COPY.lowQuality}</p>
    ) : null;

  /** A row of cards to pick from: the candidates at `indices`, the shown one pressed, under `label` (none when the text above introduces them). */
  const chips = (group: string, label: string | null, indices: number[]) => {
    if (!res || !indices.length) return null;
    return (
      <div class="dv-alts" role="group" aria-label={group}>
        {label ? <span aria-hidden="true">{label}</span> : null}
        {indices.map((i) => {
          const c = res.result.candidates[i];
          const score = scoreOf(c);
          return (
            <button
              type="button"
              class="alt"
              key={c.cardId}
              title={res.cards[c.cardId].name}
              aria-pressed={i === shownIndex ? 'true' : 'false'}
              onClick={byUser(() => onCorrect(c.cardId, c.imageId))}
            >
              {/* The top card's image is loaded in full, not small (it is listed here once the user picked another). */}
              {cropImage === undefined ? <Thumb src={thumbs?.[c.imageId] ?? images?.[c.imageId]} /> : null}
              <em>{res.cards[c.cardId].name}</em>
              {score === null ? null : <b>{`${score}%`}</b>}
            </button>
          );
        })}
      </div>
    );
  };

  /** The offered matches; once the user picked one, the top match first and the shown one kept. */
  const chipIndices = (): number[] => {
    if (!res || topIndex === undefined) return [];
    const alts = alternativeIndices(res);
    if (!comparing.current) return alts;
    const list = [topIndex, ...alts];
    return shownIndex === undefined || list.includes(shownIndex) ? list : [...list, shownIndex];
  };

  const alternatives = (label: string) => chips('Other matches', label, chipIndices());

  const matchLine = () => {
    if (!res || !shown || !crop) return null;
    const unsure = !res.result.confident;
    // Only an AI that is itself sure may vouch for the card ("AI agrees" / "AI pick").
    const aiPick = ai?.status === 'answered' && ai.confident !== false && ai.cardId === shown.cardId;
    const p = scoreOf(shown);
    // A neutral (empty) meter when there is no number on the top match's scale.
    const meter = (
      <span class={`meter${p === null ? ' neutral' : ''}`} aria-hidden="true">
        {p === null ? null : <i style={{ width: `${p}%` }} />}
      </span>
    );
    const scoreText = p !== null ? `${p}% match` : null;
    // How and from what it matched is for the curious, in a tooltip (live check p2); a low video
    // quality stays on the line, as a hint.
    const how = methodText(res.result, crop);
    const lowRes = crop.source === 'video' && crop.videoHeight !== undefined && crop.videoHeight <= 480 ? ` · ${crop.videoHeight}p video` : null;
    if (aiPick && !ownPick) {
      // The AI confirmed the top match: no longer "Not sure".
      return (
        <div class="dv-match" title={how}>
          {meter}
          <span>
            <b>AI agrees</b>
            {p !== null ? ` · ${p}% artwork match` : null}
          </span>
        </div>
      );
    }
    return (
      <div class={`dv-match${unsure && !ownPick ? ' low' : ''}`} title={how}>
        {meter}
        {ownPick ? (
          <span>
            <b>{aiPick ? 'AI pick' : 'You picked this'}</b>
            {scoreText ? ` · ${scoreText}` : null}
          </span>
        ) : (
          <span>
            <b>{[unsure ? 'Not sure' : null, scoreText].filter(Boolean).join(' · ') || 'Match'}</b>
            {lowRes}
          </span>
        )}
      </div>
    );
  };

  const aiControls = () => {
    // The background says whether the AI check is on, so no settings reach this page.
    if (!res?.aiEnabled) {
      return (
        <div class="dv-actions">
          <button type="button" class="btn" onClick={byUser(() => onOpenOptions?.())}>
            Turn on AI check in Options
          </button>
        </div>
      );
    }
    const s = ai ?? { status: 'idle' };
    return (
      <>
        {s.status === 'answered' ? null : (
          <div class="dv-actions">
            <button type="button" class="btn gold" disabled={s.status === 'asking'} onClick={byUser(() => onAskAi())}>
              {s.status === 'asking' ? 'Asking AI…' : 'Ask AI'}
            </button>
          </div>
        )}
        {s.status === 'answered' ? (
          s.confident === false ? (
            <p class="note">AI isn't sure: {s.answer}</p>
          ) : s.cardId !== undefined ? (
            <p class="note">AI says: {s.answer}</p>
          ) : (
            <p class="note">AI says "{s.answer}", which isn't in the card data.</p>
          )
        ) : null}
        {s.status === 'failed' ? <p class="note err">AI check failed: {s.message}</p> : null}
      </>
    );
  };

  const actions = () =>
    card ? (
      <>
        <div class="dv-actions">
          {res?.entry ? (
            <button type="button" class="btn" onClick={byUser(() => onKeep())}>
              Keep in side panel
            </button>
          ) : null}
          <button type="button" class="btn" onClick={byUser(() => void copy())}>
            {copyState === 'copied' ? 'Copied' : 'Copy text'}
          </button>
          <a
            class="btn"
            href={ygoprodeckUrl(card.id)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!fromUser(e)) e.preventDefault();
            }}
          >
            YGOPRODeck ↗
          </a>
        </div>
        {copyState === 'failed' ? <p class="note err">{COPY.copyBlocked}</p> : null}
        {/* The glyphs are for the eye; screen readers get the same in words (a11y review m5). */}
        <p class="note keys" aria-hidden="true">
          {res?.entry ? (
            <>
              <kbd>K</kbd> keep ·{' '}
            </>
          ) : null}
          <kbd>C</kbd> copy · <kbd>←</kbd> <kbd>→</kbd> other matches · <kbd>Esc</kbd> close
        </p>
        <p class="sr-only">
          {`Keyboard: ${res?.entry ? 'K keeps, ' : ''}C copies, left and right arrows show other matches, Escape closes`}
        </p>
      </>
    ) : null;

  let body;
  if (state.kind === 'scanning') {
    body = (
      <>
        <div class="skel" aria-hidden="true">
          <div class="skel-card" />
          <div class="skel-lines">
            <i />
            <i style={{ width: '55%' }} />
            <i />
            <i style={{ width: '85%' }} />
          </div>
        </div>
      </>
    );
  } else if (state.kind === 'error') {
    body = (
      <div class="dv-msg">
        <p class="lead">{state.message}</p>
        {state.showOptions && onOpenOptions ? (
          <div class="dv-actions">
            <button type="button" class="btn" onClick={byUser(() => onOpenOptions())}>
              Open Options
            </button>
          </div>
        ) : null}
      </div>
    );
  } else if (faceDown) {
    body = (
      <div class="dv-msg">
        <p class="lead">{COPY.faceDown}</p>
        <p class="note">Scan it again once it is turned face-up.</p>
      </div>
    );
  } else if (!card || !shown) {
    // A card cut by the picture's edge says so, and quality isn't what went wrong. A card picked from
    // the outlines gets its own advice (it already says to raise the quality).
    const truncated = !!res?.result.truncated;
    body = (
      <div class="dv-msg">
        <p class="lead">{truncated ? COPY.nothingTruncated : picked ? COPY.nothingPicked : COPY.nothing}</p>
        {picked || truncated ? null : lowQualityTip}
      </div>
    );
  } else {
    // The small image stands in while the full one loads; null means neither exists. Without remote
    // images, the user's own crop is the picture.
    const full = images?.[shown.imageId];
    const view =
      cropImage !== undefined ? (
        <CardView card={card} imageDataUrl={cropImage} ownCrop />
      ) : (
        <CardView card={card} imageDataUrl={full !== undefined ? full : thumbs?.[shown.imageId]} />
      );
    body = !res!.result.confident ? (
      <>
        <div class="unsure">
          {res!.result.suggested ? <p class="note low">{viewableIndices(res!).length > 1 ? COPY.suggested : COPY.suggestedOne}</p> : null}
          {matchLine()}
          {alternatives('Could also be')}
          {aiControls()}
          {lowQualityTip}
        </div>
        {view}
        <div class="dv-foot">{actions()}</div>
      </>
    ) : (
      <>
        {view}
        <div class="dv-foot">
          {matchLine()}
          {alternatives(shownIndex !== topIndex ? 'Other matches' : 'Not it?')}
          {actions()}
        </div>
      </>
    );
  }

  const style: Record<string, string> = place
    ? { left: `${place.p.x}px`, top: `${place.p.y}px`, '--arrow': `${place.arrow}px` }
    : {};
  return (
    <div
      ref={ref}
      class={`ov pop${place ? '' : ' measuring'}`}
      role="dialog"
      aria-label="Duel Lens card details"
      aria-busy={state.kind === 'scanning' ? 'true' : undefined}
      tabIndex={-1}
      data-side={place?.p.side}
      style={style}
    >
      <div class="pop-scroll">
        <div class="ov-top">
          <span class="brand">
            <LensIcon />
            Duel Lens
          </span>
          <button type="button" class="x" aria-label="Close" onClick={byUser(() => onClose())}>
            ×
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
