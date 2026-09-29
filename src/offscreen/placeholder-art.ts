// YGOPRODeck serves the card back as a card's artwork until the real art is uploaded (on
// 2026-09-28, cards_cropped did so for Alditia Hell Blaze the Burning Cubic Lord 100460002,
// Divine Anima Infinity the Creation Cubic Overlord 100460004 and Fireworks Celebration
// 101206080: three byte-identical files). Indexed under a real card id, such a vector makes a
// face-down card read as that card, and the artwork would never be fetched again, since the
// download succeeded. So neither the self-updating index (index-updater.ts) nor
// tools/build-index.ts indexes an artwork whose embedding is this close to the card back's.
//
// The threshold, measured on the six bundled indexes (every model): the three placeholders sit
// at cosine 0.981-0.995 to the index's card-back entry, while the most card-back-like real
// artwork sits at 0.654 (dinov3-small-q4, Mystical Space Typhoon), 0.743 (dinov3-small), 0.708
// (dinov2-small), 0.765 (mobileclip-s0) and 0.749 (dinov2-small-duel). 0.9 leaves at least 0.08
// on either side. placeholder-art.int.test.ts re-checks it with the real default model.
import type { LoadedIndex } from '../shared/index-format';
import { l2normalize } from '../shared/preprocess';
import { CARD_BACK_ID } from '../shared/types';

/** Cosine to the card back at or above which an artwork is YGOPRODeck's placeholder. */
export const PLACEHOLDER_ART_COSINE = 0.9;

/** The index's card-back (face-down) entry as a unit vector; null when it was built without one. */
export function cardBackVector(index: LoadedIndex): Float32Array | null {
  const i = index.meta.entries.findIndex((e) => e.cardId === CARD_BACK_ID);
  if (i < 0) return null;
  const dim = index.meta.dim;
  return l2normalize(Float32Array.from(index.vectors.subarray(i * dim, (i + 1) * dim)));
}

/** Whether an artwork's (L2-normalised) embedding is the card back: YGOPRODeck's placeholder. */
export function isPlaceholderArt(vector: Float32Array, cardBack: Float32Array): boolean {
  let cos = 0;
  for (let i = 0; i < vector.length; i++) cos += vector[i] * cardBack[i];
  return cos >= PLACEHOLDER_ART_COSINE;
}

/**
 * tools/build-index.ts: leaves out the artworks that are the card back, comparing each to the
 * card-back entry among them (kept itself). Without a card-back entry nothing can be checked,
 * and everything is kept.
 */
export function dropPlaceholders<E extends { cardId: number }>(
  entries: E[],
  vectors: Float32Array[],
): { entries: E[]; vectors: Float32Array[]; dropped: E[] } {
  const backAt = entries.findIndex((e) => e.cardId === CARD_BACK_ID);
  if (backAt < 0) return { entries, vectors, dropped: [] };
  const back = vectors[backAt];
  const kept: { entries: E[]; vectors: Float32Array[] } = { entries: [], vectors: [] };
  const dropped: E[] = [];
  entries.forEach((e, i) => {
    if (i !== backAt && isPlaceholderArt(vectors[i], back)) {
      dropped.push(e);
      return;
    }
    kept.entries.push(e);
    kept.vectors.push(vectors[i]);
  });
  return { ...kept, dropped };
}
