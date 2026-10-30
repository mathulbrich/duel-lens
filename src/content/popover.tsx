// The popover beside the user's box: the matched card, how sure the match is, the next
// best matches ("Not it?"), and the actions. Always dark, with a foil top edge.
// - When the answer (or an error) comes it takes focus (a11y review B2); the overlay's status region
//   (app.tsx) says the outcome in words (announcement()).
// - Its keys (C copy, S side panel, ← → other matches, Esc close, ↑ ↓ scroll) come through scan mode's
//   one key handler (selection.tsx), which calls the actions it hands over (`handle`).
// - Only the user's own clicks count (security review M1): a script's click on a button does nothing.
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RecognizeResponse } from '../shared/messages';
import type { ReportCard, ReportDraft } from '../shared/report';
import { CARD_BACK_ID, type Candidate, type CardRecord, type CropPayload, type RecognitionResult, type ScanContext } from '../shared/types';
import { CardView, cardText, ygoprodeckUrl } from './card-view';
import { t } from '../shared/i18n';
import { arrowOffset, placePopover, type Placement, type Rect } from './geometry';
import { LensIcon } from './icons';
import { byUser, fromUser } from './trusted';
import { ReportPanel } from './report-panel';
import { WrongCardPanel, type WrongCardMatch } from './wrong-card';

export type PopoverState =
  | { kind: 'scanning' }
  /** `context`: where the read was (the page, the video's time), for "Report" (report-panel.tsx). */
  /** No `crop`: a card looked up by name (the bar's "Find card"), nothing of the page read: no report, no AI. */
  | { kind: 'result'; response: RecognizeResponse; crop?: CropPayload; selected: number /* index into candidates */; context?: ScanContext }
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
  /**
   * The card shows from its hover preview while its history entry is being recorded: "Keep in side
   * panel" shows, disabled, until the entry comes (app.tsx).
   */
  keepPending?: boolean;
  /** The × was pressed: with a pointer, or from the keyboard (Enter or Space on it). */
  onClose(how?: 'pointer' | 'key'): void;
  onKeep(): void;
  onCorrect(cardId: number, imageId: number): void;
  onAskAi(): void;
  onOpenOptions?(): void;
  /** "Find card" (nothing matched): the card the user picked by name, to show (app.tsx findCard). */
  onFindCard?(match: WrongCardMatch): void;
  /** Filled with the popover's own actions, for the keys (selection.tsx). */
  handle?: { current: PopoverHandle | null };
  /**
   * A card's details shown by hovering it ("Show card details: Full details on hover", app.tsx): passive, so it
   * never takes the focus, and it stays while the pointer is on it (WCAG 1.4.13), as the quick preview does. It
   * offers only what needs no record (Copy, YGOPRODeck): a click on it pins the card (`onPick`), whose popover has
   * the rest (Keep, the other matches, Ask AI, "Wrong card?", Report issue), so nothing typed goes with the pointer.
   */
  hover?: { id: string; onEnter(): void; onLeave(): void; onPick(): void };
}

/** What scan mode's key handler asks of the popover. */
export interface PopoverHandle {
  /** C: copy the card's text. */
  copy(): void;
  /** S: keep the card in the side panel (when it has a history entry). */
  keep(): void;
  /** ← (-1) and →(1): show the previous or next match. */
  step(dir: 1 | -1): void;
  /** ↑ (-1) and ↓ (1): scroll the card text, else the popover. */
  scroll(dir: 1 | -1): void;
  /** The popover's element: Tab moves between its controls. */
  element(): HTMLElement | null;
  /**
   * Esc: closes the panel the focus is in ("Wrong card?", Find card, Report issue), focus back on its button; true
   * when it did. A panel that is done (a pick saved, a report sent) no longer has the focus: Esc closes the popover.
   */
  closePanel(): boolean;
}

/** How far ↑ and ↓ scroll the popover (CSS px). */
const SCROLL_STEP = 40;

