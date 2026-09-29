// Measures where YGOPRODeck's artwork crop (cards_cropped/<id>.jpg) sits inside the full
// card image (cards/<id>.jpg, 813x1185), to derive ART_BOX / ART_BOX_PENDULUM in
// src/shared/card-layout.ts. Not imported by any entry point.
//
// Usage: npx tsx src/offscreen/__measure__/measure-art-box.ts
// Images are downloaded once into data/measure/ (at most ~6 requests per second).
//
// Method: the crop is a rescaled copy of the art window, so we search over scale and
// position. Grayscale mean-squared difference, coarse at 1/8 scale over every size and
// offset, then refined at 1/4 scale and finally at full scale.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { resizeToFloatRGB, type RGBAImage } from '../../shared/preprocess';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT_DIR = path.join(ROOT, 'data/measure');
const UA = 'DuelLens/0.1 (personal project; art-box measurement)';

const CARDS: { id: number; kind: 'standard' | 'pendulum'; label: string }[] = [
  { id: 46986414, kind: 'standard', label: 'Dark Magician (normal)' },
  { id: 14558127, kind: 'standard', label: 'Ash Blossom & Joyous Spring (effect)' },
  { id: 55144522, kind: 'standard', label: 'Pot of Greed (spell)' },
  { id: 44095762, kind: 'standard', label: 'Mirror Force (trap)' },
  { id: 1861629, kind: 'standard', label: 'Decode Talker (link)' },
  { id: 84013237, kind: 'standard', label: 'Number 39: Utopia (xyz)' },
  { id: 44508094, kind: 'standard', label: 'Stardust Dragon (synchro)' },
  { id: 16178681, kind: 'pendulum', label: 'Odd-Eyes Pendulum Dragon (effect_pendulum)' },
  { id: 70026064, kind: 'pendulum', label: 'Bujin Hiruko (normal_pendulum)' },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function download(url: string, file: string): Promise<void> {
  if (existsSync(file)) return;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  await sleep(170); // stay well under 8 requests per second
}

async function decode(file: string): Promise<RGBAImage> {
  const { data, info } = await sharp(await readFile(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

function toGray(img: RGBAImage, width = img.width, height = img.height): Gray {
  const rgb = resizeToFloatRGB(img, width, height);
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  return { data, width, height };
}

/** Mean squared difference of `patch` placed at (x, y) in `img`. */
function msd(img: Gray, patch: Gray, x: number, y: number, stride = 1): number {
  let sum = 0;
  let n = 0;
  for (let py = 0; py < patch.height; py += stride) {
    const row = (y + py) * img.width + x;
    const prow = py * patch.width;
    for (let px = 0; px < patch.width; px += stride) {
      const d = img.data[row + px] - patch.data[prow + px];
      sum += d * d;
      n++;
    }
  }
  return sum / n;
}

interface Match {
  x: number;
  y: number;
  w: number;
  h: number;
  err: number;
}

/** Exhaustive search over widths in [wMin, wMax] and every position, at one scale. */
function search(
  full: RGBAImage,
  crop: RGBAImage,
  factor: number,
  widths: number[],
  pos?: { x0: number; x1: number; y0: number; y1: number },
): Match {
  const img = toGray(full, Math.round(full.width / factor), Math.round(full.height / factor));
  let best: Match = { x: 0, y: 0, w: 0, h: 0, err: Infinity };
  for (const wFull of widths) {
    const w = Math.round(wFull / factor);
    const h = Math.round((wFull * crop.height) / crop.width / factor);
    if (w < 8 || h < 8 || w > img.width || h > img.height) continue;
    const patch = toGray(crop, w, h);
    const x0 = pos ? Math.max(0, Math.floor(pos.x0 / factor)) : 0;
    const y0 = pos ? Math.max(0, Math.floor(pos.y0 / factor)) : 0;
    const x1 = pos ? Math.min(img.width - w, Math.ceil(pos.x1 / factor)) : img.width - w;
    const y1 = pos ? Math.min(img.height - h, Math.ceil(pos.y1 / factor)) : img.height - h;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const err = msd(img, patch, x, y, factor >= 4 ? 1 : 2);
        if (err < best.err) best = { x: x * factor, y: y * factor, w: w * factor, h: h * factor, err };
      }
    }
  }
  return best;
}

const range = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let v = from; v <= to; v += step) out.push(v);
  return out;
};

/** Top part of an image (rows [0, fraction * height)). */
function topPart(img: RGBAImage, fraction: number): RGBAImage {
  const height = Math.round(img.height * fraction);
  return { data: img.data.subarray(0, img.width * height * 4), width: img.width, height };
}

