// Artworks YGOPRODeck lacks, indexed from Konami's own card renders at build time (tools/fetch-alt-artworks.ts,
// tools/add-alt-artworks.ts; the user's decision of 2026-09-30). Only their vectors ship: no picture of them is
// bundled or fetched, and the extension never contacts their source.
//
// Such an index entry has a synthetic imageId that YGOPRODeck never uses: -(konamiId * 100 + artwork), e.g. -1561902
// for artwork 2 of Artemis, the Magistus Moon Maiden (Konami id 15619). It is negative, so it can't collide with a
// YGOPRODeck image id (all positive: passcodes, passcode + N alternates, and YGOPRODeck's own 9-digit ids such as
// 101304014), and it is at most -101, so it can't be the card back's -1 (CARD_BACK_ID) either.
//
// Wherever an imageId becomes an image URL or a record (the popover, its lists, the history, the side panel), a
// synthetic id stands for the card's own YGOPRODeck image, its first imageIds entry: displayImageId().
import type { Candidate, CardRecord } from './types';

/** Konami numbers a card's artworks from 1; the manifest's 101 and up are Rush Duel prints, which are never indexed. */
const ARTWORK_SLOTS = 100;

/** The synthetic imageId of Konami's artwork `artwork` of the card with Konami id `konamiId`. */
export function altArtworkId(konamiId: number, artwork: number): number {
  if (!Number.isSafeInteger(konamiId) || konamiId < 1) throw new Error(`Not a Konami card id: ${konamiId}`);
  if (!Number.isInteger(artwork) || artwork < 1 || artwork >= ARTWORK_SLOTS) {
    throw new Error(`Artwork number ${artwork} of Konami card ${konamiId} is outside 1-${ARTWORK_SLOTS - 1}`);
  }
  const id = -(konamiId * ARTWORK_SLOTS + artwork);
  if (!Number.isSafeInteger(id)) throw new Error(`Konami card id ${konamiId} is too large for a synthetic image id`);
  return id;
}

/** Whether `imageId` is a synthetic id (altArtworkId): an artwork from Konami's renders, with no YGOPRODeck image. */
export function isAltArtwork(imageId: number): boolean {
  return Number.isSafeInteger(imageId) && imageId <= -(ARTWORK_SLOTS + 1) && -imageId % ARTWORK_SLOTS !== 0;
}

/** The Konami card id and artwork number a synthetic id stands for, or null for any other id. */
export function parseAltArtwork(imageId: number): { konamiId: number; artwork: number } | null {
  if (!isAltArtwork(imageId)) return null;
  const n = -imageId;
  return { konamiId: Math.floor(n / ARTWORK_SLOTS), artwork: n % ARTWORK_SLOTS };
}

/**
 * The YGOPRODeck image to show or record for a match on `imageId`: the id itself, or for a synthetic id the card's
 * own first artwork. Without the card's record a synthetic id stays as it is: nothing can show it (image-cache.ts
 * answers null for it without a request).
 */
export function displayImageId(imageId: number, card: Pick<CardRecord, 'imageIds'> | undefined): number {
  if (!isAltArtwork(imageId)) return imageId;
  return card?.imageIds[0] ?? imageId;
}

/** `candidates` with each synthetic imageId replaced by its card's YGOPRODeck image (displayImageId). */
export function displayCandidates(candidates: Candidate[], cards: Record<number, Pick<CardRecord, 'imageIds'>>): Candidate[] {
  return candidates.map((c) => {
    const imageId = displayImageId(c.imageId, cards[c.cardId]);
    return imageId === c.imageId ? c : { ...c, imageId };
  });
}
