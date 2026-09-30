// The card artworks YGOPRODeck lacks (ALT-ART, the user's decision of 2026-09-30): which of Konami's artworks to fetch,
// from where, and how their vectors join an index. Konami's artworks come from ygoresources' manifest of Konami's own
// card renders (data/raw/ygoresources-artworks-manifest.json: Konami card id → artwork number → renders per language),
// at build time only: tools/fetch-alt-artworks.ts downloads the renders, tools/add-alt-artworks.ts adds the vectors of
// the ones YGOPRODeck has no image for. Only vectors ship; the extension never contacts ygoresources.
import { altArtworkId, isAltArtwork } from '../../src/shared/alt-artwork';
import { encodeIndexBinary, quantizeInt8, type AltArtworksInfo, type IndexEntry, type IndexMeta, type LoadedIndex } from '../../src/shared/index-format';
import type { CardRecord } from '../../src/shared/types';
import { isIndexableCard } from './artworks';

// ---------- the manifest ----------

export interface ManifestSource {
  /** Protocol-relative URL, e.g. //artworks-en-n.ygoresources.com/1/0/0_1.png. */
  path: string;
  /** 'neuron_high': Konami's clean card render; 'neuron_rush': a Rush Duel render; 'database': a watermarked "SAMPLE" copy. */
  source: string;
}

export interface ManifestArtwork {
  bestArt?: string;
  bestOCG?: string;
  /** Present when the artwork is printed in the TCG (an English print). It can point at a watermarked copy. */
  bestTCG?: string;
  /** Per language ('en', 'ja', …), every copy of this artwork. */
  idx: Record<string, ManifestSource[]>;
}

export interface ArtworksManifest {
  cards: Record<string, Record<string, ManifestArtwork>>;
}

const sources = (a: ManifestArtwork) => Object.values(a.idx ?? {}).flat();

/** A Rush Duel print (numbered 101 and up; another game, another frame): never an artwork of the OCG/TCG card. */
export const isRushArtwork = (a: ManifestArtwork) => sources(a).length > 0 && sources(a).every((s) => s.source === 'neuron_rush');

/** The language's Neuron render (Konami's clean card render, never a watermarked database copy), as an https URL. */
export function neuronRender(a: ManifestArtwork, lang: 'en' | 'ja'): string | undefined {
  const hit = (a.idx?.[lang] ?? []).find((s) => s.source === 'neuron_high');
  return hit ? `https:${hit.path}` : undefined;
}

// ---------- which artworks ----------

export interface AltArtworkRef {
  cardId: number;
  konamiId: number;
  /** Konami's artwork number (1 is the card's first). */
  artwork: number;
  /** The synthetic imageId it gets in an index (src/shared/alt-artwork.ts). */
  imageId: number;
  /** Printed in the TCG: the manifest has an English print of it (bestTCG). */
  tcg: boolean;
  /**
   * Neuron renders to try, in order: the English one, then the Japanese one of the SAME artwork (the art is the same
   * in every language; the English host sometimes fails DNS). Never a watermarked database copy.
   */
  urls: string[];
  frameType: string;
  name: string;
}

export interface AltArtworkPlan {
  /** Cards (indexable, with a Konami id) whose Konami artworks, Rush Duel prints aside, outnumber their YGOPRODeck images. */
  gapCards: CardRecord[];
  /** The gap cards' artworks in scope, each to fetch and compare with the card's YGOPRODeck images. */
  refs: AltArtworkRef[];
  /** Artworks in scope with no clean render to fetch. */
  skipped: { cardId: number; konamiId: number; artwork: number; name: string; reason: string }[];
}

export const RENDER_FILE = (konamiId: number, artwork: number) => `${konamiId}_${artwork}.png`;

/**
 * The gap cards and their artworks in scope. Which artwork is missing is decided later by similarity
 * (tools/add-alt-artworks.ts), never by artwork number: YGOPRODeck's image order needn't match Konami's, so every
 * artwork in scope of a gap card is listed. Scope: by default the artworks printed in the TCG (bestTCG); `all`: every
 * artwork (Rush Duel prints never).
 */
