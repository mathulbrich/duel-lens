// Dumps the images the engine embeds for each row of a foil set (tools/train/eval-foil.ts's real.json): every
// hypothesis of both stages (thresholds that never decide), as the engine cuts them from the crop the content
// script sends. tools/train/foil_torch.py then scores any PyTorch checkpoint on exactly these images, so a
// checkpoint can be checked on real footage before it is exported and indexed.
//   npx tsx tools/train/dump-hyps.ts [--set data/train/foil/real.json] [--out data/train/foil/hyps]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';
import { ROOT } from '../realset/lib/cards';
import { buildCrop } from '../realset/lib/crop';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine, type Embedder } from '../../src/offscreen/engine';
import { decodeIndex, type IndexMeta } from '../../src/shared/index-format';
import { getModel } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';

const arg = (n: string) => (process.argv.indexOf(n) >= 0 ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const setPath = path.resolve(ROOT, arg('--set') ?? 'data/train/foil/real.json');
const outDir = path.resolve(ROOT, arg('--out') ?? 'data/train/foil/hyps');

async function main() {
  const rows = JSON.parse(readFileSync(setPath, 'utf8')) as { id: string; frame: string; box: { x: number; y: number; w: number; h: number }; cardId: number; group: string }[];
  // The model only decides which hypotheses run (none decide here); its vectors are not kept.
  const spec = getModel('dinov2-small-duel');
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) as IndexMeta;
  const buf = readFileSync(`${base}.bin`);
  const index = decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
  const node = await createNodeEmbedder(spec);
  const det = await createNodeCardDetector();
  let got: RGBAImage[] = [];
  const embedder: Embedder = {
    modelId: spec.id,
    embed: async (images) => {
      got.push(...images);
      return node.embed(images);
    },
  };
  const engine = createEngine({
    embedder,
    index,
    spec: { ...spec, thresholds: { score: Infinity, margin: 0, floor: -Infinity } },
    detector: det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence }),
  });
  mkdirSync(outDir, { recursive: true });
  const manifest: { id: string; cardId: number; group: string; files: string[] }[] = [];
  for (const row of rows) {
    const frame = await loadRGBA(path.join(ROOT, row.frame));
    const { cropImg, inner } = buildCrop(frame, row.box);
    got = [];
    await engine.recognize(cropImg, inner);
    const files: string[] = [];
    for (const [k, img] of got.entries()) {
      const f = `${row.id}__${k}.png`;
      await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
        .removeAlpha()
        .png()
        .toFile(path.join(outDir, f));
      files.push(f);
    }
    manifest.push({ id: row.id, cardId: row.cardId, group: row.group, files });
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`dumped ${manifest.reduce((n, m) => n + m.files.length, 0)} hypothesis images of ${manifest.length} rows to ${path.relative(ROOT, outDir)}`);
  await det.release();
  await node.release();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
