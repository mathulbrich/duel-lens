// Live's vote: each read of a tracked card is one vote; two confident reads of the same card promote it, and a
// card that has been read enough times without that is rejected.
import type { RecognizeResponse } from "../../shared/messages";
import { CARD_BACK_ID } from "../../shared/types";

export type VoteState = "voting" | "promoted" | "rejected";

export interface Read {
  cardId: number | null;
  imageId: number | null;
  confident: boolean;
}

export const VOTE = { agree: 2, readLimit: 4 } as const;

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
    confident:
      !result.error &&
      result.confident &&
      !result.faceDown &&
      top.cardId !== CARD_BACK_ID,
  };
}

/**
 * Promoted on `agree` confident reads of one card, unless a different card was also read confidently (the track
 * is then ambiguous and keeps voting); rejected once `readLimit` reads have not promoted it.
 */
export function settle(reads: Read[]): {
  state: VoteState;
  cardId?: number;
  imageId?: number;
} {
  const sure = reads.filter((r) => r.confident && r.cardId !== null);
  const ids = new Set(sure.map((r) => r.cardId));
  if (ids.size === 1 && sure.length >= VOTE.agree) {
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
