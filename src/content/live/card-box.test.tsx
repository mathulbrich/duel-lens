// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { RecognizeResponse } from '../../shared/messages';
import { trustEvents, untrusted } from '../test-events';
import { ASH, BELLE } from '../test-fixtures';
import { LiveCardBox } from './card-box';

let distrust: () => void;
beforeEach(() => {
  distrust = trustEvents();
});
afterEach(() => {
  cleanup();
  distrust();
});

/** A card found by name (app.tsx lookUp): one candidate, no crop, no history entry, no AI. */
const found = (card: typeof ASH): RecognizeResponse => ({
  result: { candidates: [{ cardId: card.id, imageId: card.imageIds[0], score: 0, source: 'name' }], confident: true, faceDown: false, modelId: '', timings: {} },
  cards: { [card.id]: card },
  aiEnabled: false,
});
const ANCHOR = { x: 300, y: 120, w: 75, h: 105 };

function open(props: Partial<Parameters<typeof LiveCardBox>[0]> = {}) {
  const onClose = vi.fn();
  const view = render(<LiveCardBox response={found(ASH)} anchor={ANCHOR} images={{}} onClose={onClose} {...props} />);
  return { onClose, ...view };
}

describe('LiveCardBox', () => {
  // Over a playing video it is as small as it can be (the card box review): the card, its facts and its text. No
  // passcode, price or links (the side panel's card has them), and no Keep, Wrong card?, Report issue or Copy.
  it('shows the card, its facts and its text only: no links or numbers line, no actions', () => {
    const { container } = open();
    expect(screen.getByText(ASH.name)).toBeTruthy();
    expect(container.querySelector('.dv-meta')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Wrong card/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Report/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ask AI|Turn on AI/ })).toBeNull();
  });

  // The user's report: an empty orange bar where the "Turn on AI check" button was, and an empty line under the links.
  it('a card Live is not sure of says "Not sure" in its block, and no empty foot shows', () => {
    const unsure: RecognizeResponse = {
      result: { candidates: [{ cardId: ASH.id, imageId: ASH.imageIds[0], score: 0.74 }], confident: false, faceDown: false, modelId: 'm', timings: {} },
      cards: { [ASH.id]: ASH },
      aiEnabled: false,
    };
    const { container } = render(<LiveCardBox response={unsure} anchor={ANCHOR} images={{}} onClose={vi.fn()} />);
    expect(container.querySelector('.unsure')?.textContent).toBe('Not sure');
    expect(container.querySelector('.dv-foot')).toBeNull();
    expect(container.querySelector('.dv-actions')).toBeNull();
  });

  it('a sure card read from the video has no foot either: no "Found by name", nothing under its links', () => {
    // The shape Live really sends for a sure read (index.ts liveResponse): one candidate "by name", score 0, no crop.
    const read: RecognizeResponse = {
      result: { candidates: [{ cardId: ASH.id, imageId: ASH.imageIds[0], score: 0, source: 'name' }], confident: true, faceDown: false, modelId: '', timings: {} },
      cards: { [ASH.id]: ASH },
      aiEnabled: false,
    };
    const { container } = render(<LiveCardBox response={read} anchor={ANCHOR} images={{}} onClose={vi.fn()} />);
    expect(container.querySelector('.unsure')).toBeNull();
    expect(container.querySelector('.dv-foot')).toBeNull();
    expect(container.textContent).not.toContain('Found by name');
  });

  it('never takes the focus; Space reaches the page', async () => {
    const player = document.createElement('button');
    document.body.append(player);
    player.focus();
    const page = vi.fn();
    document.addEventListener('keydown', page);
    open();
    await Promise.resolve();
    expect(document.activeElement).toBe(player);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    player.dispatchEvent(space);
    expect(page).toHaveBeenCalledTimes(1);
    expect(space.defaultPrevented).toBe(false);
    document.removeEventListener('keydown', page);
    player.remove();
  });

  it('a hover box too tall for above the hand card shortens there, never beside it over the next card', async () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const tall = this.classList.contains('pop');
      return { x: 0, y: 0, left: 0, top: 0, right: 420, bottom: tall ? 575 : 0, width: tall ? 420 : 0, height: tall ? 575 : 0, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const hand = { x: 280, y: 540, w: 100, h: 150 };
      const { container } = open({ hover: true, anchor: hand });
      await Promise.resolve();
      const box = container.querySelector<HTMLElement>('.pop')!;
      expect(box.dataset.side).toBe('above');
      expect(box.style.maxHeight).toBe(`${hand.y - 12 - 8}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
    }
  });

  it('Esc closes the box and goes no further; other keys pass', () => {
    const { onClose } = open();
    const page = vi.fn();
    document.addEventListener('keydown', page);
    fireEvent.keyDown(document.body, { key: 'k' });
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(onClose).not.toHaveBeenCalled();
    expect(page).toHaveBeenCalledTimes(2);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(esc);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(true);
    expect(page).toHaveBeenCalledTimes(2); // the page never saw the Esc
    document.removeEventListener('keydown', page);
  });

  it('Esc shrinks the bigger picture first, then closes the box', () => {
    const { onClose } = open({ images: { [ASH.imageIds[0]]: 'data:image/jpeg;base64,AAAA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
    expect(document.querySelector('.dv.big')).toBeTruthy();
    const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    act(() => {
      esc();
    });
    expect(document.querySelector('.dv.big')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Its contract (the review): it never takes the focus, the bigger picture included, so Space and K stay the player's.
  it('keeps the focus on the page when its picture grows or shrinks', () => {
    const player = document.createElement('button');
    document.body.append(player);
    player.focus();
    open({ images: { [ASH.imageIds[0]]: 'data:image/jpeg;base64,AAAA' } });
    // A real press: its mousedown would focus the button; the box keeps it from doing so.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    screen.getByRole('button', { name: 'Show the picture bigger' }).dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
    expect(document.querySelector('.dv.big')).toBeTruthy();
    expect(document.activeElement).toBe(player);
    const down2 = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.querySelector('.dv-big')!.dispatchEvent(down2);
    expect(down2.defaultPrevented).toBe(true);
    fireEvent.click(document.querySelector('.dv-big')!);
    expect(document.querySelector('.dv.big')).toBeNull();
    expect(document.activeElement).toBe(player);
    player.remove();
  });

  it("ignores a page script's Esc", () => {
    const { onClose } = open();
    document.body.dispatchEvent(untrusted(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('the ✕ closes it, and the key listener goes when it unmounts', () => {
    const { onClose, unmount } = open();
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a second box replaces the first (a new card for the same host)', () => {
    const { rerender } = open();
    rerender(<LiveCardBox response={found(BELLE)} anchor={ANCHOR} images={{}} onClose={() => undefined} />);
    expect(screen.queryByText(ASH.name)).toBeNull();
    expect(screen.getByText(BELLE.name)).toBeTruthy();
  });
});

const IMG = { [ASH.imageIds[0]]: 'data:image/jpeg;base64,AAAA' };

/**
 * The boxes laid out as a browser would (happy-dom lays out nothing): its content `small` tall, `big` tall while its
 * picture shows bigger (the content's min-height); the box as tall as its content up to its max-height, and at least
 * its min-height, which wins over the max-height as in CSS. Its scroller reports what lies beyond what shows. The
 * window is happy-dom's, 1024 x 768 unless a test sets its height.
 */
function layout(small: number, big: number) {
  const natural = (pop: HTMLElement) => (pop.querySelector('.dv.big') ? big : small);
  const shown = (pop: HTMLElement) => Math.max(parseFloat(pop.style.minHeight) || 0, Math.min(natural(pop), parseFloat(pop.style.maxHeight) || Infinity));
  const proto = HTMLElement.prototype;
  const real = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const [w, h] = this.classList.contains('pop') ? [420, shown(this)] : [0, 0];
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
  const scroller = (el: HTMLElement, of: (pop: HTMLElement) => number) => {
    const pop = el.classList.contains('pop-scroll') ? el.closest<HTMLElement>('.pop') : null;
    return pop ? of(pop) : 0;
  };
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: function (this: HTMLElement) { return scroller(this, (pop) => Math.max(natural(pop), shown(pop))); } });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: function (this: HTMLElement) { return scroller(this, shown); } });
  return () => {
    proto.getBoundingClientRect = real;
    delete (proto as { scrollHeight?: number }).scrollHeight;
    delete (proto as { clientHeight?: number }).clientHeight;
  };
}

/** The browser sees the box change size (its ResizeObserver; happy-dom has none that fires). */
const relayout = () =>
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });

describe('LiveCardBox: the bigger picture keeps the box where it is', () => {
  // The user's report (Live check, a big card on a stream): the box above its card grew for the bigger picture, no
  // longer fitted above, and was placed again below the card, away from the pointer on its picture; the pointer then
  // on neither the box nor the card, the box went.
  it('a hover box above its card stays above when its picture shows bigger, as tall as the room there allows', () => {
    const restore = layout(200, 498);
    try {
      const card = { x: 300, y: 230, w: 105, h: 150 }; // 210 px above it, 368 below
      const { container } = open({ hover: true, anchor: card, images: IMG });
      const box = container.querySelector<HTMLElement>('.pop')!;
      expect(box.dataset.side).toBe('above');
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
      relayout();
      relayout();
      expect(document.querySelector('.dv.big')).not.toBeNull();
      expect(box.dataset.side).toBe('above');
      expect(box.style.maxHeight).toBe('210px');
      expect(box.style.top).toBe('8px'); // its foot still by the card: 8 + 210 + 12 = 230
    } finally {
      restore();
    }
  });

  // The pinned box: no room beside the card for it (a narrow window), below it; grown, it fitted nowhere and went to the
  // roomiest side, beside the card.
  it('a pinned box below its card stays below when its picture shows bigger', () => {
    const restore = layout(250, 498);
    try {
      const card = { x: 400, y: 300, w: 230, h: 150 }; // 374 px right of it, 380 left, 298 below, 280 above
      const { container } = open({ anchor: card, images: IMG });
      const box = container.querySelector<HTMLElement>('.pop')!;
      expect(box.dataset.side).toBe('below');
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
      relayout();
      relayout();
      expect(box.dataset.side).toBe('below');
      expect(box.style.maxHeight).toBe('298px');
      expect(box.style.top).toBe('462px');
    } finally {
      restore();
    }
  });

  // The user's report: "the box has to be scrolled" for the bigger picture. It lies over the box's own room (styles.ts:
  // the box does not scroll while it shows), from the top row down: a box scrolled down a little comes back to its top
  // row, so Duel Lens and the close button show above the picture.
  it('brings a box scrolled down back to its top row when the picture shows bigger', () => {
    open({ images: IMG });
    const scroller = document.querySelector<HTMLElement>('.pop-scroll')!;
    scroller.scrollTop = 60;
    fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
    expect(scroller.scrollTop).toBe(0);
  });

  // A click on the bigger picture shrinks it: the box keeps its height while the pointer is still on it, so it never
  // shrinks from under the pointer (which would let a hover box go); the pointer leaving it lets it shrink.
  it('stays as tall while the pointer is on it after the picture shrinks, and shrinks once the pointer leaves', () => {
    const restore = layout(200, 498);
    try {
      const card = { x: 300, y: 230, w: 105, h: 150 };
      const onLeave = vi.fn();
      const { container } = open({ hover: true, anchor: card, images: IMG, onLeave });
      const box = container.querySelector<HTMLElement>('.pop')!;
      fireEvent.pointerEnter(box);
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
      relayout();
      fireEvent.pointerMove(document.querySelector('.dv-big')!);
      fireEvent.click(document.querySelector('.dv-big')!);
      relayout();
      expect(document.querySelector('.dv.big')).toBeNull();
      expect(box.style.minHeight).toBe('210px');
      expect(box.dataset.side).toBe('above');
      expect(box.style.top).toBe('8px');
      fireEvent.pointerLeave(box);
      relayout();
      expect(box.style.minHeight).toBe('');
      expect(onLeave).toHaveBeenCalledTimes(1);
      expect(box.style.top).toBe('18px'); // 230 - 12 - 200: by its card again
    } finally {
      restore();
    }
  });

  // The review: a box whose card moves while its picture shows bigger takes the side that suits its new place (not the
  // old side, where there may be no room at all), and keeps that one from then on.
  it('a new anchor while the picture shows bigger: the box takes the roomy side for it, and keeps it', () => {
    const restore = layout(200, 498);
    try {
      const props = { hover: true, images: IMG, response: found(ASH), onClose: vi.fn() };
      const { container, rerender } = render(<LiveCardBox {...props} anchor={{ x: 300, y: 230, w: 105, h: 150 }} />);
      const box = container.querySelector<HTMLElement>('.pop')!;
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
      relayout();
      expect(box.dataset.side).toBe('above');
      // The card moves to the window's top: no room above it (y 10), 586 px below.
      rerender(<LiveCardBox {...props} anchor={{ x: 300, y: 10, w: 105, h: 150 }} />);
      relayout();
      expect(box.dataset.side).toBe('below');
      expect(box.style.maxHeight).toBe('');
      expect(box.style.top).toBe('172px'); // 10 + 150 + 12
      relayout();
      expect(box.dataset.side).toBe('below');
      // Further down (380 px above it, 198 below): above now, shortened to its room there; kept on the next layouts.
      rerender(<LiveCardBox {...props} anchor={{ x: 300, y: 400, w: 105, h: 150 }} />);
      relayout();
      relayout();
      expect(box.dataset.side).toBe('above');
      expect(box.style.maxHeight).toBe('380px');
    } finally {
      restore();
    }
  });

  // The review: the height held after a shrink is never more than the box's room. The window shrinks under a held box
  // below its card: 298 px of room, then 180; the box would run past its room (min-height wins over max-height).
  it('the height held after a shrink is cut to the room left when the window shrinks', () => {
    const restore = layout(250, 498);
    const win = window as unknown as { innerHeight: number | null };
    try {
      const card = { x: 400, y: 300, w: 230, h: 150 }; // 298 px below it
      const { container } = open({ anchor: card, images: IMG });
      const box = container.querySelector<HTMLElement>('.pop')!;
      fireEvent.pointerEnter(box);
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
      relayout();
      fireEvent.click(document.querySelector('.dv-big')!);
      relayout();
      expect(box.dataset.side).toBe('below');
      expect(box.getBoundingClientRect().height).toBe(298); // held
      win.innerHeight = 650; // 180 px below the card now
      relayout();
      relayout();
      expect(box.dataset.side).toBe('below');
      expect(box.getBoundingClientRect().height).toBeLessThanOrEqual(180);
      expect(parseFloat(box.style.top) + box.getBoundingClientRect().height).toBeLessThanOrEqual(650 - 8);
    } finally {
      win.innerHeight = null;
      restore();
    }
  });

  it('a shrink from the keyboard (Esc), the pointer elsewhere, lets the box shrink at once', () => {
    const restore = layout(200, 498);
    try {
      const { container } = open({ hover: true, anchor: { x: 300, y: 230, w: 105, h: 150 }, images: IMG });
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
      act(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      expect(document.querySelector('.dv.big')).toBeNull();
      expect(container.querySelector<HTMLElement>('.pop')!.style.minHeight).toBe('');
    } finally {
      restore();
    }
  });

  // Live check on a picture: a rest on the box after the card reads the card again and shows it again, its artwork
  // not loaded yet; the picture went back to its loading state for a moment, and the bigger one with it (the box
  // shrank and grew again, placed anew each time).
  it('the same card shown again keeps its picture, the bigger one too, while its artwork loads again', () => {
    const { rerender } = render(<LiveCardBox response={found(ASH)} anchor={ANCHOR} images={IMG} onClose={vi.fn()} hover />);
    fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
    expect(document.querySelector('.dv.big')).not.toBeNull();
    rerender(<LiveCardBox response={found(ASH)} anchor={{ ...ANCHOR }} images={{}} onClose={vi.fn()} hover />);
    expect(document.querySelector('.dv.big')).not.toBeNull();
    expect(document.querySelector('.dv-big img')?.getAttribute('src')).toBe(IMG[ASH.imageIds[0]]);
    // Another card is another picture: no stand-in from the last one.
    rerender(<LiveCardBox response={found(BELLE)} anchor={ANCHOR} images={{}} onClose={vi.fn()} hover />);
    expect(document.querySelector('.dv.big')).toBeNull();
    expect(document.querySelector(`img[src="${IMG[ASH.imageIds[0]]}"]`)).toBeNull();
  });
});
