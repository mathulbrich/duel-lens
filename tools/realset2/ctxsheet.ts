// realset2 context sheet: for each covered box in data/realset2/context.jsonl, its crop from the set frame
// next to the same place in the context frames (tools/realset2/context.ts), each with the engine's read
// there, and the official image of the most frequent confident read: a person decides by eye whether the
// covered card is that card.
//
//   npx tsx tools/realset2/ctxsheet.ts --out <file.jpg> [--pids a#1,b#2]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { artOf, fullCardOf } from './lib/refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type AB = { x: number; y: number; w: number; h: number };
interface Ctx {
  dt: number;
  file: string;
  iou: number;
  userBox: AB | null;
  confident: boolean;
  top: { cardId: number; name: string; score: number }[];
}

const H = 230;
async function cropOf(file: string, b: AB): Promise<Buffer> {
  const meta = await sharp(file).metadata();
  const m = 0.25;
  const x0 = Math.max(0, Math.floor(b.x - b.w * m));
  const y0 = Math.max(0, Math.floor(b.y - b.h * m));
  const x1 = Math.min(meta.width!, Math.ceil(b.x + b.w * (1 + m)));
  const y1 = Math.min(meta.height!, Math.ceil(b.y + b.h * (1 + m)));
  const svg = Buffer.from(`<svg width="${x1 - x0}" height="${y1 - y0}"><rect x="${b.x - x0}" y="${b.y - y0}" width="${b.w}" height="${b.h}" fill="none" stroke="#00ff66" stroke-opacity="0.6" stroke-width="1.5"/></svg>`);
  const buf = await sharp(file).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).composite([{ input: svg }]).png().toBuffer();
  return sharp(buf).resize({ height: H, width: H, fit: 'contain', background: '#222' }).png().toBuffer();
}

async function main() {
  const out = arg('--out');
  if (!out) throw new Error('--out <file.jpg>');
  const only = arg('--pids')?.split(',');
  const boxes = new Map<string, AB>();
  for (const line of readFileSync(path.join(OUT, 'proposals.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    for (const b of (JSON.parse(line) as { boxes: { pid: string; userBox: AB }[] }).boxes) boxes.set(b.pid, b.userBox);
  }
  const rows = readFileSync(path.join(OUT, 'context.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { pid: string; frame: string; ctx: Ctx[] })
    .filter((r) => !only || only.includes(r.pid));
  const layers: OverlayOptions[] = [];
  const W = H + 4;
  let y = 0;
  for (const [n, r] of rows.entries()) {
    const label = (x: number, text: string, color = '#ffd400') =>
      layers.push({ input: Buffer.from(`<svg width="${W}" height="20"><text x="2" y="15" font-size="13" font-family="Helvetica" fill="${color}">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 34)}</text></svg>`), left: x, top: y });
    label(0, `${n + 1} ${r.pid.slice(3)}`);
    layers.push({ input: await cropOf(path.join(OUT, 'frames', `${r.frame}.jpg`), boxes.get(r.pid)!), left: 0, top: y + 20 });
    let x = W + 8;
    const votes = new Map<number, number>();
    for (const c of r.ctx) {
      if (!c.userBox) continue;
      label(x, `${c.dt > 0 ? '+' : ''}${c.dt}s ${c.confident ? 'SURE' : '?'} ${c.top[0]?.name ?? '-'}`, c.confident ? '#7CFC00' : '#bbbbbb');
      layers.push({ input: await cropOf(path.join(ROOT, c.file), c.userBox), left: x, top: y + 20 });
      if (c.confident && c.top[0]) votes.set(c.top[0].cardId, (votes.get(c.top[0].cardId) ?? 0) + 1);
      x += W;
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      const ref = (await fullCardOf(best[0])) ?? artOf(best[0]);
      if (ref) layers.push({ input: await sharp(ref).resize(Math.round((H * 268) / 391), H, { fit: 'fill' }).png().toBuffer(), left: 6 * W + 12, top: y + 20 });
      label(6 * W + 12, `ref ${best[0]}`, '#ffffff');
    }
    y += H + 26;
  }
  await sharp({ create: { width: 6 * W + 12 + Math.round((H * 268) / 391) + 10, height: Math.max(y, 10), channels: 3, background: '#000' } })
    .composite(layers)
    .jpeg({ quality: 86 })
    .toFile(out);
  console.log(`${rows.length} rows -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
