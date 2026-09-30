// realset2 zoom: one box's crop, enlarged, next to large official card images of the given candidates,
// for a careful check by eye of a label the review sheet left in doubt.
//
//   npx tsx tools/realset2/zoom.ts --out <file.jpg> (--pid <frame>#<i> | --frame <frame> --box x,y,w,h)
//        [--cards id,id,...] [--rot 0|90|-90|180] [--margin 0.25] [--h 600] [--enhance]
// Without --cards, the proposal's top 3 are shown.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { artOf, cardById, fullCardOf } from './lib/refs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const out = arg('--out');
  if (!out) throw new Error('--out <file.jpg>');
  const H = Number(arg('--h') ?? 600);
  const margin = Number(arg('--margin') ?? 0.25);
  let frame = arg('--frame');
  type Box = { x: number; y: number; w: number; h: number };
  let box: Box | null = null;
  let cands: number[] = (arg('--cards') ?? '').split(',').filter(Boolean).map(Number);
  const pid = arg('--pid');
  if (pid) {
    const [f] = pid.split('#');
    frame = f;
    for (const file of ['proposals.jsonl', 'proposals-extra.jsonl']) {
      let text = '';
      try {
        text = readFileSync(path.join(OUT, file), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n').filter(Boolean)) {
        const p = JSON.parse(line) as { frame: string; boxes: { pid: string; userBox: Box; top10: { cardId: number }[] }[] };
        if (p.frame !== f) continue;
        const b = p.boxes.find((x) => x.pid === pid);
        if (b) {
          box = b.userBox;
          if (cands.length === 0) cands = b.top10.slice(0, 3).map((c) => c.cardId);
        }
      }
    }
  } else if (arg('--box')) {
    const [x, y, w, h] = arg('--box')!.split(',').map(Number);
    box = { x, y, w, h };
  }
  if (!frame || !box) throw new Error('--pid, or --frame and --box');
  const file = path.join(OUT, 'frames', `${frame}.jpg`);
  const meta = await sharp(file).metadata();
  const x0 = Math.max(0, Math.floor(box.x - box.w * margin));
  const y0 = Math.max(0, Math.floor(box.y - box.h * margin));
  const x1 = Math.min(meta.width!, Math.ceil(box.x + box.w * (1 + margin)));
  const y1 = Math.min(meta.height!, Math.ceil(box.y + box.h * (1 + margin)));
  let crop = await sharp(file).extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).png().toBuffer();
  // --enhance stretches the crop's contrast (a dark or washed-out card), for reading it by eye only.
  if (process.argv.includes('--enhance')) crop = await sharp(crop).normalise({ lower: 1, upper: 99 }).png().toBuffer();
  const rot = Number(arg('--rot') ?? 0);
  if (rot) crop = await sharp(crop).rotate(rot).png().toBuffer();
  const cm = await sharp(crop).metadata();
  const cw = Math.round((cm.width! * H) / cm.height!);
  const layers: OverlayOptions[] = [{ input: await sharp(crop).resize(cw, H, { kernel: 'lanczos3' }).png().toBuffer(), left: 0, top: 30 }];
  let x = cw + 12;
  const labels: string[] = [`<text x="4" y="22" font-family="Helvetica" font-size="18" fill="#ffd400">${frame} [${box.x},${box.y},${box.w},${box.h}]</text>`];
  for (const id of cands) {
    const ref = (await fullCardOf(id, 'large')) ?? artOf(id);
    const rw = Math.round((H * 421) / 614);
    if (ref) layers.push({ input: await sharp(ref).resize(rw, H, { fit: 'fill' }).png().toBuffer(), left: x, top: 30 });
    labels.push(`<text x="${x}" y="${H + 52}" font-family="Helvetica" font-size="16" fill="#ffffff">${id} ${(cardById.get(id)?.name ?? '?').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
    x += rw + 12;
  }
  const W = x;
  layers.push({ input: Buffer.from(`<svg width="${W}" height="${H + 64}">${labels.join('')}</svg>`), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H + 64, channels: 3, background: '#111111' } }).composite(layers).jpeg({ quality: 90 }).toFile(out);
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
