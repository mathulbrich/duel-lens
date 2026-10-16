// Checks that an exported model runs on onnxruntime-web's WASM backend (what the extension uses)
// and matches onnxruntime-node: cosine per image, batch 1 vs batch 4, and WASM latency.
// Usage: npx tsx tools/train/check-web.ts <model.onnx> [threads] [--browser]   (--browser: WebGPU and WASM latency in Chrome, below)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ortNode from 'onnxruntime-node';
import * as ortWeb from 'onnxruntime-web';

const file = process.argv[2];
const threads = Number(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 1);
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

// --browser: the page's own session.run() time in headless Chrome (src/offscreen/__measure__/browser-ort.ts: the
// extension's ORT builds, cross-origin isolated like the offscreen document, so WASM gets min(4, cores) threads), on
// WebGPU and on WASM, one image and a batch of 8: first run (shader compile / warm-up) and the median of 10 after.
// The file must be under extension/ (the page serves only that folder).
if (process.argv.includes('--browser')) {
  const { launchBrowserOrt } = await import('../../src/offscreen/__measure__/browser-ort');
  const rel = path.relative(path.join(root, 'extension'), path.resolve(file));
  if (rel.startsWith('..')) throw new Error('--browser needs a model file under extension/');
  const browser = await launchBrowserOrt();
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const res: Record<string, unknown> = { file: path.basename(file), adapter: browser.adapter };
  for (const ep of ['webgpu', 'wasm'] as const) {
    if (ep === 'webgpu' && !browser.adapter) continue;
    const t0 = performance.now();
    const s = await browser.session(rel, ep);
    res[`${ep}SessionMs`] = +(performance.now() - t0).toFixed(0);
    for (const b of [1, 8]) {
      const data = rand(b * plane, 11 + b);
      const ms: number[] = [];
      for (let i = 0; i < 11; i++) {
        await s.run({ pixel_values: { type: 'float32', data, dims: [b, 3, 224, 224] } as never });
        ms.push(s.lastRunMs);
      }
      res[`${ep}Batch${b}`] = { firstMs: +ms[0].toFixed(1), medianMs: +med(ms.slice(1)).toFixed(1) };
    }
    await s.release();
  }
  console.log(JSON.stringify(res));
  await browser.close();
}
