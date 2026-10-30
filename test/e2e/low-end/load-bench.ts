// What loading the engine costs on this machine, as the offscreen document loads it on WASM: ONNX Runtime's WASM
// start and the card detector's session (the first session, at the detector's optimization level), then the
// embedder's session at --embedder-opt. Also how far that embedder's vectors are from the one optimized at 'all'
// (the lowest cosine over a few random inputs), since a graph optimization may round differently.
// Usage (in the low-end container, see README.md):
//   npx tsx test/e2e/low-end/load-bench.ts [--threads 1] [--detector-opt all] [--embedder-opt all|extended|basic|disabled]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { CARD_DETECTOR } from '../../../src/offscreen/detector/spec';
import { DEFAULT_MODEL_ID, getModel } from '../../../src/shared/models';

type Level = 'all' | 'extended' | 'basic' | 'disabled';
const root = path.resolve(import.meta.dirname, '../../..');
const opt = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
ort.env.wasm.numThreads = Number(opt('--threads') ?? 1);
ort.env.wasm.wasmPaths = `${path.join(root, 'node_modules/onnxruntime-web/dist')}/`;
const detectorOpt = (opt('--detector-opt') ?? 'all') as Level;
const embedderOpt = (opt('--embedder-opt') ?? 'all') as Level;

async function create(file: string, level: Level) {
  const bytes = new Uint8Array(readFileSync(file));
  const t = performance.now();
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: level });
  return { session, ms: Math.round(performance.now() - t) };
}

const spec = getModel(DEFAULT_MODEL_ID);
const detector = await create(path.join(root, 'extension', CARD_DETECTOR.dir, CARD_DETECTOR.file), detectorOpt);
const embedderFile = path.join(root, 'extension/models', spec.file);
const embedder = await create(embedderFile, embedderOpt);

const reference = embedderOpt === 'all' ? embedder.session : (await create(embedderFile, 'all')).session;
const s = spec.inputSize;
let minCosine = 1;
for (let i = 0; i < 4; i++) {
  const input = new ort.Tensor('float32', Float32Array.from({ length: 3 * s * s }, () => Math.random() * 2 - 1), [1, 3, s, s]);
  const [a, b] = await Promise.all([embedder.session, reference].map(async (x) => (await x.run({ [spec.inputName]: input }))[spec.outputName].data as Float32Array));
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k];
    na += a[k] * a[k];
    nb += b[k] * b[k];
  }
  minCosine = Math.min(minCosine, dot / Math.sqrt(na * nb));
}
console.log(JSON.stringify({ threads: ort.env.wasm.numThreads, detectorOpt, embedderOpt, firstSessionMs: detector.ms, embedderSessionMs: embedder.ms, minCosineToAll: minCosine }));
process.exit(0); // onnxruntime-web's WASM threads keep Node alive
