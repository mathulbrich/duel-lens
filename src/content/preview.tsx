// The hover preview (UX-2): resting the pointer on an outlined card, or moving keyboard focus to it,
// shows a compact summary beside it: the card's name, its type line and facts, and its banlist and
// Genesys chips. A click opens the full popover (and records the read); the preview never does.
// - It shows what a peek read (`recognize` with `record: false`: no history entry, no correction, no AI)
//   answered, kept per outline for the session (app.tsx). No image, so it needs no network; no buttons.
// - It sits where it covers the other cards (and the open popover) the least (placePreview).
// - WCAG 1.4.13: the pointer can move onto it (it stays while the pointer is over it), Esc hides it
//   without moving the pointer, and it stays until the pointer or focus leaves (app.tsx).
// - A click on it opens that card's full popover, as a click on its outline does.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { RecognizeResponse } from '../shared/messages';
import type { CardRecord } from '../shared/types';
import { CardFacts, factsInWords, typeLine } from './card-view';
import type { Rect } from './geometry';
import { COPY, displayedCard } from './popover';
import { fromUser } from './trusted';

/** What a peek says about the card, as the preview shows it. */
export type PreviewKind = 'sure' | 'unsure' | 'low' | 'none' | 'face-down';

export interface PreviewText {
  kind: PreviewKind;
  /** The one line on top: the name, "Not sure: <name>", or what a click does. */
  head: string;
  /** The card whose type line and facts follow (a sure or "Not sure" answer only). */
  card?: CardRecord;
}

export const PREVIEW_COPY = {
  notSure: (name: string) => `Not sure: ${name}`,
  low: 'Low match: click for options',
  none: 'No match: click to try',
  faceDown: 'Face-down card',
} as const;

/** The preview's text for a peek's answer (displayedCard picks the card, as the popover does). */
export function previewText(res: RecognizeResponse): PreviewText {
  if (res.result.faceDown) return { kind: 'face-down', head: PREVIEW_COPY.faceDown };
  const shown = displayedCard(res, 0);
  if (!shown) return { kind: 'none', head: PREVIEW_COPY.none };
  if (res.result.suggested) return { kind: 'low', head: PREVIEW_COPY.low };
  if (!res.result.confident) return { kind: 'unsure', head: PREVIEW_COPY.notSure(shown.card.name), card: shown.card };
  return { kind: 'sure', head: shown.card.name, card: shown.card };
}

/** The preview in words, for screen readers: "Card 3 of 9: Ash Blossom & Joyous Spring. FIRE, Level 3, …" */
export function previewWords(p: PreviewText, label?: string): string {
  const head = p.kind === 'face-down' ? COPY.faceDown : `${p.head}.`;
  const facts = p.card ? ` ${factsInWords(p.card)}.` : '';
  return `${label ? `${label}: ` : ''}${head}${facts}`;
}

// ---------- placement ----------

export type PreviewSide = 'right' | 'left' | 'below' | 'above';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/** Covering the card itself costs this much more than covering the same area of another card. */
const OWN_CARD = 10;

/**
 * Where the preview goes beside `anchor` (the card's bounds): right, left, below or above it, `gap` px
 * off and clamped `margin` px inside the viewport, whichever covers the least of `avoid` (the other
 * cards, the open popover) and of the card itself; ties go in that order.
 */
export function placePreview(
  anchor: Rect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  avoid: Rect[] = [],
  gap = 8,
  margin = 8,
): { x: number; y: number; side: PreviewSide } {
  const maxX = viewport.w - size.w - margin;
  const maxY = viewport.h - size.h - margin;
  const midX = clamp(anchor.x + anchor.w / 2 - size.w / 2, margin, maxX);
  const midY = clamp(anchor.y + anchor.h / 2 - size.h / 2, margin, maxY);
  const at: Record<PreviewSide, { x: number; y: number }> = {
    right: { x: clamp(anchor.x + anchor.w + gap, margin, maxX), y: midY },
    left: { x: clamp(anchor.x - gap - size.w, margin, maxX), y: midY },
    below: { x: midX, y: clamp(anchor.y + anchor.h + gap, margin, maxY) },
    above: { x: midX, y: clamp(anchor.y - gap - size.h, margin, maxY) },
  };
  let best: { x: number; y: number; side: PreviewSide; cost: number } | null = null;
  for (const side of ['right', 'left', 'below', 'above'] as const) {
    const box = { ...at[side], w: size.w, h: size.h };
    const cost = OWN_CARD * overlap(box, anchor) + avoid.reduce((sum, r) => sum + overlap(box, r), 0);
    if (!best || cost < best.cost) best = { ...at[side], side, cost };
  }
  return { x: best!.x, y: best!.y, side: best!.side };
}

// ---------- the element ----------

export interface PreviewProps {
  /** The card's bounds on the page (CSS px). */
  anchor: Rect;
  text: PreviewText;
  /** What it should cover the least: the other cards' bounds, the open popover's. Read when it is placed. */
  avoid(): Rect[];
  /** The pointer came onto it, or left it (WCAG 1.4.13: it stays while the pointer is over it). */
  onEnter(): void;
  onLeave(): void;
  /** A click on it: open the card's full popover. */
  onPick(): void;
}

/** The preview's id: the outline it describes points at it (aria-describedby). */
export const PREVIEW_ID = 'dl-preview';

export function Preview({ anchor, text, avoid, onEnter, onLeave, onPick }: PreviewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number; side: PreviewSide } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const p = placePreview(anchor, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }, avoid());
    setPlace((prev) => (prev && prev.x === p.x && prev.y === p.y && prev.side === p.side ? prev : p));
  }, [anchor.x, anchor.y, anchor.w, anchor.h, text.head]);

  return (
    <div
      ref={ref}
      id={PREVIEW_ID}
      class={`pv ${text.kind}${place ? '' : ' measuring'}`}
      role="tooltip"
      data-side={place?.side}
      style={place ? { left: `${place.x}px`, top: `${place.y}px` } : undefined}
      onPointerEnter={(e) => fromUser(e) && onEnter()}
      onPointerLeave={(e) => fromUser(e) && onLeave()}
      // Keeps focus where it is (the preview isn't focusable), as the frozen frame does.
      onPointerDown={(e) => fromUser(e) && e.preventDefault()}
      onClick={(e) => fromUser(e) && onPick()}
    >
      <p class="pv-head">{text.head}</p>
      {text.card ? (
        <>
          <p class="pv-type">{typeLine(text.card)}</p>
          <CardFacts card={text.card} />
        </>
      ) : null}
    </div>
  );
}
