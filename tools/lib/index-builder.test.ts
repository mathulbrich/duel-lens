import { describe, expect, it } from 'vitest';
import { decodeIndex, type IndexEntry, type IndexMeta } from '../../src/shared/index-format';
import { l2normalize } from '../../src/shared/preprocess';
import { topKByCard } from '../../src/shared/search';
import { buildIndexArtefacts } from './index-builder';

const unit = (xs: number[]) => l2normalize(Float32Array.from(xs));
const arrayBufferOf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

const entries: IndexEntry[] = [
  { imageId: 10, cardId: 1 },
  { imageId: 20, cardId: 2 },
  { imageId: 30, cardId: -1 },
];
const vectors = [unit([1, 0, 0]), unit([0, 1, 0]), unit([0.6, 0.8, 0])];

describe('buildIndexArtefacts', () => {
  it('writes int8 vectors and metadata that decodeIndex accepts', () => {
    const { bin, metaJson } = buildIndexArtefacts(entries, vectors, {
      modelId: 'm',
      dbVersion: '147.20',
      builtAt: '2026-09-28T00:00:00.000Z',
    });
    const meta = JSON.parse(metaJson) as IndexMeta;
    expect(meta).toEqual({
      modelId: 'm',
      dim: 3,
      count: 3,
      quant: 'int8',
      builtAt: '2026-09-28T00:00:00.000Z',
      dbVersion: '147.20',
      entries,
    });
    const index = decodeIndex(arrayBufferOf(bin), meta);
    expect(index.vectors).toBeInstanceOf(Int8Array);
    expect(Array.from(index.vectors)).toEqual([127, 0, 0, 0, 127, 0, 76, 102, 0]);
  });

  it('keeps entries in vector order, so each vector finds its own entry', () => {
    const { bin, metaJson } = buildIndexArtefacts(entries, vectors, { modelId: 'm' });
    const index = decodeIndex(arrayBufferOf(bin), JSON.parse(metaJson) as IndexMeta);
    vectors.forEach((v, i) => {
      const [top] = topKByCard(v, index, 1);
      expect(top).toMatchObject({ imageId: entries[i].imageId, cardId: entries[i].cardId });
      expect(top.score).toBeCloseTo(1, 2);
    });
  });

  it('stamps builtAt when not given and omits a missing dbVersion', () => {
    const meta = JSON.parse(buildIndexArtefacts(entries, vectors, { modelId: 'm' }).metaJson) as IndexMeta;
    expect(Number.isNaN(Date.parse(meta.builtAt))).toBe(false);
    expect(meta).not.toHaveProperty('dbVersion');
  });

  it('rejects mismatched inputs', () => {
    expect(() => buildIndexArtefacts(entries.slice(0, 2), vectors, { modelId: 'm' })).toThrow(/entries/);
    expect(() => buildIndexArtefacts(entries, [vectors[0], vectors[1], unit([1, 0])], { modelId: 'm' })).toThrow(/dim/);
    expect(() => buildIndexArtefacts([], [], { modelId: 'm' })).toThrow(/empty/);
  });
});
