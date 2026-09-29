// Checks that an exported model runs on onnxruntime-web's WASM backend (what the extension uses)
// and matches onnxruntime-node: cosine per image, batch 1 vs batch 4, and WASM latency.
// Usage: npx tsx tools/train/check-web.ts <model.onnx> [threads]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ortNode from 'onnxruntime-node';
import * as ortWeb from 'onnxruntime-web';

const file = process.argv[2];
const threads = Number(process.argv[3] ?? 1);
const root = path.resolve(import.meta.dirname, '../..');
ortWeb.env.wasm.numThreads = threads;
ortWeb.env.wasm.wasmPaths = `${path.join(root, 'node_modules/onnxruntime-web/dist')}/`;

function rand(n: number, seed: number) {
  let a = seed;
  return Float32Array.from({ length: n }, () => {
    a = (a * 1664525 + 1013904223) >>> 0;
    return (a / 2 ** 32) * 4 - 2;
  });
}
const cos = (a: Float32Array, b: Float32Array) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(na * nb);
};

const n = 4, plane = 3 * 224 * 224;
const x = rand(n * plane, 7);
const web = await ortWeb.InferenceSession.create(new Uint8Array(readFileSync(file)), { executionProviders: ['wasm'] });
const node = await ortNode.InferenceSession.create(file);
// the model's first output: 'embedding' ([n, dim]) or e.g. 'pooler_output'
const run = async (s: any, T: any, data: Float32Array, b: number) =>
  (await s.run({ pixel_values: new T('float32', data, [b, 3, 224, 224]) }))[s.outputNames[0]].data as Float32Array;
const zw = await run(web, ortWeb.Tensor, x, n);
const zn = await run(node, ortNode.Tensor, x, n);
const dim = zw.length / n;
const one = await run(web, ortWeb.Tensor, x.slice(0, plane), 1);
const t0 = performance.now();
for (let i = 0; i < 5; i++) await run(web, ortWeb.Tensor, x.slice(0, plane), 1);
const ms = (performance.now() - t0) / 5;
const out = {
  file: path.basename(file),
  dim,
  webVsNodeMinCos: Math.min(...Array.from({ length: n }, (_, i) => cos(zw.slice(i * dim, (i + 1) * dim), zn.slice(i * dim, (i + 1) * dim)))),
  webBatch1VsBatch4Cos: cos(one, zw.slice(0, dim)),
  wasmMsPerImage: +ms.toFixed(1),
  wasmThreads: threads,
};
console.log(JSON.stringify(out));
