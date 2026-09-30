// realset2 samples: a contact sheet of example crops per category (and of the negatives), each captioned
// with its label and, when a results file is given, the engine's answer; for the report.
//
//   npx tsx tools/realset2/samples.ts --out <file.jpg> [--per 6] [--results data/realset2/results-engine-<model>.json]
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Row {
  id: string;
  frame: string;
  userBox: { x: number; y: number; w: number; h: number };
  name: string;
  category: string;
  tags: string[];
}
interface Neg {
  id: string;
  frame: string;
  box: [number, number, number, number];
  design: string;
  category: string;
}
interface Res {
  id: string;
  confident: boolean;
  top1Correct?: boolean;
  candidates: { name: string; score: number }[];
}

const T = 190;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function crop(frame: string, b: { x: number; y: number; w: number; h: number }): Promise<Buffer> {
  const file = path.join(OUT, 'frames', `${frame}.jpg`);
  const m = 0.12;
  const x0 = Math.max(0, Math.floor(b.x - b.w * m));
  const y0 = Math.max(0, Math.floor(b.y - b.h * m));
  const x1 = Math.min(1920, Math.ceil(b.x + b.w * (1 + m)));
  const y1 = Math.min(1080, Math.ceil(b.y + b.h * (1 + m)));
  const svg = Buffer.from(`<svg width="${x1 - x0}" height="${y1 - y0}"><rect x="${b.x - x0}" y="${b.y - y0}" width="${b.w}" height="${b.h}" fill="none" stroke="#00ff66" stroke-width="1.5" stroke-opacity="0.7"/></svg>`);
  const buf = await sharp(file).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).composite([{ input: svg }]).png().toBuffer();
  return sharp(buf).resize(T, T, { fit: 'contain', background: '#1a1a1a' }).png().toBuffer();
}

async function main() {
  const out = arg('--out');
  if (!out) throw new Error('--out <file.jpg>');
  const per = Number(arg('--per') ?? 6);
  const set = JSON.parse(readFileSync(path.join(OUT, 'set.json'), 'utf8')) as Row[];
  const negs = JSON.parse(readFileSync(path.join(OUT, 'negatives.json'), 'utf8')) as Neg[];
  const resultsFile = arg('--results') ? path.resolve(ROOT, arg('--results')!) : null;
  const res = new Map<string, Res>();
  if (resultsFile && existsSync(resultsFile)) {
    const r = JSON.parse(readFileSync(resultsFile, 'utf8')) as { rows: Res[]; negatives?: { rows: Res[] } };
    for (const x of [...r.rows, ...(r.negatives?.rows ?? [])]) res.set(x.id, x);
  }
  const groups: [string, { frame: string; box: Row['userBox']; label: string; id: string }[]][] = [];
  for (const c of ['normal', 'tilted', 'small', 'cut', 'covered', 'foil', 'overframe', 'digital']) {
    const rows = set.filter((r) => r.category === c);
    if (!rows.length) continue;
    // Spread the picks over the category (every k-th row), so they come from different frames.
    const step = Math.max(1, Math.floor(rows.length / per));
    const picked = rows.filter((_, i) => i % step === 0).slice(0, per);
    groups.push([`${c} (${rows.length})`, picked.map((r) => ({ frame: r.frame, box: r.userBox, label: r.name, id: r.id }))]);
  }
  for (const c of ['sleeve', 'pile', 'zone', 'mat-art', 'overlay', 'logo', 'hand', 'other']) {
    const rows = negs.filter((n) => n.category === c);
    if (!rows.length) continue;
    const picked = rows.slice(0, Math.min(3, rows.length));
    groups.push([`negative: ${c} (${rows.length})`, picked.map((n) => ({ frame: n.frame, box: { x: n.box[0], y: n.box[1], w: n.box[2], h: n.box[3] }, label: n.design, id: n.id }))]);
  }
  const layers: OverlayOptions[] = [];
  const W = T + 8;
  let y = 0;
  let width = 0;
  // Two negative groups share a line; card categories take one each.
  for (const [title, items] of groups) {
    layers.push({ input: Buffer.from(`<svg width="${W * per}" height="24"><text x="2" y="18" font-size="17" font-weight="bold" font-family="Helvetica" fill="#ffd400">${esc(title)}</text></svg>`), left: 0, top: y });
    y += 24;
    for (const [k, it] of items.entries()) {
      const x = k * W;
      layers.push({ input: await crop(it.frame, it.box), left: x, top: y });
      const r = res.get(it.id);
      const answer = r ? (r.candidates[0] ? `${r.confident ? 'SURE' : 'unsure'} ${r.candidates[0].name}` : 'nothing') : '';
      const ok = r ? (r.top1Correct === undefined ? !r.confident : r.top1Correct) : true;
      const text = `<text x="1" y="13" font-size="11" font-family="Helvetica" fill="#ffffff">${esc(it.label.slice(0, 30))}</text>` + (answer ? `<text x="1" y="27" font-size="11" font-family="Helvetica" fill="${ok ? '#7CFC00' : '#ff6060'}">${esc(answer.slice(0, 32))}</text>` : '');
      layers.push({ input: Buffer.from(`<svg width="${T}" height="30">${text}</svg>`), left: x, top: y + T + 2 });
      width = Math.max(width, x + W);
    }
    y += T + 36;
  }
  await sharp({ create: { width, height: y, channels: 3, background: '#000000' } }).composite(layers).jpeg({ quality: 85 }).toFile(out);
  console.log(`${groups.length} groups -> ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
