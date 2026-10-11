import { describe, expect, it } from 'vitest';
import type { RecognizeResponse } from '../shared/messages';
import { CARD_BACK_ID } from '../shared/types';
import { boardCardOf, boardFrame, boardSide, boardState, boardSummary, MAX_BOARD, storedBoard, validBoard } from './board';
import { ASH, BELLE, response } from './test-fixtures';

describe('which player a card belongs to', () => {
  const viewport = { w: 1500, h: 1000 };

  it('goes by the whole frozen frame when no video holds the card: below its middle is near, above it far', () => {
    const frame = boardFrame(300, 700, viewport, []);
    expect(frame).toEqual({ x: 0, y: 0, w: 1500, h: 1000 });
    expect(boardSide(700, frame)).toBe('near');
    expect(boardSide(300, frame)).toBe('far');
    expect(boardSide(500, frame)).toBe('far'); // the middle itself is not below it
  });

  it("goes by the video's own picture when one holds the card (a player above a page's text, say)", () => {
    const video = { x: 100, y: 60, w: 960, h: 540 }; // middle at y = 330
    const frame = boardFrame(500, 400, viewport, [video]);
    expect(frame).toBe(video);
    expect(boardSide(400, frame)).toBe('near'); // above the viewport's middle, below the video's
    expect(boardSide(200, frame)).toBe('far');
  });

  it('takes the biggest video holding the card, and ignores videos that hold it not or have no size', () => {
    const small = { x: 400, y: 300, w: 200, h: 150 };
    const big = { x: 0, y: 0, w: 1280, h: 720 };
    const empty = { x: 0, y: 0, w: 0, h: 0 };
    expect(boardFrame(500, 350, viewport, [small, empty, big])).toBe(big);
    expect(boardFrame(1400, 900, viewport, [small, big])).toEqual({ x: 0, y: 0, w: 1500, h: 1000 });
  });
});

describe("a card's place on the board", () => {
  const read = (extra: Partial<RecognizeResponse['result']> = {}, scores = [0.9, 0.8]) => {
    const r = response([ASH, BELLE], scores);
    return { ...r, result: { ...r.result, ...extra } };
  };

  it('says how sure the read was: sure when confident, a low match, else not sure', () => {
    expect(boardState(read({ confident: true }).result)).toBe('sure');
    expect(boardState(read({ confident: false, suggested: true }).result)).toBe('low');
    expect(boardState(read({ confident: false }).result)).toBe('not-sure');
  });

  it("is the read's top card with its image, its side and its state", () => {
    expect(boardCardOf(read({ confident: true }), 'near')).toEqual({ cardId: ASH.id, imageId: ASH.imageIds[0], side: 'near', state: 'sure' });
  });

  it('skips the card back and candidates without card data', () => {
    const r = read({ confident: false });
    const back = { cardId: CARD_BACK_ID, imageId: CARD_BACK_ID, score: 0.95 };
    const unknown = { cardId: 999, imageId: 999, score: 0.94 };
    const shown = { ...r, result: { ...r.result, candidates: [back, unknown, ...r.result.candidates] } };
    expect(boardCardOf(shown, 'far')).toEqual({ cardId: ASH.id, imageId: ASH.imageIds[0], side: 'far', state: 'not-sure' });
  });

  it('is nothing for a read that named no card: no match, a face-down card, an error', () => {
    const none = read();
    expect(boardCardOf({ ...none, result: { ...none.result, candidates: [] } }, 'near')).toBeNull();
    expect(boardCardOf(read({ faceDown: true }), 'near')).toBeNull();
    expect(boardCardOf(read({ error: 'model failed' }), 'near')).toBeNull();
  });

  it('counts each player\'s cards', () => {
    const c = { cardId: 1, imageId: 1, state: 'sure' } as const;
    expect(boardSummary([{ ...c, side: 'near' }, { ...c, side: 'far' }, { ...c, side: 'near' }])).toBe('2 near, 1 far');
    expect(boardSummary([])).toBe('0 near, 0 far');
  });
});

describe('a board from a content script, checked', () => {
  const ok = { cardId: 14558127, imageId: 14558127, side: 'near', state: 'low' };

  it('keeps a well-formed board, with only the fields a board card has', () => {
    expect(validBoard([ok, { ...ok, side: 'far', state: 'sure', name: 'x' }])).toEqual([ok, { ...ok, side: 'far', state: 'sure' }]);
    expect(validBoard([])).toEqual([]);
    expect(validBoard(Array.from({ length: MAX_BOARD }, () => ok))).toHaveLength(MAX_BOARD);
  });

  it.each([
    ['not a list', { 0: ok }],
    ['too long', Array.from({ length: MAX_BOARD + 1 }, () => ok)],
    ['a NaN id', [{ ...ok, cardId: NaN }]],
    ['an unsafe id', [{ ...ok, imageId: 2 ** 60 }]],
    ['a missing side', [{ ...ok, side: undefined }]],
    ['an unknown state', [{ ...ok, state: 'maybe' }]],
    ['a string', ['14558127']],
  ])('refuses one that is %s', (_, board) => {
    expect(validBoard(board)).toBeNull();
  });

  it('reads back only a well-formed stored board', () => {
    expect(storedBoard({ cards: [ok], at: 5 })).toEqual({ cards: [ok], at: 5 });
    expect(storedBoard({ cards: [], at: 5, reading: true })).toEqual({ cards: [], at: 5, reading: true });
    expect(storedBoard({ cards: [], at: 5, reading: 'yes' })).toEqual({ cards: [], at: 5 });
    expect(storedBoard({ cards: [ok] })).toBeNull();
    expect(storedBoard({ cards: 'x', at: 5 })).toBeNull();
    expect(storedBoard(undefined)).toBeNull();
  });
});
