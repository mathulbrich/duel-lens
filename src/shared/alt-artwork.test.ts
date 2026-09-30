import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { altArtworkId, displayCandidates, displayImageId, isAltArtwork, parseAltArtwork } from './alt-artwork';
import { CARD_BACK_ID, type Candidate, type CardRecord } from './types';

describe('altArtworkId', () => {
  it('is -(konamiId * 100 + artwork)', () => {
    expect(altArtworkId(15619, 2)).toBe(-1561902);
    expect(altArtworkId(1, 1)).toBe(-101);
    expect(altArtworkId(12950, 99)).toBe(-1295099);
  });

  it('refuses what is not a Konami card id or an artwork number 1-99 (101 and up are Rush Duel prints)', () => {
    for (const [k, a] of [
      [0, 1],
      [-5, 1],
      [1.5, 1],
      [15619, 0],
      [15619, 100],
      [15619, 101],
      [15619, 2.5],
      [Number.NaN, 1],
    ]) {
      expect(() => altArtworkId(k, a)).toThrow();
    }
  });
});

describe('isAltArtwork', () => {
  it('knows its own ids', () => {
    expect(isAltArtwork(altArtworkId(15619, 2))).toBe(true);
    expect(isAltArtwork(altArtworkId(1, 1))).toBe(true);
  });

  it('never takes a YGOPRODeck id or the card back for one', () => {
    // passcodes, passcode + N alternates, YGOPRODeck's own 9-digit ids, the card back
    for (const id of [34755994, 14558127, 14558128, 46986414, 46986420, 101304014, 149694341, 1, 0, CARD_BACK_ID]) {
      expect(isAltArtwork(id)).toBe(false);
    }
  });

  it('refuses ids that decode to artwork 0 and anything that is not an integer', () => {
    for (const id of [-100, -1561900, -1.5, Number.NaN, Number.NEGATIVE_INFINITY, -2]) expect(isAltArtwork(id)).toBe(false);
  });

  it('never collides with an image id of the bundled card data (extension/data/cards.json)', () => {
    const file = path.resolve(import.meta.dirname, '../../extension/data/cards.json');
    const { cards } = JSON.parse(readFileSync(file, 'utf8')) as { cards: CardRecord[] };
    const ids = cards.flatMap((c) => [c.id, ...c.imageIds]);
    expect(ids.length).toBeGreaterThan(10000);
    expect(ids.filter(isAltArtwork)).toEqual([]);
    expect(Math.min(...ids)).toBeGreaterThan(0);
  });
});

describe('parseAltArtwork', () => {
  it('gives back the Konami card id and artwork number', () => {
    expect(parseAltArtwork(-1561902)).toEqual({ konamiId: 15619, artwork: 2 });
    expect(parseAltArtwork(altArtworkId(8933, 3))).toEqual({ konamiId: 8933, artwork: 3 });
  });

  it('is null for any other id', () => {
    expect(parseAltArtwork(34755994)).toBeNull();
    expect(parseAltArtwork(CARD_BACK_ID)).toBeNull();
  });
});

describe('displayImageId', () => {
  const artemis: Pick<CardRecord, 'imageIds'> = { imageIds: [34755994] };
  const ash: Pick<CardRecord, 'imageIds'> = { imageIds: [14558127, 14558128] };

  it("stands a synthetic id in for the card's own first YGOPRODeck image", () => {
    expect(displayImageId(-1561902, artemis)).toBe(34755994);
    expect(displayImageId(altArtworkId(12950, 3), ash)).toBe(14558127);
  });

  it('leaves YGOPRODeck ids alone, alternates included', () => {
    expect(displayImageId(14558128, ash)).toBe(14558128);
    expect(displayImageId(34755994, undefined)).toBe(34755994);
    expect(displayImageId(CARD_BACK_ID, undefined)).toBe(CARD_BACK_ID);
  });

  it('keeps a synthetic id without the card record (nothing can show it: image-cache answers null)', () => {
    expect(displayImageId(-1561902, undefined)).toBe(-1561902);
    expect(displayImageId(-1561902, { imageIds: [] })).toBe(-1561902);
  });
});

describe('displayCandidates', () => {
  it('maps only the synthetic ids, keeping every other candidate as it is', () => {
    const top: Candidate = { cardId: 34755994, imageId: -1561902, score: 0.91 };
    const other: Candidate = { cardId: 14558127, imageId: 14558128, score: 0.6 };
    const out = displayCandidates([top, other], { 34755994: { imageIds: [34755994] }, 14558127: { imageIds: [14558127, 14558128] } });
    expect(out).toEqual([{ cardId: 34755994, imageId: 34755994, score: 0.91 }, other]);
    expect(out[1]).toBe(other);
    expect(top.imageId).toBe(-1561902); // not mutated
  });
});
