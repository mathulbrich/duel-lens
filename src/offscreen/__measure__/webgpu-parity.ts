// Measurement (not shipped, not a test): the WebGPU execution provider against WASM, both in a real
// headless Chrome page (browser-ort.ts), on the same inputs the extension builds (embedImages and
// createCardDetector run here in Node; only session.run() runs in the page). Also onnxruntime-node,
// the runtime the bundled index was built with.
// - The embedder: 200 card crops from data/realset2/set.json (every other row, eval-real's own crop of
//   the row's userBox, tools/realset/lib/crop.ts), one at a time and in batches of 8. Gate: cosine
//   >= 0.9995 between the WebGPU and WASM vectors on every crop; the index's top card per crop too.
// - The card detector: the same rows' frames (detect(), click to scan) and crops (detectInCropWithWeak(),
//   a scan): the same outlines (count, kind; largest corner and confidence differences).
// - Latency: the page's own session.run() times (no transfer), first run and median after.
// Usage: npx tsx src/offscreen/__measure__/webgpu-parity.ts [--n 200] [--out FILE]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ortNode from 'onnxruntime-node';
import { loadRGBA } from '../../../tools/lib/image';
import { buildCrop } from '../../../tools/realset/lib/crop';
import type { RealsetEntry } from '../../../tools/realset/lib/types';
import { embedImages, type SessionLike, type TensorCtor } from '../../shared/embed-core';
import { decodeIndex, type IndexMeta } from '../../shared/index-format';
import { DEFAULT_MODEL_ID, getModel } from '../../shared/models';
import { topKByCard } from '../../shared/search';
import type { RGBAImage } from '../../shared/preprocess';
import { createCardDetector } from '../detector/detector';
import { CARD_DETECTOR } from '../detector/spec';
import { launchBrowserOrt, type RemoteSession } from './browser-ort';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const N = Number(arg('--n') ?? 200);
const OUT = arg('--out') ?? path.join(ROOT, 'test/e2e/out/webgpu-parity.json');
const Tensor = ortNode.Tensor as unknown as TensorCtor;
const spec = getModel(DEFAULT_MODEL_ID);

const cos = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // both L2-normalised
};
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const r7 = (v: number) => Math.round(v * 1e7) / 1e7;
const stats = (v: number[]) => ({ min: r7(Math.min(...v)), p1: r7([...v].sort((a, b) => a - b)[Math.floor(v.length / 100)]), mean: r7(v.reduce((a, b) => a + b, 0) / v.length) });
const times = (v: number[]) => ({ firstMs: +v[0].toFixed(1), medianMs: +median(v.slice(1)).toFixed(1), n: v.length });

// The rows: every other card row of realset2 (spread over its videos), up to N.
const set = JSON.parse(readFileSync(path.join(ROOT, 'data/realset2/set.json'), 'utf8')) as RealsetEntry[];
const rows = set.filter((_, i) => i % 2 === 0).slice(0, N);
const frames = new Map<string, RGBAImage>();
async function frame(name: string): Promise<RGBAImage> {
  let f = frames.get(name);
  if (!f) {
    const base = path.join(ROOT, 'data/realset2/frames', name);
    f = await loadRGBA(existsSync(`${base}.jpg`) ? `${base}.jpg` : `${base}.png`);
    frames.set(name, f);
  }
  return f;
}
const crops: RGBAImage[] = [];
for (const r of rows) crops.push(buildCrop(await frame(r.frame), r.userBox).cropImg);
console.error(`[parity] ${crops.length} crops from ${frames.size} frames (data/realset2)`);

// The index, for each vector's top card.
const indexBase = path.join(ROOT, 'extension/data', `index-${spec.id}`);
const bin = readFileSync(`${indexBase}.bin`);
const index = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), JSON.parse(readFileSync(`${indexBase}.meta.json`, 'utf8')) as IndexMeta);
const topCard = (v: Float32Array): number => topKByCard(v, index, 1)[0].cardId;

const browser = await launchBrowserOrt();
console.error('[parity] WebGPU adapter:', browser.adapter);
if (!browser.adapter) throw new Error('No WebGPU adapter in this Chrome: try BROWSER_ORT_FLAGS="--enable-unsafe-webgpu"');
const nodeSession = (await ortNode.InferenceSession.create(path.join(ROOT, 'extension/models', spec.file), { graphOptimizationLevel: 'all' })) as unknown as SessionLike;
const model = `models/${spec.file}`;
const [gpu, wasm] = [await browser.session(model, 'webgpu'), await browser.session(model, 'wasm')];

async function embedAll(s: SessionLike, batch: number, ms?: number[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < crops.length; i += batch) {
    out.push(...(await embedImages(s, Tensor, { ...spec, maxBatch: batch }, crops.slice(i, i + batch))));
    if (ms) ms.push((s as RemoteSession).lastRunMs);
  }
  return out;
}
const msGpu1: number[] = [];
const msWasm1: number[] = [];
const msGpu8: number[] = [];
const msWasm8: number[] = [];
const vNode = await embedAll(nodeSession, 1);
const vGpu = await embedAll(gpu, 1, msGpu1);
const vWasm = await embedAll(wasm, 1, msWasm1);
const vGpu8 = await embedAll(gpu, 8, msGpu8);
const vWasm8 = await embedAll(wasm, 8, msWasm8);

