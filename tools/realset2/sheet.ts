// realset2 review sheets: each proposed box (data/realset2/proposals.jsonl) as its crop from the frame
// next to the clean artwork of the engine's top candidates (data/artworks/<imageId>.jpg), numbered, for
// a person to confirm or reject by eye. Sheets go to --dir (a scratch folder), with sheets.json mapping
// each tile to its proposal id.
//
//   npx tsx tools/realset2/sheet.ts --dir <scratch>/sheets [--frames a,b] [--kind face-up|face-down|all]
//        [--undecided] [--per 12] [--refs 3] [--pids a#1,b#2] [--min-long 0]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { artOf, fullCardOf } from './lib/refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dir = arg('--dir');
if (!dir) throw new Error('--dir <folder for the sheets>');
const frames = arg('--frames')?.split(',').filter(Boolean) ?? null;
const pids = arg('--pids')?.split(',').filter(Boolean) ?? null;
const kind = arg('--kind') ?? 'face-up';
const per = Number(arg('--per') ?? 12);
const nRefs = Number(arg('--refs') ?? 3);
const undecided = process.argv.includes('--undecided');
const prefix = arg('--prefix') ?? 'sheet';
const proposalsFile = path.join(OUT, arg('--proposals') ?? 'proposals.jsonl');

export interface Cand {
  cardId: number;
  name: string;
  score: number;
}
export interface ProposedBox {
  pid: string;
  kind: string;
  conf: number;
  angleDeg: number;
  size: { w: number; h: number };
  pts: [number, number][];
  userBox: { x: number; y: number; w: number; h: number };
  edge: boolean;
  answer: { candidates: Cand[]; confident: boolean };
  top10: Cand[];
}
interface FrameProposals {
  frame: string;
  boxes: ProposedBox[];
}


const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --scale enlarges every tile (a closer look at doubtful boxes); --cols sets the columns.
const S = Number(arg('--scale') ?? 1);
const COLS = Number(arg('--cols') ?? (S > 1.2 ? 1 : 2));
const TILE_W = Math.round(780 * S);
const TILE_H = Math.round(330 * S);
const CROP_H = Math.round(270 * S);

