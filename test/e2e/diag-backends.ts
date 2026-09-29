// Diagnostic for run.ts --real: are its differences from tools/eval-real.ts the ONNX Runtime backend?
// Runs the engine (with the extension's card detector on the same backend) on eval-real's own crops
// (tools/realset/lib/crop.ts) twice: on onnxruntime-node, as eval-real does, and on onnxruntime-web's
// WASM backend, as the offscreen document does (it uses min(4, cores) threads). Compares both with the extension's raw answers in
// test/e2e/out/real-results.json, which run.ts --real writes.
// Usage: npx tsx test/e2e/diag-backends.ts [--threads 4]   (writes test/e2e/out/backends.json)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as ortNode from 'onnxruntime-node';
import * as ortWeb from 'onnxruntime-web';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine, type UserBox } from '../../src/offscreen/engine';
import { embedImages, type SessionLike, type TensorCtor } from '../../src/shared/embed-core';
import { decodeIndex, type IndexMeta } from '../../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';
import { loadRGBA } from '../../tools/lib/image';
import { buildCrop } from '../../tools/realset/lib/crop';

const root = path.resolve(import.meta.dirname, '../..');
const threadsArg = process.argv.indexOf('--threads');
const threads = threadsArg >= 0 ? Number(process.argv[threadsArg + 1]) : 4;
ortWeb.env.wasm.numThreads = threads;
ortWeb.env.wasm.wasmPaths = `${path.join(root, 'node_modules/onnxruntime-web/dist')}/`;

const spec = getModel(DEFAULT_MODEL_ID);
const indexBase = path.join(root, 'extension/data', `index-${spec.id}`);
const bin = readFileSync(`${indexBase}.bin`);
const meta = JSON.parse(readFileSync(`${indexBase}.meta.json`, 'utf8')) as IndexMeta;
const index = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);

interface Top {
  cardId: number;
  score: number;
}

interface Answer {
  recognizer: string | null;
  confident: boolean;
  faceDown: boolean;
  top: Top[];
}

/** The engine, embedder and card detector alike, on one ONNX Runtime backend. */
async function engineOn(backend: 'node' | 'wasm') {
  const file = path.join(root, 'extension/models', spec.file);
  const embedder = await (backend === 'node'
    ? ortNode.InferenceSession.create(file, { graphOptimizationLevel: 'all' })
    : ortWeb.InferenceSession.create(new Uint8Array(readFileSync(file)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }));
  const Tensor = (backend === 'node' ? ortNode.Tensor : ortWeb.Tensor) as unknown as TensorCtor;
  const embed = (images: RGBAImage[]) => embedImages(embedder as unknown as SessionLike, Tensor, spec, images);
  const cardDetector = (await createNodeCardDetector({ runtime: backend, threads })).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const engine = createEngine({ embedder: { modelId: spec.id, embed }, index, spec, detector: cardDetector });
  const tops = (cs: readonly { cardId: number; score: number }[]) => cs.slice(0, 5).map((c) => ({ cardId: c.cardId, score: c.score }));
  return async (img: RGBAImage, inner: UserBox): Promise<Answer> => {
    const r = await engine.recognize(img, inner);
    return { recognizer: r.recognizer ?? null, confident: r.confident, faceDown: r.faceDown, top: tops(r.candidates) };
  };
}

interface ExtRow {
  id: string;
  frame: string;
  box: { x: number; y: number; w: number; h: number };
  raw: { recognizer: string | null; confident: boolean; faceDown: boolean; candidates: Top[] } | null;
}

const results = JSON.parse(readFileSync(path.join(root, 'test/e2e/out/real-results.json'), 'utf8')) as { rows: ExtRow[] };
const [onNode, onWasm] = [await engineOn('node'), await engineOn('wasm')];
const frames = new Map<string, RGBAImage>();

/** Same top 5 (cards, in order) and the largest score difference; null when the cards differ. */
function against(a: Answer, ext: NonNullable<ExtRow['raw']>) {
  const sameCards = a.top.length === ext.candidates.length && a.top.every((c, i) => c.cardId === ext.candidates[i].cardId);
  const sameDecision = a.recognizer === ext.recognizer && a.confident === ext.confident && a.faceDown === ext.faceDown;
  const maxScoreDiff = sameCards ? Math.max(0, ...a.top.map((c, i) => Math.abs(c.score - ext.candidates[i].score))) : null;
  return { sameCards, sameDecision, maxScoreDiff };
}

type Check = ReturnType<typeof against>;
const rows: { id: string; ext: NonNullable<ExtRow['raw']>; node: Answer; wasm: Answer; nodeVsExt: Check; wasmVsExt: Check }[] = [];
for (const row of results.rows) {
  if (!row.raw) continue;
  let frame = frames.get(row.frame);
  if (!frame) frames.set(row.frame, (frame = await loadRGBA(path.join(root, 'data/debug/frames', `${row.frame}.png`))));
  const { cropImg, inner } = buildCrop(frame, row.box);
  const node = await onNode(cropImg, inner);
  const wasm = await onWasm(cropImg, inner);
  const out = { id: row.id, ext: row.raw, node, wasm, nodeVsExt: against(node, row.raw), wasmVsExt: against(wasm, row.raw) };
  rows.push(out);
  const fmt = (c: Check) => (c.sameCards ? `Δ ${c.maxScoreDiff!.toExponential(1)}` : 'other cards') + (c.sameDecision ? '' : ' OTHER DECISION');
  console.log(`${row.id.padEnd(32)} node: ${fmt(out.nodeVsExt).padEnd(22)} wasm×${threads}: ${fmt(out.wasmVsExt)}`);
}
const summary = (k: 'nodeVsExt' | 'wasmVsExt') => ({
  rows: rows.length,
  sameTop5: rows.filter((r) => r[k].sameCards).length,
  sameDecision: rows.filter((r) => r[k].sameDecision).length,
  maxScoreDiff: Math.max(0, ...rows.map((r) => r[k].maxScoreDiff ?? 0)),
});
console.log(`\nonnxruntime-node vs the extension: ${JSON.stringify(summary('nodeVsExt'))}`);
console.log(`onnxruntime-web WASM, ${threads} threads, vs the extension: ${JSON.stringify(summary('wasmVsExt'))}`);
writeFileSync(path.join(root, 'test/e2e/out/backends.json'), JSON.stringify({ threads, node: summary('nodeVsExt'), wasm: summary('wasmVsExt'), rows }, null, 2));
process.exit(0); // onnxruntime-web's WASM threads keep Node alive
