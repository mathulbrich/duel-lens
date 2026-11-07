// A card box opened from an outline says the name of the track it was opened on. If that track is read again (its
// zones moved after the last read) or promoted to another card, the name may no longer be true: the box goes.
import type { LiveView } from './controller';

/** True when track `trackId` is outlined as still voting, or as a card other than `cardId`; false when it is not outlined at all. */
export function trackNoLongerShows(cards: LiveView['cards'], trackId: number | undefined, cardId: number): boolean {
  if (trackId === undefined) return false;
  const c = cards.find((x) => x.trackId === trackId);
  return !!c && c.cardId !== cardId; // read again as another card, or not sure any more
}
