// Speed of the card detector through the extension's TypeScript module (src/offscreen/detector/):
// findCards() on the 7 labelled full-view frames at 1456x819 and their 2x upscales (a Retina capture,
// 2912x1638), split into preprocessing (resize + tensor), the model run and decoding. PNG decoding is
// not measured (the offscreen page decodes natively). One process per runtime/thread count
// (onnxruntime-web reads numThreads once).
//
//   npx tsx tools/train-detector/bench-speed.ts --runtime wasm --threads 4 [--model <onnx>] [--runs 3]
//   npx tsx tools/train-detector/bench-speed.ts --runtime node
import { readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { refined } from '../../src/offscreen/detector/detector';
import { CARD_DETECTOR_FILE, createNodeCardDetector } from '../../src/offscreen/detector/node';
import type { RGBAImage } from '../../src/shared/preprocess';
import { loadRGBA } from '../lib/image';

const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const runtime = (opt('--runtime') ?? 'wasm') as 'node' | 'wasm';
const threads = opt('--threads') ? Number(opt('--threads')) : runtime === 'wasm' ? 4 : undefined;
const runs = Number(opt('--runs') ?? 3);
const file = opt('--model') ?? CARD_DETECTOR_FILE;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const t0 = performance.now();
  const det = await createNodeCardDetector({ file, runtime, threads });
  const loadMs = performance.now() - t0;
  const dir = path.join(root, 'data/debug/fullview');
  const names = ['fv-wc-t12000.png', 'fv-wc-t18000.png', 'fv-wcq-t400.png', 'fv-wcq-t900.png', 'fv-ycsg-t10400.png', 'fv-ycsg-t14500.png', 'fv-ycsm-t26191.png'].filter((n) =>
    readdirSync(dir).includes(n),
  );
  const frames: RGBAImage[] = [];
  for (const n of names) frames.push(await loadRGBA(path.join(dir, n)));
  const retina: RGBAImage[] = [];
  for (const n of names) {
    const img = frames[names.indexOf(n)];
    retina.push(await loadRGBA(await sharp(path.join(dir, n)).resize(img.width * 2, img.height * 2, { kernel: 'lanczos3' }).png().toBuffer()));
  }
  // first run (session warm-up), not counted
  let t = performance.now();
  await det.findCards(frames[0]);
  const firstMs = performance.now() - t;
  const out: Record<string, unknown> = { runtime, threads: threads ?? 'default', model: path.relative(root, file), loadMs: Math.round(loadMs), firstMs: Math.round(firstMs) };
  for (const [label, set] of [
    ['1456x819', frames],
    ['2912x1638 (Retina)', retina],
  ] as const) {
    const total: number[] = [];
    const pre: number[] = [];
    const run: number[] = [];
    const dec: number[] = [];
    for (let k = 0; k < runs; k++) {
      for (const img of set) {
        t = performance.now();
        await det.findCards(img);
        total.push(performance.now() - t);
        pre.push(det.last!.preprocessMs);
        run.push(det.last!.runMs);
        dec.push(det.last!.decodeMs);
      }
    }
    // the outline fit (refine.ts) of every face-up card at >= 0.4, per card
    const perCard: number[] = [];
    for (const img of set) {
      for (const c of (await det.findCards(img)).filter((x) => x.kind === 'face-up' && x.conf >= 0.4)) {
        const t0 = performance.now();
        refined(img, c);
        perCard.push(performance.now() - t0);
      }
    }
    out[label] = {
      medianMs: Math.round(median(total)),
      preprocessMs: Math.round(median(pre)),
      runMs: Math.round(median(run)),
      decodeMs: +median(dec).toFixed(1),
      maxMs: Math.round(Math.max(...total)),
      n: total.length,
      refinePerCardMs: +median(perCard).toFixed(1),
      refineCards: perCard.length,
    };
  }
  console.log(JSON.stringify(out));
  await det.release();
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