const cGpuWasm = vGpu.map((v, i) => cos(v, vWasm[i]));
const cGpuNode = vGpu.map((v, i) => cos(v, vNode[i]));
const cWasmNode = vWasm.map((v, i) => cos(v, vNode[i]));
const cGpu8Wasm = vGpu8.map((v, i) => cos(v, vWasm[i]));
const cWasm8Wasm = vWasm8.map((v, i) => cos(v, vWasm[i]));
const topNode = vNode.map(topCard);
const topChanged = (vs: Float32Array[]) => vs.map(topCard).filter((c, i) => c !== topNode[i]).length;
const embedder = {
  crops: crops.length,
  cosine: {
    webgpuVsWasm: stats(cGpuWasm),
    webgpuVsNode: stats(cGpuNode),
    wasmVsNode: stats(cWasmNode),
    webgpuBatch8VsWasm: stats(cGpu8Wasm),
    wasmBatch8VsWasm: stats(cWasm8Wasm),
  },
  below09995: { webgpuVsWasm: cGpuWasm.filter((c) => c < 0.9995).length, webgpuBatch8VsWasm: cGpu8Wasm.filter((c) => c < 0.9995).length },
  topCardChangedVsNode: { webgpu: topChanged(vGpu), wasm: topChanged(vWasm), webgpuBatch8: topChanged(vGpu8) },
  latency: { webgpu: times(msGpu1), wasm: times(msWasm1), webgpuBatch8: times(msGpu8), wasmBatch8: times(msWasm8) },
};
console.error('[parity] embedder', JSON.stringify(embedder));
await Promise.all([gpu.release(), wasm.release()]);

// The card detector: whole frames (click to scan) and the crops (a scan).
const detFile = `${CARD_DETECTOR.dir}/${CARD_DETECTOR.file}`;
const dets = await Promise.all(
  (['webgpu', 'wasm'] as const).map(async (ep) => {
    const session = await browser.session(detFile, ep);
    const d = createCardDetector({ session, Tensor, release: () => session.release() }).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
    return { ep, session, d };
  }),
);
interface Box {
  kind?: string;
  conf: number;
  pts: [number, number][];
}
function compare(a: Box[], b: Box[]) {
  if (a.length !== b.length || a.some((x, i) => x.kind !== b[i].kind)) return { same: false, maxPt: null, maxConf: null };
  let maxPt = 0;
  let maxConf = 0;
  a.forEach((x, i) => {
    maxConf = Math.max(maxConf, Math.abs(x.conf - b[i].conf));
    x.pts.forEach(([px, py], k) => (maxPt = Math.max(maxPt, Math.hypot(px - b[i].pts[k][0], py - b[i].pts[k][1]))));
  });
  return { same: true, maxPt, maxConf };
}
const frameNames = [...frames.keys()];
const detect = { frames: { n: 0, differ: [] as string[], maxPt: 0, maxConf: 0 }, crops: { n: 0, differ: [] as number[], maxPt: 0, maxConf: 0 }, latency: {} as Record<string, unknown> };
const ms: Record<string, number[]> = { 'webgpu-frame': [], 'wasm-frame': [], 'webgpu-crop': [], 'wasm-crop': [] };
for (const name of frameNames) {
  const g: Box[] = [];
  const w: Box[] = [];
  for (const { ep, session, d } of dets) {
    // One run at a time, as the offscreen queue runs them (concurrent runs would skew the times).
    (ep === 'webgpu' ? g : w).push(...((await d.detect(frames.get(name)!)) as Box[]));
    ms[`${ep}-frame`].push(session.lastRunMs);
  }
  const c = compare(g, w);
  detect.frames.n++;
  if (!c.same) detect.frames.differ.push(name);
  else ((detect.frames.maxPt = Math.max(detect.frames.maxPt, c.maxPt!)), (detect.frames.maxConf = Math.max(detect.frames.maxConf, c.maxConf!)));
}
for (let i = 0; i < crops.length; i++) {
  const g: Box[] = [];
  const w: Box[] = [];
  for (const { ep, session, d } of dets) {
    const out = await d.detectInCropWithWeak!(crops[i]);
    (ep === 'webgpu' ? g : w).push(...([...out.cards, ...out.weak] as Box[]));
    ms[`${ep}-crop`].push(session.lastRunMs);
  }
  const c = compare(g, w);
  detect.crops.n++;
  if (!c.same) detect.crops.differ.push(i);
  else ((detect.crops.maxPt = Math.max(detect.crops.maxPt, c.maxPt!)), (detect.crops.maxConf = Math.max(detect.crops.maxConf, c.maxConf!)));
}
for (const [k, v] of Object.entries(ms)) detect.latency[k] = times(v);
console.error('[parity] detector', JSON.stringify(detect));
await browser.close();

const pass = embedder.below09995.webgpuVsWasm === 0 && embedder.below09995.webgpuBatch8VsWasm === 0;
writeFileSync(OUT, JSON.stringify({ model: spec.id, adapter: browser.adapter, embedder, detector: detect, pass }, null, 2));
console.log(`parity (cosine >= 0.9995 on all ${crops.length} crops, WebGPU vs WASM): ${pass ? 'PASS' : 'FAIL'}; written to ${path.relative(ROOT, OUT)}`);
process.exitCode = pass ? 0 : 1;
