// Which artwork crops to download and index: one per YGOPRODeck image id.
import { ART_BOX, ART_BOX_PENDULUM, type CardBox } from '../../src/shared/card-layout';
import type { CardRecord } from '../../src/shared/types';

export interface ArtworkRef {
  imageId: number;
  cardId: number;
  url: string;
}

/** YGOPRODeck's cropped artwork (about 624×624) for an image id. */
export const artworkUrl = (imageId: number) => `https://images.ygoprodeck.com/images/cards_cropped/${imageId}.jpg`;

/**
 * Entries that are not real cards: "???" (149694341) stands in for unrevealed cards in
 * tournament deck profiles, and its artworks are the card back with a question mark, which
 * would compete with the card-back (face-down) entry.
 */
const NOT_CARDS = new Set([149694341]);

/** Whether a card's artworks belong in the index: not a Skill card (its "art" is a portrait), not a placeholder. */
export const isIndexableCard = (card: Pick<CardRecord, 'id' | 'frameType'>) => card.frameType !== 'skill' && !NOT_CARDS.has(card.id);

/**
 * Every artwork of every card, in card order. Skill cards are skipped (their "art" is a
 * character portrait, not a card artwork), as are placeholders (NOT_CARDS); a repeated image
 * id keeps its first card.
 */
export function listArtworks(cards: CardRecord[]): ArtworkRef[] {
  const seen = new Set<number>();
  const out: ArtworkRef[] = [];
  for (const card of cards) {
    if (!isIndexableCard(card)) continue;
    for (const imageId of card.imageIds) {
      if (seen.has(imageId)) continue;
      seen.add(imageId);
      out.push({ imageId, cardId: card.id, url: artworkUrl(imageId) });
    }
  }
  return out;
}

// ---------- fallback when YGOPRODeck has no cropped artwork ----------

/** YGOPRODeck's full card image (813×1185) for an image id. */
export const cardImageUrl = (imageId: number) => `https://images.ygoprodeck.com/images/cards/${imageId}.jpg`;

/** The part of a full card image that matches its cards_cropped artwork. */
export const artBoxFor = (frameType: string): CardBox => (frameType.endsWith('_pendulum') ? ART_BOX_PENDULUM : ART_BOX);

/** A card-relative box in whole pixels of a width×height image, clipped to the image. */
export function artBoxPixels(width: number, height: number, box: CardBox) {
  const left = Math.min(width - 1, Math.max(0, Math.round(box.x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.round(box.y * height)));
  return {
    left,
    top,
    width: Math.max(1, Math.min(width - left, Math.round(box.w * width))),
    height: Math.max(1, Math.min(height - top, Math.round(box.h * height))),
  };
}
