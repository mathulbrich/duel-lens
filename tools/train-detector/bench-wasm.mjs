// Times detector ONNX files in onnxruntime-web's WASM build (as the offscreen page runs it) and in
// onnxruntime-node, at a few input sizes. Also checks WASM-vs-Node parity of the outputs.
//   node tools/train-detector/bench-wasm.mjs <file.onnx> [...] [--sizes 736x1280,576x1024] [--threads 1,4] [--runs 5]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'package.json'));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const sizes = opt('--sizes', '736x1280,576x1024').split(',').map((s) => s.split('x').map(Number));
const threadList = opt('--threads', '1,4').split(',').map(Number);
const runs = Number(opt('--runs', '5'));
const skipNode = args.includes('--no-node');

const loaded = await import(require.resolve('onnxruntime-web/wasm'));
const ortWeb = loaded.env ? loaded : loaded.default;
ortWeb.env.wasm.wasmPaths = path.join(root, 'node_modules/onnxruntime-web/dist/');
const ortNode = require('onnxruntime-node');

function input(h, w) {
  const x = new Float32Array(3 * h * w);
  let s = 7;
  for (let i = 0; i < x.length; i++) {
    s = (s * 16807) % 2147483647;
    x[i] = s / 2147483647;
  }
  return x;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function time(session, Tensor, h, w) {
  const feeds = { [session.inputNames[0]]: new Tensor('float32', input(h, w), [1, 3, h, w]) };
  const t0 = performance.now();
  let out = await session.run(feeds);
  const first = performance.now() - t0;
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    out = await session.run(feeds);
    ts.push(performance.now() - t);
  }
  return { first: Math.round(first), median: Math.round(median(ts)), out };
}

for (const file of files) {
  const buf = readFileSync(file);
  const row = { file: path.basename(file), MB: +(buf.length / 1e6).toFixed(2) };
  for (const threads of threadList) {
    // numThreads is read when the WASM module first initialises, so every thread count needs its own process.
    if (threads !== threadList[0]) continue;
    ortWeb.env.wasm.numThreads = threads;
    const s = await ortWeb.InferenceSession.create(buf, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    for (const [h, w] of sizes) {
      const r = await time(s, ortWeb.Tensor, h, w);
      row[`wasm${threads}t ${h}x${w}`] = `${r.median} (first ${r.first})`;
      if (!skipNode) {
        const n = await ortNode.InferenceSession.create(buf, { graphOptimizationLevel: 'all' });
        const rn = await time(n, ortNode.Tensor, h, w);
        row[`node ${h}x${w}`] = rn.median;
        let maxd = 0;
        for (const k of Object.keys(r.out)) {
          const a = r.out[k].data;
          const b = rn.out[k].data;
          for (let i = 0; i < a.length; i++) maxd = Math.max(maxd, Math.abs(a[i] - b[i]));
        }
        row[`maxdiff ${h}x${w}`] = +maxd.toExponential(2);
        await n.release();
      }
    }
    await s.release();
  }
  console.log(JSON.stringify(row));
}
