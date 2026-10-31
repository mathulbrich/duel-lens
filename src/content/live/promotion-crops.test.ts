import { describe, expect, it } from 'vitest';
import { PROMOTION_CROPS_KEEP, recordPromotion, type PromotionCrop } from './promotion-crops';

const p = (n: number): PromotionCrop => ({ cardId: n, trackId: n, videoTime: n, dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 });

describe('recordPromotion', () => {
  it('keeps nothing when the flag is off (a store build)', () => {
    const list: PromotionCrop[] = [];
    recordPromotion(list, p(1), false);
    expect(list).toEqual([]);
  });
  it('keeps the newest 200 when on', () => {
    const list: PromotionCrop[] = [];
    for (let i = 0; i < PROMOTION_CROPS_KEEP + 5; i++) recordPromotion(list, p(i), true);
    expect(list).toHaveLength(PROMOTION_CROPS_KEEP);
    expect(list[0].cardId).toBe(5);
  });
});
