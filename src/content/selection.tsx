// Scan mode's frozen-frame layer: the screenshot taken when the shortcut was pressed fills the
// viewport, dimmed. The cards the detector found on it are outlined: a click on one reads it (Tab
// or the arrows and Enter do the same from the keyboard), and a drag boxes anything, as before. The
// layer stays up after a read (UX-1): the card read is marked as the current one, its popover sits
// beside it (app.tsx), and another card or box can be read at once, until the user leaves.
// - A press released within CLICK_SLOP px is a click: on a card or its outline it picks that card
//   (the smallest, where cards overlap). So is a wobble too small to be a box that starts and ends
//   on the same card (a tap with a finger or a pen).
// - A click on no card sets a first corner instead: a box without dragging (WCAG 2.5.7, a11y review
//   M1). A marker shows the corner, the bar asks for the opposite one and a box follows the pointer;
//   the next click, anywhere (on an outline too), reads the box between the two. A click back on the
//   corner, or Esc, drops it. A drag still works at any time, and replaces it. While a popover is open,
//   a click on no card closes the popover instead (and sets no corner).
// - Anything longer is a drag. The outlines are only drawn: every pointer event goes to the layer,
//   so they never get in a drag's way. Assistive technology reaches them as buttons, though: its
//   activation (a click on the outline itself) reads that card, and its focus lights it.
// - The bar at the top says how many cards are outlined and how to leave; its ✕ leaves scan mode.
// - Leaving: Esc (once nothing else is open), the ✕, a right-click, and K or Space (YouTube's
//   play/pause: the videos Duel Lens paused play again, index.ts).
// - The layer is a modal dialog that takes focus as it opens (a11y review B1); index.ts gives focus
//   back to the page when Duel Lens closes. While a popover shows, the popover is the dialog.
// - It holds scan mode's one key handler (keys.ts), and hands the popover's keys to it (`popover`).
// - Only the user's own input counts (security review M1): pointer events and clicks a script made
//   are ignored.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { normalizeDrag, type OrientedBox, type Rect } from './geometry';
import { LensIcon } from './icons';
import { installKeyHandler, type KeyResult } from './keys';
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

/** The card lit up: under the pointer, or in keyboard focus (which also moves DOM focus to its outline). */
export interface Active {
  index: number;
  by: 'pointer' | 'key';
}

/** The open popover's keys, for the layer's key handler (app.tsx builds it). */
export interface PopoverKeys {
  /** Esc, once the hover preview is hidden. */
  close(): void;
  copy(): void;
  keep(): void;
  step(dir: 1 | -1): void;
  scroll(dir: 1 | -1): void;
  /** The popover's element: Tab moves between its controls, and stays in it. */
  element(): HTMLElement | null;
}

/** What app.tsx asks of the layer. */
export interface LayerHandle {
  /** Moves keyboard focus to a card's outline, which lights it (the popover closed with Esc). */
  focusCard(index: number): void;
  /** Moves focus to the layer itself. */
  focus(): void;
  /** Where the pointer is on the frame (CSS px), or null when it isn't over it. */
  pointer(): Corner | null;
}