async function tile(no: number, b: ProposedBox, frameFile: string): Promise<Buffer> {
  const meta = await sharp(frameFile).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const m = Number(arg('--margin') ?? 0.18);
  const x0 = Math.max(0, Math.floor(b.userBox.x - b.userBox.w * m));
  const y0 = Math.max(0, Math.floor(b.userBox.y - b.userBox.h * m));
  const x1 = Math.min(W, Math.ceil(b.userBox.x + b.userBox.w * (1 + m)));
  const y1 = Math.min(H, Math.ceil(b.userBox.y + b.userBox.h * (1 + m)));
  // The box outline on the crop (thin), so the card meant is clear when cards overlap.
  const bw = x1 - x0;
  const bh = y1 - y0;
  const poly = b.pts.map(([x, y]) => `${(x - x0).toFixed(1)},${(y - y0).toFixed(1)}`).join(' ');
  const outline = Buffer.from(`<svg width="${bw}" height="${bh}"><polygon points="${poly}" fill="none" stroke="#00ff66" stroke-width="${Math.max(1, bw / 220)}" stroke-opacity="0.55"/></svg>`);
  let crop = sharp(frameFile).extract({ left: x0, top: y0, width: bw, height: bh }).composite([{ input: outline }]);
  let cropBuf = await crop.png().toBuffer();
  // --enhance stretches the crop's contrast (dark or washed-out cards), for reading by eye only.
  if (process.argv.includes('--enhance')) cropBuf = await sharp(cropBuf).normalise({ lower: 1, upper: 99 }).png().toBuffer();
  // Portrait for sideways cards, so the artwork compares at a glance.
  if (Math.abs(b.angleDeg) >= 45) cropBuf = await sharp(cropBuf).rotate(b.angleDeg > 0 ? -90 : 90).png().toBuffer();
  const cm = await sharp(cropBuf).metadata();
  const scale = CROP_H / cm.height!;
  let cw = Math.round(cm.width! * scale);
  if (cw > 330 * S) cw = Math.round(330 * S);
  const cropImg = await sharp(cropBuf).resize({ width: cw, height: CROP_H, fit: 'contain', background: '#202020', kernel: 'lanczos3' }).png().toBuffer();
  const layers: OverlayOptions[] = [{ input: cropImg, left: 6, top: 30 }];
  const refs = b.top10.slice(0, nRefs);
  let x = 6 + cw + 10;
  // Full official card images (frame colour, name, level) when they can be had; the artwork otherwise.
  const heights = [270, 185, 185].map((h) => Math.round(h * S));
  for (const [i, c] of refs.entries()) {
    const h = heights[i] ?? 150;
    const w = Math.round((h * 268) / 391);
    const full = await fullCardOf(c.cardId);
    const art = full ?? artOf(c.cardId);
    if (art) layers.push({ input: await sharp(art).resize(w, h, { fit: 'fill' }).png().toBuffer(), left: x, top: 30 });
    x += w + 8;
  }
  const flags = [b.kind === 'face-down' ? 'FACE-DOWN' : '', b.answer.confident ? 'SURE' : 'unsure', `${b.size.w}x${b.size.h}`, `${b.angleDeg}deg`, b.edge ? 'EDGE' : '', `c${b.conf}`].filter(Boolean).join(' ');
  const lines = [
    `<text x="6" y="22" font-family="Helvetica" font-size="21" font-weight="bold" fill="#ffd400">${no}</text>`,
    `<text x="46" y="22" font-family="Helvetica" font-size="15" fill="#dddddd">${esc(flags)}</text>`,
  ];
  let ty = 30 + CROP_H + 2;
  const refLine = refs.map((c, i) => `${i + 1}) ${c.name} ${c.score.toFixed(3)}`).join('   ');
  lines.push(`<text x="6" y="${ty + 16}" font-family="Helvetica" font-size="14" fill="#ffffff">${esc(refLine.slice(0, 120))}</text>`);
  ty += 20;
  const more = b.top10.slice(nRefs, 7).map((c, i) => `${i + nRefs + 1}) ${c.name}`).join('  ');
  lines.push(`<text x="6" y="${ty + 12}" font-family="Helvetica" font-size="11" fill="#aaaaaa">${esc(more.slice(0, 150))}</text>`);
  const svg = Buffer.from(`<svg width="${TILE_W}" height="${TILE_H}">${lines.join('')}</svg>`);
  layers.push({ input: svg, left: 0, top: 0 });
  return sharp({ create: { width: TILE_W, height: TILE_H, channels: 3, background: '#111111' } }).composite(layers).png().toBuffer();
}

async function main() {
  mkdirSync(dir!, { recursive: true });
  const decisionsFile = path.join(OUT, 'decisions.jsonl');
  const decided: Record<string, boolean> = {};
  if (undecided && existsSync(decisionsFile)) {
    for (const line of readFileSync(decisionsFile, 'utf8').split('\n').filter(Boolean)) decided[(JSON.parse(line) as { pid: string }).pid] = true;
  }
  const all = readFileSync(proposalsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FrameProposals);
  const picked: { frame: string; b: ProposedBox }[] = [];
  for (const f of all) {
    if (frames && !frames.includes(f.frame)) continue;
    for (const b of f.boxes) {
      if (pids && !pids.includes(b.pid)) continue;
      if (!pids && kind !== 'all' && b.kind !== kind) continue;
      if (undecided && decided[b.pid]) continue;
      picked.push({ frame: f.frame, b });
    }
  }
  const index: Record<string, Record<number, string>> = {};
  let sheetNo = 0;
  for (let i = 0; i < picked.length; i += per) {
    const group = picked.slice(i, i + per);
    const cols = COLS;
    const rows = Math.ceil(group.length / cols);
    const layers: OverlayOptions[] = [];
    const map: Record<number, string> = {};
    for (const [k, { frame, b }] of group.entries()) {
      const no = i + k + 1;
      map[no] = b.pid;
      layers.push({ input: await tile(no, b, path.join(OUT, 'frames', `${frame}.jpg`)), left: (k % cols) * (TILE_W + 6), top: Math.floor(k / cols) * (TILE_H + 6) });
    }
    const name = `${prefix}-${String(++sheetNo).padStart(2, '0')}.jpg`;
    await sharp({ create: { width: cols * (TILE_W + 6), height: rows * (TILE_H + 6), channels: 3, background: '#000000' } })
      .composite(layers)
      .jpeg({ quality: 88 })
      .toFile(path.join(dir!, name));
    index[name] = map;
  }
  writeFileSync(path.join(dir!, `${prefix}.json`), JSON.stringify(index, null, 1));
  console.log(`${picked.length} boxes on ${sheetNo} sheets in ${dir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
