// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
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
  it('offers Copy and the links, not Keep, Wrong card? or Report issue', () => {
    open();
    expect(screen.getByText(ASH.name)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy text' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /YGOPRODeck/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Keep/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Wrong card/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Report/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ask AI|Turn on AI/ })).toBeNull();
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
