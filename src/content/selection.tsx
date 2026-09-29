// The frozen-frame selection layer: the screenshot taken when the shortcut was pressed fills the
// viewport, dimmed. The cards the detector found on it are outlined: a click on one scans it (Tab
// or the arrows and Enter do the same from the keyboard), and a drag boxes anything, as before.
// - A press released within CLICK_SLOP px is a click: on a card or its outline it picks that card
//   (the smallest, where cards overlap). So is a wobble too small to be a box that starts and ends
//   on the same card (a tap with a finger or a pen).
// - A click on no card sets a first corner instead: a box without dragging (WCAG 2.5.7, a11y review
//   M1). A marker shows the corner, the hint asks for the opposite one and a box follows the pointer;
//   the next click, anywhere (on an outline too), scans the box between the two. A click back on the
//   corner, or Esc, drops it (a second Esc closes). A drag still works at any time, and replaces it.
// - Anything longer is a drag. The outlines are only drawn: every pointer event goes to the layer,
//   so they never get in a drag's way. Assistive technology reaches them as buttons, though: its
//   activation (a click on the outline itself) scans that card, and its focus lights it.
// - The layer is a modal dialog that takes focus as it opens (a11y review B1); index.ts gives focus
//   back to the page when Duel Lens closes. While a card is matched it is no dialog: the popover is.
// - Only the user's own input counts (security review M1): pointer events and clicks a script made
//   are ignored.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { normalizeDrag, type OrientedBox, type Rect } from './geometry';
import { LensIcon } from './icons';
import { installKeyHandler } from './keys';
import { cardAt, type CardOutline } from './outlines';
import { byUser, fromUser } from './trusted';

/** Drags smaller than this (in CSS px, either side) are dropped: too small to read. */
export const MIN_BOX = 12;
/** A press that moves no further than this (CSS px) before its release is a click, not a drag. */
export const CLICK_SLOP = 6;
/**
 * Outlines, and the boxes drawn on a detected card, sit this far (CSS px) outside the card's edge,
 * so they don't vanish into the card's own border.
 */
export const CARD_PAD = 3;

export interface SelectionLayerProps {
  /** Data URL of the screenshot taken when the shortcut was pressed. */
  screenshot: string;
  /**
   * The viewport the screenshot covers (innerWidth x innerHeight, scrollbars included). The
   * frame is drawn at exactly this size so it lines up with the page; the overlay itself is
   * narrower when there is a classic scrollbar.
   */
  viewport?: { w: number; h: number };
  onSelect(r: Rect): void;
  onCancel(): void;
  /** While matching: keep the frozen frame, show this box with the foil sweep, ignore input. */
  busy?: Rect | null;
  /** The busy box turned like the card, when the card was picked from the outlines. */
  busyShape?: OrientedBox | null;
  /** The detected cards to outline (null or absent until detection answers). */
  cards?: CardOutline[] | null;
  /** Detection is still running: the hint says "Finding cards…". */
  finding?: boolean;
  /** Detection answered and found no card to outline: the hint says so (live check p4). */
  noneFound?: boolean;
  /** A detected card was clicked, or chosen with the keyboard: its index in `cards`. */
  onPick?(index: number): void;
}

type BoxMode = 'drawing' | 'scanning' | 'done' | 'hover';

