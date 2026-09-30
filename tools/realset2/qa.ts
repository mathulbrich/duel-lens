// realset2 QA sheet: each set row's crop (turned upright for sideways cards) next to the official image of
// its label, for spot checks by eye (like tools/realset/verify.ts for data/realset).
//
//   npx tsx tools/realset2/qa.ts --out <prefix> [--ids a,b] [--where identified|misses|all] [--results <file>] [--per 16]
// --where misses needs --results (eval-real's output): the rows whose engine top-1 is not the label.
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

interface Row {
  id: string;
  frame: string;
  userBox: { x: number; y: number; w: number; h: number };
  rotatedBox: { angleDeg: number } | null;
  cardId: number;
  name: string;
  category: string;
  tags: string[];
  labelledBy: string;
}

const H = 260;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function tile(r: Row, answer: string): Promise<Buffer> {
  const b = r.userBox;
  const m = 0.06;
  const x0 = Math.max(0, Math.floor(b.x - b.w * m));
  const y0 = Math.max(0, Math.floor(b.y - b.h * m));
  const x1 = Math.min(1920, Math.ceil(b.x + b.w * (1 + m)));
  const y1 = Math.min(1080, Math.ceil(b.y + b.h * (1 + m)));
  let buf = await sharp(path.join(OUT, 'frames', `${r.frame}.jpg`)).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  const a = r.rotatedBox?.angleDeg ?? 0;
  if (Math.abs(a) >= 45) buf = await sharp(buf).rotate(a > 0 ? -90 : 90).png().toBuffer();
  if (r.tags.includes('rot180')) buf = await sharp(buf).rotate(180).png().toBuffer();
  const meta = await sharp(buf).metadata();
  const cw = Math.min(260, Math.round((meta.width! * H) / meta.height!));
  const crop = await sharp(buf).resize(cw, H, { fit: 'contain', background: '#1a1a1a', kernel: 'lanczos3' }).png().toBuffer();
  const ref = (await fullCardOf(r.cardId)) ?? artOf(r.cardId);
  const rw = Math.round((H * 268) / 391);
  const W = cw + rw + 18;
  const layers: OverlayOptions[] = [{ input: crop, left: 4, top: 22 }];
  if (ref) layers.push({ input: await sharp(ref).resize(rw, H, { fit: 'fill' }).png().toBuffer(), left: cw + 12, top: 22 });
  const text =
    `<text x="4" y="16" font-size="13" font-family="Helvetica" fill="#ffd400">${esc(`${r.name} [${r.category}]`.slice(0, 52))}</text>` +
    `<text x="4" y="${H + 38}" font-size="11" font-family="Helvetica" fill="#bbbbbb">${esc(r.id.replace(/^r2-/, '').slice(0, 48))}</text>` +
    `<text x="4" y="${H + 52}" font-size="11" font-family="Helvetica" fill="#ff9090">${esc(answer.slice(0, 52))}</text>`;
  layers.push({ input: Buffer.from(`<svg width="${W}" height="${H + 58}">${text}</svg>`), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H + 58, channels: 3, background: '#111111' } }).composite(layers).png().toBuffer();
}

async function main() {
  const out = arg('--out');
  if (!out) throw new Error('--out <prefix>');
  const per = Number(arg('--per') ?? 16);
  const set = JSON.parse(readFileSync(path.join(OUT, 'set.json'), 'utf8')) as Row[];
  const where = arg('--where') ?? 'identified';
  const answers = new Map<string, { top1Correct: boolean; confident: boolean; candidates: { name: string; score: number }[] }>();
  if (arg('--results')) {
    const res = JSON.parse(readFileSync(path.resolve(ROOT, arg('--results')!), 'utf8')) as { rows: { id: string; top1Correct: boolean; confident: boolean; candidates: { name: string; score: number }[] }[] };
    for (const r of res.rows) answers.set(r.id, r);
  }
  const ids = arg('--ids')?.split(',');
  const rows = set.filter((r) =>
    ids ? ids.includes(r.id) : where === 'all' ? true : where === 'misses' ? answers.get(r.id)?.top1Correct === false : !r.labelledBy.endsWith('candidate 1'),
  );
  const cols = 4;
  let sheet = 0;
  for (let i = 0; i < rows.length; i += per) {
    const tiles = await Promise.all(
      rows.slice(i, i + per).map((r) => {
        const a = answers.get(r.id);
        const text = a ? `engine: ${a.confident ? 'SURE' : 'unsure'} ${a.candidates[0] ? `${a.candidates[0].name} ${a.candidates[0].score.toFixed(3)}` : 'nothing'}` : '';
        return tile(r, text);
      }),
    );
    const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
    const cw = Math.max(...metas.map((m) => m.width!)) + 6;
    const ch = Math.max(...metas.map((m) => m.height!)) + 6;
    const layers = tiles.map((t, k) => ({ input: t, left: (k % cols) * cw, top: Math.floor(k / cols) * ch }));
    const file = `${out}-${String(++sheet).padStart(2, '0')}.jpg`;
    await sharp({ create: { width: cols * cw, height: Math.ceil(tiles.length / cols) * ch, channels: 3, background: '#000' } }).composite(layers).jpeg({ quality: 86 }).toFile(file);
    console.log(file);
  }
  console.log(`${rows.length} rows`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
