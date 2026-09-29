// Integration: the placeholder threshold (placeholder-art.ts) with the real default model, the
// way the self-updating index applies it: a fresh embedding of each downloaded artwork against
// the bundled index's card-back entry. YGOPRODeck's card-back placeholders must be caught, and
// the most card-back-like real artworks kept. Skips when the model, the index or the artworks
// (data/artworks, tools/fetch-artworks.ts) are missing.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRGBA } from '../../tools/lib/image';
import { createNodeEmbedder, modelPath, type NodeEmbedder } from '../../tools/lib/ort-node';
import { decodeIndex, type IndexMeta } from '../shared/index-format';
import { DEFAULT_MODEL_ID, getModel } from '../shared/models';
import { cardBackVector, isPlaceholderArt } from './placeholder-art';

const ROOT = path.resolve(import.meta.dirname, '../..');
const spec = getModel(DEFAULT_MODEL_ID);
const art = (imageId: number) => path.join(ROOT, 'data/artworks', `${imageId}.jpg`);
const indexFile = (ext: string) => path.join(ROOT, 'extension/data', `index-${spec.id}.${ext}`);

/** YGOPRODeck's card back, served as these cards' artwork on 2026-09-28. */
const PLACEHOLDERS = [100460002, 100460004, 101206080];
/**
 * The real artworks closest to the card back in the bundled index (Mystical Space Typhoon, Neo
 * Space, Red-Eyes Fusion, Burgeoning Whirlflame, Dark Hole, ZERO-MAX), and two cards whose small
 * image was a placeholder while their cropped art is real (Ilios, Abyss Vagrada).
 */
const REAL = [5318639, 42015635, 6172122, 86690572, 53129443, 30562585, 19438484, 100460003];

const ready = existsSync(modelPath(spec)) && existsSync(indexFile('bin')) && [...PLACEHOLDERS, ...REAL].every((id) => existsSync(art(id)));

describe.skipIf(!ready)('placeholder artwork, with the real default model', () => {
  let embedder: NodeEmbedder;
  let back: Float32Array;
  const cosine = async (imageId: number) => {
    const [v] = await embedder.embed([await loadRGBA(art(imageId))]);
    return { v, cos: v.reduce((s, x, i) => s + x * back[i], 0) };
  };

  beforeAll(async () => {
    const bin = readFileSync(indexFile('bin'));
    const meta = JSON.parse(readFileSync(indexFile('meta.json'), 'utf8')) as IndexMeta;
    back = cardBackVector(decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta))!;
    embedder = await createNodeEmbedder(spec);
  }, 60_000);

  afterAll(async () => {
    await embedder?.release();
  });

  it('catches every card-back placeholder and keeps the most card-back-like real artworks', async () => {
    const seen: string[] = [];
    for (const id of PLACEHOLDERS) {
      const { v, cos } = await cosine(id);
      seen.push(`placeholder ${id} ${cos.toFixed(3)}`);
      expect(isPlaceholderArt(v, back), `${id} at ${cos.toFixed(3)}`).toBe(true);
    }
    for (const id of REAL) {
      const { v, cos } = await cosine(id);
      seen.push(`real ${id} ${cos.toFixed(3)}`);
      expect(isPlaceholderArt(v, back), `${id} at ${cos.toFixed(3)}`).toBe(false);
    }
    console.log(`[placeholder-art.int] ${spec.id}: ${seen.join(', ')}`);
  }, 60_000);
});
