// Brute-force nearest-neighbour search over the artwork index, grouped by card.
import { CARD_BACK_ID, type Candidate } from './types';
import type { LoadedIndex } from './index-format';
import type { EmbeddingModelSpec } from './models';

/**
 * Best candidates for an L2-normalised query vector: one per card (its best-matching
 * artwork), sorted by score, at most k.
 */
export function topKByCard(query: Float32Array, index: LoadedIndex, k: number): Candidate[] {
  const { dim, count, entries } = index.meta;
  if (query.length !== dim) throw new Error(`Query has ${query.length} dims, index has ${dim}`);
  const v = index.vectors;
  const scale = v instanceof Int8Array ? 1 / 127 : 1;
  const best = new Map<number, Candidate>();
  for (let i = 0; i < count; i++) {
    let dot = 0;
    const off = i * dim;
    for (let d = 0; d < dim; d++) dot += query[d] * v[off + d];
    const score = dot * scale;
    const { cardId, imageId } = entries[i];
    const prev = best.get(cardId);
    if (!prev || score > prev.score) best.set(cardId, { cardId, imageId, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Merge candidate lists from several crop hypotheses: max score per card. */
export function mergeCandidates(lists: Candidate[][], k: number): Candidate[] {
  const best = new Map<number, Candidate>();
  for (const list of lists) {
    for (const c of list) {
      const prev = best.get(c.cardId);
      if (!prev || c.score > prev.score) best.set(c.cardId, c);
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/**
 * confident: top score clears `score` and beats the next card by `margin`.
 * nothing: no candidate, or the top score is below `floor`.
 */
export function decide(
  candidates: Candidate[],
  t: EmbeddingModelSpec['thresholds'],
): { confident: boolean; nothing: boolean } {
  const s1 = candidates[0]?.score ?? -Infinity;
  if (!(s1 >= t.floor)) return { confident: false, nothing: true };
  const lead = s1 - (candidates[1]?.score ?? 0);
  let confident = (s1 >= t.score && lead >= t.margin) || (t.second !== undefined && s1 >= t.second.score && lead >= t.second.margin);
  // The card back looks like no card, so a real one wins by a wide margin; a narrow win is
  // something dark and patterned (an empty mat zone), not a face-down card.
  if (confident && candidates[0].cardId === CARD_BACK_ID && t.cardBackMargin !== undefined && lead < t.cardBackMargin) confident = false;
  return { confident, nothing: false };
}
