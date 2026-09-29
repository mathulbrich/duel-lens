// Fetches the English card back from Yugipedia (File:Back-EN.png) once and saves the region a
// face-down card's "artwork" crop would cover (ART_BOX) as data/card-back.jpg, which
// tools/build-index.ts embeds as the card-back entry (cardId CARD_BACK_ID).
//
// Usage: npx tsx tools/fetch-card-back.ts [--force]
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ART_BOX } from '../src/shared/card-layout';
import { createRateLimiter, politeFetch } from './lib/http';

const root = path.resolve(import.meta.dirname, '..');
const OUT = path.join(root, 'data/card-back.jpg');
const FULL = path.join(root, 'data/raw/card-back-full.png');
const API = 'https://yugipedia.com/api.php?action=query&format=json&prop=imageinfo&iiprop=url|size&titles=File:Back-EN.png';

// Yugipedia etiquette: at most 1 request per second (the UA names the project).
const limiter = createRateLimiter(1);

async function main() {
  if (existsSync(OUT) && !process.argv.includes('--force')) {
    console.log(`${path.relative(root, OUT)} already exists (use --force to fetch again)`);
    return;
  }
  const info = await politeFetch(API, { limiter });
  if (!info.ok) throw new Error(`Yugipedia API → HTTP ${info.status}`);
  const pages = ((await info.json()) as { query: { pages: Record<string, { imageinfo?: { url: string }[] }> } }).query.pages;
  const url = Object.values(pages)[0]?.imageinfo?.[0]?.url;
  if (!url) throw new Error('File:Back-EN.png has no image URL');
  const res = await politeFetch(url, { limiter });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const png = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(FULL), { recursive: true });
  await writeFile(FULL, png);

  // Trim a transparent margin (if any) so the fractions apply to the card itself.
  const card = await sharp(png).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 }).png().toBuffer({ resolveWithObject: true });
  const { width, height } = card.info;
  const box = {
    left: Math.round(ART_BOX.x * width),
    top: Math.round(ART_BOX.y * height),
    width: Math.round(ART_BOX.w * width),
    height: Math.round(ART_BOX.h * height),
  };
  await sharp(card.data).extract(box).flatten({ background: '#000' }).jpeg({ quality: 95 }).toFile(OUT);
  console.log(`card back ${width}×${height} (from ${url}); art box ${box.width}×${box.height} → ${path.relative(root, OUT)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