const place = (r: Rect) => ({ left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
const padShape = (s: OrientedBox): OrientedBox => ({ ...s, w: s.w + 2 * CARD_PAD, h: s.h + 2 * CARD_PAD });
const padRect = (r: Rect): Rect => ({ x: r.x - CARD_PAD, y: r.y - CARD_PAD, w: r.w + 2 * CARD_PAD, h: r.h + 2 * CARD_PAD });

/**
 * The gold box, with the page dimmed around it (box-shadow cut-out) while drawing, hovering or
 * scanning. With a `shape` (a detected card) the box turns with the card, CARD_PAD outside its
 * edge, and its label stays upright beside the card's bounds (`rect`).
 */
export function SelectionBox({ rect, mode, label, shape }: { rect: Rect; mode: BoxMode; label?: string; shape?: OrientedBox | null }) {
  // Put the label under the box when there is no room above it.
  const below = rect.y < 30 ? ' lb' : '';
  if (!shape) {
    return (
      <div class={`sel ${mode}${below}`} style={place(rect)}>
        {label ? <span class="sel-label">{label}</span> : null}
      </div>
    );
  }
  const p = padShape(shape);
  const turned = { ...place({ x: p.cx - p.w / 2, y: p.cy - p.h / 2, w: p.w, h: p.h }), transform: `rotate(${p.angle}rad)` };
  return (
    <>
      <div class={`sel ${mode}`} style={turned} />
      {label ? (
        <div class={`sel-anchor${below}`} style={place(padRect(rect))}>
          <span class="sel-label">{label}</span>
        </div>
      ) : null}
    </>
  );
}

/** A point on the frozen frame (CSS px). */
export type Corner = [number, number];

/** A press on the frozen frame: where it went down, and whether it has moved past CLICK_SLOP. */
export interface Press {
  x: number;
  y: number;
  dragging: boolean;
}

/** What a press does once released. */
export type Release =
  | { kind: 'pick'; index: number } // scan that detected card
  | { kind: 'select'; rect: Rect } // scan this box
  | { kind: 'arm'; at: Corner } // a first corner: the box's opposite corner comes with the next click
  | { kind: 'disarm' } // drop the first corner
  | { kind: 'none' }; // nothing: too small to read (the corner, if any, stays)

/**
 * The selection's rules, for a press released at (x, y) with the first corner `corner` (if one is set):
 * - A drag (moved past CLICK_SLOP, and MIN_BOX px or more each way) scans its box, corner or not.
 * - With a corner, a click, or a wobble too small to be a box, is the opposite corner: it scans the box
 *   between the two, on a card too. Within CLICK_SLOP of the corner it drops the corner instead; a box
 *   too thin to read does nothing (the corner stays). A drag too thin to read drops the corner.
 * - Without one, a click picks the card under it, or sets the first corner where there is no card, and
 *   a wobble that starts and ends on the same card picks it (review M5). Anything else does nothing.
 */
export function onRelease(p: Press, x: number, y: number, corner: Corner | null, cards: CardOutline[]): Release {
  const moved = p.dragging || Math.hypot(x - p.x, y - p.y) > CLICK_SLOP;
  const drag = normalizeDrag(p.x, p.y, x, y);
  const big = (r: Rect) => r.w >= MIN_BOX && r.h >= MIN_BOX;
  if (moved && big(drag)) return { kind: 'select', rect: drag };
  const tap = !moved || (drag.w < MIN_BOX && drag.h < MIN_BOX);
  if (corner) {
    if (!tap || Math.hypot(p.x - corner[0], p.y - corner[1]) <= CLICK_SLOP) return { kind: 'disarm' };
    const box = normalizeDrag(corner[0], corner[1], p.x, p.y);
    return big(box) ? { kind: 'select', rect: box } : { kind: 'none' };
  }
  if (!moved) {
    const hit = cardAt(cards, p.x, p.y, CARD_PAD);
    return hit === null ? { kind: 'arm', at: [p.x, p.y] } : { kind: 'pick', index: hit };
  }
  if (tap) {
    const from = cardAt(cards, p.x, p.y, CARD_PAD);
    if (from !== null && from === cardAt(cards, x, y, CARD_PAD)) return { kind: 'pick', index: from };
  }
  return { kind: 'none' };
}

/** An outline's rect: CARD_PAD outside the card's edge, turned like the card. */
function outlineRect(c: CardOutline) {
  const p = padShape(c.shape);
  return {
    x: p.cx - p.w / 2,
    y: p.cy - p.h / 2,
    width: p.w,
    height: p.h,
    rx: 4,
    transform: `rotate(${(p.angle * 180) / Math.PI} ${p.cx} ${p.cy})`,
  };
}

/**
 * The frame dimmed around the outlined cards (live check M1: a uniform dim left the outlines hard to
 * find): each card shows in a hole the size of its outline, so the cards to click are the bright ones.
 * With no card outlined it is the plain dim.
 */
function Spotlight({ cards, w, h }: { cards: CardOutline[]; w: number; h: number }) {
  if (!cards.length) return <div class="dim" />;
  return (
    <svg class="spotlight" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <mask id="dl-spotlight" maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
          <rect width={w} height={h} fill="#fff" />
          {cards.map((c, i) => (
            <rect key={i} class="hole" fill="#000" {...outlineRect(c)} />
          ))}
        </mask>
      </defs>
      <rect class="shade" width={w} height={h} mask="url(#dl-spotlight)" />
    </svg>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where the hint sits in a frame `w` px wide: centred, between y0 and y1 (a little wider than it ever is). */
const hintZone = (w: number, y0: number, y1: number): Rect => ({ x: w / 2 - 240, y: y0, w: 480, h: y1 - y0 });

/** The card lit up: under the pointer, or in keyboard focus (which also moves DOM focus to its outline). */
type Active = { index: number; by: 'pointer' | 'key' };

export function SelectionLayer(props: SelectionLayerProps) {
  const { screenshot, viewport, busy, busyShape, cards, finding, noneFound } = props;
  const [box, setBox] = useState<Rect | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [onCard, setOnCard] = useState(false);
  /** The first corner of a box made with two clicks (null when none is set). */
  const [corner, setCorner] = useState<Corner | null>(null);
  const press = useRef<(Press & { id: number }) | null>(null);
  /** Where the pointer was last seen over the frame (null once it left). */
  const pointer = useRef<[number, number] | null>(null);
  const finished = useRef(false);
  const layerRef = useRef<HTMLDivElement>(null);
  const outlineEls = useRef<(SVGRectElement | null)[]>([]);
  const cb = useRef(props);
  cb.current = props;
  const outlines = busy ? [] : (cards ?? []);
  const outlinesRef = useRef(outlines);
  outlinesRef.current = outlines;
  const activeRef = useRef(active);
  activeRef.current = active;
  const cornerRef = useRef(corner);
  cornerRef.current = corner;

  const light = (next: Active | null) => {
    activeRef.current = next;
    setActive(next);
  };

  const arm = (at: Corner | null) => {
    cornerRef.current = at;
    setCorner(at);
  };

  const cancel = () => {
    if (finished.current) return;
    finished.current = true;
    press.current = null;
    setBox(null);
    cb.current.onCancel();
  };

  const pick = (index: number) => {
    if (finished.current || !cb.current.onPick) return;
    finished.current = true;
    press.current = null;
    arm(null);
    cb.current.onPick(index);
  };

  const step = (dir: 1 | -1) => {
    const n = outlinesRef.current.length;
    if (finished.current || n === 0) return;
    const from = activeRef.current?.index;
    light({ index: from === undefined ? (dir > 0 ? 0 : n - 1) : (from + dir + n) % n, by: 'key' });
  };

  const activate = () => {
    const a = activeRef.current;
    if (a && a.index < outlinesRef.current.length) pick(a.index);
  };

  // The dialog takes focus as it opens, so screen readers announce it (a11y review B1).
  useLayoutEffect(() => {
    layerRef.current?.focus({ preventScroll: true });
  }, []);

  // Esc drops a first corner, else cancels; Tab / arrows step through the outlined cards and Enter or
  // Space scans one; K and C, and F, T and I (the page's layout keys), are kept from the page while the
  // frame is frozen. Installed during commit, so the keys are covered from the first frame.
  useLayoutEffect(
    () =>
      busy
        ? undefined
        : installKeyHandler({
            onClose: onEscape,
            onPrev: () => step(-1),
            onNext: () => step(1),
            onStep: step,
            onActivate: activate,
            onLayoutKey: () => undefined,
          }),
    [!!busy],
  );

  // Keyboard focus follows the lit card, so screen readers announce "Card 3 of 12".
  useLayoutEffect(() => {
    if (active?.by === 'key') outlineEls.current[active.index]?.focus({ preventScroll: true });
  }, [active]);

  const maxX = viewport?.w ?? window.innerWidth;
  const maxY = viewport?.h ?? window.innerHeight;
  const point = (e: PointerEvent) => [clamp(e.clientX, 0, maxX), clamp(e.clientY, 0, maxY)];

  const hoverAt = (x: number, y: number) => {
    const hit = cardAt(outlinesRef.current, x, y, CARD_PAD);
    setOnCard(hit !== null);
    const a = activeRef.current;
    if (hit !== null) {
      if (a?.index !== hit || a.by !== 'pointer') light({ index: hit, by: 'pointer' });
    } else if (a?.by === 'pointer') {
      light(null);
    }
  };

  /** With a first corner set, the box follows the pointer (none while it is back on the corner). */
  const band = (x: number, y: number) => {
    const c = cornerRef.current;
    setBox(c && Math.hypot(x - c[0], y - c[1]) > CLICK_SLOP ? normalizeDrag(c[0], c[1], x, y) : null);
  };

  function onEscape() {
    if (!cornerRef.current) return cancel();
    arm(null);
    setBox(null);
    const at = pointer.current;
    if (at && !press.current) hoverAt(at[0], at[1]);
  }

  // Outlines that come under a pointer that has stopped light the card under it at once, not at
  // the pointer's next move (review M13).
  useLayoutEffect(() => {
    const at = pointer.current;
    if (at && !busy && !finished.current && !press.current && !cornerRef.current) hoverAt(at[0], at[1]);
  }, [cards]);

  /** Focus moved to an outline (a screen reader's cursor, or the keys above): light that card. */
  const focusOn = (index: number) => {
    const a = activeRef.current;
    if (!finished.current && (a?.index !== index || a.by !== 'key')) light({ index, by: 'key' });
  };

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (busy || finished.current || !fromUser(e)) return;
    e.preventDefault();
    if (e.button !== 0 || press.current) return; // right-click cancels via contextmenu
    const [x, y] = point(e);
    pointer.current = [x, y];
    press.current = { x, y, id: e.pointerId, dragging: false };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety (drags that leave the window); the drag works without it.
    }
  };

  const onPointerMove = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!fromUser(e)) return;
    const [x, y] = point(e);
    pointer.current = [x, y];
    const p = press.current;
    if (!p) {
      if (busy || finished.current) return;
      // A first corner is set: the box follows, and no card lights (the next click ends the box, on a card too).
      if (cornerRef.current) band(x, y);
      else hoverAt(x, y);
      return;
    }
    if (e.pointerId !== p.id) return;
    if (!p.dragging) {
      if (Math.hypot(x - p.x, y - p.y) <= CLICK_SLOP) return;
      p.dragging = true;
      setOnCard(false);
      light(null);
    }
    setBox(normalizeDrag(p.x, p.y, x, y));
  };

  const onPointerUp = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id || !fromUser(e)) return;
    press.current = null;
    const [x, y] = point(e);
    const r = onRelease(p, x, y, cornerRef.current, outlinesRef.current);
    switch (r.kind) {
      case 'pick':
        pick(r.index);
        return;
      case 'select':
        finished.current = true;
        arm(null);
        setBox(r.rect);
        cb.current.onSelect(r.rect);
        return;
      case 'arm':
        arm(r.at);
        setBox(null);
        return;
      case 'disarm':
        arm(null);
        setBox(null);
        hoverAt(x, y);
        return;
      case 'none':
        // Too small to read: dropped, and the selection stays open (with its first corner, if one is set).
        if (cornerRef.current) band(x, y);
        else setBox(null);
    }
  };

  const onPointerCancel = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!fromUser(e)) return;
    press.current = null;
    setBox(null);
  };

  const onPointerLeave = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (press.current || !fromUser(e)) return;
    pointer.current = null;
    setOnCard(false);
    if (activeRef.current?.by === 'pointer') light(null);
    if (cornerRef.current) setBox(null);
  };

  const onContextMenu = (e: Event) => {
    e.preventDefault();
    if (!busy && fromUser(e)) cancel();
  };

  // The page must not scroll under the frozen frame, or the box would no longer line up
  // with the page once the frame is gone.
  const onWheel = (e: Event) => e.preventDefault();

  const shown = busy ?? box;
  const lit = !shown && active ? outlines[active.index] : undefined;
  const armed = busy ? null : corner;
  const count = outlines.length;
  const searching = !!finding && count === 0;
  // The hint moves to the bottom when a card lies under it at the top and none does at the bottom.
  const under = (zone: Rect) => outlines.some((c) => overlaps(c.rect, zone));
  const hintLow = under(hintZone(maxX, 0, 64)) && !under(hintZone(maxX, maxY - 64, maxY));
  return (
    <div
      ref={layerRef}
      class={`layer${busy ? ' busy' : ''}${onCard && !busy ? ' on-card' : ''}`}
      // One dialog at a time: while a card is matched, the popover is the dialog (a11y review m1).
      role={busy ? undefined : 'dialog'}
      aria-modal={busy ? undefined : 'true'}
      aria-label={busy ? undefined : 'Duel Lens: select a card'}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
      onWheel={onWheel}
    >
      <img
        class="shot"
        src={screenshot}
        alt=""
        draggable={false}
        style={viewport ? { width: `${viewport.w}px`, height: `${viewport.h}px` } : undefined}
      />
      {shown || lit ? null : <Spotlight cards={outlines} w={maxX} h={maxY} />}
      {count ? (
        <svg class="cards" width={maxX} height={maxY} viewBox={`0 0 ${maxX} ${maxY}`}>
          {/* Each outline twice (live check M1): a dark line under a bright one, seen on any mat. */}
          {outlines.map((c, i) => (
            <rect key={`u${i}`} class="under" aria-hidden="true" {...outlineRect(c)} />
          ))}
          {outlines.map((c, i) => (
            <rect
              key={i}
              ref={(el) => {
                outlineEls.current[i] = el;
              }}
              {...outlineRect(c)}
              role="button"
              tabindex={-1}
              aria-label={c.label}
              // Only assistive technology clicks an outline itself (the layer takes the mouse's).
              onClick={byUser(() => pick(i))}
              onFocus={() => focusOn(i)}
            />
          ))}
        </svg>
      ) : null}
      {shown ? (
        <SelectionBox
          rect={shown}
          mode={busy ? 'scanning' : 'drawing'}
          label={busy ? 'Matching artwork…' : undefined}
          shape={busy ? busyShape : null}
        />
      ) : lit ? (
        <SelectionBox rect={lit.rect} mode="hover" shape={lit.shape} />
      ) : null}
      {armed ? <div class="corner" aria-hidden="true" style={{ left: `${armed[0]}px`, top: `${armed[1]}px` }} /> : null}
      {busy || (box && !armed) ? null : (
        <p class={`hint${searching && !armed ? ' finding' : ''}${hintLow ? ' low' : ''}`} role="status">
          <LensIcon />
          {armed ? (
            <>
              <span>Click the opposite corner</span>
              <span aria-hidden="true">·</span>
              <span>
                <kbd>Esc</kbd> to cancel
              </span>
            </>
          ) : (
            <>
              <span>
                {searching
                  ? 'Finding cards…'
                  : count
                    ? 'Click a card, or drag a box'
                    : noneFound
                      ? 'No cards found. Drag a box around one.'
                      : 'Drag a box around a card'}
              </span>
              <span aria-hidden="true">·</span>
              <span>
                <kbd>Esc</kbd> cancels
              </span>
              {count ? (
                <span class="sr-only">
                  {count === 1 ? '1 card found' : `${count} cards found`}. Tab goes through them, Enter scans one.
                </span>
              ) : null}
            </>
          )}
        </p>
      )}
    </div>
  );
}