export const COPY = {
  scanning: t('content_matching_artwork'),
  faceDown: t('popover_face_down'),
  nothing: t('popover_no_match'),
  /** After a click on an outline (live check m6): the user framed nothing, so no framing advice. */
  nothingPicked: t('popover_no_match_picked'),
  /** The card runs off the edge of the picture and nothing matched (RecognitionResult.truncated). */
  nothingTruncated: t('popover_no_match_truncated'),
  /**
   * No match cleared the floor, but a card was picked (a click, or the detector's card in the box): the engine
   * offers its closest cards (RecognitionResult.suggested; click-regression-report.md).
   */
  suggested: t('popover_low_match_multiple'),
  /** The same, when the engine suggests a single card. */
  suggestedOne: t('popover_low_match_single'),
  /** The status region's words for "nothing matched" (a11y review B2). */
  noCard: t('popover_no_card_announcement'),
  lowQuality: t('popover_low_quality_tip'),
  copyBlocked: t('popover_copy_blocked'),
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
  if (ai?.status === 'asking') return t('popover_asking_ai');
  if (ai?.status === 'failed') return t('popover_ai_check_failed', ai.message);
  if (ai?.status === 'answered') {
    if (ai.confident === false) return t('popover_announce_ai_unsure', ai.answer);
    return ai.cardId === undefined ? t('popover_ai_says_unknown', ai.answer) : t('popover_announce_ai_says', ai.answer);
  }
  const res = state.response;
  if (res.result.faceDown) return COPY.faceDown;
  const shown = displayedCard(res, state.selected);
  if (!shown) return COPY.noCard;
  if (res.result.confident || shown.index !== viewableIndices(res)[0]) return `${shown.card.name}.`;
  const more = alternativeIndices(res).length;
  const extra = more === 0 ? '' : more === 1 ? t('popover_more_matches_suffix_one', more) : t('popover_more_matches_suffix_other', more);
  return t('popover_announce_match_result', res.result.suggested ? t('popover_label_low_match') : t('popover_label_not_sure'), shown.card.name, extra);
}

/**
 * A candidate's score as a percentage: every candidate is the embedding matcher's, so all share
 * one scale (its cosine). Null for a card with no score of ours (the AI's pick).
 */
function scoreOf(c: Candidate): number | null {
  return c.score > 0 ? Math.round(Math.min(1, c.score) * 100) : null;
}

const HOW = {
  quad: t('popover_method_card_outline'),
  whole: t('popover_method_whole_box'),
  fit: t('popover_method_card_shaped_fit'),
  art: t('popover_method_artwork_only'),
} as const;

