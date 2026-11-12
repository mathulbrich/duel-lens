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
