// E2E builds only (the flag, build-flags.d.ts): the crop of the read that promoted each track, as the loop sent it to
// `recognize`, so test/e2e/live-real.ts can show what Live saw beside the card it named. A store build keeps nothing.
export interface PromotionCrop {
  cardId: number;
  trackId: number;
  videoTime: number;
  /** PNG data URL of the crop the loop sent to recognize. */
  dataUrl: string;
  width: number;
  height: number;
}

export const PROMOTION_CROPS_KEEP = 200;

/** Adds one promotion to `list` (newest last, at most 200) when `enabled`; a no-op otherwise. */
export function recordPromotion(list: PromotionCrop[], p: PromotionCrop, enabled: boolean = __DUEL_LENS_E2E__): void {
  if (!enabled) return;
  list.push(p);
  if (list.length > PROMOTION_CROPS_KEEP) list.shift();
}
