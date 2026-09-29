// Parity of the card detector on onnxruntime-web's WASM build (as the offscreen page runs it) against
// onnxruntime-node, through the extension's TypeScript module: every labelled full-view frame, every
// box at score >= 0.2 matched across runtimes by polygon IoU; reports the worst IoU, the largest
// score difference and any box found by one runtime only.
//
//   npx tsx tools/train-detector/parity-wasm.ts [--model <onnx>] [--threads 4]
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { polygonIoU, type Pt } from '../../src/offscreen/detector/geometry';
import { CARD_DETECTOR_FILE, createNodeCardDetector } from '../../src/offscreen/detector/node';
import { loadRGBA } from '../lib/image';

const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const file = opt('--model') ?? CARD_DETECTOR_FILE;
const threads = Number(opt('--threads') ?? 4);

async function main() {
  const node = await createNodeCardDetector({ file, runtime: 'node' });
  const wasm = await createNodeCardDetector({ file, runtime: 'wasm', threads });
  const dir = path.join(root, 'data/debug/fullview');
  let worstIoU = 1;
  let worstScore = 0;
  let boxes = 0;
  let unmatched = 0;
  let kindFlips = 0;
  for (const f of readdirSync(dir).filter((n) => /^fv-.*\.png$/.test(n)).sort()) {
    const img = await loadRGBA(path.join(dir, f));
    const a = await node.findCards(img);
    const b = await wasm.findCards(img);
    for (const x of a) {
      boxes++;
      let best = 0;
      let match = null as (typeof b)[number] | null;
      for (const y of b) {
        const u = polygonIoU(x.pts as Pt[], y.pts as Pt[]);
        if (u > best) [best, match] = [u, y];
      }
      if (!match || best < 0.5) {
        // a box right at the score floor can fall on either side of it
        unmatched++;
        console.log(`  ${f}: node box ${x.kind} ${x.conf} has no WASM match`);
        continue;
      }
      worstIoU = Math.min(worstIoU, best);
      worstScore = Math.max(worstScore, Math.abs(x.conf - match.conf));
      if (x.kind !== match.kind) kindFlips++;
    }
    unmatched += Math.max(0, b.length - a.length);
  }
  console.log(JSON.stringify({ model: path.relative(root, file), wasmThreads: threads, boxes, worstIoU: +worstIoU.toFixed(5), maxScoreDiff: +worstScore.toFixed(5), kindFlips, unmatched }));
  await node.release();
  await wasm.release();
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
