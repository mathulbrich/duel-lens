// The extension's engine as tools/eval-real.ts builds it (the embedding matcher, our card detector on
// onnxruntime-node at CARD_DETECTOR.minConfidence), for the partial-card tools, plus the whole-frame
// detector run click to scan makes (to emulate a click on an outlined card).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createNodeCardDetector } from '../../../src/offscreen/detector/node';
import type { OwnCardDetector } from '../../../src/offscreen/detector/detector';
import { CARD_DETECTOR } from '../../../src/offscreen/detector/spec';
import { createEngine, type Embedder, type Engine, type RescueOptions } from '../../../src/offscreen/engine';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../../../src/shared/index-format';
import { getModel, type EmbeddingModelSpec } from '../../../src/shared/models';
import type { DetectedCardBox } from '../../../src/shared/messages';
import type { RGBAImage } from '../../../src/shared/preprocess';
import { createNodeEmbedder } from '../../lib/ort-node';

export const ROOT = path.resolve(import.meta.dirname, '../../..');

/** Same as tools/eval-real.ts's private loadIndexFromDisk (copied). */
export async function loadIndexFromDisk(spec: EmbeddingModelSpec): Promise<LoadedIndex> {
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  const [meta, buf] = await Promise.all([readFile(`${base}.meta.json`, 'utf8').then((s) => JSON.parse(s) as IndexMeta), readFile(`${base}.bin`)]);
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

export interface Rig {
  engine: Engine;
  spec: EmbeddingModelSpec;
  index: LoadedIndex;
  embedder: Embedder;
  det: OwnCardDetector;
  /** Click to scan's outlines on a whole frame: face-up, at the extension's confidence. */
  outlines(frame: RGBAImage): Promise<DetectedCardBox[]>;
  release(): Promise<void>;
}

/** `rescue`: false for the engine without the rescue path (as it was before it), or settings to try. */
export async function makeRig(modelId = 'dinov2-small-duel', rescue?: Partial<RescueOptions> | false): Promise<Rig> {
  const spec = getModel(modelId);
  const [node, index, det] = await Promise.all([createNodeEmbedder(spec), loadIndexFromDisk(spec), createNodeCardDetector()]);
  const embedder: Embedder = { modelId: spec.id, embed: node.embed };
  const detector = det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const engine = createEngine({ embedder, index, spec, detector, rescue });
  return {
    engine,
    spec,
    index,
    embedder,
    det,
    outlines: (frame) => detector.detect(frame),
    release: async () => {
      await node.release();
      await det.release();
    },
  };
}
