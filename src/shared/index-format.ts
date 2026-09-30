// Binary format of the artwork-embedding index (extension/data/index-<model>.bin) and
// its JSON sidecar (index-<model>.meta.json).
//
// Binary layout (little-endian):
//   0  'YGIX' magic
//   4  u32 version (1)
//   8  u32 dim
//  12  u32 count
//  16  u32 quant (0 = float32, 1 = int8 = round(v * 127) of an L2-normalised vector)
//  20  count * dim values

export const INDEX_VERSION = 1;
const MAGIC = [0x59, 0x47, 0x49, 0x58]; // "YGIX"
const HEADER_BYTES = 20;

export type IndexQuant = 'int8' | 'float32';

export interface IndexEntry {
  /** YGOPRODeck image id; for an artwork YGOPRODeck lacks, a synthetic id (src/shared/alt-artwork.ts). */
  imageId: number;
  /** Card id, or CARD_BACK_ID (-1) for the card back. */
  cardId: number;
  /**
   * Provenance of an artwork YGOPRODeck lacks (tools/add-alt-artworks.ts): its vector comes from Konami's card render
   * (Konami's card id and artwork number). Absent on every YGOPRODeck artwork and on the card back.
   */
  source?: 'konami';
  konamiId?: number;
  artwork?: number;
}

/** The artworks YGOPRODeck lacks that tools/add-alt-artworks.ts appended to an index (after every other entry). */
export interface AltArtworksInfo {
  /** Where the renders come from: Konami's card renders, through ygoresources' mirror (build time only). */
  source: 'konami';
  via: string;
  /** How many entries were appended (each with source 'konami'). */
  count: number;
  /**
   * When a Konami artwork already had a vector, and so wasn't added: at `clearly` cosine or more to one of its card's
   * YGOPRODeck images, or as the one artwork closest to such an image at `closest` or more (tools/add-alt-artworks.ts).
   */
  covered: { clearly: number; closest: number };
  /** Which model's vectors decided what was covered. */
  decidedBy: string;
  addedAt: string;
}

export interface IndexMeta {
  modelId: string;
  dim: number;
  count: number;
  quant: IndexQuant;
  builtAt: string;
  /** YGOPRODeck database_version the index was built from. */
  dbVersion?: string;
  /** Present when the index also holds artworks YGOPRODeck lacks (entries with source 'konami'). */
  altArtworks?: AltArtworksInfo;
  /** One entry per vector, in the same order. */
  entries: IndexEntry[];
}

export interface LoadedIndex {
  meta: IndexMeta;
  vectors: Int8Array | Float32Array;
}

export function quantizeInt8(v: Float32Array): Int8Array {
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, v[i])) * 127);
  return out;
}

export function encodeIndexBinary(
  dim: number,
  count: number,
  quant: IndexQuant,
  vectors: Int8Array | Float32Array,
): Uint8Array {
  if (vectors.length !== dim * count) throw new Error(`Expected ${dim * count} values, got ${vectors.length}`);
  const body = new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  const out = new Uint8Array(HEADER_BYTES + body.byteLength);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, INDEX_VERSION, true);
  view.setUint32(8, dim, true);
  view.setUint32(12, count, true);
  view.setUint32(16, quant === 'int8' ? 1 : 0, true);
  out.set(body, HEADER_BYTES);
  return out;
}

export function decodeIndex(bin: ArrayBufferLike, meta: IndexMeta): LoadedIndex {
  const bytes = new Uint8Array(bin);
  if (bytes.length < HEADER_BYTES || MAGIC.some((m, i) => bytes[i] !== m)) {
    throw new Error('This file is not a Duel Lens index (bad magic)');
  }
  const view = new DataView(bin);
  const version = view.getUint32(4, true);
  const dim = view.getUint32(8, true);
  const count = view.getUint32(12, true);
  const quant: IndexQuant = view.getUint32(16, true) === 1 ? 'int8' : 'float32';
  if (version !== INDEX_VERSION) throw new Error(`Unsupported index version ${version}`);
  if (dim !== meta.dim || count !== meta.count || quant !== meta.quant || meta.entries.length !== count) {
    throw new Error(
      `Index metadata does not match the binary (binary: dim ${dim}, count ${count}, ${quant}; ` +
        `meta: dim ${meta.dim}, count ${meta.count}, ${meta.quant}, ${meta.entries.length} entries)`,
    );
  }
  const bytesPer = quant === 'int8' ? 1 : 4;
  if (bytes.length < HEADER_BYTES + dim * count * bytesPer) throw new Error('Index file is truncated');
  const vectors =
    quant === 'int8' ? new Int8Array(bin, HEADER_BYTES, dim * count) : new Float32Array(bin, HEADER_BYTES, dim * count);
  return { meta, vectors };
}
