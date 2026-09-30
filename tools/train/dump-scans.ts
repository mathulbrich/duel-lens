// Dumps the images the CURRENT engine embeds for each row of a set (combined-retrain-report.md): by drag (the row's
// box, cropped as the content script crops a drag) and/or by click (click to scan's outline under the box's centre,
// found by the whole-frame detector on the native frame, handed to the engine as crop.outline), with thresholds that
// never decide (so both rotation stages run; no rescue, badge or suggestions).
// The embedder is a stub (zero vectors): the hypotheses depend on the detector and the engine only, so any PyTorch
// checkpoint can then be scored on exactly these images, before it is exported and indexed (tools/train/screen.py).
// Like dump-hyps.ts, with clicks and non-card rows too.
//   npx tsx tools/train/dump-scans.ts --set rows.json --modes drag,click --out DIR
// Row: { id, frame (path from the repo root or absolute), box {x,y,w,h}, cardId (null: not a card), group }.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadRGBA } from '../lib/image';
import { ROOT } from '../realset/lib/cards';
import { buildCrop } from '../realset/lib/crop';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine, type Embedder } from '../../src/offscreen/engine';
import { decodeIndex, type IndexMeta } from '../../src/shared/index-format';
import type { DetectedCardBox } from '../../src/shared/messages';
import { getModel } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';

const arg = (n: string) => (process.argv.indexOf(n) >= 0 ? process.argv[process.argv.indexOf(n) + 1] : undefined);
const setPath = path.resolve(ROOT, arg('--set') ?? '');
const outDir = path.resolve(ROOT, arg('--out') ?? '');
const modes = (arg('--modes') ?? 'drag').split(',') as ('drag' | 'click')[];

interface Row {
  id: string;
  frame: string;
  box: { x: number; y: number; w: number; h: number };
  cardId: number | null;
  group: string;
}

const inside = (pts: readonly (readonly number[])[], x: number, y: number) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const area = (pts: readonly (readonly number[])[]) =>
  Math.abs(pts.reduce((s, p, i) => s + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0)) / 2;

/** eval-gate.ts's clickHit: the smallest face-up outline containing the box's centre. */
function clickHit(outlines: readonly DetectedCardBox[], box: Row['box']) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const hits = outlines.filter((o) => o.kind !== 'face-down' && inside(o.pts, cx, cy)).sort((a, b) => area(a.pts) - area(b.pts));
  if (!hits.length) return null;
  const pts = hits[0].pts;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { pts, box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
}

async function main() {
  const rows = JSON.parse(readFileSync(setPath, 'utf8')) as Row[];
  const spec = getModel('dinov2-small-duel');
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  const meta = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8')) as IndexMeta;
  const buf = readFileSync(`${base}.bin`);
  const index = decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
  const det = await createNodeCardDetector();
  const detector = det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  let got: RGBAImage[] = [];
  const embedder: Embedder = {
    modelId: spec.id,
    embed: async (images) => {
      got.push(...images);
      return images.map(() => new Float32Array(spec.dim));
    },
  };
  const engine = createEngine({ embedder, index, spec: { ...spec, thresholds: { score: Infinity, margin: 0, floor: -Infinity } }, detector });
  mkdirSync(outDir, { recursive: true });
  const manifest: { id: string; cardId: number | null; group: string; mode: string; files: string[]; noOutline?: boolean; best?: string }[] = [];
  let lastFrame = '';
  let frame: RGBAImage | null = null;
  let outlines: DetectedCardBox[] | null = null;
  for (const row of rows) {
    if (row.frame !== lastFrame) {
      frame = await loadRGBA(path.resolve(ROOT, row.frame));
      lastFrame = row.frame;
      outlines = null;
    }
    for (const mode of modes) {
      let box = row.box;
      let outline: [number, number][] | undefined;
      if (mode === 'click') {
        outlines ??= await detector.detect(frame!);
        const hit = clickHit(outlines, row.box);
        if (!hit) {
          manifest.push({ id: row.id, cardId: row.cardId, group: row.group, mode, files: [], noOutline: true });
          continue;
        }
        box = hit.box;
        outline = hit.pts.map(([x, y]) => [x, y] as [number, number]);
      }
      const { cropImg, inner, px, outW, outH } = buildCrop(frame!, box);
      const inCrop = outline?.map(([x, y]) => [((x - px.x) * outW) / px.w, ((y - px.y) * outH) / px.h] as [number, number]) ?? null;
      got = [];
      const res = await engine.recognize(cropImg, inner, inCrop);
      if (res.error) console.error(`[dump] ${row.id} ${mode}: ${res.error}`);
      const files: string[] = [];
      for (const [k, img] of got.entries()) {
        const f = `${row.id}__${mode}__${k}.png`;
        await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
          .removeAlpha()
          .png()
          .toFile(path.join(outDir, f));
        files.push(f);
      }
      manifest.push({ id: row.id, cardId: row.cardId, group: row.group, mode, files });
    }
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`dumped ${manifest.reduce((n, m) => n + m.files.length, 0)} images of ${manifest.length} scans to ${outDir}`);
  await det.release?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
