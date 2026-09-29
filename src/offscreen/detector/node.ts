// The card detector on onnxruntime-node or on onnxruntime-web's WASM build in Node, for tests and
// tools (never imported by the extension bundle): the same createCardDetector() code the offscreen
// page runs.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SessionLike, TensorCtor } from '../../shared/embed-core';
import { createCardDetector, type OwnCardDetector } from './detector';
import { CARD_DETECTOR } from './spec';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/** extension/models/detector/card-detector.onnx (tools/train-detector/README.md rebuilds it). */
export const CARD_DETECTOR_FILE = path.join(ROOT, 'extension', CARD_DETECTOR.dir, CARD_DETECTOR.file);

export const haveCardDetector = (file: string = CARD_DETECTOR_FILE) => existsSync(file);

export interface NodeCardDetectorOptions {
  file?: string;
  /** 'node' (default): onnxruntime-node; 'wasm': onnxruntime-web's WASM build, as the offscreen page runs it. */
  runtime?: 'node' | 'wasm';
  /** Intra-op threads (node) or WASM threads (wasm; default 4, the offscreen page's maximum). */
  threads?: number;
}

export async function createNodeCardDetector(opts: NodeCardDetectorOptions = {}): Promise<OwnCardDetector> {
  const file = opts.file ?? CARD_DETECTOR_FILE;
  if (opts.runtime === 'wasm') {
    const require = createRequire(path.join(ROOT, 'package.json'));
    const loaded = await import(require.resolve('onnxruntime-web/wasm'));
    const ort = (loaded.env ? loaded : loaded.default) as typeof import('onnxruntime-web/wasm');
    ort.env.wasm.numThreads = opts.threads ?? 4;
    ort.env.wasm.wasmPaths = path.join(ROOT, 'node_modules/onnxruntime-web/dist/');
    const session = await ort.InferenceSession.create(await readFile(file), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return createCardDetector({
      session: session as unknown as SessionLike,
      Tensor: ort.Tensor as unknown as TensorCtor,
      release: () => session.release(),
    });
  }
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(file, {
    graphOptimizationLevel: 'all',
    ...(opts.threads ? { intraOpNumThreads: opts.threads, interOpNumThreads: 1 } : {}),
  });
  return createCardDetector({
    session: session as unknown as SessionLike,
    Tensor: ort.Tensor as unknown as TensorCtor,
    release: () => session.release(),
  });
}
