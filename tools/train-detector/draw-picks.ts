// Debug view: the detector's outlines on a frame, or in the content script's crop of a user box.
//   npx tsx tools/train-detector/draw-picks.ts --model <onnx> --frame <png> [--box x,y,w,h] --out <png> [--min 0.2]
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { loadRGBA } from '../lib/image';
import { buildCrop } from '../realset/lib/crop';

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

async function main() {
  const det = await createNodeCardDetector({ file: opt('--model'), threads: 2 });
  let img = await loadRGBA(readFileSync(opt('--frame')!));
  const box = opt('--box')?.split(',').map(Number);
  const min = Number(opt('--min') ?? 0.2);
  let cards;
  if (box) {
    const crop = buildCrop(img, { x: box[0], y: box[1], w: box[2], h: box[3] });
    img = crop.cropImg;
    cards = await det.findInCrop(img);
  } else cards = await det.findCards(img);
  cards = cards.filter((c) => c.conf >= min);
  const poly = (pts: number[][]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${cards
    .map((c, i) => {
      const col = c.kind === 'face-up' ? '#30d158' : '#ff9f0a';
      return `<polygon points="${poly(c.pts)}" fill="none" stroke="${col}" stroke-width="3"/><circle cx="${c.pts[0][0]}" cy="${c.pts[0][1]}" r="5" fill="${col}"/><text x="${c.cx}" y="${c.cy}" fill="${col}" font-size="18" font-family="monospace">${i}:${c.conf.toFixed(2)}</text>`;
    })
    .join('')}</svg>`;
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(opt('--out')!);
  console.log(cards.map((c, i) => `${i}: ${c.kind} ${c.conf} c=(${c.cx},${c.cy}) ${c.w}x${c.h} a=${c.angle}`).join('\n'));
  await det.release();
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