// Pendulum crops are the whole illustration; on the printed card only its top part is
// visible (the Pendulum and monster text boxes cover the rest), so match only that part.
const PENDULUM_VISIBLE = 0.5;

async function measure(
  id: number,
  kind: 'standard' | 'pendulum',
): Promise<{ full: RGBAImage; crop: RGBAImage; m: Match }> {
  const fullFile = path.join(OUT_DIR, `${id}-full.jpg`);
  const cropFile = path.join(OUT_DIR, `${id}-cropped.jpg`);
  await download(`https://images.ygoprodeck.com/images/cards/${id}.jpg`, fullFile);
  await download(`https://images.ygoprodeck.com/images/cards_cropped/${id}.jpg`, cropFile);
  const full = await decode(fullFile);
  const crop = await decode(cropFile);
  const probe = kind === 'pendulum' ? topPart(crop, PENDULUM_VISIBLE) : crop;
  // 1/8 scale: every width from 40% to 100% of the card width, every position.
  const coarse = search(full, probe, 8, range(Math.round(full.width * 0.4), full.width, 8));
  // 1/4 scale around the coarse match.
  const mid = search(full, probe, 4, range(coarse.w - 16, coarse.w + 16, 4), {
    x0: coarse.x - 16, x1: coarse.x + 16, y0: coarse.y - 16, y1: coarse.y + 16,
  });
  // Full scale: every width and position within a few pixels.
  const fine = search(full, probe, 1, range(mid.w - 6, mid.w + 6, 1), {
    x0: mid.x - 6, x1: mid.x + 6, y0: mid.y - 6, y1: mid.y + 6,
  });
  // Report the box of the whole crop (same origin and scale as the matched part).
  return { full, crop, m: { ...fine, h: Math.round((fine.w * crop.height) / crop.width) } };
}

/**
 * First row below `top` where the card stops showing artwork: the row whose mean
 * brightness jumps most (the Pendulum text box border), searched in [from, to).
 */
function textBoxTop(full: RGBAImage, x0: number, x1: number, from: number, to: number): number {
  const g = toGray(full);
  const rowMean = (y: number) => {
    let s = 0;
    for (let x = x0; x < x1; x++) s += g.data[y * g.width + x];
    return s / (x1 - x0);
  };
  let best = from;
  let bestJump = -Infinity;
  for (let y = from + 2; y < to - 2; y++) {
    const jump = Math.abs(rowMean(y + 2) - rowMean(y - 2));
    if (jump > bestJump) {
      bestJump = jump;
      best = y;
    }
  }
  return best;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const rows: Record<'standard' | 'pendulum', number[][]> = { standard: [], pendulum: [] };
  for (const card of CARDS) {
    const { full, crop, m } = await measure(card.id, card.kind);
    const f = [m.x / full.width, m.y / full.height, m.w / full.width, m.h / full.height];
    rows[card.kind].push(f);
    console.log(
      `${card.label.padEnd(44)} full ${full.width}x${full.height} crop ${crop.width}x${crop.height} → ` +
        `x=${m.x} y=${m.y} w=${m.w} h=${m.h} (rms ${Math.sqrt(m.err).toFixed(1)}) ` +
        `fractions ${f.map((v) => v.toFixed(4)).join(' ')}`,
    );
    if (card.kind === 'pendulum') {
      // Inner strip of the art (avoids the Pendulum Scale boxes at the sides).
      const y = textBoxTop(full, m.x + Math.round(m.w * 0.2), m.x + Math.round(m.w * 0.8), m.y + 200, m.y + m.h - 200);
      console.log(`  Pendulum text box starts at y=${y} (${(y / full.height).toFixed(4)} of the card height)`);
    }
  }
  for (const kind of ['standard', 'pendulum'] as const) {
    const r = rows[kind];
    const mean = [0, 1, 2, 3].map((i) => r.reduce((a, v) => a + v[i], 0) / r.length);
    const spread = [0, 1, 2, 3].map((i) => Math.max(...r.map((v) => v[i])) - Math.min(...r.map((v) => v[i])));
    console.log(
      `${kind}: x=${mean[0].toFixed(3)} y=${mean[1].toFixed(3)} w=${mean[2].toFixed(3)} h=${mean[3].toFixed(3)} ` +
        `(max-min spread ${spread.map((v) => v.toFixed(4)).join(' ')})`,
    );
  }
}

await main();
