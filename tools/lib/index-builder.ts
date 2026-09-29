// Turns embedded artworks into the shipped index artefacts (index-<model>.bin + .meta.json).
import { encodeIndexBinary, quantizeInt8, type IndexEntry, type IndexMeta } from '../../src/shared/index-format';

export interface IndexBuildInfo {
  modelId: string;
  /** YGOPRODeck database_version of the card data the artworks came from. */
  dbVersion?: string;
  /** ISO timestamp; defaults to now. */
  builtAt?: string;
}

/** int8-quantise L2-normalised vectors; entries[i] describes vectors[i]. */
export function buildIndexArtefacts(
  entries: IndexEntry[],
  vectors: Float32Array[],
  info: IndexBuildInfo,
): { bin: Uint8Array; metaJson: string } {
  if (vectors.length === 0) throw new Error('Cannot build an empty index');
  if (entries.length !== vectors.length) {
    throw new Error(`Got ${entries.length} entries for ${vectors.length} vectors`);
  }
  const dim = vectors[0].length;
  const count = vectors.length;
  const all = new Int8Array(dim * count);
  vectors.forEach((v, i) => {
    if (v.length !== dim) throw new Error(`Vector ${i} has dim ${v.length}, expected ${dim}`);
    all.set(quantizeInt8(v), i * dim);
  });
  const meta: IndexMeta = {
    modelId: info.modelId,
    dim,
    count,
    quant: 'int8',
    builtAt: info.builtAt ?? new Date().toISOString(),
    ...(info.dbVersion !== undefined ? { dbVersion: info.dbVersion } : {}),
    entries: entries.map(({ imageId, cardId }) => ({ imageId, cardId })),
  };
  return { bin: encodeIndexBinary(dim, count, 'int8', all), metaJson: JSON.stringify(meta) };
}
