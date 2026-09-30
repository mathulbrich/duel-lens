import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { altArtworkId, isAltArtwork, parseAltArtwork } from '../../src/shared/alt-artwork';
import { decodeIndex, type IndexMeta } from '../../src/shared/index-format';
import { DEFAULT_MODEL_ID } from '../../src/shared/models';
import { l2normalize } from '../../src/shared/preprocess';
import { CARD_BACK_ID, type CardRecord } from '../../src/shared/types';
import {
  appendAltArtworks,
  coveredArtworks,
  extrasDiff,
  isRushArtwork,
  matchOwn,
  neuronRender,
  planAltArtworks,
  similarityGroups,
  stableAddedAt,
  unacceptedGroups,
  unreproducible,
  withoutAltArtworks,
  type ArtworksManifest,
  type ExtraArtwork,
  type ManifestArtwork,
} from './alt-artworks';
import { buildIndexArtefacts } from './index-builder';

const card = (id: number, konamiId: number | undefined, imageIds: number[], frameType = 'effect'): CardRecord => ({
  id,
  ...(konamiId !== undefined ? { konamiId } : {}),
  name: `Card ${id}`,
  type: 'Effect Monster',
  frameType,
  desc: '',
  imageIds,
});

/** A manifest artwork: its English and Japanese Neuron renders and database copies, as ygoresources lists them. */
const art = (k: number, n: number, opts: { tcg?: boolean; enNeuron?: boolean; jaNeuron?: boolean; rush?: boolean } = {}): ManifestArtwork => {
  const { tcg = true, enNeuron = tcg, jaNeuron = true, rush = false } = opts;
  if (rush) return { bestArt: `//artworks-jp-rn.ygoresources.com/x/${k}_${n}.png`, idx: { ja: [{ path: `//artworks-jp-rn.ygoresources.com/x/${k}_${n}.png`, source: 'neuron_rush' }] } };
  const en = [
    ...(enNeuron ? [{ path: `//artworks-en-n.ygoresources.com/x/${k}_${n}.png`, source: 'neuron_high' }] : []),
    ...(tcg ? [{ path: `//artworks-en-db.ygoresources.com/x/${k}_${n}.png`, source: 'database' }] : []),
  ];
  const ja = [
    ...(jaNeuron ? [{ path: `//artworks-jp-n.ygoresources.com/x/${k}_${n}.png`, source: 'neuron_high' }] : []),
    { path: `//artworks-jp-db.ygoresources.com/x/${k}_${n}.png`, source: 'database' },
  ];
  return {
    ...(tcg ? { bestTCG: (enNeuron ? en[0] : en[en.length - 1]).path } : {}),
    idx: { ...(en.length ? { en } : {}), ja, de: [{ path: `//artworks-de-db.ygoresources.com/x/${k}_${n}.png`, source: 'database' }] },
  };
};

describe('neuronRender and isRushArtwork', () => {
  it("gives a language's clean Neuron render as https, never a watermarked database copy", () => {
    expect(neuronRender(art(15619, 2), 'en')).toBe('https://artworks-en-n.ygoresources.com/x/15619_2.png');
    expect(neuronRender(art(15619, 2), 'ja')).toBe('https://artworks-jp-n.ygoresources.com/x/15619_2.png');
    expect(neuronRender(art(15619, 2, { enNeuron: false }), 'en')).toBeUndefined();
  });

  it('knows a Rush Duel print', () => {
    expect(isRushArtwork(art(15150, 105, { rush: true }))).toBe(true);
    expect(isRushArtwork(art(15150, 1))).toBe(false);
  });
});