/** "card outline, upside-down · 720p video" */
function methodText(result: RecognitionResult, crop: CropPayload): string {
  const rot = result.best?.rotation;
  const turn = rot === 180 ? t('popover_orientation_upside_down') : rot === 90 || rot === 270 ? t('popover_orientation_sideways') : undefined;
  const how = [result.best ? HOW[result.best.hypothesis] : undefined, turn].filter(Boolean).join(', ');
  const from =
    crop.source === 'video'
      ? crop.videoHeight
        ? t('popover_source_video_with_height', crop.videoHeight)
        : t('popover_source_video')
      : t('popover_source_screenshot');
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
  const { anchor, state, images, thumbs, cropImage, ai, picked, keepPending, onClose, onKeep, onCorrect, onAskAi, onOpenOptions, onFindCard, handle, hover } = props;
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ p: Placement; arrow: number } | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // "Wrong card?": a name search for when none of the chips above are right (its own component,
  // src/content/wrong-card.tsx). Closes (and resets) whenever a new scan's popover mounts, since
  // `key={pin.seq}` in app.tsx remounts the whole Popover for each one.
  const [wrongOpen, setWrongOpen] = useState(false);
  // "Report" (report-panel.tsx): this read to the public issue tracker, after the user sees what goes.
  const [reportOpen, setReportOpen] = useState(false);
  const reportEscape = useRef<(() => boolean) | null>(null);
  // "Find card": the same name search, when nothing matched (the pick shows the card: onFindCard).
  const [findOpen, setFindOpen] = useState(false);

  // ---------- what to show ----------
  const res = state.kind === 'result' ? state.response : null;
  const crop = state.kind === 'result' ? (state.crop ?? null) : null;
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

  /** The read as "Report" sends it (without the comment): the top card, the one the user picked instead if any, the rest. */
  const reportDraft = (): Omit<ReportDraft, 'comment'> | null => {
    if (state.kind !== 'result' || !res || !state.crop) return null;
    const named = (i: number): ReportCard | null => {
      const c = res.result.candidates[i];
      const record = c && res.cards[c.cardId];
      return record ? { cardId: c.cardId, name: record.name, score: c.score } : null;
    };
    // A card found by name ("Find card") is the user's, nothing having matched.
    const found = topIndex !== undefined && res.result.candidates[topIndex]?.source === 'name' ? named(topIndex) : null;
    const top = topIndex !== undefined && !found ? named(topIndex) : null;
    const pick = found ?? (top && ownPick && shownIndex !== undefined ? named(shownIndex) : null);
    const others = viewable
      .filter((i) => i !== topIndex && res.result.candidates[i]?.source !== 'name')
      .map(named)
      .filter((c): c is ReportCard => c !== null)
      .slice(0, 4);
    return {
      kind: !top ? 'no-match' : pick || res.result.confident ? 'wrong-card' : 'not-sure',
      dataUrl: state.crop.dataUrl,
      shown: top ? { ...top, confident: res.result.confident } : null,
      others,
      userCard: pick ? { cardId: pick.cardId, name: pick.name } : null,
      pageUrl: state.context?.pageUrl ?? location.href,
      ...(state.context?.videoTime !== undefined ? { videoTime: state.context.videoTime } : {}),
      modelId: res.result.modelId,
    };
  };
  // Only a read of the page can be reported: a card looked up by name has no crop.
  const reportButton = () =>
    crop && !hover ? (
      <button type="button" class="btn report" aria-expanded={reportOpen} onClick={byUser(() => setReportOpen((v) => !v))}>
        {t('popover_report_button')}
      </button>
    ) : null;
  const reportPanel = () => {
    const draft = reportOpen ? reportDraft() : null;
    return draft ? <ReportPanel draft={draft} onOpenOptions={onOpenOptions} escape={reportEscape} /> : null;
  };

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

  /** ↑ and ↓: the card text while it can scroll that way, else the popover itself. */
  const scroll = (dir: 1 | -1) => {
    const el = ref.current;
    const text = el?.querySelector<HTMLElement>('.dv-text');
    const room = (s: HTMLElement) => (dir > 0 ? s.scrollHeight - s.clientHeight - s.scrollTop : s.scrollTop) > 0;
    const target = text && room(text) ? text : el?.querySelector<HTMLElement>('.pop-scroll');
    if (target) target.scrollTop = Math.max(0, target.scrollTop + dir * SCROLL_STEP);
  };

  // The keys' actions, for scan mode's key handler; each reads the latest render. A popover that goes
  // away clears them only when they are still its own (the next card's popover renders first).
  const own = useRef<PopoverHandle | null>(null);
  own.current = {
    copy: () => {
      void copy();
    },
    keep: () => {
      if (card && res?.entry) onKeep();
    },
    step,
    scroll,
    element: () => ref.current,
    closePanel: () => {
      const at = (ref.current?.getRootNode() as Document | ShadowRoot | undefined)?.activeElement;
      if (!at || !ref.current?.contains(at) || !at.closest('.dv-wrong, .dv-report')) return false;
      // Report issue's own right-card search closes first: the report and its comment stay.
      if (at.closest('.dv-report') && reportEscape.current?.()) return true;
      const button = ref.current?.querySelector<HTMLElement>('button[aria-expanded="true"]');
      (button ?? ref.current)?.focus({ preventScroll: true });
      setWrongOpen(false);
      setFindOpen(false);
      setReportOpen(false);
      return true;
    },
  };
  if (handle) handle.current = own.current;
  useEffect(
    () => () => {
      if (handle && handle.current === own.current) handle.current = null;
    },
    [],
  );

  // ---------- focus: the answer or the error, once placed (a hidden popover can't take focus) ----------
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (hover || focused.current || !place || (state.kind !== 'result' && state.kind !== 'error')) return;
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

  // The same inside its panels, which render on their own: a "Wrong card?" pick, Report issue sent, its right card
  // picked or removed. Chrome says the focused control went with a focusout (no new target, the control gone);
  // Firefox says nothing, so a change inside the popover checks too.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = el.getRootNode() as Document | ShadowRoot;
    let inside = false;
    const restore = () => {
      const page = document.activeElement;
      if (inside && el.isConnected && !root.activeElement && (!page || page === document.body)) el.focus({ preventScroll: true });
    };
    const onIn = () => {
      inside = true;
    };
    const onOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (to) {
        inside = el.contains(to);
        return;
      }
      // No new target: a click on nothing focusable (focus left), or the focused control was removed.
      const from = e.target as Node;
      queueMicrotask(() => {
        if (from.isConnected) inside = false;
        else restore();
      });
    };
    const changes = new MutationObserver(restore);
    changes.observe(el, { childList: true, subtree: true });
    el.addEventListener('focusin', onIn);
    el.addEventListener('focusout', onOut);
    return () => {
      changes.disconnect();
      el.removeEventListener('focusin', onIn);
      el.removeEventListener('focusout', onOut);
    };
  }, []);

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
    if (!res || !indices.length || hover) return null;
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

  const alternatives = (label: string) => chips(t('popover_other_matches_label'), label, chipIndices());

  const matchLine = () => {
    if (res && shown?.source === 'name') {
      return (
        <div class="dv-match">
          <span class="meter neutral" aria-hidden="true" />
          <span>{t('popover_found_by_name')}</span>
        </div>
      );
    }
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
    const scoreText = p !== null ? t('popover_score_match', p) : null;
    // How and from what it matched is for the curious, in a tooltip (live check p2); a low video
    // quality stays on the line, as a hint.
    const how = methodText(res.result, crop);
    const lowRes =
      crop.source === 'video' && crop.videoHeight !== undefined && crop.videoHeight <= 480
        ? ` · ${t('popover_source_video_with_height', crop.videoHeight)}`
        : null;
    if (aiPick && !ownPick) {
      // The AI confirmed the top match: no longer "Not sure".
      return (
        <div class="dv-match" title={how}>
          {meter}
          <span>
            <b>{t('popover_ai_agrees')}</b>
            {p !== null ? ` · ${t('popover_artwork_match_percent', p)}` : null}
          </span>
        </div>
      );
    }
    return (
      <div class={`dv-match${unsure && !ownPick ? ' low' : ''}`} title={how}>
        {meter}
        {ownPick ? (
          <span>
            <b>{aiPick ? t('popover_ai_pick') : t('popover_you_picked')}</b>
            {scoreText ? ` · ${scoreText}` : null}
          </span>
        ) : (
          <span>
            <b>{[unsure ? t('popover_label_not_sure') : null, scoreText].filter(Boolean).join(' · ') || t('popover_match_label')}</b>
            {lowRes}
          </span>
        )}
      </div>
    );
  };

  const aiControls = () => {
    if (hover) return null;
    // The background says whether the AI check is on, so no settings reach this page.
    if (!res?.aiEnabled) {
      return (
        <div class="dv-actions">
          <button type="button" class="btn" onClick={byUser(() => onOpenOptions?.())}>
            {t('popover_turn_on_ai_button')}
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
              {s.status === 'asking' ? t('popover_asking_ai') : t('popover_ask_ai_button')}
            </button>
          </div>
        )}
        {s.status === 'answered' ? (
          s.confident === false ? (
            <p class="note">{t('popover_ai_unsure_note', s.answer)}</p>
          ) : s.cardId !== undefined ? (
            <p class="note">{t('popover_ai_says_note', s.answer)}</p>
          ) : (
            <p class="note">{t('popover_ai_says_unknown', s.answer)}</p>
          )
        ) : null}
        {s.status === 'failed' ? <p class="note err">{t('popover_ai_check_failed', s.message)}</p> : null}
      </>
    );
  };

  const actions = () =>
    card ? (
      <>
        <div class="dv-actions">
          {(res?.entry || keepPending) && !hover ? (
            <button type="button" class="btn" disabled={!res?.entry} onClick={byUser(() => onKeep())}>
              {t('popover_keep_button')}
            </button>
          ) : null}
          <button type="button" class="btn" onClick={byUser(() => void copy())}>
            {copyState === 'copied' ? t('popover_copy_button_copied') : t('popover_copy_button_default')}
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
            {t('popover_ygoprodeck_link')}
          </a>
          {res?.entry && !hover ? (
            <button type="button" class="btn" aria-expanded={wrongOpen} onClick={byUser(() => setWrongOpen((v) => !v))}>
              {t('popover_wrong_card_button')}
            </button>
          ) : null}
          {reportButton()}
        </div>
        {wrongOpen && res?.entry ? <WrongCardPanel entryId={res.entry.id} /> : null}
        {reportPanel()}
        {copyState === 'failed' ? <p class="note err">{COPY.copyBlocked}</p> : null}
        {/* The glyphs are for the eye; screen readers get the same in words (a11y review m5). A hovered card's keys
            are scan mode's (the popover's own work once it is clicked), so its popover lists none. */}
        {hover ? null : (
        <p class="note keys" aria-hidden="true">
          <kbd>C</kbd> {t('popover_hint_copy')} ·{' '}
          {res?.entry ? (
            <>
              <kbd>S</kbd> {t('popover_hint_side_panel')} ·{' '}
            </>
          ) : null}
          <kbd>←</kbd> <kbd>→</kbd> {t('popover_hint_other_matches')} · <kbd>Esc</kbd> {t('popover_hint_close')}
        </p>
        )}
        {hover ? null : <p class="sr-only">{res?.entry ? t('popover_sr_keys_with_panel') : t('popover_sr_keys_no_panel')}</p>}
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
              {t('popover_open_options_button')}
            </button>
          </div>
        ) : null}
      </div>
    );
  } else if (faceDown) {
    body = (
      <div class="dv-msg">
        <p class="lead">{COPY.faceDown}</p>
        <p class="note">{t('popover_face_down_hint')}</p>
        {res?.entry && !hover ? (
          <div class="dv-actions">
            <button type="button" class="btn" aria-expanded={wrongOpen} onClick={byUser(() => setWrongOpen((v) => !v))}>
              {t('popover_wrong_card_button')}
            </button>
          </div>
        ) : null}
        {wrongOpen && res?.entry ? <WrongCardPanel entryId={res.entry.id} /> : null}
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
        {res ? (
          <div class="dv-actions">
            {onFindCard ? (
              <button type="button" class="btn" aria-expanded={findOpen} onClick={byUser(() => setFindOpen((v) => !v))}>
                {t('popover_find_card_button')}
              </button>
            ) : null}
            {reportButton()}
          </div>
        ) : null}
        {findOpen && onFindCard ? <WrongCardPanel onPick={onFindCard} /> : null}
        {reportPanel()}
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
          {alternatives(t('popover_could_also_be_label'))}
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
          {alternatives(shownIndex !== topIndex ? t('popover_other_matches_label') : t('popover_not_it_label'))}
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
      class={`ov pop${place ? '' : ' measuring'}${hover ? ' hovering' : ''}`}
      id={hover?.id}
      onPointerEnter={hover ? () => hover.onEnter() : undefined}
      onPointerLeave={hover ? () => hover.onLeave() : undefined}
      onClick={
        hover
          ? (e) => {
              // Its own Copy and YGOPRODeck press themselves; a click anywhere else pins the card.
              if (fromUser(e) && !(e.target as Element).closest?.('button, a')) hover.onPick();
            }
          : undefined
      }
      role="dialog"
      aria-label={t('popover_dialog_label')}
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
          <button type="button" class="x" aria-label={t('popover_close_label')} onClick={byUser((e: MouseEvent) => onClose(e.detail === 0 ? 'key' : 'pointer'))}>
            ×
          </button>
        </div>
        {body}
      </div>
    </div>
  );
}
