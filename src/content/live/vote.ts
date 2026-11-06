// Live's vote: each read of a tracked card is one vote; two confident reads of the same card promote it (one, when it
// is very clear), and a card that has been read enough times without that is rejected.
import type { RecognizeResponse } from "../../shared/messages";
import { CARD_BACK_ID } from "../../shared/types";

export type VoteState = "voting" | "promoted" | "rejected";

export interface Read {
  cardId: number | null;
  imageId: number | null;
  confident: boolean;
  /** The top candidate's match score (absent when nothing matched). */
  score?: number;
}

/**
 * `clear`: a confident read at or above this score promotes on its own. Calibrated 2026-11-06 on the suggest-floor
 * sets (data/debug/suggest-floor/cal-*.json, 2,592 confident reads): at 0.86, 628 of the 1,061 right confident reads
 * of real footage clear it; the only wrong ones that do are 3 non-card overlay boxes and 1 card read the same wrong
 * way every time, which two agreeing reads let through as well.
 */
export const VOTE = { agree: 2, clear: 0.86, readLimit: 4 } as const;

const NONE: Read = { cardId: null, imageId: null, confident: false };

/** One recognize answer as a vote: confident only for a sure, face-up card that is not the card back, from an answer that did not fail. */
export function readOf(response: RecognizeResponse | { error: string }): Read {
  if (!("result" in response)) return { ...NONE };
  const { result } = response;
  const top = result.candidates[0];
  if (!top) return { ...NONE };
  return {
    cardId: top.cardId,
    imageId: top.imageId,
    score: top.score,
    confident:
      !result.error &&
      result.confident &&
      !result.faceDown &&
      top.cardId !== CARD_BACK_ID,
  };
}

/**
 * Promoted on `agree` confident reads of one card, or on one that scores `clear` or more, unless a different card was also read confidently (the track
 * is then ambiguous and keeps voting); rejected once `readLimit` reads have not promoted it.
 */
export function settle(reads: Read[]): {
  state: VoteState;
  cardId?: number;
  imageId?: number;
} {
  const sure = reads.filter((r) => r.confident && r.cardId !== null);
  const ids = new Set(sure.map((r) => r.cardId));
  if (ids.size === 1 && (sure.length >= VOTE.agree || sure.some((r) => (r.score ?? 0) >= VOTE.clear))) {
    const last = sure[sure.length - 1];
    return {
      state: "promoted",
      cardId: last.cardId as number,
      imageId: last.imageId as number,
    };
  }
  if (reads.length >= VOTE.readLimit) return { state: "rejected" };
  return { state: "voting" };
}
