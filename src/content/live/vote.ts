// Live's vote: each read of a tracked card is one vote; two confident reads of the same card promote it (one, when it
// is very clear), and a card that has been read enough times without that is rejected.
import type { RecognizeResponse } from "../../shared/messages";
import { LIVE_CUT_VOTE } from "../../shared/live";
import { CARD_BACK_ID } from "../../shared/types";

export type VoteState = "voting" | "promoted" | "rejected";

export interface Read {
  cardId: number | null;
  imageId: number | null;
  confident: boolean;
  /** The top candidate's match score (absent when nothing matched). */
  score?: number;
  /** Read while its part of the picture moved (a hand passing over it): an empty one says nothing about the card. */
  moving?: true;
}

/**
 * `clear`: a confident read at or above this score promotes on its own. Calibrated 2026-11-06 on the suggest-floor
 * sets (data/debug/suggest-floor/cal-*.json, 2,592 confident reads): at 0.86, 628 of the 1,061 right confident reads
 * of real footage clear it; the only wrong ones that do are 3 non-card overlay boxes and 1 card read the same wrong
 * way every time, which two agreeing reads let through as well.
 */
/**
 * `cut`: a card running off the picture's edge (a hand at the bottom of the video) is read by the engine's rescue
 * path, whose answers are not confident on their own (a covered hand card read sure from its visible part is). Live reads a card again and again, so such an answer at or
 * above `score` and ahead of the next card by `lead` counts as a confident vote: two agreeing reads list it. One at or
 * above `alone` lists it by itself, as a `clear` read does (2026-11-07, a hand waited for a second read of every card).
 * On the suggest-floor sets (1,142 cut answers): at `score` 109 right, 0 wrong; at `alone` 65 right, 0 wrong (no
 * non-card).
 */
export const VOTE = { agree: 2, clear: 0.86, readLimit: 4, cut: LIVE_CUT_VOTE } as const;

const NONE: Read = { cardId: null, imageId: null, confident: false };

/** One recognize answer as a vote: confident only for a sure, face-up card that is not the card back, from an answer that did not fail. */
export function readOf(response: RecognizeResponse | { error: string }): Read {
  if (!("result" in response)) return { ...NONE };
  const { result } = response;
  const top = result.candidates[0];
  if (!top) return { ...NONE };
  const usable = !result.error && !result.faceDown && top.cardId !== CARD_BACK_ID;
  if (usable && !result.confident && result.truncated && top.score >= VOTE.cut.score && top.score - (result.candidates[1]?.score ?? 0) >= VOTE.cut.lead) {
    // A cut card's sure vote; from VOTE.cut.alone it carries its score, so it lists the card alone (VOTE.clear).
    return { cardId: top.cardId, imageId: top.imageId, confident: true, ...(top.score >= VOTE.cut.alone ? { score: top.score } : {}) };
  }
  return {
    cardId: top.cardId,
    imageId: top.imageId,
    score: top.score,
    confident: usable && result.confident,
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
  // An empty read is not a try at the card when its spot moved (a hand over it), nor once the card was read sure (then
  // something covers it: the Live E2E's Dark Magician, read sure, then empty 5 times under the passing hand).
  const readSure = sure.length > 0;
  if (reads.filter((r) => !(r.cardId === null && (r.moving || readSure))).length >= VOTE.readLimit) return { state: "rejected" };
  if (reads.length >= VOTE.readLimit * 3) return { state: "rejected" }; // a spot that never stops moving: enough
  // The last two reads gave the same unsure answer to the same score: the picture there did not change, and a third
  // read would answer the same. Read again only once its zones move (controller.ts readAgainWhereMoved).
  const [a, b] = reads.slice(-2);
  if (a && b && !a.confident && !b.confident && a.cardId === b.cardId && a.score !== undefined && b.score !== undefined && Math.abs(a.score - b.score) < 0.001) return { state: "rejected" };
  return { state: "voting" };
}