export function planAltArtworks(cards: CardRecord[], manifest: ArtworksManifest, opts: { all?: boolean } = {}): AltArtworkPlan {
  const gapCards: CardRecord[] = [];
  const refs: AltArtworkRef[] = [];
  const skipped: AltArtworkPlan['skipped'] = [];
  for (const card of cards) {
    if (!isIndexableCard(card) || card.konamiId === undefined) continue;
    const artworks = Object.entries(manifest.cards[String(card.konamiId)] ?? {})
      .filter(([, a]) => !isRushArtwork(a))
      .map(([n, a]) => ({ n: Number(n), a }))
      .filter(({ n }) => Number.isInteger(n) && n >= 1 && n <= 99)
      .sort((x, y) => x.n - y.n);
    if (artworks.length <= card.imageIds.length) continue;
    gapCards.push(card);
    for (const { n, a } of artworks) {
      const tcg = a.bestTCG !== undefined;
      if (!opts.all && !tcg) continue;
      const urls = [neuronRender(a, 'en'), neuronRender(a, 'ja')].filter((u): u is string => u !== undefined);
      if (urls.length === 0) {
        skipped.push({ cardId: card.id, konamiId: card.konamiId, artwork: n, name: card.name, reason: 'no clean render (only watermarked database copies)' });
        continue;
      }
      refs.push({ cardId: card.id, konamiId: card.konamiId, artwork: n, imageId: altArtworkId(card.konamiId, n), tcg, urls, frameType: card.frameType, name: card.name });
    }
  }
  return { gapCards, refs, skipped };
}

// ---------- similarity ----------

/** Cosine of an L2-normalised float query with index entry `i` (int8 entries are stored as round(v * 127)). */
export function scoreEntry(q: Float32Array, index: LoadedIndex, i: number): number {
  const { dim } = index.meta;
  const v = index.vectors;
  let dot = 0;
  for (let d = 0; d < dim; d++) dot += q[d] * v[i * dim + d];
  return v instanceof Int8Array ? dot / 127 : dot;
}

export interface OwnMatch {
  /** Best cosine to one of the card's own YGOPRODeck images (-Infinity when the index has none of them). */
  own: number;
  ownImageId: number | null;
  /** The cosine to each of the card's own YGOPRODeck images, by image id. */
  ownAll: Map<number, number>;
  /** Best cosine to any OTHER card's entry (the card back included), and that card. */
  other: number;
  otherCardId: number | null;
}

/** How close `q` is to its card's own YGOPRODeck vectors, and to the nearest other card. Synthetic entries are ignored. */
export function matchOwn(q: Float32Array, index: LoadedIndex, cardId: number): OwnMatch {
  const out: OwnMatch = { own: Number.NEGATIVE_INFINITY, ownImageId: null, ownAll: new Map(), other: Number.NEGATIVE_INFINITY, otherCardId: null };
  index.meta.entries.forEach((e, i) => {
    if (isAltArtwork(e.imageId)) return;
    const s = scoreEntry(q, index, i);
    if (e.cardId === cardId) {
      out.ownAll.set(e.imageId, s);
      if (s > out.own) [out.own, out.ownImageId] = [s, e.imageId];
    } else if (s > out.other) [out.other, out.otherCardId] = [s, e.cardId];
  });
  return out;
}

export interface CoverRule {
  /** At or above this cosine to one of its card's YGOPRODeck images, a Konami artwork IS that image. */
  clearly: number;
  /** Below `clearly`, a YGOPRODeck image still covers the ONE Konami artwork closest to it, at this cosine or more. */
  closest: number;
}

/**
 * Which of one card's Konami artworks YGOPRODeck already has (true: covered), from `scores[k]`: artwork k's cosine to
 * each of the card's YGOPRODeck images. A YGOPRODeck image is one artwork, so below `clearly` it covers at most one
 * Konami artwork: the closest, when at least `closest` (another scan of it, or a Pendulum render, whose blank Pendulum
 * text box costs it about 0.08). Pairs are taken greedily, best first. An artwork `clearly` that close to an image is
 * covered whatever else is: Konami can list one image twice.
 */
export function coveredArtworks(scores: Map<number, number>[], rule: CoverRule): boolean[] {
  const covered = scores.map((m) => [...m.values()].some((s) => s >= rule.clearly));
  const pairs = scores.flatMap((m, k) => [...m].map(([imageId, s]) => ({ k, imageId, s }))).sort((a, b) => b.s - a.s);
  const claimedK = new Set<number>();
  const claimedImage = new Set<number>();
  for (const { k, imageId, s } of pairs) {
    if (s < rule.closest) break;
    if (claimedK.has(k) || claimedImage.has(imageId)) continue;
    claimedK.add(k);
    claimedImage.add(imageId);
    covered[k] = true;
  }
  return covered;
}