describe('planAltArtworks', () => {
  const manifest: ArtworksManifest = {
    cards: {
      // Artemis: 2 Konami artworks, 1 YGOPRODeck image → a gap card; both artworks listed (similarity decides).
      15619: { 1: art(15619, 1), 2: art(15619, 2) },
      // the same number on both sides: not a gap card
      100: { 1: art(100, 1) },
      // 1 image, 2 artworks, but the second is a Rush Duel print: not a gap card
      15150: { 1: art(15150, 1), 105: art(15150, 105, { rush: true }) },
      // a gap card whose artwork 3 is OCG only, and artwork 2 has only a Japanese Neuron render
      12950: { 1: art(12950, 1), 2: art(12950, 2, { enNeuron: false }), 3: art(12950, 3, { tcg: false }) },
      // a gap card whose extra artwork has no Neuron render at all
      6846: { 1: art(6846, 1), 2: art(6846, 2, { enNeuron: false, jaNeuron: false }) },
      // a Skill card and the '???' placeholder are never indexed
      500: { 1: art(500, 1), 2: art(500, 2) },
      501: { 1: art(501, 1), 2: art(501, 2) },
    },
  };
  const cards = [
    card(34755994, 15619, [34755994], 'link'),
    card(1000, 100, [1000]),
    card(2000, 15150, [2000]),
    card(14558127, 12950, [14558127]),
    card(3629090, 6846, [3629090]),
    card(300102004, 500, [300102004], 'skill'),
    card(149694341, 501, [149694341], 'spell'),
    card(4000, undefined, [4000]),
  ];

  it('lists every TCG artwork of every gap card, English render first, with its synthetic id', () => {
    const plan = planAltArtworks(cards, manifest);
    expect(plan.gapCards.map((c) => c.id)).toEqual([34755994, 14558127, 3629090]);
    expect(plan.refs.map((r) => [r.cardId, r.artwork, r.imageId, r.tcg])).toEqual([
      [34755994, 1, altArtworkId(15619, 1), true],
      [34755994, 2, altArtworkId(15619, 2), true],
      [14558127, 1, altArtworkId(12950, 1), true],
      [14558127, 2, altArtworkId(12950, 2), true],
      [3629090, 1, altArtworkId(6846, 1), true],
    ]);
    expect(plan.refs[1].urls).toEqual(['https://artworks-en-n.ygoresources.com/x/15619_2.png', 'https://artworks-jp-n.ygoresources.com/x/15619_2.png']);
    expect(plan.refs[1]).toMatchObject({ konamiId: 15619, frameType: 'link', name: 'Card 34755994' });
  });

  it("falls back to the Japanese render of the same artwork, and never to a database copy", () => {
    const plan = planAltArtworks(cards, manifest);
    expect(plan.refs.find((r) => r.konamiId === 12950 && r.artwork === 2)?.urls).toEqual(['https://artworks-jp-n.ygoresources.com/x/12950_2.png']);
    for (const r of plan.refs) for (const u of r.urls) expect(u).toMatch(/^https:\/\/artworks-(en|jp)-n\.ygoresources\.com\//);
    expect(plan.skipped).toEqual([
      { cardId: 3629090, konamiId: 6846, artwork: 2, name: 'Card 3629090', reason: 'no clean render (only watermarked database copies)' },
    ]);
  });

  it('with all, also lists the artworks never printed in the TCG', () => {
    const plan = planAltArtworks(cards, manifest, { all: true });
    const ash = plan.refs.filter((r) => r.cardId === 14558127);
    expect(ash.map((r) => [r.artwork, r.tcg])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
    expect(plan.refs.some((r) => r.artwork >= 100)).toBe(false);
  });
});

const unit = (xs: number[]) => l2normalize(Float32Array.from(xs));

function indexFiles(entries: { imageId: number; cardId: number }[], vectors: Float32Array[]) {
  const { bin, metaJson } = buildIndexArtefacts(entries, vectors, { modelId: 'm', dbVersion: '147.20', builtAt: '2026-09-28T00:00:00.000Z' });
  return { bin, meta: JSON.parse(metaJson) as IndexMeta, metaJson };
}
const base = indexFiles(
  [
    { imageId: 10, cardId: 1 },
    { imageId: 11, cardId: 1 },
    { imageId: 20, cardId: 2 },
    { imageId: -1, cardId: -1 },
  ],
  [unit([1, 0, 0]), unit([0.8, 0.6, 0]), unit([0, 1, 0]), unit([0, 0, 1])],
);
const extra = (konamiId: number, artwork: number, cardId: number, v: number[]): ExtraArtwork => ({
  entry: { imageId: altArtworkId(konamiId, artwork), cardId, source: 'konami', konamiId, artwork },
  vector: unit(v),
});
const info = { source: 'konami' as const, via: 'test', covered: { clearly: 0.95, closest: 0.85 }, decidedBy: 'm', addedAt: '2026-09-30T00:00:00.000Z' };
const loaded = (f: { bin: Uint8Array; meta: IndexMeta }) => decodeIndex(f.bin.slice().buffer, f.meta);

describe('matchOwn', () => {
  it("scores a query against its card's own images and, apart, the nearest other card", () => {
    const m = matchOwn(unit([0.8, 0.6, 0]), loaded(base), 1);
    expect(m.ownImageId).toBe(11);
    expect(m.own).toBeCloseTo(1, 2);
    expect(m.otherCardId).toBe(2);
    expect(m.other).toBeCloseTo(0.6, 2);
  });

  it('ignores extra artworks already in the index', () => {
    const merged = appendAltArtworks(base, [extra(7, 2, 1, [0, 0.6, 0.8])], info);
    const m = matchOwn(unit([0, 0.6, 0.8]), loaded({ bin: merged.bin, meta: JSON.parse(merged.metaJson) }), 1);
    expect(m.own).toBeCloseTo(0.36, 2); // its YGOPRODeck image 11 (0.6 x 0.6), not its own synthetic entry (1)
    expect(m.ownImageId).toBe(11);
  });
});

describe('coveredArtworks', () => {
  const rule = { clearly: 0.95, closest: 0.85 };
  const m = (pairs: [number, number][]) => new Map(pairs);

  it('covers an artwork clearly one of the images, and no other version of that image (a TCG edit, a recolour)', () => {
    // Heat Wave: YGOPRODeck has the OCG artwork (#2); #1 is the TCG print, edited
    expect(coveredArtworks([m([[45141013, 0.931]]), m([[45141013, 0.983]])], rule)).toEqual([false, true]);
  });

  it("covers the one artwork closest to an image even below 'clearly' (a Pendulum render, another scan)", () => {
    expect(coveredArtworks([m([[1, 0.884]]), m([[1, 0.3]])], rule)).toEqual([true, false]);
    expect(coveredArtworks([m([[1, 0.84]])], rule)).toEqual([false]);
  });

  it('pairs each image with at most one artwork, best pairs first, over several images', () => {
    // Odd-Eyes-like: three images, four artworks; artwork 3 is closest to image 11, taken by artwork 1 first
    const scores = [
      m([[10, 0.2], [11, 0.95], [12, 0.3]]),
      m([[10, 0.9], [11, 0.2], [12, 0.3]]),
      m([[10, 0.3], [11, 0.88], [12, 0.87]]),
      m([[10, 0.1], [11, 0.1], [12, 0.2]]),
    ];
    expect(coveredArtworks(scores, rule)).toEqual([true, true, true, false]);
  });

  it("covers every artwork 'clearly' an image, even two of one image (Konami can list an image twice)", () => {
    expect(coveredArtworks([m([[1, 0.99]]), m([[1, 0.97]]), m([[1, 0.93]])], rule)).toEqual([true, true, false]);
  });

  it('covers nothing on a card without YGOPRODeck vectors', () => {
    expect(coveredArtworks([m([]), m([])], rule)).toEqual([false, false]);
  });
});

describe('appendAltArtworks', () => {
  it('appends the extras with their provenance, keeping every earlier byte, builtAt and dbVersion', () => {
    const { bin, metaJson } = appendAltArtworks(base, [extra(15619, 2, 1, [0, 0.6, 0.8]), extra(12950, 3, 2, [0.6, 0, 0.8])], info);
    const meta = JSON.parse(metaJson) as IndexMeta;
    expect(meta.count).toBe(6);
    expect(meta.builtAt).toBe(base.meta.builtAt);
    expect(meta.dbVersion).toBe('147.20');
    expect(meta.altArtworks).toEqual({ ...info, count: 2 });
    expect(meta.entries.slice(4)).toEqual([
      { imageId: -1561902, cardId: 1, source: 'konami', konamiId: 15619, artwork: 2 },
      { imageId: -1295003, cardId: 2, source: 'konami', konamiId: 12950, artwork: 3 },
    ]);
    // the vector bytes and the entries' text before the extras are the original's
    expect(Buffer.from(bin.subarray(20, 20 + 4 * 3)).equals(Buffer.from(base.bin.subarray(20)))).toBe(true);
    expect(metaJson).toContain(`"entries":${JSON.stringify(base.meta.entries).slice(0, -1)},`);
    expect(Array.from(loaded({ bin, meta }).vectors.subarray(12))).toEqual([0, 76, 102, 76, 0, 102]);
  });

  it('refuses ids that are not synthetic, an id twice, and a vector of another size', () => {
    const bad = (x: ExtraArtwork[]) => () => appendAltArtworks(base, x, info);
    expect(bad([{ ...extra(1, 2, 1, [1, 0, 0]), entry: { ...extra(1, 2, 1, [1, 0, 0]).entry, imageId: 12345 } }])).toThrow(/synthetic/);
    expect(bad([extra(1, 2, 1, [1, 0, 0]), extra(1, 2, 1, [0, 1, 0])])).toThrow(/twice/);
    expect(bad([{ ...extra(1, 2, 1, [1, 0, 0]), vector: unit([1, 0]) }])).toThrow(/dim/);
  });

  it('with no extras, gives back the same index', () => {
    const { bin, metaJson } = appendAltArtworks(base, [], info);
    expect(Buffer.from(bin).equals(Buffer.from(base.bin))).toBe(true);
    expect(metaJson).toBe(base.metaJson);
  });
});

describe('withoutAltArtworks', () => {
  it('drops the extras a previous run appended, so a re-run gives the same bytes', () => {
    const first = appendAltArtworks(base, [extra(15619, 2, 1, [0, 0.6, 0.8])], info);
    const stripped = withoutAltArtworks({ bin: first.bin, meta: JSON.parse(first.metaJson) });
    expect(Buffer.from(stripped.bin).equals(Buffer.from(base.bin))).toBe(true);
    expect(stripped.meta).toEqual(base.meta);
    const again = appendAltArtworks(stripped, [extra(15619, 2, 1, [0, 0.6, 0.8])], info);
    expect(Buffer.from(again.bin).equals(Buffer.from(first.bin))).toBe(true);
    expect(again.metaJson).toBe(first.metaJson);
  });

  it('leaves an index without extras as it is, and refuses extras before other entries', () => {
    expect(withoutAltArtworks(base)).toBe(base);
    const odd = indexFiles(
      [
        { imageId: altArtworkId(1, 2), cardId: 1 },
        { imageId: 10, cardId: 1 },
      ],
      [unit([1, 0, 0]), unit([0, 1, 0])],
    );
    expect(() => withoutAltArtworks(odd)).toThrow(/rebuild/);
  });
});

describe('unreproducible (a run must not quietly write fewer extras)', () => {
  const manifest: ArtworksManifest = {
    cards: {
      15619: { 1: art(15619, 1), 2: art(15619, 2) },
      12950: { 1: art(12950, 1), 2: art(12950, 2), 3: art(12950, 3, { tcg: false }) },
      700: { 1: art(700, 1), 2: art(700, 2) },
    },
  };
  // Card 7000 is no longer a gap card: YGOPRODeck now has both its artworks.
  const cards = [card(34755994, 15619, [34755994]), card(14558127, 12950, [14558127]), card(7000, 700, [7000, 7001])];
  const plan = planAltArtworks(cards, manifest);
  const extra = (konamiId: number, artwork: number, cardId: number) => ({ imageId: altArtworkId(konamiId, artwork), cardId, source: 'konami' as const, konamiId, artwork });

  it('is empty when every artwork in scope has a usable render and the input extras are all in scope', () => {
    expect(unreproducible(plan, [], [extra(15619, 2, 34755994)])).toEqual([]);
  });

  it('lists every artwork in scope without a usable render', () => {
    const ref = plan.refs.find((r) => r.konamiId === 15619 && r.artwork === 2)!;
    expect(unreproducible(plan, [{ ref, reason: 'no render data/alt-artworks/15619_2.png' }], [])).toEqual([
      'Card 34755994, artwork 2 (Konami 15619): no render data/alt-artworks/15619_2.png',
    ]);
  });

  it("lists an input extra of a gap card outside this run's scope (an --all index refreshed without --all)", () => {
    expect(unreproducible(plan, [], [extra(12950, 3, 14558127)])).toEqual([
      "the index's extra -1295003 (Konami 12950, artwork 3) is outside this run's scope (was the index made with --all?)",
    ]);
    expect(unreproducible(planAltArtworks(cards, manifest, { all: true }), [], [extra(12950, 3, 14558127)])).toEqual([]);
  });

  it('lets an extra go when YGOPRODeck now has its card\'s artworks', () => {
    expect(unreproducible(plan, [], [extra(700, 2, 7000)])).toEqual([]);
  });
});

describe('extrasDiff', () => {
  it('lists the extras added and removed, by id, ignoring YGOPRODeck entries', () => {
    const a = { imageId: altArtworkId(1, 2), cardId: 1 };
    const b = { imageId: altArtworkId(2, 2), cardId: 2 };
    const c = { imageId: altArtworkId(3, 2), cardId: 3 };
    const ygo = { imageId: 10, cardId: 1 };
    expect(extrasDiff([ygo, a, b], [ygo, b, c])).toEqual({ added: [c], removed: [a] });
    expect(extrasDiff([ygo, a], [ygo, a])).toEqual({ added: [], removed: [] });
  });
});

describe('similarityGroups', () => {
  it('links items at the cosine or more, through each other too, and keeps the rest alone', () => {
    // a~b 0.96, b~c 0.96, a~c 0.84: one group by single linkage; d apart
    const a = unit([1, 0, 0]);
    const b = unit([0.96, 0.28, 0]);
    const c = unit([0.84, 0.54, 0.05]);
    const d = unit([0, 0, 1]);
    expect(similarityGroups([a, b, c, d], 0.95)).toEqual([[0, 1, 2], [3]]);
    expect(similarityGroups([a, c], 0.95)).toEqual([[0], [1]]);
  });

  it('links only the pairs the predicate allows (look-alikes across cards, not within one)', () => {
    const v = [unit([1, 0, 0]), unit([1, 0.01, 0]), unit([1, 0, 0.01])];
    const cardOf = [1, 1, 2];
    expect(similarityGroups(v, 0.95, (i, j) => cardOf[i] !== cardOf[j])).toEqual([[0, 1, 2]]);
    expect(similarityGroups(v, 0.95, (i, j) => cardOf[i] === cardOf[j])).toEqual([[0, 1], [2]]);
  });
});

describe('unacceptedGroups', () => {
  const kept = [[31893528, 67287533, 94772232, 30170981, 94212438]];

  it('accepts a group whose cards are all in one kept list, a part of it too', () => {
    expect(unacceptedGroups([[31893528, 67287533, 94772232, 30170981, 94212438]], kept)).toEqual([]);
    expect(unacceptedGroups([[67287533, 94212438]], kept)).toEqual([]);
  });

  it('refuses a group with a card no kept list names, and ignores a single card', () => {
    expect(unacceptedGroups([[31893528, 1234], [5678]], kept)).toEqual([[31893528, 1234]]);
  });
});

describe('stableAddedAt (a re-run with nothing new changes no byte)', () => {
  const extras = [extra(15619, 2, 1, [0, 0.6, 0.8]), extra(12950, 3, 2, [0.6, 0, 0.8])];
  const infoNoDate = { source: 'konami' as const, via: 'test', covered: { clearly: 0.95, closest: 0.85 }, decidedBy: 'm' };
  const first = appendAltArtworks(base, extras, { ...infoNoDate, addedAt: '2026-09-30T15:08:00.177Z' });
  const input = { bin: first.bin, meta: JSON.parse(first.metaJson) as IndexMeta };
  const NOW = '2026-10-01T00:00:00.000Z';

  it("keeps the input's date when the extras, their vectors and the rule are the same, so the files are byte-identical", () => {
    const at = stableAddedAt(input, extras, infoNoDate, NOW);
    expect(at).toBe('2026-09-30T15:08:00.177Z');
    const again = appendAltArtworks(withoutAltArtworks(input), extras, { ...infoNoDate, addedAt: at });
    expect(Buffer.from(again.bin).equals(Buffer.from(first.bin))).toBe(true);
    expect(again.metaJson).toBe(first.metaJson);
  });

  it('takes a new date when an extra, a vector byte or the rule changes, or the index had no extras', () => {
    expect(stableAddedAt(input, extras.slice(0, 1), infoNoDate, NOW)).toBe(NOW);
    expect(stableAddedAt(input, [extras[0], { ...extras[1], vector: unit([0.6, 0.1, 0.8]) }], infoNoDate, NOW)).toBe(NOW);
    expect(stableAddedAt(input, extras, { ...infoNoDate, covered: { clearly: 0.95, closest: 0.8 } }, NOW)).toBe(NOW);
    expect(stableAddedAt(base, extras, infoNoDate, NOW)).toBe(NOW);
  });
});

describe('the committed indexes (extension/data)', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const { dbVersion, cards } = JSON.parse(readFileSync(path.join(root, 'extension/data/cards.json'), 'utf8')) as { dbVersion: string; cards: CardRecord[] };
  const byId = new Map(cards.map((c) => [c.id, c]));
  const ygoImages = new Set(cards.flatMap((c) => c.imageIds));

  /** The extras both committed indexes hold (tools/add-alt-artworks.ts, altart-report.md). Change it on purpose, with a refresh. */
  const EXTRAS = 267;
  const extrasOf = (modelId: string) =>
    (JSON.parse(readFileSync(path.join(root, `extension/data/index-${modelId}.meta.json`), 'utf8')) as IndexMeta).entries.filter((e) => isAltArtwork(e.imageId));

  it(`both hold the same ${EXTRAS} extras, in the same order: a refresh that lost some would show here`, () => {
    const v3b = extrasOf(DEFAULT_MODEL_ID);
    expect(v3b).toHaveLength(EXTRAS);
    expect(extrasOf('dinov2-small-duel')).toEqual(v3b);
  });

  for (const modelId of [DEFAULT_MODEL_ID, 'dinov2-small-duel']) {
    it(`${modelId}: YGOPRODeck's artworks first, then Konami's extras, each with its provenance and its card's Konami id`, () => {
      const meta = JSON.parse(readFileSync(path.join(root, `extension/data/index-${modelId}.meta.json`), 'utf8')) as IndexMeta;
      expect(meta.dbVersion).toBe(dbVersion);
      const first = meta.entries.findIndex((e) => isAltArtwork(e.imageId));
      const extras = meta.entries.slice(first);
      expect(first).toBeGreaterThan(14000);
      expect(extras.length).toBeGreaterThan(0);
      expect(extras.every((e) => isAltArtwork(e.imageId))).toBe(true);
      expect(meta.altArtworks).toMatchObject({ source: 'konami', count: extras.length });
      for (const e of extras) {
        expect(e.source).toBe('konami');
        expect(parseAltArtwork(e.imageId)).toEqual({ konamiId: e.konamiId, artwork: e.artwork });
        expect(byId.get(e.cardId)?.konamiId).toBe(e.konamiId);
      }
      expect(new Set(extras.map((e) => e.imageId)).size).toBe(extras.length);
      // Every other entry is a YGOPRODeck artwork of its card, or the card back, with no provenance fields.
      for (const e of meta.entries.slice(0, first)) {
        expect(e.cardId === CARD_BACK_ID || (ygoImages.has(e.imageId) && byId.get(e.cardId)?.imageIds.includes(e.imageId))).toBe(true);
        expect(Object.keys(e)).toEqual(['imageId', 'cardId']);
      }
    });
  }
});
