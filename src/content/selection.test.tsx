// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/preact';
import type { CardDetection, DetectedCardBox } from '../shared/messages';
import type { Point } from './geometry';
import { outlinesFrom, type CardOutline } from './outlines';
import { CLICK_SLOP, onRelease, SelectionLayer } from './selection';
import { trustEvents, untrusted } from './test-events';

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

let distrust: () => void;

beforeEach(() => {
  distrust = trustEvents(); // the user's own pointer and keys
  // installKeyHandler (Escape-to-cancel) checks chrome.runtime.id (a live,
  // non-invalidated context, as real content scripts always have).
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id' } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  distrust();
});

/** The frozen frame's layer: a dialog while selecting, not while matching (a11y review m1). */
const layerIn = (container: Element) => container.querySelector<HTMLElement>('.layer')!;

function setup(extra: { busy?: { x: number; y: number; w: number; h: number } } = {}) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const { container } = render(<SelectionLayer screenshot={SHOT} onSelect={onSelect} onCancel={onCancel} {...extra} />);
  return { onSelect, onCancel, layer: layerIn(container) };
}

function drag(layer: Element, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(layer, { clientX: from[0], clientY: from[1], button: 0, pointerId: 1 });
  fireEvent.pointerMove(layer, { clientX: (from[0] + to[0]) / 2, clientY: (from[1] + to[1]) / 2, pointerId: 1 });
  fireEvent.pointerMove(layer, { clientX: to[0], clientY: to[1], pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe('SelectionLayer', () => {
  it('draws the frozen frame at the captured viewport size (scrollbar included)', () => {
    const onSelect = vi.fn();
    render(
      <SelectionLayer screenshot={SHOT} viewport={{ w: 1920, h: 1080 }} onSelect={onSelect} onCancel={vi.fn()} />,
    );
    const img = screen.getByRole('dialog', { name: /select a card/i }).querySelector('img')!;
    expect(img.style.width).toBe('1920px');
    expect(img.style.height).toBe('1080px');
  });

  it('shows the frozen screenshot with a hint', () => {
    const { layer } = setup();
    const img = layer.querySelector('img');
    expect(img?.getAttribute('src')).toBe(SHOT);
    expect(screen.getByText(/drag a box around a card/i)).toBeTruthy();
  });

  it('calls onSelect with the normalised rect after pointer down, move and up', () => {
    const { layer, onSelect, onCancel } = setup();
    drag(layer, [100, 80], [40, 20]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ x: 40, y: 20, w: 60, h: 60 });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('clamps a drag that leaves the viewport', () => {
    const { layer, onSelect } = setup();
    drag(layer, [100, 100], [-50, 99999]);
    expect(onSelect).toHaveBeenCalledWith({ x: 0, y: 100, w: 100, h: window.innerHeight - 100 });
  });

  it('cancels on Escape', () => {
    const { onCancel, onSelect } = setup();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  // Click to scan: a stray click or a tiny drag no longer throws the frozen frame away (Esc and
  // right-click still do); a box too small to read is just dropped.
  it('drops a drag smaller than 12x12 px and keeps selecting', () => {
    const { layer, onSelect, onCancel } = setup();
    drag(layer, [100, 100], [108, 150]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(layer.querySelector('.sel')).toBeNull();
    expect(screen.getByText(/drag a box around a card/i)).toBeTruthy();
    drag(layer, [100, 100], [160, 190]); // and the next drag still scans
    expect(onSelect).toHaveBeenCalledWith({ x: 100, y: 100, w: 60, h: 90 });
  });

  it('cancels on right-click', () => {
    const { layer, onSelect, onCancel } = setup();
    fireEvent.pointerDown(layer, { clientX: 10, clientY: 10, button: 2, pointerId: 1 });
    const menu = fireEvent.contextMenu(layer, { clientX: 10, clientY: 10 });
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(menu).toBe(false); // the page's context menu is suppressed
  });

  it('keeps the page from scrolling under the frozen frame', () => {
    const { layer } = setup();
    const wheel = fireEvent.wheel(layer, { deltaY: 120 });
    expect(wheel).toBe(false); // default prevented
  });

  it('while busy, shows the box as "Matching artwork…" and ignores new drags', () => {
    const { layer, onSelect, onCancel } = setup({ busy: { x: 10, y: 40, w: 60, h: 90 } });
    expect(screen.getByText('Matching artwork…')).toBeTruthy();
    drag(layer, [300, 300], [400, 450]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ---------- click to scan ----------

const VIEW = { w: 1000, h: 800 };

function box(pts: Point[]): DetectedCardBox {
  return { cx: 0, cy: 0, w: 0, h: 0, angle: 0, conf: 0.9, pts };
}
/** An upright w x h card with its top-left corner at (x, y). */
const upright = (x: number, y: number, w: number, h: number) =>
  box([
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]);
// A 50x100 card centred on (600, 400), turned atan2(3, 4) ≈ 36.9° clockwise (corners by hand).
const TILTED = box([
  [610, 345],
  [650, 375],
  [590, 455],
  [550, 425],
]);

/** The outlines for a screenshot of the 1000x800 viewport at devicePixelRatio 1. */
function cardsOf(...boxes: DetectedCardBox[]): CardOutline[] {
  const d: CardDetection = { boxes, width: VIEW.w, height: VIEW.h, ms: 100 };
  return outlinesFrom(d, VIEW);
}

// Reading order: A (100,100) and B (300,100) on the top row, then the tilted card C.
const THREE = () => cardsOf(TILTED, upright(300, 100, 100, 140), upright(100, 100, 100, 140));

function setupCards(
  props: { cards?: CardOutline[] | null; finding?: boolean; noneFound?: boolean; busy?: { x: number; y: number; w: number; h: number } } = {},
) {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const onPick = vi.fn();
  const { container } = render(
    <SelectionLayer
      screenshot={SHOT}
      viewport={VIEW}
      onSelect={onSelect}
      onCancel={onCancel}
      onPick={onPick}
      cards={props.cards === undefined ? THREE() : props.cards}
      finding={props.finding}
      noneFound={props.noneFound}
      busy={props.busy}
    />,
  );
  return { onSelect, onCancel, onPick, layer: layerIn(container) };
}

/** Press and release, moving by (dx, dy) in between. */
function click(layer: Element, at: [number, number], move: [number, number] = [0, 0]) {
  fireEvent.pointerDown(layer, { clientX: at[0], clientY: at[1], button: 0, pointerId: 1 });
  if (move[0] || move[1]) fireEvent.pointerMove(layer, { clientX: at[0] + move[0], clientY: at[1] + move[1], pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: at[0] + move[0], clientY: at[1] + move[1], pointerId: 1 });
}

const hover = (layer: Element, x: number, y: number) => fireEvent.pointerMove(layer, { clientX: x, clientY: y, pointerId: 1 });
const lit = (layer: Element) => layer.querySelector<HTMLElement>('.sel.hover');

describe('SelectionLayer: detected cards', () => {
  it('outlines every detected card just outside its edge, turned like it, each labelled with its place ("Card 2 of 3")', () => {
    setupCards();
    const outlines = screen.getAllByRole('button', { name: /^Card \d of 3$/ });
    expect(outlines.map((o) => o.getAttribute('aria-label'))).toEqual(['Card 1 of 3', 'Card 2 of 3', 'Card 3 of 3']);
    const geometry = (el: Element) => ['x', 'y', 'width', 'height', 'transform'].map((a) => el.getAttribute(a));
    // The 100x140 card at (100,100), 3 px outside its edge on every side.
    expect(geometry(outlines[0])).toEqual(['97', '97', '106', '146', 'rotate(0 150 170)']);
    // The tilted 50x100 card centred on (600,400), turned atan2(3, 4) = 36.87°.
    const [x, y, w, h, turn] = geometry(outlines[2]);
    expect([x, y, w, h]).toEqual(['572', '347', '56', '106']);
    expect(turn).toMatch(/^rotate\(36\.869\d* 600 400\)$/);
  });

  it('says "Finding cards…" while detection runs, then "Click a card, or drag a box" once cards are outlined', () => {
    setupCards({ cards: null, finding: true });
    expect(screen.getByText(/finding cards/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Card / })).toBeNull();
    cleanup();
    setupCards();
    expect(screen.getByText(/click a card, or drag a box/i)).toBeTruthy();
    expect(screen.queryByText(/finding cards/i)).toBeNull();
  });

  it('falls back to the drag hint when detection found nothing or never answered', () => {
    setupCards({ cards: [] });
    expect(screen.getByText(/drag a box around a card/i)).toBeTruthy();
    cleanup();
    setupCards({ cards: null, finding: false });
    expect(screen.getByText(/drag a box around a card/i)).toBeTruthy();
  });

  it('scans the card under a click (press and release within 6 px), without drawing a box', () => {
    const { layer, onPick, onSelect, onCancel } = setupCards();
    click(layer, [150, 170], [4, 4]); // a 5.7 px wobble is still a click
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(0);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('counts a click on the outline itself, drawn just outside the card', () => {
    const { layer, onPick } = setupCards();
    click(layer, [202, 170]); // 2 px right of card 1's edge, on its outline (3 px out)
    expect(onPick).toHaveBeenCalledWith(0);
  });

  it('follows the tilted outline: a click in its bounding box but off the card picks nothing', () => {
    const { layer, onPick } = setupCards();
    click(layer, [640, 440]); // inside the bounds (550..650, 345..455), outside the card
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' }); // drops the first corner that click set
    click(layer, [600, 400]);
    expect(onPick).toHaveBeenCalledWith(2);
  });

  it('scans nothing on a click over no card: it sets a first corner instead (see two clicks, below)', () => {
    const { layer, onPick, onSelect, onCancel } = setupCards();
    click(layer, [800, 700]);
    expect(onPick).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' }); // drops the corner
    click(layer, [150, 170]); // and a click on a card still scans it
    expect(onPick).toHaveBeenCalledWith(0);
  });

  it('treats a press that moves more than 6 px as a drag, even when it starts on a card', () => {
    const { layer, onPick, onSelect } = setupCards();
    drag(layer, [120, 120], [260, 300]);
    expect(onPick).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({ x: 120, y: 120, w: 140, h: 180 });
  });

  // Review M5: on touch or pen input a tap wobbles; one that starts and ends on the same card is a click.
  it('treats a small wobble on a card (past the click slop, too small to be a box) as a click on that card', () => {
    const { layer, onPick, onSelect, onCancel } = setupCards();
    click(layer, [150, 170], [8, 5]); // 9.4 px: a drag, but an 8x5 box
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(0);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('drops a small wobble that leaves its card, or that starts off the cards, as before', () => {
    const { layer, onPick, onSelect } = setupCards();
    click(layer, [198, 170], [9, 0]); // from card 1's edge to 7 px past it, beyond its outline
    click(layer, [240, 170], [8, 5]); // between the cards
    expect(onPick).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText(/click a card, or drag a box/i)).toBeTruthy();
  });

  it('judges a click by its release too: a press and a release far apart, with no move reported between, is a drag', () => {
    const { layer, onPick, onSelect } = setupCards();
    fireEvent.pointerDown(layer, { clientX: 120, clientY: 120, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 260, clientY: 300, pointerId: 1 });
    expect(onPick).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({ x: 120, y: 120, w: 140, h: 180 });
  });

  it('picks the smallest card where outlines overlap', () => {
    // A box around a whole pile, and one card lying on it.
    const cards = cardsOf(upright(50, 50, 400, 400), upright(200, 200, 100, 140));
    const { layer, onPick } = setupCards({ cards });
    const small = cards.findIndex((c) => c.rect.w === 100);
    click(layer, [250, 270]);
    expect(onPick).toHaveBeenCalledWith(small);
  });

  it('lights the card under the pointer, turned like the card, with a pointer cursor; off the cards, neither', () => {
    const { layer } = setupCards();
    hover(layer, 600, 400);
    expect(layer.classList.contains('on-card')).toBe(true);
    const box = lit(layer)!;
    expect(box).not.toBeNull();
    // The 50x100 card centred on (600, 400), turned atan2(3, 4) radians, lit where its outline is (3 px out).
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual(['572px', '347px', '56px', '106px']);
    expect(box.style.transform).toMatch(/^rotate\(0\.6435\d*rad\)$/);
    hover(layer, 800, 700);
    expect(layer.classList.contains('on-card')).toBe(false);
    expect(lit(layer)).toBeNull();
  });

  it('never lets the outlines get in the way of a drag', () => {
    const { layer, onSelect } = setupCards();
    // From empty space, across two cards.
    drag(layer, [60, 60], [420, 300]);
    expect(onSelect).toHaveBeenCalledWith({ x: 60, y: 60, w: 360, h: 240 });
  });

  it('steps through the outlines with Tab, Shift+Tab and the arrows, and Enter scans the one in focus', () => {
    const { onPick } = setupCards();
    const outline = (n: number) => screen.getByRole('button', { name: `Card ${n} of 3` });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(outline(1));
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(outline(2));
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(outline(1));
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' }); // wraps around to the last
    expect(document.activeElement).toBe(outline(3));
    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(outline(1));
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it('lights the card in keyboard focus too', () => {
    const { layer } = setupCards();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(lit(layer)?.style.left).toBe('97px');
  });

  // Review M3: a screen reader activates an outline with a click on the element itself (NVDA's
  // browse-mode Enter, VoiceOver's VO+Space), and moves focus to it with its own cursor.
  it('scans an outline that assistive technology activates (a click on the outline itself)', () => {
    const { onPick } = setupCards();
    fireEvent.click(screen.getByRole('button', { name: 'Card 2 of 3' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith(1);
  });

  it('lights the outline a screen reader moves focus to, and Enter scans that one', () => {
    const { layer, onPick } = setupCards();
    act(() => screen.getByRole('button', { name: 'Card 3 of 3' }).focus());
    expect(lit(layer)?.style.left).toBe('572px'); // the tilted card
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(2);
  });

  // Review M13: the card under the pointer lights up when its outline comes, not at the next move.
  it('lights the card under a pointer that stopped before the outlines came', () => {
    const props = { screenshot: SHOT, viewport: VIEW, onSelect: vi.fn(), onCancel: vi.fn(), onPick: vi.fn() };
    const { rerender } = render(<SelectionLayer {...props} cards={null} finding />);
    const layer = screen.getByRole('dialog', { name: /select a card/i });
    hover(layer, 600, 400); // where the tilted card will be outlined
    expect(lit(layer)).toBeNull();
    rerender(<SelectionLayer {...props} cards={THREE()} />);
    expect(lit(layer)?.style.left).toBe('572px');
    expect(layer.classList.contains('on-card')).toBe(true);
  });

  it('lights nothing when the outlines come after the pointer left the frame', () => {
    const props = { screenshot: SHOT, viewport: VIEW, onSelect: vi.fn(), onCancel: vi.fn(), onPick: vi.fn() };
    const { rerender } = render(<SelectionLayer {...props} cards={null} finding />);
    const layer = screen.getByRole('dialog', { name: /select a card/i });
    hover(layer, 600, 400);
    fireEvent.pointerLeave(layer, { clientX: 600, clientY: 400, pointerId: 1 });
    rerender(<SelectionLayer {...props} cards={THREE()} />);
    expect(lit(layer)).toBeNull();
  });

  it('ignores Enter when no card is in focus', () => {
    const { onPick, onSelect, onCancel } = setupCards();
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('moves the hint to the bottom when a card sits under it at the top, and keeps it on top otherwise', () => {
    // The hint is centred at the top of the 1000 px wide frame.
    setupCards({ cards: cardsOf(upright(450, 5, 100, 140)) });
    expect(screen.getByRole('status').classList.contains('low')).toBe(true);
    cleanup();
    setupCards(); // cards at y >= 100, clear of the hint
    expect(screen.getByRole('status').classList.contains('low')).toBe(false);
    cleanup();
    // Cards under both places: it stays on top.
    setupCards({ cards: cardsOf(upright(450, 5, 100, 140), upright(450, 700, 100, 95)) });
    expect(screen.getByRole('status').classList.contains('low')).toBe(false);
  });

  it('is no dialog while a card is being matched: the popover is the one dialog then (a11y review m1)', () => {
    const { layer } = setupCards({ busy: { x: 100, y: 100, w: 100, h: 140 } });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(layer.hasAttribute('aria-modal')).toBe(false);
    expect(layer.hasAttribute('aria-label')).toBe(false);
  });

  it('hides the outlines while a card is being matched', () => {
    setupCards({ busy: { x: 100, y: 100, w: 100, h: 140 } });
    expect(screen.queryByRole('button', { name: /^Card / })).toBeNull();
  });

  it('draws the matching box turned like the clicked card, with its label kept upright above it', () => {
    const [, , tilted] = THREE();
    render(
      <SelectionLayer
        screenshot={SHOT}
        viewport={VIEW}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        busy={tilted.rect}
        busyShape={tilted.shape}
      />,
    );
    const box = document.querySelector<HTMLElement>('.layer .sel.scanning')!;
    expect(box.style.transform).toMatch(/^rotate\(0\.6435\d*rad\)$/);
    expect(box.textContent).toBe(''); // the label is not turned with the box
    const label = screen.getByText('Matching artwork…');
    const anchor = label.parentElement as HTMLElement;
    // Above the card's bounds (550,345)-(650,455), 3 px out like the box.
    expect([anchor.style.left, anchor.style.top, anchor.style.width, anchor.style.height]).toEqual(['547px', '342px', '106px', '116px']);
  });
});

// ---------- a11y review B1: the dialog takes focus as it opens ----------

describe('SelectionLayer: focus', () => {
  it('takes focus as it opens, without scrolling the page, so screen readers announce the dialog', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const { layer } = setupCards();
    expect(layer.getAttribute('role')).toBe('dialog');
    expect(layer.getAttribute('aria-modal')).toBe('true');
    expect(layer.getAttribute('aria-label')).toBe('Duel Lens: select a card');
    expect(layer.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(layer);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});

// ---------- security review M1: only the user's own input ----------

describe('SelectionLayer: only real input', () => {
  it('ignores pointer events, right-clicks and outline clicks that a script made', () => {
    const { layer, onPick, onSelect, onCancel } = setupCards();
    const fake = (type: 'pointerDown' | 'pointerMove' | 'pointerUp' | 'contextMenu', init: object) =>
      fireEvent(layer, untrusted(createEvent[type](layer, init)));
    // A drag across two cards, a click on a card, a click on no card, a right-click.
    fake('pointerDown', { clientX: 60, clientY: 60, button: 0, pointerId: 1 });
    fake('pointerMove', { clientX: 420, clientY: 300, pointerId: 1 });
    fake('pointerUp', { clientX: 420, clientY: 300, pointerId: 1 });
    fake('pointerDown', { clientX: 150, clientY: 170, button: 0, pointerId: 1 });
    fake('pointerUp', { clientX: 150, clientY: 170, pointerId: 1 });
    fake('pointerDown', { clientX: 800, clientY: 700, button: 0, pointerId: 1 });
    fake('pointerUp', { clientX: 800, clientY: 700, pointerId: 1 });
    fake('contextMenu', { clientX: 10, clientY: 10 });
    // Assistive technology's way in: a click on the outline itself.
    const outline = screen.getByRole('button', { name: 'Card 2 of 3' });
    fireEvent(outline, untrusted(createEvent.click(outline)));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(layer.querySelector('.sel, .corner')).toBeNull(); // no box drawn, no corner set
    click(layer, [150, 170]); // the user's own click still scans
    expect(onPick).toHaveBeenCalledWith(0);
  });
});

// ---------- a11y review M3 (WCAG 2.5.8): targets of 24x24 px at least ----------

describe('SelectionLayer: small cards', () => {
  it('takes a click up to 12 px from the centre of a card drawn under 24x24 px, and outlines it as before', () => {
    const { layer, onPick } = setupCards({ cards: cardsOf(upright(500, 500, 10, 14)) }); // centre (505, 507)
    const outline = screen.getByRole('button', { name: 'Card 1 of 1' });
    expect([outline.getAttribute('width'), outline.getAttribute('height')]).toEqual(['16', '20']); // 3 px out, as before
    click(layer, [505 + 11, 507 - 11]); // outside its outline, inside 24x24 px around its centre
    expect(onPick).toHaveBeenCalledWith(0);
  });
});

// ---------- a11y review M1 (WCAG 2.5.7): a box with two clicks, no dragging ----------

describe('onRelease: what a press does once released', () => {
  const cards = THREE(); // A (100..200, 100..240) and B (300..400, 100..240) on top, the tilted C about (600, 400)
  const press = (x: number, y: number, dragging = false) => ({ x, y, dragging });

  it('scans a drag of 12x12 px or more, with or without a first corner', () => {
    const rect = { x: 60, y: 60, w: 360, h: 240 };
    expect(onRelease(press(60, 60, true), 420, 300, null, cards)).toEqual({ kind: 'select', rect });
    expect(onRelease(press(60, 60, true), 420, 300, [800, 700], cards)).toEqual({ kind: 'select', rect });
  });

  it('picks the card under a click, and sets a first corner where a click finds no card', () => {
    expect(onRelease(press(150, 170), 152, 171, null, cards)).toEqual({ kind: 'pick', index: 0 });
    expect(onRelease(press(800, 700), 800, 700, null, cards)).toEqual({ kind: 'arm', at: [800, 700] });
  });

  it('with a first corner, takes a click anywhere, on a card too, for the opposite corner', () => {
    expect(onRelease(press(150, 170), 150, 170, [40, 50], cards)).toEqual({ kind: 'select', rect: { x: 40, y: 50, w: 110, h: 120 } });
    expect(onRelease(press(900, 760), 900, 760, [800, 700], cards)).toEqual({ kind: 'select', rect: { x: 800, y: 700, w: 100, h: 60 } });
  });

  it('with a first corner, cancels it on a click within the click slop of it', () => {
    expect(onRelease(press(800 + CLICK_SLOP, 700), 800 + CLICK_SLOP, 700, [800, 700], cards)).toEqual({ kind: 'disarm' });
    expect(onRelease(press(804, 704), 804, 704, [800, 700], cards)).toEqual({ kind: 'disarm' });
  });

  it('with a first corner, keeps it when the second click would make a box too thin to read', () => {
    expect(onRelease(press(808, 900), 808, 900, [800, 700], cards)).toEqual({ kind: 'none' });
  });

  it("with a first corner, takes a tap's small wobble for the second click (a finger or a pen)", () => {
    expect(onRelease(press(900, 760, true), 908, 765, [800, 700], cards)).toEqual({ kind: 'select', rect: { x: 800, y: 700, w: 100, h: 60 } });
  });

  it('with a first corner, drops it after a drag too thin to read', () => {
    expect(onRelease(press(500, 600, true), 700, 605, [800, 700], cards)).toEqual({ kind: 'disarm' });
  });

  it('without a corner, keeps the rules for wobbles and thin drags: a wobble on one card picks it, the rest is dropped', () => {
    expect(onRelease(press(150, 170, true), 158, 175, null, cards)).toEqual({ kind: 'pick', index: 0 });
    expect(onRelease(press(240, 170, true), 248, 175, null, cards)).toEqual({ kind: 'none' });
    expect(onRelease(press(500, 600, true), 700, 605, null, cards)).toEqual({ kind: 'none' });
  });
});

describe('SelectionLayer: a box with two clicks', () => {
  const corner = (layer: Element) => layer.querySelector<HTMLElement>('.corner');
  const hint = () => screen.getByRole('status');

  it('marks a first corner where a click finds no card, and the hint asks for the opposite corner', () => {
    const { layer, onSelect, onPick, onCancel } = setupCards();
    click(layer, [800, 700]);
    expect([corner(layer)?.style.left, corner(layer)?.style.top]).toEqual(['800px', '700px']);
    expect(corner(layer)?.getAttribute('aria-hidden')).toBe('true');
    expect(hint().textContent).toBe('Click the opposite corner·Esc to cancel');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('draws the box from the corner to the pointer as it moves, as a drag does, lighting no card', () => {
    const { layer } = setupCards();
    click(layer, [700, 650]);
    hover(layer, 150, 170); // over card A
    const band = layer.querySelector<HTMLElement>('.sel.drawing')!;
    expect([band.style.left, band.style.top, band.style.width, band.style.height]).toEqual(['150px', '170px', '550px', '480px']);
    expect(lit(layer)).toBeNull();
    expect(layer.classList.contains('on-card')).toBe(false);
    expect(hint().textContent).toContain('Click the opposite corner'); // still there while the box follows
  });

  it('scans the box between the two corners on the second click, even when it lands on an outline', () => {
    const { layer, onSelect, onPick } = setupCards();
    click(layer, [700, 650]);
    hover(layer, 150, 170);
    click(layer, [150, 170]); // on card A
    expect(onPick).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({ x: 150, y: 170, w: 550, h: 480 });
  });

  it('cancels the corner on a second click within the click slop of it', () => {
    const { layer, onSelect, onCancel } = setupCards();
    click(layer, [800, 700]);
    click(layer, [803, 704]);
    expect(corner(layer)).toBeNull();
    expect(hint().textContent).toContain('Click a card, or drag a box');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('Esc cancels the corner first, then closes on a second Esc', () => {
    const { layer, onCancel } = setupCards();
    click(layer, [800, 700]);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(corner(layer)).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
    expect(hint().textContent).toContain('Click a card, or drag a box');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('still takes a drag with a corner set, which replaces it', () => {
    const { layer, onSelect } = setupCards();
    click(layer, [800, 700]);
    drag(layer, [60, 60], [420, 300]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({ x: 60, y: 60, w: 360, h: 240 });
  });

  it('works where no card was found too', () => {
    const { layer, onSelect } = setup();
    click(layer, [100, 100]);
    expect(hint().textContent).toContain('Click the opposite corner');
    click(layer, [220, 275]);
    expect(onSelect).toHaveBeenCalledWith({ x: 100, y: 100, w: 120, h: 175 });
  });
});

// ---------- live check M1: outlines you can see ----------

describe('SelectionLayer: the outlined cards stand out', () => {
  const holes = (layer: Element) => [...layer.querySelectorAll('svg.spotlight mask rect.hole')];

  it('dims the frame around the outlined cards only: a hole in the dim for each, turned like its outline', () => {
    const { layer } = setupCards();
    expect(layer.querySelector('div.dim')).toBeNull();
    const spot = layer.querySelector('svg.spotlight')!;
    expect(spot.getAttribute('aria-hidden')).toBe('true');
    const outlines = screen.getAllByRole('button', { name: /^Card \d of 3$/ });
    const geometry = (el: Element) => ['x', 'y', 'width', 'height', 'transform'].map((a) => el.getAttribute(a));
    expect(holes(layer).map(geometry)).toEqual(outlines.map(geometry));
    // The dim itself is masked by them.
    const mask = spot.querySelector('mask')!;
    expect(spot.querySelector('rect.shade')!.getAttribute('mask')).toBe(`url(#${mask.id})`);
  });

  it('dims the whole frame while no card is outlined, and nothing more while a box is drawn', () => {
    const { layer } = setupCards({ cards: null, finding: true });
    expect(layer.querySelector('div.dim')).not.toBeNull();
    expect(layer.querySelector('svg.spotlight')).toBeNull();
    cleanup();
    const second = setupCards();
    fireEvent.pointerDown(second.layer, { clientX: 60, clientY: 60, button: 0, pointerId: 1 });
    fireEvent.pointerMove(second.layer, { clientX: 420, clientY: 300, pointerId: 1 }); // the box dims around itself
    expect(second.layer.querySelector('svg.spotlight, div.dim')).toBeNull();
  });

  it('draws each outline twice: a dark line under a bright one, the dark one hidden from screen readers', () => {
    const { layer } = setupCards();
    const under = [...layer.querySelectorAll('svg.cards rect.under')];
    const lines = screen.getAllByRole('button', { name: /^Card \d of 3$/ });
    expect(under).toHaveLength(3);
    expect(under.every((u) => u.getAttribute('aria-hidden') === 'true' && !u.hasAttribute('role'))).toBe(true);
    const geometry = (el: Element) => ['x', 'y', 'width', 'height', 'transform'].map((a) => el.getAttribute(a));
    expect(under.map(geometry)).toEqual(lines.map(geometry));
    // Every dark line comes before (under) every bright one.
    const all = [...layer.querySelectorAll('svg.cards rect')];
    expect(all.slice(0, 3)).toEqual(under);
  });
});

// ---------- live check p4 and m2 ----------

describe('SelectionLayer: the hint and the page keys', () => {
  it('says so when the detection found no card', () => {
    setupCards({ cards: [], noneFound: true });
    expect(screen.getByRole('status').textContent).toBe('No cards found. Drag a box around one.·Esc cancels');
  });

  it('keeps F, T and I from the page while the frame is frozen, so its layout stays as captured', () => {
    const page = vi.fn();
    document.addEventListener('keydown', page);
    setupCards();
    for (const key of ['f', 't', 'i']) fireEvent.keyDown(document.body, { key });
    expect(page).not.toHaveBeenCalled();
    document.removeEventListener('keydown', page);
  });
});