// ---------- merging into an index ----------

export interface IndexFiles {
  bin: Uint8Array;
  meta: IndexMeta;
}

const HEADER_BYTES = 20;

/**
 * The index without the synthetic entries a previous run appended: the same bytes up to them. They must be the
 * index's last entries (this tool only ever appends them); anything else throws rather than rebuild.
 */
export function withoutAltArtworks(files: IndexFiles): IndexFiles {
  const { meta, bin } = files;
  if (meta.quant !== 'int8') throw new Error(`Only int8 indexes take extra artworks (this one is ${meta.quant})`);
  const first = meta.entries.findIndex((e) => isAltArtwork(e.imageId));
  if (first < 0) return files;
  if (meta.entries.slice(first).some((e) => !isAltArtwork(e.imageId))) {
    throw new Error('The index has extra (Konami) artworks before other entries: rebuild it with tools/build-index.ts first');
  }
  const { altArtworks: _gone, ...rest } = meta;
  const entries = meta.entries.slice(0, first);
  const body = bin.subarray(HEADER_BYTES, HEADER_BYTES + first * meta.dim);
  return { meta: { ...rest, count: first, entries }, bin: encodeIndexBinary(meta.dim, first, 'int8', new Int8Array(body.buffer, body.byteOffset, body.byteLength)) };
}

export interface ExtraArtwork {
  entry: Required<Pick<IndexEntry, 'imageId' | 'cardId' | 'source' | 'konamiId' | 'artwork'>>;
  vector: Float32Array;
}

/**
 * `base` (with no synthetic entries: withoutAltArtworks) with `extras` appended: every existing vector byte and meta
 * entry stays as it was, `count` grows, `altArtworks` records what was added, and builtAt and dbVersion don't change.
 */
export function appendAltArtworks(base: IndexFiles, extras: ExtraArtwork[], info: Omit<AltArtworksInfo, 'count'>): { bin: Uint8Array; metaJson: string } {
  const { meta } = base;
  if (meta.entries.some((e) => isAltArtwork(e.imageId))) throw new Error('Strip the previous extra artworks first (withoutAltArtworks)');
  if (meta.quant !== 'int8') throw new Error(`Only int8 indexes take extra artworks (this one is ${meta.quant})`);
  const known = new Set(meta.entries.map((e) => e.imageId));
  const count = meta.count + extras.length;
  const all = new Int8Array(count * meta.dim);
  all.set(new Int8Array(base.bin.buffer, base.bin.byteOffset + HEADER_BYTES, meta.count * meta.dim), 0);
  extras.forEach((x, i) => {
    if (!isAltArtwork(x.entry.imageId)) throw new Error(`Extra artwork ${x.entry.imageId} doesn't have a synthetic id`);
    if (known.has(x.entry.imageId)) throw new Error(`Extra artwork ${x.entry.imageId} is in the index twice`);
    known.add(x.entry.imageId);
    if (x.vector.length !== meta.dim) throw new Error(`Extra artwork ${x.entry.imageId} has dim ${x.vector.length}, the index ${meta.dim}`);
    all.set(quantizeInt8(x.vector), (meta.count + i) * meta.dim);
  });
  const { entries, altArtworks: _old, ...head } = meta;
  const next: IndexMeta = {
    ...head,
    count,
    ...(extras.length > 0 ? { altArtworks: { ...info, count: extras.length } } : {}),
    entries: [
      ...entries,
      ...extras.map(({ entry: { imageId, cardId, source, konamiId, artwork } }) => ({ imageId, cardId, source, konamiId, artwork })),
    ],
  };
  return { bin: encodeIndexBinary(meta.dim, count, 'int8', all), metaJson: JSON.stringify(next) };
}

// ---------- guards for a run (altart-review.md M1, M3, M4) ----------

/**
 * What a run can't reproduce, so that it must not write (M1): each artwork in scope without a usable render (never
 * fetched, deleted, or not a whole card), and each extra of the input index whose card is still a gap card but whose
 * artwork is outside this run's scope (the index was made with --all, say). An extra whose card is no longer a gap
 * card (YGOPRODeck now has as many images) is not a problem: dropping it is right.
 */
