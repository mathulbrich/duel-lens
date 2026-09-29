// Real-model checks: skipped for any model whose file is not in extension/models/ yet,
// and when no artwork has been downloaded to data/artworks/ (npm run data:artworks).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODELS } from '../../src/shared/models';
import { rotate180 } from '../../src/shared/preprocess';
import { degrade } from './degrade';
import { loadRGBA } from './image';
import { createNodeEmbedder, modelPath } from './ort-node';

const ARTWORKS = path.resolve(import.meta.dirname, '../../data/artworks');

function sampleArtwork(): string | undefined {
  const known = ['89631139', '14558127'].map((id) => path.join(ARTWORKS, `${id}.jpg`)).find(existsSync);
  if (known || !existsSync(ARTWORKS)) return known;
  const any = readdirSync(ARTWORKS).find((f) => f.endsWith('.jpg'));
  return any && path.join(ARTWORKS, any);
}

const sample = sampleArtwork();

/** 50 artworks spread over data/artworks (sorted by file name), or none if fewer are downloaded. */
function spreadArtworks(count: number): string[] {
  if (!existsSync(ARTWORKS)) return [];
  const all = readdirSync(ARTWORKS).filter((f) => f.endsWith('.jpg')).sort();
  if (all.length < count) return [];
  const step = Math.floor(all.length / count);
  return Array.from({ length: count }, (_, i) => path.join(ARTWORKS, all[i * step]));
}

const gallery = spreadArtworks(50);
const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);

describe.each(Object.values(MODELS))('$id on onnxruntime-node', (spec) => {
  const ready = existsSync(modelPath(spec)) && sample !== undefined;

  it.skipIf(!ready)('embeds a real artwork into a unit vector of spec.dim', async () => {
    const embedder = await createNodeEmbedder(spec);
    try {
      const [v] = await embedder.embed([await loadRGBA(sample!)]);
      expect(v).toHaveLength(spec.dim);
      expect(Math.sqrt(dot(v, v))).toBeCloseTo(1, 4);
    } finally {
      await embedder.release();
    }
  });

  // Guards against a model file that is broken for retrieval (Xenova's int8 MobileCLIP-S0 kept
  // only 13 of 40 mildly degraded artworks on top among 2,000; its float weights kept 40).
  it.skipIf(!existsSync(modelPath(spec)) || gallery.length === 0)(
    'finds mildly degraded artworks among 50 clean ones',
    async () => {
      const embedder = await createNodeEmbedder(spec);
      try {
        const clean = await Promise.all(gallery.map((f) => loadRGBA(f)));
        const refs = await embedder.embed(clean);
        for (let q = 0; q < 5; q++) {
          const [v] = await embedder.embed([await degrade(clean[q], 'mild', q + 1)]);
          const best = refs.reduce((b, r, i) => (dot(v, r) > dot(v, refs[b]) ? i : b), 0);
          expect(best, `query ${q} (${path.basename(gallery[q])})`).toBe(q);
        }
      } finally {
        await embedder.release();
      }
    },
    60_000,
  );

  // Dynamically quantised (int8) graphs compute activation scales over the whole batch, so a
  // vector would depend on its batch neighbours; those models must declare maxBatch: 1.
  it.skipIf(!ready || spec.maxBatch === 1)('gives the same vectors for a batch of 2 as one by one', async () => {
    const embedder = await createNodeEmbedder({ ...spec, maxBatch: 2 });
    try {
      const img = await loadRGBA(sample!);
      const imgs = [img, rotate180(img)];
      const batched = await embedder.embed(imgs);
      const single = [(await embedder.embed([imgs[0]]))[0], (await embedder.embed([imgs[1]]))[0]];
      expect(batched).toHaveLength(2);
      for (let i = 0; i < 2; i++) expect(dot(batched[i], single[i])).toBeGreaterThan(0.999);
    } finally {
      await embedder.release();
    }
  });
});
