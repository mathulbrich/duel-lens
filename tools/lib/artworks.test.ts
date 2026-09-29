import { describe, expect, it } from 'vitest';
import type { CardRecord } from '../../src/shared/types';
import { artBoxFor, artBoxPixels, artworkUrl, cardImageUrl, listArtworks } from './artworks';
import { ART_BOX, ART_BOX_PENDULUM } from '../../src/shared/card-layout';

const card = (id: number, frameType: string, imageIds: number[]): CardRecord => ({
  id, name: `Card ${id}`, type: 'Effect Monster', frameType, desc: '', imageIds,
});

describe('listArtworks', () => {
  it('returns one entry per artwork, with the cropped-artwork URL', () => {
    const list = listArtworks([card(14558127, 'effect', [14558127, 14558128]), card(55144522, 'spell', [55144522])]);
    expect(list).toEqual([
      { imageId: 14558127, cardId: 14558127, url: 'https://images.ygoprodeck.com/images/cards_cropped/14558127.jpg' },
      { imageId: 14558128, cardId: 14558127, url: 'https://images.ygoprodeck.com/images/cards_cropped/14558128.jpg' },
      { imageId: 55144522, cardId: 55144522, url: 'https://images.ygoprodeck.com/images/cards_cropped/55144522.jpg' },
    ]);
  });

  it('skips Skill cards, which have no real artwork', () => {
    const list = listArtworks([card(300102004, 'skill', [300102004]), card(1, 'token', [1])]);
    expect(list.map((a) => a.imageId)).toEqual([1]);
  });

  it("skips the '???' deck-profile placeholder, whose art is the card back with a question mark", () => {
    const list = listArtworks([card(149694341, 'spell', [149694341, 149694343]), card(2, 'spell', [2])]);
    expect(list.map((a) => a.cardId)).toEqual([2]);
  });

  it('de-duplicates repeated image ids, keeping the first card', () => {
    const list = listArtworks([card(1, 'effect', [10, 10, 11]), card(2, 'effect', [11, 12])]);
    expect(list.map((a) => [a.imageId, a.cardId])).toEqual([
      [10, 1],
      [11, 1],
      [12, 2],
    ]);
  });

  it('builds the URL from the image id', () => {
    expect(artworkUrl(89631139)).toBe('https://images.ygoprodeck.com/images/cards_cropped/89631139.jpg');
  });
});

describe('art box fallback (for artworks YGOPRODeck has no crop of)', () => {
  it('builds the full card image URL', () => {
    expect(cardImageUrl(662853)).toBe('https://images.ygoprodeck.com/images/cards/662853.jpg');
  });

  it('uses the Pendulum art box for Pendulum frames only', () => {
    expect(artBoxFor('effect_pendulum')).toBe(ART_BOX_PENDULUM);
    expect(artBoxFor('xyz_pendulum')).toBe(ART_BOX_PENDULUM);
    expect(artBoxFor('effect')).toBe(ART_BOX);
    expect(artBoxFor('spell')).toBe(ART_BOX);
  });

  it('converts a box to whole pixels inside the image', () => {
    expect(artBoxPixels(1000, 2000, { x: 0.1, y: 0.2, w: 0.5, h: 0.25 })).toEqual({ left: 100, top: 400, width: 500, height: 500 });
    // Never outside the image, even if the box pokes out.
    expect(artBoxPixels(100, 100, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 })).toEqual({ left: 90, top: 90, width: 10, height: 10 });
  });
});
