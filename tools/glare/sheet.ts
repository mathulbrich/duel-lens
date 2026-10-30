// A contact sheet of chosen lines of a harvest jsonl (videos/<video>.jsonl, .rejected.jsonl or candidates.jsonl),
// sorted by a field: for tuning the glare score (tools/glare/metrics.ts).
//   npx tsx tools/glare/sheet.ts --in data/debug/glare/harvest/calib-r2/videos/local.rejected.jsonl --out x.jpg
//       [--sort glare.score] [--desc] [--from 0] [--n 30] [--where 'r => r.engine.answer !== "confident"']
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

const argv = process.argv.slice(2);
const arg = (n: string) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
const inFile = path.resolve(arg('--in')!);
const base = path.basename(path.dirname(inFile)) === 'videos' ? path.dirname(path.dirname(inFile)) : path.dirname(inFile);
const out = path.resolve(arg('--out')!);
const sortKey = arg('--sort') ?? 'glare.score';
const desc = argv.includes('--desc');
const from = Number(arg('--from') ?? 0);
const n = Number(arg('--n') ?? 30);
// eslint-disable-next-line no-new-func
const where = arg('--where') ? (new Function(`return (${arg('--where')})`)() as (r: any) => boolean) : () => true;
const get = (o: any, k: string) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);

const rows = readFileSync(inFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(where);
rows.sort((a, b) => (desc ? -1 : 1) * (Number(get(a, sortKey)) - Number(get(b, sortKey))));
const pick = rows.slice(from, from + n);
const cols = 6;
const CW = 260, CH = 220, IMG = 180;
const W = cols * CW, H = Math.ceil(pick.length / cols) * CH;
const layers: OverlayOptions[] = [];
let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><style>text{font-family:Helvetica;font-size:13px;fill:#fff}</style>`;
for (const [i, r] of pick.entries()) {
  const x = (i % cols) * CW, y = Math.floor(i / cols) * CH;
  const crop = path.join(base, r.crop), card = path.join(base, r.card);
  if (existsSync(crop)) layers.push({ input: await sharp(crop).resize(IMG - 60, IMG, { fit: 'contain', background: '#222' }).png().toBuffer(), left: x + 2, top: y + 2 });
  if (existsSync(card)) layers.push({ input: await sharp(card).resize(124, IMG, { fit: 'fill' }).png().toBuffer(), left: x + IMG - 54, top: y + 2 });
  const m = r.metrics;
  const g = r.glare ?? {};
  svg += `<text x="${x + 4}" y="${y + IMG + 16}">${r.index ?? ''} s${g.score} w${g.wash} d${g.dark} p${g.patch} ${r.engine.answer.slice(0, 4)}</text>`;
  svg += `<text x="${x + 4}" y="${y + IMG + 32}">b${Math.round(m.card.p02)} bl${g.blackLift} dl${g.darkLiftAbove} ${sortKey.split('.').pop()}=${get(r, sortKey)}</text>`;
}
svg += '</svg>';
layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } }).composite(layers).jpeg({ quality: 80 }).toFile(out);
console.log(`${out}: ${pick.length} of ${rows.length}`);
