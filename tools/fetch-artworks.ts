// Downloads every card artwork crop (YGOPRODeck cards_cropped) into data/artworks/<imageId>.jpg,
// politely: at most 8 requests per second, 4 at a time. Existing files (> 1 KB) are skipped,
// so the script can be re-run to resume. Failures are listed in data/artworks/failures.json.
// When YGOPRODeck has no crop of an artwork (404), the art box is cut from the full card image
// instead (src/shared/card-layout.ts) and listed in data/artworks/derived.json.
//
// Usage: npx tsx tools/fetch-artworks.ts [--limit N]
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { CardRecord } from '../src/shared/types';
import { artBoxFor, artBoxPixels, cardImageUrl, listArtworks, type ArtworkRef } from './lib/artworks';
import { createRateLimiter, politeFetch } from './lib/http';

const root = path.resolve(import.meta.dirname, '..');
const CARDS = path.join(root, 'extension/data/cards.json');
const OUT_DIR = path.join(root, 'data/artworks');
const FAILURES = path.join(OUT_DIR, 'failures.json');
const DERIVED = path.join(OUT_DIR, 'derived.json');
const RATE = 8;
const CONCURRENCY = 4;
const MIN_BYTES = 1024;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const artworkPath = (imageId: number) => path.join(OUT_DIR, `${imageId}.jpg`);
const have = (file: string) => existsSync(file) && statSync(file).size > MIN_BYTES;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

async function getJpeg(url: string, limiter: () => Promise<void>): Promise<Buffer> {
  const res = await politeFetch(url, { limiter, retries: 4, backoffMs: 2000 });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
  if (buf[0] === 0xff && buf[1] === 0xd8) return buf;
  // A few files are PNGs behind a .jpg name: re-encode anything sharp can decode.
  try {
    return await sharp(buf).flatten({ background: '#000' }).jpeg({ quality: 95 }).toBuffer();
  } catch {
    throw new Error(`not an image (${res.headers.get('content-type')})`);
  }
}

/** Returns true when the artwork had to be cut from the full card image. */
async function download(a: ArtworkRef, frameType: string, limiter: () => Promise<void>): Promise<boolean> {
  let buf: Buffer;
  let derived = false;
  try {
    buf = await getJpeg(a.url, limiter);
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
    const full = await getJpeg(cardImageUrl(a.imageId), limiter);
    const { width = 0, height = 0 } = await sharp(full).metadata();
    const box = artBoxPixels(width, height, artBoxFor(frameType));
    buf = await sharp(full).extract(box).jpeg({ quality: 92 }).toBuffer();
    derived = true;
  }
  const file = artworkPath(a.imageId);
  await writeFile(`${file}.part`, buf);
  await rename(`${file}.part`, file);
  return derived;
}

async function main() {
  const { cards } = JSON.parse(await readFile(CARDS, 'utf8')) as { cards: CardRecord[] };
  let all = listArtworks(cards);
  const limit = Number(arg('--limit') ?? 0);
  if (limit > 0) all = all.slice(0, limit);
  await mkdir(OUT_DIR, { recursive: true });
  const todo = all.filter((a) => !have(artworkPath(a.imageId)));
  console.log(`${all.length} artworks, ${all.length - todo.length} already present, ${todo.length} to download`);

  const frameOf = new Map(cards.map((c) => [c.id, c.frameType]));
  const derived: ArtworkRef[] = existsSync(DERIVED) ? JSON.parse(await readFile(DERIVED, 'utf8')) : [];
  const limiter = createRateLimiter(RATE);
  const failures: (ArtworkRef & { error: string })[] = [];
  const t0 = Date.now();
  let next = 0;
  let done = 0;
  const report = async () => {
    const secs = (Date.now() - t0) / 1000;
    const eta = done > 0 ? ((todo.length - done) * secs) / done : 0;
    console.log(
      `${done}/${todo.length} (${failures.length} failed) · ${secs.toFixed(0)} s elapsed · ETA ${(eta / 60).toFixed(1)} min`,
    );
    await writeFile(FAILURES, JSON.stringify(failures, null, 1));
    await writeFile(DERIVED, JSON.stringify(derived, null, 1));
  };
  const worker = async () => {
    while (next < todo.length) {
      const a = todo[next++];
      try {
        if (await download(a, frameOf.get(a.cardId) ?? '', limiter)) derived.push(a);
      } catch (err) {
        failures.push({ ...a, error: (err as Error).message });
      }
      done++;
      if (done % 250 === 0) await report();
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await report();
  const present = all.filter((a) => have(artworkPath(a.imageId))).length;
  console.log(
    `done: ${present}/${all.length} artworks on disk (${derived.length} cut from full card images), ` +
      `${failures.length} failures (${path.relative(root, FAILURES)})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
