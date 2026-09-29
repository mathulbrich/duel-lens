import { describe, expect, it } from 'vitest';
import { decodeIndex, encodeIndexBinary, quantizeInt8, type IndexEntry, type LoadedIndex } from '../shared/index-format';
import { CARD_BACK_ID } from '../shared/types';
import { cardBackVector, dropPlaceholders, isPlaceholderArt, PLACEHOLDER_ART_COSINE } from './placeholder-art';

/** A unit vector in 3-d at cosine `c` to [1, 0, 0]. */
const at = (c: number) => Float32Array.of(c, Math.sqrt(1 - c * c), 0);

function index(entries: IndexEntry[], vectors: Float32Array[]): LoadedIndex {
  const flat = new Int8Array(vectors.length * 3);
  vectors.forEach((v, i) => flat.set(quantizeInt8(v), i * 3));
  const meta = { modelId: 'm', dim: 3, count: entries.length, quant: 'int8' as const, builtAt: '2026-09-28T00:00:00Z', entries };
  return decodeIndex(encodeIndexBinary(3, entries.length, 'int8', flat).slice().buffer, meta);
}

describe('cardBackVector', () => {
  it("is the index's card-back entry, as a unit vector", () => {
    const idx = index(
      [
        { imageId: 1, cardId: 1 },
        { imageId: CARD_BACK_ID, cardId: CARD_BACK_ID },
      ],
      [Float32Array.of(1, 0, 0), Float32Array.of(0, 0.6, 0.8)],
    );
    const back = cardBackVector(idx)!;
    expect(Array.from(back).map((x) => Math.round(x * 100) / 100)).toEqual([0, 0.6, 0.8]);
    expect(Math.hypot(...back)).toBeCloseTo(1, 6);
  });

  it('is null for an index built without the card back', () => {
    expect(cardBackVector(index([{ imageId: 1, cardId: 1 }], [Float32Array.of(1, 0, 0)]))).toBeNull();
  });
});

describe('isPlaceholderArt', () => {
  const back = Float32Array.of(1, 0, 0);

  it("takes an artwork this close to the card back for YGOPRODeck's placeholder", () => {
    expect(isPlaceholderArt(at(0.98), back)).toBe(true); // the placeholders in the bundled index: 0.981-0.995
    expect(isPlaceholderArt(at(PLACEHOLDER_ART_COSINE + 0.001), back)).toBe(true);
  });

  it('keeps real artworks, even the most card-back-like ones', () => {
    expect(isPlaceholderArt(at(0.77), back)).toBe(false); // the closest real artwork in any bundled index: 0.765
    expect(isPlaceholderArt(at(PLACEHOLDER_ART_COSINE - 0.001), back)).toBe(false);
  });
});

describe('dropPlaceholders (tools/build-index.ts)', () => {
  it("drops the artworks that are the card back, keeping the card back's own entry and every real artwork", () => {
    const entries = [
      { imageId: 10, cardId: 10 },
      { imageId: 100460002, cardId: 100460002 },
      { imageId: 20, cardId: 20 },
      { imageId: CARD_BACK_ID, cardId: CARD_BACK_ID },
    ];
    const vectors = [at(0.3), at(0.982), at(0.65), at(1)];
    const out = dropPlaceholders(entries, vectors);
    expect(out.entries.map((e) => e.imageId)).toEqual([10, 20, CARD_BACK_ID]);
    expect(out.vectors).toEqual([vectors[0], vectors[2], vectors[3]]);
    expect(out.dropped).toEqual([{ imageId: 100460002, cardId: 100460002 }]);
  });

  it('keeps everything when there is no card back to compare with', () => {
    const entries = [{ imageId: 10, cardId: 10 }];
    const out = dropPlaceholders(entries, [at(0.99)]);
    expect(out.entries).toEqual(entries);
    expect(out.dropped).toEqual([]);
  });
});
