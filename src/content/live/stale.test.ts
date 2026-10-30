import { describe, expect, it } from 'vitest';
import type { LiveView } from './controller';
import { trackNoLongerShows } from './stale';

const box = { x: 0, y: 0, w: 0.1, h: 0.1 };
const promoted = (trackId: number, cardId: number): LiveView['cards'][number] => ({ trackId, state: 'promoted', cardId, imageId: 1, box });

describe('trackNoLongerShows', () => {
  it('is false while the track still shows the card', () => expect(trackNoLongerShows([promoted(1, 7)], 1, 7)).toBe(false));
  it('is true once the track votes again', () => expect(trackNoLongerShows([{ trackId: 1, state: 'voting', box }], 1, 7)).toBe(true));
  it('is true once the track shows another card', () => expect(trackNoLongerShows([promoted(1, 8)], 1, 7)).toBe(true));
  it('is false when the track is not outlined (missed once, a cut) or the box has no track', () => {
    expect(trackNoLongerShows([], 1, 7)).toBe(false);
    expect(trackNoLongerShows([{ trackId: 1, state: 'voting', box }], undefined, 7)).toBe(false);
  });
});
