// realset2 proposals: for every captured frame (data/realset2/capture.jsonl), every card the card
// detector finds (both classes, outlines fitted to the image), and for each, what the extension's
// engine answers on the box a user would draw around it (the outline's axis-aligned bounds, through
// eval-real's crop: tools/realset/lib/crop.ts) plus its top 10 before any threshold (the NEVER_DECIDE
// engine, as eval-real --raw builds it). These are CANDIDATES for a person to confirm by eye; nothing
// here is a label. Appends one line per frame to data/realset2/proposals.jsonl (frames already there
// are skipped).
//
//   npx tsx tools/realset2/propose.ts [--model dinov2-small-duel] [--min-conf 0.3] [--frames a,b]
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadRGBA } from '../lib/image';
import { makeRig } from '../partial/lib/engine';
import { buildCrop } from '../realset/lib/crop';
import { loadCards } from '../realset/lib/cards';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine } from '../../src/offscreen/engine';
import { CARD_BACK_ID, type Candidate } from '../../src/shared/types';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const modelId = arg('--model') ?? 'dinov2-small-duel';
const minConf = Number(arg('--min-conf') ?? 0.3);
const only = arg('--frames')?.split(',').filter(Boolean) ?? null;
const outFile = path.join(OUT, arg('--out') ?? 'proposals.jsonl');

const NEVER_DECIDE = { score: Infinity, margin: 0, floor: -Infinity };

async function main() {
  const capture = readFileSync(path.join(OUT, 'capture.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { frame: string; video: string; t: number; width: number; height: number });
  const done = new Set(
    existsSync(outFile)
      ? readFileSync(outFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { frame: string }).frame)
      : [],
  );
  const todo = capture.filter((c) => !done.has(c.frame) && (!only || only.includes(c.frame)) && existsSync(path.join(OUT, 'frames', `${c.frame}.jpg`)));
  console.error(`[propose] ${todo.length} frames to do (${done.size} done), model ${modelId}`);
  const rig = await makeRig(modelId);
  const detector = rig.det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const rawEngine = createEngine({ embedder: rig.embedder, index: rig.index, spec: { ...rig.spec, thresholds: NEVER_DECIDE }, detector });
  const cards = loadCards();
  const nameOf = (id: number) => (id === CARD_BACK_ID ? 'Card back (face-down)' : (cards.byId.get(id)?.name ?? `(unknown ${id})`));
  const listed = (cs: readonly Candidate[]) => cs.map((c) => ({ cardId: c.cardId, name: nameOf(c.cardId), score: Math.round(c.score * 10000) / 10000 }));
  for (const c of todo) {
    const t0 = Date.now();
    const img = await loadRGBA(path.join(OUT, 'frames', `${c.frame}.jpg`));
    const found = (await rig.det.findCards(img, { refine: true })).filter((b) => b.conf >= minConf);
    const boxes = [];
    for (const [i, b] of found.entries()) {
      const xs = b.pts.map((p) => p[0]);
      const ys = b.pts.map((p) => p[1]);
      const x0 = Math.max(0, Math.floor(Math.min(...xs)));
      const y0 = Math.max(0, Math.floor(Math.min(...ys)));
      const x1 = Math.min(img.width, Math.ceil(Math.max(...xs)));
      const y1 = Math.min(img.height, Math.ceil(Math.max(...ys)));
      const userBox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      if (userBox.w < 8 || userBox.h < 8) continue;
      const edge = Math.min(...xs) < 2 || Math.min(...ys) < 2 || Math.max(...xs) > img.width - 2 || Math.max(...ys) > img.height - 2;
      const { cropImg, inner } = buildCrop(img, userBox);
      const r = await rig.engine.recognize(cropImg, inner);
      const all = await rawEngine.recognize(cropImg, inner);
      boxes.push({
        pid: `${c.frame}#${i}`,
        kind: b.kind,
        conf: Math.round(b.conf * 1000) / 1000,
        angleDeg: Math.round((b.angle * 180) / Math.PI),
        size: { w: Math.round(b.w), h: Math.round(b.h) },
        pts: b.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
        refined: b.refined ?? null,
        userBox,
        edge,
        answer: { candidates: listed(r.candidates), confident: r.confident, recognizer: r.recognizer ?? null, error: r.error ?? null },
        top10: listed(all.candidates),
      });
    }
    appendFileSync(outFile, JSON.stringify({ frame: c.frame, video: c.video, t: c.t, width: img.width, height: img.height, model: modelId, boxes }) + '\n');
    console.error(`[propose] ${c.frame}: ${boxes.length} boxes (${boxes.filter((b) => b.kind === 'face-up').length} face-up) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  await rig.release();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
