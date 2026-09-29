// Builds the artwork-embedding index for one model:
//   data/artworks/<imageId>.jpg (+ data/card-back.jpg) → extension/data/index-<model>.bin/.meta.json
//
// Usage: npx tsx tools/build-index.ts --model <id> [--limit N] [--threads N] [--out-dir DIR]
//   --out-dir  write somewhere other than extension/data (e.g. for experiments)
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dropPlaceholders } from '../src/offscreen/placeholder-art';
import type { IndexEntry } from '../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel } from '../src/shared/models';
import type { RGBAImage } from '../src/shared/preprocess';
import { CARD_BACK_ID, type CardRecord } from '../src/shared/types';
import { listArtworks } from './lib/artworks';
import { loadRGBA } from './lib/image';
import { buildIndexArtefacts } from './lib/index-builder';
import { createNodeEmbedder } from './lib/ort-node';

const root = path.resolve(import.meta.dirname, '..');
const CARDS = path.join(root, 'extension/data/cards.json');
const ARTWORKS = path.join(root, 'data/artworks');
const CARD_BACK = path.join(root, 'data/card-back.jpg');
const OUT_DIR = path.join(root, 'extension/data');
const CHUNK = 32;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Item {
  entry: IndexEntry;
  file: string;
}

async function decode(items: Item[]): Promise<{ entry: IndexEntry; img: RGBAImage }[]> {
  const out = await Promise.all(
    items.map(async ({ entry, file }) => {
      try {
        return { entry, img: await loadRGBA(file) };
      } catch (err) {
        console.warn(`skipping ${path.relative(root, file)}: ${(err as Error).message}`);
        return undefined;
      }
    }),
  );
  return out.filter((x) => x !== undefined);
}

async function main() {
  const spec = getModel(arg('--model') ?? DEFAULT_MODEL_ID);
  const { dbVersion, cards } = JSON.parse(await readFile(CARDS, 'utf8')) as { dbVersion: string; cards: CardRecord[] };
  const refs = listArtworks(cards);
  let items: Item[] = refs
    .map((a) => ({ entry: { imageId: a.imageId, cardId: a.cardId }, file: path.join(ARTWORKS, `${a.imageId}.jpg`) }))
    .filter((it) => existsSync(it.file));
  const missing = refs.length - items.length;
  const limit = Number(arg('--limit') ?? 0);
  if (limit > 0) items = items.slice(0, limit);
  if (existsSync(CARD_BACK)) items.push({ entry: { imageId: CARD_BACK_ID, cardId: CARD_BACK_ID }, file: CARD_BACK });
  else console.warn('data/card-back.jpg not found: building without the card back (face-down) entry');
  console.log(
    `${spec.id}: embedding ${items.length} images (${missing} of ${refs.length} artworks not downloaded), ` +
      `batches of ${spec.maxBatch ?? 16}`,
  );

  const embedder = await createNodeEmbedder(spec, { threads: Number(arg('--threads') ?? 0) || undefined });
  const entries: IndexEntry[] = [];
  const vectors: Float32Array[] = [];
  const t0 = performance.now();
  let pending = decode(items.slice(0, CHUNK));
  for (let start = 0; start < items.length; start += CHUNK) {
    const batch = await pending;
    if (start + CHUNK < items.length) pending = decode(items.slice(start + CHUNK, start + 2 * CHUNK));
    const vecs = await embedder.embed(batch.map((b) => b.img));
    batch.forEach((b, i) => {
      entries.push(b.entry);
      vectors.push(vecs[i]);
    });
    const done = start + batch.length;
    if (Math.floor(done / 1000) > Math.floor(start / 1000) || done === items.length) {
      const secs = (performance.now() - t0) / 1000;
      console.log(
        `  ${done}/${items.length} · ${((secs * 1000) / done).toFixed(1)} ms/image · ` +
          `ETA ${(((items.length - done) * secs) / done / 60).toFixed(1)} min`,
      );
    }
  }
  await embedder.release();

  // YGOPRODeck serves the card back as the artwork of a card whose art isn't uploaded yet: leave
  // those out (src/offscreen/placeholder-art.ts), so that a face-down card can't read as one of
  // them and the self-updating index fetches their real art once it is up.
  const kept = dropPlaceholders(entries, vectors);
  if (!entries.some((e) => e.cardId === CARD_BACK_ID)) console.warn('no card back to compare with: card-back placeholder artworks are not left out');
  for (const e of kept.dropped) console.warn(`left out artwork ${e.imageId} (card ${e.cardId}): it is the card back, a placeholder`);

  const { bin, metaJson } = buildIndexArtefacts(kept.entries, kept.vectors, { modelId: spec.id, dbVersion });
  const dir = path.resolve(arg('--out-dir') ?? OUT_DIR);
  const out = { bin: path.join(dir, `index-${spec.id}.bin`), meta: path.join(dir, `index-${spec.id}.meta.json`) };
  await mkdir(dir, { recursive: true });
  await writeFile(out.bin, bin);
  await writeFile(out.meta, metaJson);
  console.log(
    `${spec.id}: wrote ${path.relative(root, out.bin)} (${(bin.byteLength / 1e6).toFixed(2)} MB, ${kept.entries.length} vectors × ${vectors[0].length}) ` +
      `and ${path.relative(root, out.meta)} (${(Buffer.byteLength(metaJson) / 1e6).toFixed(2)} MB), ` +
      `database ${dbVersion}, ${((performance.now() - t0) / 60000).toFixed(1)} min`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