export function unreproducible(plan: AltArtworkPlan, unusable: { ref: AltArtworkRef; reason: string }[], inputExtras: IndexEntry[]): string[] {
  const out = unusable.map(({ ref, reason }) => `${ref.name}, artwork ${ref.artwork} (Konami ${ref.konamiId}): ${reason}`);
  const inScope = new Set(plan.refs.map((r) => r.imageId));
  const gapCards = new Set(plan.gapCards.map((c) => c.id));
  for (const e of inputExtras) {
    if (!inScope.has(e.imageId) && gapCards.has(e.cardId)) {
      out.push(`the index's extra ${e.imageId} (Konami ${e.konamiId}, artwork ${e.artwork}) is outside this run's scope (was the index made with --all?)`);
    }
  }
  return out;
}

/** The extras (by imageId) one index has and the other hasn't. */
export function extrasDiff(before: IndexEntry[], after: IndexEntry[]): { added: IndexEntry[]; removed: IndexEntry[] } {
  const had = new Set(before.filter((e) => isAltArtwork(e.imageId)).map((e) => e.imageId));
  const has = new Set(after.filter((e) => isAltArtwork(e.imageId)).map((e) => e.imageId));
  return {
    added: after.filter((e) => isAltArtwork(e.imageId) && !had.has(e.imageId)),
    removed: before.filter((e) => isAltArtwork(e.imageId) && !has.has(e.imageId)),
  };
}

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, d) => s + x * b[d], 0);

/**
 * Groups of items linked, directly or through each other (single linkage), by a cosine of at least `at`, when `pair`
 * allows the link. Each group lists item positions in order; an item linked to nothing is a group of its own.
 */
export function similarityGroups(vectors: Float32Array[], at: number, pair: (i: number, j: number) => boolean = () => true): number[][] {
  const parent = vectors.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      if (pair(i, j) && cosine(vectors[i], vectors[j]) >= at) parent[Math.max(find(i), find(j))] = Math.min(find(i), find(j));
    }
  }
  const groups = new Map<number, number[]>();
  vectors.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  return [...groups.values()];
}

/**
 * The card groups among `groups` (card ids linked by look-alike extras, M3) that no entry of `accepted` covers: every
 * card of a group must be in one accepted list. A group of look-alike extras of DIFFERENT cards is kept only by an
 * explicit decision (tools/add-alt-artworks.ts LOOKALIKES_KEPT): keeping one of them would make the others' prints read
 * as that card, confidently.
 */
export function unacceptedGroups(groups: number[][], accepted: number[][]): number[][] {
  return groups.filter((g) => g.length > 1 && !accepted.some((a) => g.every((cardId) => a.includes(cardId))));
}

/**
 * The input index's `altArtworks.addedAt` when this run appends exactly the extras it already has, with the same rule
 * and source (so a re-run with nothing new changes no byte, M4); else `now`.
 */
export function stableAddedAt(input: IndexFiles, extras: ExtraArtwork[], info: Omit<AltArtworksInfo, 'count' | 'addedAt'>, now: string): string {
  const prev = input.meta.altArtworks;
  if (!prev) return now;
  const sameInfo =
    prev.source === info.source &&
    prev.via === info.via &&
    prev.decidedBy === info.decidedBy &&
    prev.covered?.clearly === info.covered.clearly &&
    prev.covered?.closest === info.covered.closest;
  if (!sameInfo) return now;
  const first = input.meta.entries.findIndex((e) => isAltArtwork(e.imageId));
  const had = first < 0 ? [] : input.meta.entries.slice(first);
  const { dim } = input.meta;
  const fields = ['imageId', 'cardId', 'source', 'konamiId', 'artwork'] as const;
  const same =
    had.length === extras.length &&
    extras.every(({ entry, vector }, i) => {
      if (fields.some((f) => had[i][f] !== entry[f])) return false;
      const at = HEADER_BYTES + (first + i) * dim;
      const old = new Int8Array(input.bin.buffer, input.bin.byteOffset + at, dim);
      const q = quantizeInt8(vector);
      return q.every((x, d) => x === old[d]);
    });
  return same ? prev.addedAt : now;
}