export interface SelectionLayerProps {
  /** Data URL of the screenshot taken when the shortcut was pressed. */
  screenshot: string;
  /**
   * The viewport the screenshot covers (innerWidth x innerHeight, scrollbars included). The
   * frame is drawn at exactly this size so it lines up with the page; the overlay itself is
   * narrower when there is a classic scrollbar.
   */
  viewport?: { w: number; h: number };
  /** A box was drawn (a drag, or two clicked corners): read it. */
  onSelect(r: Rect): void;
  /** Leave scan mode: Esc with nothing else open, the bar's ✕, a right-click, K or Space. */
  onCancel(): void;
  /** While a read is under way: this box shows the foil sweep, and picks and drags wait. */
  busy?: Rect | null;
  /** The busy box turned like the card, when the card was picked from the outlines. */
  busyShape?: OrientedBox | null;
  /** The detected cards to outline (null or absent until detection answers). */
  cards?: CardOutline[] | null;
  /** Detection is still running: the bar says "Finding cards…". */
  finding?: boolean;
  /** Detection answered and found no card to outline: the bar says so (live check p4). */
  noneFound?: boolean;
  /**
   * A detected card was clicked, or chosen with the keyboard: its index in `cards`, and for a pointer's click where it
   * went down (CSS px; the crop carries it, CropPayload.click). A key, or assistive technology, gives no point.
   */
  onPick?(index: number, at?: Corner): void;
  /** The card (or box) whose details the popover shows: marked as the current one. */
  current?: { rect: Rect; shape?: OrientedBox | null } | null;
  /**
   * A popover is open (a card's details, "Matching artwork…", or an error): the layer is no dialog, a click
   * on no card closes it (onDismiss) instead of setting a corner, and C, S, ← →, ↑ ↓, Tab and Esc are its keys.
   */
  popover?: PopoverKeys | null;
  /** Close the popover: a click on no card while it is open. */
  onDismiss?(): void;
  /** Esc goes here first: true when that hid something (the hover preview), and Esc does nothing more. */
  onEscape?(): boolean;
  /** The lit card changed: the pointer came onto a card or left it, or keyboard focus moved (hover intent, app.tsx). */
  onActive?(active: Active | null): void;
  /** Said by a status region of its own (the hover preview of the card in keyboard focus, in words). */
  said?: string;
  /** The outline the hover preview describes (aria-describedby), and the preview's id. */
  describedBy?: { index: number; id: string } | null;
  /** Filled with the layer's own actions (app.tsx). */
  handle?: { current: LayerHandle | null };
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
  | { kind: 'pick'; index: number } // read that detected card
  | { kind: 'select'; rect: Rect } // read this box
  | { kind: 'arm'; at: Corner } // a first corner: the box's opposite corner comes with the next click
  | { kind: 'disarm' } // drop the first corner
  | { kind: 'dismiss' } // close the open popover
  | { kind: 'none' }; // nothing: too small to read (the corner, if any, stays)

/**
 * The selection's rules, for a press released at (x, y) with the first corner `corner` (if one is set):
 * - A drag (moved past CLICK_SLOP, and MIN_BOX px or more each way) reads its box, corner or not.
 * - With a corner, a click, or a wobble too small to be a box, is the opposite corner: it reads the box
 *   between the two, on a card too. Within CLICK_SLOP of the corner it drops the corner instead; a box
 *   too thin to read does nothing (the corner stays). A drag too thin to read drops the corner.
 * - Without one, a click picks the card under it, or sets the first corner where there is no card
 *   (closes the popover instead, when one is open: `popoverOpen`), and a wobble that starts and ends on
 *   the same card picks it (review M5). Anything else does nothing.
 */
export function onRelease(p: Press, x: number, y: number, corner: Corner | null, cards: CardOutline[], popoverOpen = false): Release {
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
    if (hit !== null) return { kind: 'pick', index: hit };
    return popoverOpen ? { kind: 'dismiss' } : { kind: 'arm', at: [p.x, p.y] };
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
 * So does `box`, the box whose details the popover shows. With neither it is the plain dim.
 */
function Spotlight({ cards, box, w, h }: { cards: CardOutline[]; box?: Rect | null; w: number; h: number }) {
  if (!cards.length && !box) return <div class="dim" />;
  return (
    <svg class="spotlight" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <defs>
        <mask id="dl-spotlight" maskUnits="userSpaceOnUse" x={0} y={0} width={w} height={h}>
          <rect width={w} height={h} fill="#fff" />
          {cards.map((c, i) => (
            <rect key={i} class="hole" fill="#000" {...outlineRect(c)} />
          ))}
          {box ? <rect class="hole" fill="#000" x={box.x} y={box.y} width={box.w} height={box.h} /> : null}
        </mask>
      </defs>
      <rect class="shade" width={w} height={h} mask="url(#dl-spotlight)" />
    </svg>
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where the bar sits in a frame `w` px wide: centred, between y0 and y1 (a little wider than it ever is). */
const barZone = (w: number, y0: number, y1: number): Rect => ({ x: w / 2 - 240, y: y0, w: 480, h: y1 - y0 });

/** Focusable controls inside `el`, in order. */
const focusablesIn = (el: Element): HTMLElement[] =>
  Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'));

/** A control that presses itself with Enter (the popover's buttons and links, the bar's ✕). Space leaves scan mode instead. */
const isControl = (el: Element | null | undefined) => !!el && (el.tagName === 'BUTTON' || el.tagName === 'A');

export function SelectionLayer(props: SelectionLayerProps) {
  const { screenshot, viewport, busy, busyShape, cards, finding, noneFound, current, popover, said, describedBy } = props;
  const [box, setBox] = useState<Rect | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [onCard, setOnCard] = useState(false);
  /** The first corner of a box made with two clicks (null when none is set). */
  const [corner, setCorner] = useState<Corner | null>(null);
  const press = useRef<(Press & { id: number }) | null>(null);
  /** Where the pointer was last seen over the frame (null once it left). */
  const pointer = useRef<[number, number] | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const outlineEls = useRef<(SVGRectElement | null)[]>([]);
  const cb = useRef(props);
  cb.current = props;
  const outlines = cards ?? [];
  const outlinesRef = useRef(outlines);
  outlinesRef.current = outlines;
  const activeRef = useRef(active);
  activeRef.current = active;
  const cornerRef = useRef(corner);
  cornerRef.current = corner;

  const light = (next: Active | null) => {
    const prev = activeRef.current;
    if (prev?.index === next?.index && prev?.by === next?.by) return;
    activeRef.current = next;
    setActive(next);
    cb.current.onActive?.(next);
  };

  const arm = (at: Corner | null) => {
    cornerRef.current = at;
    setCorner(at);
  };

  const cancel = () => {
    press.current = null;
    setBox(null);
    cb.current.onCancel();
  };

  const pick = (index: number, at?: Corner) => {
    if (cb.current.busy || !cb.current.onPick) return;
    press.current = null;
    arm(null);
    if (at) cb.current.onPick(index, at);
    else cb.current.onPick(index);
  };

  const step = (dir: 1 | -1) => {
    const n = outlinesRef.current.length;
    if (cb.current.busy || n === 0) return;
    const from = activeRef.current?.index;
    focusCard(from === undefined ? (dir > 0 ? 0 : n - 1) : (from + dir + n) % n);
  };

  /** Lights a card as keyboard focus does, and moves focus to its outline. */
  const focusCard = (index: number) => {
    light({ index, by: 'key' });
    outlineEls.current[index]?.focus({ preventScroll: true });
  };

  const activate = () => {
    const a = activeRef.current;
    if (a && a.index < outlinesRef.current.length) pick(a.index);
  };

  const root = () => layerRef.current?.getRootNode() as (Document | ShadowRoot) | undefined;
  const focused = () => root()?.activeElement ?? null;

  if (props.handle) {
    props.handle.current = {
      focusCard,
      focus: () => layerRef.current?.focus({ preventScroll: true }),
      pointer: () => pointer.current,
    };
  }

  // The dialog takes focus as it opens, so screen readers announce it (a11y review B1).
  useLayoutEffect(() => {
    layerRef.current?.focus({ preventScroll: true });
  }, []);

  // ---------- keys ----------
  function onEscape() {
    if (cb.current.onEscape?.()) return;
    if (cornerRef.current) {
      arm(null);
      setBox(null);
      const at = pointer.current;
      if (at && !press.current) hoverAt(at[0], at[1]);
      return;
    }
    if (cb.current.popover) return cb.current.popover.close();
    cancel();
  }

  /** Tab and Shift+Tab: through the popover's controls while it is open; else the outlines, then the bar's ✕. */
  function onTab(dir: 1 | -1): KeyResult {
    const pop = cb.current.popover?.element();
    if (cb.current.popover) {
      if (!pop) return;
      const items = focusablesIn(pop);
      if (!items.length) return pop.focus({ preventScroll: true });
      const i = items.indexOf(focused() as HTMLElement);
      items[i < 0 ? (dir > 0 ? 0 : items.length - 1) : (i + dir + items.length) % items.length].focus({ preventScroll: true });
      return;
    }
    const n = outlinesRef.current.length;
    const items = n + 1; // the outlines, then the ✕
    const now = focused();
    let i = now === exitRef.current ? n : outlineEls.current.findIndex((el, j) => j < n && el === now);
    if (i < 0 && activeRef.current) i = activeRef.current.index;
    const next = i < 0 ? (dir > 0 ? 0 : items - 1) : (i + dir + items) % items;
    if (next < n && !cb.current.busy) focusCard(next);
    else exitRef.current?.focus({ preventScroll: true });
  }

  // Esc hides the hover preview, drops a first corner, closes the popover, else leaves; K and Space
  // leave (YouTube's play/pause: the video plays again); Tab / arrows step through the outlined cards
  // and Enter reads one; with a popover open, C copies, S keeps, ← → show other matches and ↑ ↓ scroll it.
  // F, T and I (the page's layout keys) are kept from the page. Installed during commit, so the keys
  // are covered from the first frame.
  useLayoutEffect(
    () =>
      installKeyHandler(
        {
          onClose: onEscape,
          // K and Space always leave, a focused button or not (Enter presses one): the page never gets them.
          onPlay: () => cancel(),
          onKeep: () => cb.current.popover?.keep(),
          onCopy: () => cb.current.popover?.copy(),
          onPrev: () => (cb.current.popover ? cb.current.popover.step(-1) : step(-1)),
          onNext: () => (cb.current.popover ? cb.current.popover.step(1) : step(1)),
          onStep: (dir, via) => {
            if (via === 'tab') return onTab(dir);
            if (cb.current.popover) cb.current.popover.scroll(dir);
            else step(dir);
          },
          onActivate: () => {
            if (isControl(focused()) || cb.current.popover) return false; // a button presses itself
            if (!cb.current.busy) activate();
          },
          onLayoutKey: () => undefined,
        },
        window,
        (root() as ShadowRoot | undefined)?.host,
      ),
    [],
  );

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

  /** The pointer is off the cards (it left the frame, or it is over the bar). */
  const offCards = () => {
    setOnCard(false);
    if (activeRef.current?.by === 'pointer') light(null);
  };

  /** With a first corner set, the box follows the pointer (none while it is back on the corner). */
  const band = (x: number, y: number) => {
    const c = cornerRef.current;
    setBox(c && Math.hypot(x - c[0], y - c[1]) > CLICK_SLOP ? normalizeDrag(c[0], c[1], x, y) : null);
  };

  // Outlines that come under a pointer that has stopped light the card under it at once, not at
  // the pointer's next move (review M13).
  useLayoutEffect(() => {
    const at = pointer.current;
    if (at && !busy && !press.current && !cornerRef.current) hoverAt(at[0], at[1]);
  }, [cards]);

  // Once a read is over, the card under a pointer that stayed still lights again.
  useLayoutEffect(() => {
    const at = pointer.current;
    if (!busy && at && !press.current && !cornerRef.current) hoverAt(at[0], at[1]);
  }, [!!busy]);

  /** Focus moved to an outline (a screen reader's cursor, or the keys above): light that card. */
  const focusOn = (index: number) => {
    const a = activeRef.current;
    if (a?.index !== index || a.by !== 'key') light({ index, by: 'key' });
  };

  /** Focus left an outline (to the popover, the ✕, the page): it no longer lights its card. */
  const blurOn = (index: number) => {
    const a = activeRef.current;
    if (a?.index === index && a.by === 'key') light(null);
  };

  /** Events on the bar are its own (its ✕): not a press on the frame. */
  const onBar = (e: Event) => !!(e.target as Element | null)?.closest?.('.bar');

  const onPointerDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if (!fromUser(e) || onBar(e)) return;
    e.preventDefault(); // focus stays where it is (the popover keeps it while another card is read)
    if (busy || e.button !== 0 || press.current) return; // right-click leaves via contextmenu
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
    const p = press.current;
    if (!p && onBar(e)) {
      pointer.current = null;
      offCards();
      return;
    }
    const [x, y] = point(e);
    pointer.current = [x, y];
    if (!p) {
      if (busy) return;
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
    const r = onRelease(p, x, y, cornerRef.current, outlinesRef.current, !!cb.current.popover);
    switch (r.kind) {
      case 'pick':
        pick(r.index, [p.x, p.y]); // where it went down: on the card picked
        return;
      case 'select':
        arm(null);
        setBox(null); // the read's own box (busy) shows from now on
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
      case 'dismiss':
        setBox(null);
        cb.current.onDismiss?.();
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
    offCards();
    if (cornerRef.current) setBox(null);
  };

  const onContextMenu = (e: Event) => {
    e.preventDefault();
    if (!busy && fromUser(e)) cancel();
  };

  // The page must not scroll under the frozen frame.
  const onWheel = (e: Event) => e.preventDefault();

  const shown = busy ?? box;
  const lit = !shown && active ? outlines[active.index] : undefined;
  const armed = busy ? null : corner;
  const count = outlines.length;
  const searching = !!finding && count === 0;
  // The bar moves to the bottom when a card lies under it at the top and none does at the bottom.
  const under = (zone: Rect) => outlines.some((c) => overlaps(c.rect, zone));
  const barLow = under(barZone(maxX, 0, 64)) && !under(barZone(maxX, maxY - 64, maxY));
  const mark = current && !busy ? current : null;
  const status = armed
    ? { shown: 'Click the opposite corner', said: 'Click the opposite corner. Esc to cancel.' }
    : searching
      ? { shown: 'Finding cards…', said: 'Finding cards…' }
      : count
        ? { shown: count === 1 ? '1 card' : `${count} cards`, said: `${count === 1 ? '1 card' : `${count} cards`} outlined. Esc to exit.` }
        : noneFound
          ? { shown: 'No cards found. Drag a box around one.', said: 'No cards found. Drag a box around one. Esc to exit.' }
          : { shown: 'Drag a box around a card', said: 'Drag a box around a card. Esc to exit.' };
  return (
    <div
      ref={layerRef}
      class={`layer${busy ? ' busy' : ''}${onCard && !busy ? ' on-card' : ''}`}
      // One dialog at a time: while a popover shows, the popover is the dialog (a11y review m1).
      role={popover ? undefined : 'dialog'}
      aria-modal={popover ? undefined : 'true'}
      aria-label={popover ? undefined : 'Duel Lens: select a card'}
      aria-describedby={popover ? undefined : 'dl-how'}
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
      {shown || lit ? null : <Spotlight cards={outlines} box={mark && !mark.shape ? mark.rect : null} w={maxX} h={maxY} />}
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
              aria-describedby={describedBy?.index === i ? describedBy.id : undefined}
              // Only assistive technology clicks an outline itself (the layer takes the mouse's).
              onClick={byUser(() => pick(i))}
              onFocus={() => focusOn(i)}
              onBlur={() => blurOn(i)}
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
      {/* The card (or box) whose details show: marked above the dim of a lit card. */}
      {mark ? <SelectionBox rect={mark.rect} mode="done" shape={mark.shape} /> : null}
      {armed ? <div class="corner" aria-hidden="true" style={{ left: `${armed[0]}px`, top: `${armed[1]}px` }} /> : null}
      <div class={`bar${barLow ? ' low' : ''}${searching && !armed ? ' finding' : ''}`}>
        <LensIcon />
        <span class="bar-name" aria-hidden="true">
          Duel Lens
        </span>
        <span aria-hidden="true">·</span>
        <span class="hint" aria-hidden="true">
          {status.shown}
        </span>
        <span aria-hidden="true">·</span>
        <span class="bar-esc" aria-hidden="true">
          <kbd>Esc</kbd> {armed ? 'to cancel' : 'to exit'}
        </span>
        <button type="button" class="x" ref={exitRef} aria-label="Exit Duel Lens" onClick={byUser(() => cancel())}>
          ✕
        </button>
        <span class="sr-only" role="status">
          {status.said}
        </span>
      </div>
      <p class="sr-only" id="dl-how">
        {count ? 'Tab goes through the cards, Enter reads one. ' : ''}Space or K leaves and plays the video again.
      </p>
      {said !== undefined ? (
        <p class="sr-only said" role="status">
          {said}
        </p>
      ) : null}
    </div>
  );
}
