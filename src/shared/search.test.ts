import { describe, expect, it } from 'vitest';
import { decide, mergeCandidates, topKByCard } from './search';
import { quantizeInt8, type LoadedIndex } from './index-format';

// Four artworks, three cards: card 2 has an alternate artwork (imageId 21).
const vecs = new Float32Array([
  1, 0, 0,        // image 10 → card 1
  0, 1, 0,        // image 20 → card 2
  0, 0.8, 0.6,    // image 21 → card 2 (alt art)
  0, 0, 1,        // image 30 → card 3
]);
const entries = [
  { imageId: 10, cardId: 1 }, { imageId: 20, cardId: 2 }, { imageId: 21, cardId: 2 }, { imageId: 30, cardId: 3 },
];
const index = (quant: 'int8' | 'float32'): LoadedIndex => ({
  meta: { modelId: 'm', dim: 3, count: 4, quant, builtAt: '', entries },
  vectors: quant === 'int8' ? quantizeInt8(vecs) : vecs,
});

describe('topKByCard', () => {
  it('returns one candidate per card, best artwork first', () => {
    const q = new Float32Array([0, 0.8, 0.6]);
    const c = topKByCard(q, index('float32'), 10);
    expect(c.map((x) => x.cardId)).toEqual([2, 3, 1]);
    expect(c[0].imageId).toBe(21);
    expect(c[0].score).toBeCloseTo(1, 5);
  });

  it('works on int8 vectors with cosine-scale scores', () => {
    const q = new Float32Array([1, 0, 0]);
    const c = topKByCard(q, index('int8'), 2);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ cardId: 1, imageId: 10 });
    expect(c[0].score).toBeCloseTo(1, 2);
  });

  it('respects k', () => {
    expect(topKByCard(new Float32Array([0, 0, 1]), index('float32'), 1)).toHaveLength(1);
  });
});

describe('mergeCandidates', () => {
  it('keeps the best score per card across lists', () => {
    const merged = mergeCandidates(
      [
        [{ cardId: 1, imageId: 10, score: 0.4 }, { cardId: 2, imageId: 20, score: 0.3 }],
        [{ cardId: 2, imageId: 21, score: 0.9 }],
      ],
      5,
    );
    expect(merged).toEqual([
      { cardId: 2, imageId: 21, score: 0.9 },
      { cardId: 1, imageId: 10, score: 0.4 },
    ]);
  });
});

describe('decide: the second confidence gate and the card-back margin', () => {
  // dinov2-small-duel's real-footage calibration (models.ts): a clear lead over the runner-up is
  // stronger evidence than the raw score, and the card back, being unlike any card, must win by a
  // clear margin (an empty mat zone once read as a card back at 0.826 with a 0.056 lead).
  const t = { score: 0.8, margin: 0.02, floor: 0.74, second: { score: 0.73, margin: 0.1 }, cardBackMargin: 0.1 };
  const c = (cardId: number, score: number) => ({ cardId, imageId: cardId, score });

  it('is confident below the main score when the lead is large enough (the second gate)', () => {
    expect(decide([c(1, 0.758), c(2, 0.645)], t)).toEqual({ confident: true, nothing: false });
  });

  it('is not confident below the main score with a small lead', () => {
    expect(decide([c(1, 0.78), c(2, 0.7)], t)).toEqual({ confident: false, nothing: false });
  });

  it('never uses the second gate below its own score', () => {
    expect(decide([c(1, 0.745), c(2, 0.5)], { ...t, second: { score: 0.75, margin: 0.1 } })).toEqual({ confident: false, nothing: false });
  });

  it('refuses a card back that wins by less than cardBackMargin, even above the main score', () => {
    expect(decide([c(-1, 0.826), c(7, 0.77)], t)).toEqual({ confident: false, nothing: false });
  });

  it('accepts a card back with a clear lead', () => {
    expect(decide([c(-1, 0.92), c(7, 0.6)], t)).toEqual({ confident: true, nothing: false });
  });

  it('behaves exactly as before for a model without these fields', () => {
    const plain = { score: 0.8, margin: 0.02, floor: 0.74 };
    expect(decide([c(1, 0.758), c(2, 0.645)], plain)).toEqual({ confident: false, nothing: false });
    expect(decide([c(-1, 0.826), c(7, 0.77)], plain)).toEqual({ confident: true, nothing: false });
  });
});

describe('decide', () => {
  const t = { score: 0.6, margin: 0.05, floor: 0.3 };
  it('is confident with a high score and a clear margin', () => {
    expect(decide([{ cardId: 1, imageId: 1, score: 0.8 }, { cardId: 2, imageId: 2, score: 0.5 }], t)).toEqual({ confident: true, nothing: false });
  });
  it('is not confident when the runner-up is too close', () => {
    expect(decide([{ cardId: 1, imageId: 1, score: 0.8 }, { cardId: 2, imageId: 2, score: 0.78 }], t).confident).toBe(false);
  });
  it('reports nothing found below the floor', () => {
    expect(decide([{ cardId: 1, imageId: 1, score: 0.2 }], t)).toEqual({ confident: false, nothing: true });
    expect(decide([], t)).toEqual({ confident: false, nothing: true });
  });
});
