// Builds the contact sheet the lead spot-checks: for every entry in data/realset/set.json, the
// real crop (built exactly like the content script — see lib/crop.ts) next to the clean artwork
// of its label. Also writes verify.md, a plain listing of every id for quick cross-reference.
//
// Usage: npx tsx tools/realset/verify.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { RGBAImage } from '../../src/shared/preprocess';
import { loadRGBA } from '../lib/image';
import { loadCards, ROOT } from './lib/cards';
import { RATIO_GATE } from './lib/constants';
import { buildCrop } from './lib/crop';
import type { RealsetEntry } from './lib/types';

const SET_PATH = path.join(ROOT, 'data/realset/set.json');
const FRAMES_DIR = path.join(ROOT, 'data/debug/frames');
const ARTWORKS_DIR = path.join(ROOT, 'data/artworks');
const OUT_PNG = path.join(ROOT, 'data/realset/verify.png');
const OUT_MD = path.join(ROOT, 'data/realset/verify.md');

const CELL_W = 170;
const CELL_H = 230;
const LABEL_W = 470;
const ROW_H = 240;
const PAD = 10;
const HEADER_H = 40;
const BG = { r: 17, g: 17, b: 17, alpha: 1 };
const CELL_BG = { r: 24, g: 24, b: 24, alpha: 1 };

function toBuffer(img: RGBAImage): Buffer {
  return Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
}

/** Fit `img` inside w x h, letterboxed; a flat placeholder when there is nothing to show. */
async function thumbnail(img: RGBAImage | null, w: number, h: number): Promise<Buffer> {
  if (!img || img.width < 1 || img.height < 1) {
    return sharp({ create: { width: w, height: h, channels: 4, background: CELL_BG } })
      .png()
      .toBuffer();
  }
  return sharp(toBuffer(img), { raw: { width: img.width, height: img.height, channels: 4 } })
    .resize(w, h, { fit: 'contain', background: CELL_BG })
    .png()
    .toBuffer();
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const entries = JSON.parse(readFileSync(SET_PATH, 'utf8')) as RealsetEntry[];
  const cards = loadCards();

  const frameCache = new Map<string, RGBAImage>();
  async function loadFrame(frame: string): Promise<RGBAImage> {
    const cached = frameCache.get(frame);
    if (cached) return cached;
    const img = await loadRGBA(path.join(FRAMES_DIR, `${frame}.png`));
    frameCache.set(frame, img);
    return img;
  }

  const sorted = [...entries].sort((a, b) => a.frame.localeCompare(b.frame) || a.id.localeCompare(b.id));

  const width = PAD * 4 + LABEL_W + CELL_W * 2;
  const height = HEADER_H + PAD + sorted.length * (ROW_H + PAD);

  const composites: { input: Buffer; left: number; top: number }[] = [];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
  svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="#111"/>`;
  svg +=
    `<text x="${PAD}" y="26" font-size="20" font-family="monospace" fill="#eee">` +
    `Duel Lens real-set verify sheet — ${sorted.length} entries (real crop | clean artwork)</text>`;
  svg +=
    `<text x="${PAD + LABEL_W + PAD * 2}" y="${HEADER_H - 4}" font-size="14" font-family="monospace" fill="#888">real crop</text>`;
  svg +=
    `<text x="${PAD + LABEL_W + PAD * 3 + CELL_W}" y="${HEADER_H - 4}" font-size="14" font-family="monospace" fill="#888">artwork</text>`;

  let y = HEADER_H + PAD;
  for (const e of sorted) {
    const frameImg = await loadFrame(e.frame);
    const crop = buildCrop(frameImg, e.userBox).cropImg;
    composites.push({ input: await thumbnail(crop, CELL_W, CELL_H), left: PAD * 2 + LABEL_W, top: y });

    const card = e.cardId != null ? cards.byId.get(e.cardId) : undefined;
    const imageId = card?.imageIds[0] ?? e.cardId;
    const artPath = imageId != null ? path.join(ARTWORKS_DIR, `${imageId}.jpg`) : '';
    const artImg = artPath && existsSync(artPath) ? await loadRGBA(artPath) : null;
    composites.push({
      input: await thumbnail(artImg, CELL_W, CELL_H),
      left: PAD * 3 + LABEL_W + CELL_W,
      top: y,
    });

    const confident = e.source === 'human' || (e.teacherRatio ?? 0) >= RATIO_GATE;
    const tag = e.source === 'human' ? 'HUMAN, verified' : confident ? `TEACHER, ratio ${e.teacherRatio} (ok)` : `TEACHER, ratio ${e.teacherRatio} (uncertain)`;
    const color = e.source === 'human' ? '#5ec26a' : confident ? '#e8c15a' : '#e0654a';
    const lines = [e.id, tag + (e.occluded ? '  [OCCLUDED]' : ''), e.name, `cardId ${e.cardId}  p=${e.teacherProb ?? '–'}`];
    svg += `<rect x="${PAD}" y="${y}" width="${LABEL_W}" height="${CELL_H}" fill="#1b1b1b" stroke="${color}" stroke-width="2"/>`;
    lines.forEach((line, i) => {
      svg +=
        `<text x="${PAD + 12}" y="${y + 26 + i * 24}" font-size="${i === 0 ? 16 : 14}" ` +
        `font-family="monospace" fill="${i === 1 ? color : '#eee'}">${esc(line)}</text>`;
    });
    y += ROW_H + PAD;
  }
  svg += '</svg>';

  await sharp({ create: { width, height, channels: 4, background: BG } })
    .composite([{ input: Buffer.from(svg) }, ...composites])
    .png()
    .toFile(OUT_PNG);

  const human = sorted.filter((e) => e.source === 'human').length;
  const md = [
    '# Duel Lens real-set verify sheet',
    '',
    `${sorted.length} entries: ${human} identified by a person, ${sorted.length - human} teacher pseudo-labels (see tools/realset/README.md).`,
    'See verify.png for the real crop next to the clean artwork of each label.',
    '',
    '| id | source | verified | teacherRatio | cardId | name |',
    '|---|---|---|---|---|---|',
    ...sorted.map(
      (e) =>
        `| ${e.id} | ${e.source} | ${e.verified} | ${e.teacherRatio ?? ''} | ${e.cardId} | ${e.name}${e.occluded ? ' (occluded)' : ''} |`,
    ),
  ].join('\n');
  writeFileSync(OUT_MD, md);

  console.log(`[verify] wrote data/realset/verify.png (${width}x${height}) and data/realset/verify.md`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
