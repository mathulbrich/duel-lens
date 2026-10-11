// "Read the whole board" (B, or the scan bar's "Read all cards"): every outlined card is read the way
// a hover preview reads it (a peek: `recognize` with `record: false`, so no history entry, no correction,
// never the AI), one at a time, and the cards read go to the side panel by player (`show-board`).
// - Which player: the card's centre against the middle of the frame it is on, the video's picture when
//   one holds it (else the whole frozen frame): below the middle is the player nearer the camera
//   ('near'), above it the one farther away ('far').
// - What each card says: the read's top card and how sure it is: 'sure' (confident), 'low' (a low
//   match) or 'not-sure'. A read that named no card (nothing found, a face-down card, an error) is left out.
// - Where it goes: the background keeps the last board in chrome.storage.session (BOARD_KEY, cleared
//   when Chrome closes), and the side panel shows it (src/sidepanel/app.tsx). The key press itself sends an
//   empty board marked `reading`: the panel opens while the user's gesture lasts (sidePanel.open() needs
//   one) and says "Reading the board…"; the final board follows however the run ends.
// Pure helpers, shared by the content script, the background (router.ts validates what it gets) and
// the side panel: nothing here touches the DOM or chrome.*.
import { t } from '../shared/i18n';
import type { BoardCard, RecognizeResponse } from '../shared/messages';
import { CARD_BACK_ID } from '../shared/types';
import type { Rect } from './geometry';

/** chrome.storage.session key of the last board (StoredBoard). */
export const BOARD_KEY = 'board';
/** The most cards one board holds: far more than a field (and both hands) ever shows. The content script reads no more. */
export const MAX_BOARD = 60;

/** The last board, as the background keeps it for the side panel. */
export interface StoredBoard {
  cards: BoardCard[];
  /** Epoch ms when it came. */
  at: number;
  /** Its cards are still being read (the key press's message): the final board follows. */
  reading?: true;
}

/** show-board's answer when the side panel couldn't open (no user gesture): the board is kept for it all the same. */
export const BOARD_PANEL_CLOSED = t('bg_board_panel_closed');

const SIDES = new Set<unknown>(['near', 'far']);
const STATES = new Set<unknown>(['sure', 'not-sure', 'low']);

/**
 * The frame a card at (cx, cy) is on: the biggest video picture holding its centre, else the whole
 * frozen frame (`viewport`). CSS px.
 */
export function boardFrame(cx: number, cy: number, viewport: { w: number; h: number }, videos: Rect[] = []): Rect {
  let best: Rect | null = null;
  for (const v of videos) {
    if (!(v.w > 0 && v.h > 0) || cx < v.x || cx > v.x + v.w || cy < v.y || cy > v.y + v.h) continue;
    if (!best || v.w * v.h > best.w * best.h) best = v;
  }
  return best ?? { x: 0, y: 0, w: viewport.w, h: viewport.h };
}

/** Which player a card whose centre is at height `cy` belongs to, on `frame`: below its middle is 'near'. */
export function boardSide(cy: number, frame: Rect): BoardCard['side'] {
  return cy > frame.y + frame.h / 2 ? 'near' : 'far';
}

/** How sure a read is, in the board's words. */
export function boardState(result: RecognizeResponse['result']): BoardCard['state'] {
  if (result.confident) return 'sure';
  return result.suggested ? 'low' : 'not-sure';
}

/**
 * The board's entry for a card's read: its top card (the first candidate with card data, not the card
 * back), with the image the popover shows for it. Null when the read named no card.
 */
export function boardCardOf(response: RecognizeResponse, side: BoardCard['side']): BoardCard | null {
  const { result, cards } = response;
  if (result.error || result.faceDown) return null;
  const top = result.candidates.find((c) => c.cardId !== CARD_BACK_ID && cards[c.cardId]);
  return top ? { cardId: top.cardId, imageId: top.imageId, side, state: boardState(result) } : null;
}

const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

/**
 * A board as a content script sent it, checked (the background takes nothing on trust): a list of at
 * most MAX_BOARD cards, each with whole-number ids, a side and a state, and nothing else. Null when
 * anything is off.
 */
export function validBoard(board: unknown): BoardCard[] | null {
  if (!Array.isArray(board) || board.length > MAX_BOARD) return null;
  const out: BoardCard[] = [];
  for (const c of board as unknown[]) {
    const b = c as Partial<BoardCard> | null;
    if (!b || typeof b !== 'object' || !isId(b.cardId) || !isId(b.imageId) || !SIDES.has(b.side) || !STATES.has(b.state)) return null;
    out.push({ cardId: b.cardId, imageId: b.imageId, side: b.side!, state: b.state! });
  }
  return out;
}

/** The stored board, if chrome.storage.session holds a well-formed one. */
export function storedBoard(value: unknown): StoredBoard | null {
  const v = value as Partial<StoredBoard> | null;
  if (!v || typeof v !== 'object' || typeof v.at !== 'number') return null;
  const cards = validBoard(v.cards);
  return cards ? { cards, at: v.at, ...(v.reading === true ? { reading: true as const } : {}) } : null;
}

/** "4 near, 3 far": how many cards each player has on a board. */
export function boardSummary(cards: BoardCard[]): string {
  const near = cards.filter((c) => c.side === 'near').length;
  return t('board_summary', near, cards.length - near);
}
