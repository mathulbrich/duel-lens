// Downloads each registered embedding model (src/shared/models.ts) into extension/models/<file>,
// then checks it with onnxruntime-node: input/output names, output shape and batch size 2.
//
// Usage: npx tsx tools/fetch-models.ts [--models a,b] [--no-verify]
//
// Some sources need one preparation step, done by tools/prepare-model.py (needs the `onnx`
// Python package, e.g. python3 -m venv data/venv && data/venv/bin/pip install onnx):
//   cut-classifier  timm classifiers: expose the pooled pre-logits features instead of logits.
//   merge-external  weights shipped in a separate .onnx_data file: inline them (one file to bundle).
//   fp16-weights    float32 model too big to bundle: store the weights as float16 (half the size).
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { MODELS, type EmbeddingModelSpec } from '../src/shared/models';
import { politeFetch } from './lib/http';
import { MODELS_DIR, modelPath } from './lib/ort-node';

const root = path.resolve(import.meta.dirname, '..');
const SRC_DIR = path.join(root, 'data/models-src');

const PREPARE: Record<string, 'cut-classifier' | 'merge-external' | 'fp16-weights'> = {
  'mobilenetv3-large': 'cut-classifier',
  'dinov3-small': 'merge-external',
  'dinov3-small-q4': 'merge-external',
  'mobileclip-s0': 'fp16-weights',
};

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function download(url: string, file: string) {
  if (existsSync(file) && statSync(file).size > 0) return;
  console.log(`  GET ${url}`);
  const res = await politeFetch(url, { timeoutMs: 600_000 });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.part`, buf);
  await rename(`${file}.part`, file);
}

function python(): string {
  const venv = path.join(root, 'data/venv/bin/python');
  return existsSync(venv) ? venv : 'python3';
}

async function fetchModel(spec: EmbeddingModelSpec) {
  const out = modelPath(spec);
  if (existsSync(out) && statSync(out).size > 0) {
    console.log(`${spec.id}: have ${spec.file}`);
    return;
  }
  console.log(`${spec.id}: fetching ${spec.file}`);
  const step = PREPARE[spec.id];
  if (!step) {
    await download(spec.sourceUrl, out);
    return;
  }
  const src = path.join(SRC_DIR, spec.id, path.basename(new URL(spec.sourceUrl).pathname));
  await download(spec.sourceUrl, src);
  if (step === 'merge-external') await download(`${spec.sourceUrl}_data`, `${src}_data`);
  try {
    execFileSync(python(), [path.join(import.meta.dirname, 'prepare-model.py'), step, src, out], { stdio: 'inherit' });
  } catch {
    throw new Error(
      `${spec.id}: tools/prepare-model.py ${step} failed. It needs the onnx Python package:\n` +
        `  python3 -m venv data/venv && data/venv/bin/pip install onnx`,
    );
  }
}

/** Load the model and run a batch of 2 blank images; report what the graph really exposes. */
async function verify(spec: EmbeddingModelSpec): Promise<string[]> {
  const problems: string[] = [];
  const session = await ort.InferenceSession.create(modelPath(spec));
  const s = spec.inputSize;
  if (!session.inputNames.includes(spec.inputName)) problems.push(`no input "${spec.inputName}" (${session.inputNames})`);
  if (!session.outputNames.includes(spec.outputName)) problems.push(`no output "${spec.outputName}" (${session.outputNames})`);
  if (problems.length === 0) {
    try {
      const x = new ort.Tensor('float32', new Float32Array(2 * 3 * s * s), [2, 3, s, s]);
      const dims = (await session.run({ [spec.inputName]: x }))[spec.outputName].dims;
      const want = spec.pooling === 'none' ? `2,${spec.dim}` : `2,*,${spec.dim}`;
      const got = spec.pooling === 'none' ? `${dims}` : `${dims[0]},*,${dims[2]}`;
      if (got !== want || (spec.pooling !== 'none' && dims.length !== 3)) problems.push(`output dims [${dims}], want [${want}]`);
      console.log(`${spec.id}: ${session.inputNames} → ${session.outputNames}; ${spec.outputName} [${dims}] for batch 2`);
    } catch (err) {
      problems.push(`batch of 2 failed (${(err as Error).message.split('\n')[0]}); set maxBatch: 1`);
    }
  }
  await session.release();
  return problems;
}

async function main() {
  const ids = arg('--models')?.split(',') ?? Object.keys(MODELS);
  await mkdir(MODELS_DIR, { recursive: true });
  let failed = false;
  for (const id of ids) {
    const spec = MODELS[id];
    if (!spec) throw new Error(`Unknown model "${id}" (known: ${Object.keys(MODELS)})`);
    if (spec.sourceUrl.startsWith('local:') && !existsSync(modelPath(spec))) {
      // Built on this machine (e.g. dinov2-small-duel by tools/train), so there is nothing to download.
      console.error(`  ✗ ${spec.id}: ${spec.file} can't be downloaded (${spec.sourceUrl}); copy it into extension/models/ or rebuild it (docs/DEVELOPMENT.md, "Models")`);
      failed = true;
      continue;
    }
    await fetchModel(spec);
    console.log(`  ${spec.file}: ${(statSync(modelPath(spec)).size / 1e6).toFixed(1)} MB`);
    if (process.argv.includes('--no-verify')) continue;
    const problems = await verify(spec);
    for (const p of problems) console.error(`  ✗ ${spec.id}: ${p}`);
    failed ||= problems.length > 0;
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
