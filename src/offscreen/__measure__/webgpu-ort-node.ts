// Measurement (not shipped, not a test): a stand-in for tools/lib/ort-node.ts and
// src/offscreen/detector/node.ts whose embedder and card detector run in one headless Chrome page
// (browser-ort.ts) on the WebGPU execution provider (BROWSER_ORT_EP=wasm: the page's WASM one), so
// tools/eval-real.ts runs unchanged with the extension's WebGPU models. webgpu-hooks.mjs swaps it in
// (BROWSER_ORT_DETECTOR=node keeps the detector on onnxruntime-node, as eval-real runs it).
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import { embedImages, type TensorCtor } from '../../shared/embed-core';
import type { EmbeddingModelSpec } from '../../shared/models';
import type { RGBAImage } from '../../shared/preprocess';
import { createNodeCardDetector as nodeCardDetector, type NodeCardDetectorOptions } from '../detector/node';
import { createCardDetector, type OwnCardDetector } from '../detector/detector';
import { CARD_DETECTOR } from '../detector/spec';
import { launchBrowserOrt, type BrowserOrt, type Ep } from './browser-ort';

export { CARD_DETECTOR_FILE, haveCardDetector } from '../detector/node';

const ep = (process.env.BROWSER_ORT_EP ?? 'webgpu') as Ep;
let launched: Promise<BrowserOrt> | null = null;
/** One page for both models. */
async function browser(): Promise<BrowserOrt> {
  launched ??= launchBrowserOrt().then((b) => {
    if (ep === 'webgpu' && !b.adapter) throw new Error('No WebGPU adapter in this Chrome');
    console.error(`[webgpu-ort-node] the page's ${ep} execution provider`, b.adapter ?? '');
    return b;
  });
  return launched;
}

export async function createNodeCardDetector(opts: NodeCardDetectorOptions = {}): Promise<OwnCardDetector> {
  if (process.env.BROWSER_ORT_DETECTOR === 'node') return nodeCardDetector(opts);
  const session = await (await browser()).session(`${CARD_DETECTOR.dir}/${CARD_DETECTOR.file}`, ep);
  console.error(`[webgpu-ort-node] the card detector on the page's ${ep} execution provider`);
  return createCardDetector({ session, Tensor: ort.Tensor as unknown as TensorCtor, release: () => session.release().catch(() => {}) });
}

export const MODELS_DIR = path.resolve(import.meta.dirname, '../../../extension/models');
export const modelPath = (spec: EmbeddingModelSpec) => path.join(MODELS_DIR, spec.file);

export async function createNodeEmbedder(spec: EmbeddingModelSpec) {
  const page = await browser();
  const session = await page.session(`models/${spec.file}`, ep);
  console.error(`[webgpu-ort-node] ${spec.id} on the page's ${ep} execution provider`);
  const ms: number[] = [];
  return {
    spec,
    session,
    embed: async (images: RGBAImage[]) => {
      const v = await embedImages(session, ort.Tensor as unknown as TensorCtor, spec, images);
      ms.push(session.lastRunMs);
      return v;
    },
    release: async () => {
      const s = [...ms].sort((a, b) => a - b);
      console.error(`[webgpu-ort-node] ${ep}: ${ms.length} embed() calls, session.run median ${s[s.length >> 1]?.toFixed(1)} ms`);
      await page.close();
    },
  };
}
