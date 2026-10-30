// ONNX Runtime Web's WASM backend on this machine, as the offscreen document runs it, for one thread count:
// the embedder (one 224 px crop per run, as a scan sends them) and the card detector (a 1280x720 screenshot,
// padded to 1280x736), with ORT's thread pool spinning while it waits for work (its default) and without.
// Run it in the low-end container to see what the slow computer pays per model run (run.sh's profiles):
//   docker run --rm <limits> <volumes> duel-lens-low-end npx tsx test/e2e/low-end/embed-bench.ts --threads 2
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { CARD_DETECTOR } from '../../../src/offscreen/detector/spec';
import { DEFAULT_MODEL_ID, getModel } from '../../../src/shared/models';

const root = path.resolve(import.meta.dirname, '../../..');
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const threads = arg('--threads', 2);
const runs = arg('--runs', 8);
ort.env.wasm.numThreads = threads;
ort.env.wasm.wasmPaths = `${path.join(root, 'node_modules/onnxruntime-web/dist')}/`;

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

async function time(file: string, input: string, shape: number[], spinning: boolean, n: number) {
  const session = await ort.InferenceSession.create(new Uint8Array(readFileSync(file)), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    extra: { session: { intra_op: { allow_spinning: spinning ? '1' : '0' } } },
  });
  const data = Float32Array.from({ length: shape.reduce((a, b) => a * b, 1) }, () => Math.random());
  const feeds = { [input]: new ort.Tensor('float32', data, shape) };
  await session.run(feeds); // the first run allocates
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await session.run(feeds);
    ms.push(performance.now() - t);
  }
  await session.release();
  return Math.round(median(ms));
}

const spec = getModel(DEFAULT_MODEL_ID);
const embedder = path.join(root, 'extension/models', spec.file);
const detector = path.join(root, 'extension', CARD_DETECTOR.dir, CARD_DETECTOR.file);
for (const spinning of [true, false]) {
  const embed = await time(embedder, spec.inputName, [1, 3, spec.inputSize, spec.inputSize], spinning, runs);
  const detect = await time(detector, CARD_DETECTOR.inputName, [1, 3, 736, 1280], spinning, Math.max(3, runs / 2));
  console.log(JSON.stringify({ threads, spinning, embedMs: embed, detectMs: detect }));
}
process.exit(0); // onnxruntime-web's WASM threads keep Node alive
