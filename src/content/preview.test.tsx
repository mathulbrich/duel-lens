// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { CardRecord } from '../shared/types';
import { Preview, placePreview, previewText, previewWords } from './preview';
import { ASH, TALKER, VEILER, DROLL, response } from './test-fixtures';

describe('previewText: what the hover preview says, per confidence', () => {
  it('names a sure card, with its type line and facts to follow', () => {
    expect(previewText(response([ASH], [0.95]))).toEqual({ kind: 'sure', head: ASH.name, card: ASH });
  });

  it('says "Not sure: <name>" for an unsure answer', () => {
    expect(previewText(response([VEILER, DROLL], [0.74, 0.69], { confident: false }))).toEqual({ kind: 'unsure', head: `Not sure: ${VEILER.name}`, card: VEILER });
  });

  it('says "Low match: click for options" for a low match, with no card named', () => {
    expect(previewText(response([VEILER, DROLL], [0.6, 0.58], { confident: false, suggested: true }))).toEqual({ kind: 'low', head: 'Low match: click for options' });
  });

  it('says "No match: click to try" when nothing matched, and "Face-down card" for a card back', () => {
    expect(previewText(response([], [], { confident: false }))).toEqual({ kind: 'none', head: 'No match: click to try' });
    expect(previewText(response([], [], { faceDown: true })).head).toBe('Face-down card');
  });

  it('says it in words for screen readers, after the card’s place', () => {
    expect(previewWords(previewText(response([TALKER], [0.9])), 'Card 2 of 5')).toBe(
      `Card 2 of 5: ${TALKER.name}. DARK, LINK-4, Cyberse / Link / Effect, Link arrows: Top, Left, Right, Bottom, ATK 2300.`,
    );
  });
});

describe('placePreview: beside the card, covering its neighbours as little as possible', () => {
  const VIEW = { w: 1000, h: 800 };
  const SIZE = { w: 200, h: 90 };
  const card = { x: 400, y: 300, w: 100, h: 140 };

  it('goes right of the card, centred on it, when nothing is in the way', () => {
    expect(placePreview(card, SIZE, VIEW)).toEqual({ x: 508, y: 325, side: 'right' });
  });

  it('goes where it covers no other card: a row of cards sends it below', () => {
    const row = [
      { x: 280, y: 300, w: 100, h: 140 },
      { x: 520, y: 300, w: 100, h: 140 },
    ];
    expect(placePreview(card, SIZE, VIEW, row)).toEqual({ x: 350, y: 448, side: 'below' });
  });

  it('never covers the card itself, even at the edge of the viewport', () => {
    const edge = { x: 880, y: 680, w: 100, h: 110 };
    const p = placePreview(edge, SIZE, VIEW);
    const overlaps = p.x < edge.x + edge.w && edge.x < p.x + SIZE.w && p.y < edge.y + edge.h && edge.y < p.y + SIZE.h;
    expect(overlaps).toBe(false);
    expect(p.side).toBe('left');
  });
});

describe('the hover preview of a translated card (card text language)', () => {
  const ashFr: CardRecord = { ...ASH, name: 'Cendres Fleuries et Joyeux Printemps', translated: { lang: 'fr', nameEn: ASH.name } };

  it('shows the English name under the translated one, and reads it out', () => {
    const p = previewText(response([ashFr], [0.9]));
    expect(p.head).toBe('Cendres Fleuries et Joyeux Printemps');
    const { container } = render(
      <Preview anchor={{ x: 0, y: 0, w: 10, h: 10 }} text={p} avoid={() => []} onEnter={vi.fn()} onLeave={vi.fn()} onPick={vi.fn()} />,
    );
    expect(container.querySelector('.pv-en')?.textContent).toBe(`English name: ${ASH.name}`);
    expect(previewWords(p).startsWith(`Cendres Fleuries et Joyeux Printemps. English name: ${ASH.name}. FIRE`)).toBe(true);
    cleanup();
  });

  it('shows none for an English card', () => {
    const p = previewText(response([ASH], [0.9]));
    const { container } = render(<Preview anchor={{ x: 0, y: 0, w: 10, h: 10 }} text={p} avoid={() => []} onEnter={vi.fn()} onLeave={vi.fn()} onPick={vi.fn()} />);
    expect(container.querySelector('.pv-en')).toBeNull();
    expect(previewWords(p)).not.toMatch(/English name/);
    cleanup();
  });
});
