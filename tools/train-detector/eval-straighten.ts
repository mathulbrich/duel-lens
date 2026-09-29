// The recogniser's accuracy after straightening a card from the detector's outline, in the drag case.
// For every labelled card of data/realset/set.json (120), plus any row of data/realset/staging-C.json
// that set.json lacks (capture-C's 63 were merged into set.json on 2026-09-29):
//   1. the content script's crop of the user's box (tools/realset/lib/crop.ts buildCrop);
//   2. the detector's first pick in it (findInCrop: confident and central);
//   3. the card straightened to CARD_W x CARD_H from
//        quad  its 4 predicted corners (keystone-aware; warpQuad, src/offscreen/geometry.ts), or
//        rect  the oriented box's corners (what a rotated-box-only detector gives);
//   4. ART_BOX cut upright and turned 180 degrees (the engine's own `quad` hypotheses, buildHypotheses),
//      embedded with the default embedding model, searched in its index (topKByCard), merged, decided
//      with the model's thresholds.
// Compared, row by row, with the engine's answers on the same rows: an eval-real.ts results file
// (--engine-results; by default data/realset/results-engine-<default model>.json, the engine as the
// extension builds it, which straightens the card itself since A4). detector-report.md compared with
// the engine before A4, which read the user's box alone. Reported overall, by production and by tag
// (perspective, tilted).
//
//   npx tsx tools/train-detector/eval-straighten.ts [--model <onnx>] [--threads N] [--out <json>]
//     [--engine-results <json>]
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CARD_H, CARD_W } from '../../src/shared/card-layout';
import { cornersOf, refined, type DetectedCard } from '../../src/offscreen/detector/detector';
import { CARD_DETECTOR_FILE, createNodeCardDetector } from '../../src/offscreen/detector/node';
import { warpQuad, type Quad } from '../../src/offscreen/geometry';
import { buildHypotheses } from '../../src/offscreen/hypotheses';
import { decodeIndex, type IndexMeta } from '../../src/shared/index-format';
import { getModel } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';
import { decide, mergeCandidates, topKByCard } from '../../src/shared/search';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';
import { buildCrop } from '../realset/lib/crop';
import type { RealsetEntry } from '../realset/lib/types';

const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelFile = opt('--model') ?? CARD_DETECTOR_FILE;
const threads = opt('--threads') ? Number(opt('--threads')) : undefined;
const outFile = opt('--out') ?? path.join(root, 'data/train-detector/eval/straighten.json');
const engineResults = opt('--engine-results');

/**
 * Hand-read corners of the fully visible perspective close-up cards (native frame pixels): Nibiru (a) is the
 * checked full-view label of fv-dp-t447 mapped into the crop (x / 0.7583 − nativeOrigin); Celtic Mystic (a)
 * was read off a 2x gridded zoom of native-dp-t96-cards (zoom.py). The other three close-up cards are half
 * covered or cut by the crop's edge.
 */
const HAND_CORNERS: Record<string, [number, number][]> = {
  'native-dp-t447-cards-nibiru-a': [
    [177.2, 89],
    [483.1, 86.4],
    [619, 438.5],
    [236.5, 445.1],
  ],
  'native-dp-t96-cards-celtic-a': [
    [107.5, 47.5],
    [396, 81.5],
    [372.5, 371.5],
    [9, 322.5],
  ],
};

/** Mean distance between two quads' corners, over the best of the 4 cyclic orders. */
function cornerError(a: [number, number][], b: [number, number][]): number {
  let best = Infinity;
  for (let s = 0; s < 4; s++) {
    let e = 0;
    for (let k = 0; k < 4; k++) e += Math.hypot(a[(k + s) % 4][0] - b[k][0], a[(k + s) % 4][1] - b[k][1]);
    best = Math.min(best, e / 4);
  }
  return best;
}

interface Row extends RealsetEntry {
  tags?: string[];
  production?: string;
}

interface EngineRow {
  id: string;
  top1Correct: boolean;
  confident: boolean;
}

function engineRows(file: string): Map<string, EngineRow> {
  const f = path.resolve(root, file);
  if (!existsSync(f)) return new Map();
  const r = JSON.parse(readFileSync(f, 'utf8')) as { rows: EngineRow[] };
  return new Map(r.rows.map((x) => [x.id, x]));
}

const productionOf = (row: Row) => {
  const f = row.frame;
  if (f.startsWith('native-wcq-')) return 'WCQ Stuttgart 2026';
  if (f.startsWith('native-wc-')) return 'WC 2026';
  if (f.startsWith('native-tsc-')) return 'tsc';
  if (f.startsWith('native-hgg720-')) return 'hgg 720p';
  if (f.startsWith('native-hgg-')) return 'hgg';
  if (f.startsWith('native-ycsc-')) return 'YCS Columbus 2026';
  if (f.startsWith('native-dp-')) return 'dp close-up';
  if (f.startsWith('native-dlaw-')) return 'dlaw oblique';
  return 'YCS Paris 2026';
};

async function main() {
  const spec = getModel();
  const embedder = await createNodeEmbedder(spec, threads ? { threads } : {});
  const meta = JSON.parse(readFileSync(path.join(root, 'extension/data', `index-${spec.id}.meta.json`), 'utf8')) as IndexMeta;
  const bin = readFileSync(path.join(root, 'extension/data', `index-${spec.id}.bin`));
  const index = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
  const det = await createNodeCardDetector({ file: modelFile, threads });

  const set = JSON.parse(readFileSync(path.join(root, 'data/realset/set.json'), 'utf8')) as Row[];
  const inSet = new Set(set.map((r) => r.id));
  const stagingC = path.join(root, 'data/realset/staging-C.json');
  const rows: Row[] = [
    ...set,
    ...(existsSync(stagingC) ? (JSON.parse(readFileSync(stagingC, 'utf8')) as Row[]).filter((r) => !inSet.has(r.id)) : []),
  ];
  const engine = engineRows(engineResults ?? path.join('data/realset', `results-engine-${spec.id}.json`));

  const frames = new Map<string, RGBAImage>();
  const results = [];
  for (const row of rows) {
    let img = frames.get(row.frame);
    if (!img) frames.set(row.frame, (img = await loadRGBA(path.join(root, 'data/debug/frames', `${row.frame}.png`))));
    const crop = buildCrop(img, row.userBox);
    const picks = await det.findInCrop(crop.cropImg, { refine: false });
    const pick: DetectedCard | undefined = picks[0];
    const variants: Record<string, { top1: number | null; score: number; confident: boolean } | null> = {};
    /** A quad grown by `k` about its centroid (the detector's outlines run ~5% per side tighter than the real set's teacher boxes). */
    const grow = (pts: [number, number][], k: number): [number, number][] => {
      const cx = pts.reduce((a, p) => a + p[0], 0) / 4;
      const cy = pts.reduce((a, p) => a + p[1], 0) / 4;
      return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
    };
    /** Candidate lists (upright and turned) for one quad, or null when it can't be straightened. */
    const hypotheses = async (pts: [number, number][]) => {
      const card = warpQuad(crop.cropImg, pts.map(([x, y]) => ({ x, y })) as Quad, CARD_W, CARD_H);
      if (!card) return null;
      // The art box upright and turned 180 degrees: the engine's `quad` hypotheses for this card, in that order.
      const vecs = await embedder.embed(buildHypotheses(card, card, null, { userBoxWithCard: false }).map((h) => h.image));
      return vecs.map((v) => topKByCard(v, index, 5));
    };
    const verdict = (lists: ReturnType<typeof topKByCard>[] | null) => {
      if (!lists) return null;
      const merged = mergeCandidates(lists, 5);
      const d = decide(merged, spec.thresholds);
      return { top1: d.nothing ? null : (merged[0]?.cardId ?? null), score: +(merged[0]?.score ?? 0).toFixed(4), confident: d.confident };
    };
    const q0 = pick ? await hypotheses(pick.pts as [number, number][]) : null;
    variants.quad = verdict(q0);
    variants.rect = pick ? verdict(await hypotheses(cornersOf(pick) as [number, number][])) : null;
    // the outline fitted to the image (refine.ts): its 4 corners, and its oriented box
    const fitted = pick ? refined(crop.cropImg, pick) : null;
    const qr = fitted ? await hypotheses(fitted.pts as [number, number][]) : null;
    const qb = fitted ? await hypotheses(cornersOf(fitted) as [number, number][]) : null;
    const qb8 = fitted ? await hypotheses(grow(cornersOf(fitted) as [number, number][], 1.08)) : null;
    variants.refined = verdict(qr);
    variants.refinedBox = verdict(qb);
    // the engine's way: every hypothesis's candidates merged (max score per card), one decision
    variants.merged = qr || qb || qb8 ? verdict([...(qr ?? []), ...(qb ?? []), ...(qb8 ?? [])]) : null;
    const e = engine.get(row.id);
    const hand = HAND_CORNERS[row.id];
    let corner: { refinedPx: number | null; quadPx: number; rectPx: number; side: number } | null = null;
    if (hand && pick) {
      const sc = crop.outW / crop.px.w;
      const truth = hand.map(([x, y]) => [(x - crop.px.x) * sc, (y - crop.px.y) * sc] as [number, number]);
      const side = Math.min(Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]), Math.hypot(truth[3][0] - truth[0][0], truth[3][1] - truth[0][1]));
      corner = {
        refinedPx: fitted ? +cornerError(fitted.pts as [number, number][], truth).toFixed(1) : null,
        quadPx: +cornerError(pick.pts as [number, number][], truth).toFixed(1),
        rectPx: +cornerError(cornersOf(pick) as [number, number][], truth).toFixed(1),
        side: Math.round(side),
      };
    }
    results.push({
      corner,
      id: row.id,
      production: productionOf(row),
      tags: row.tags ?? [],
      cardId: row.cardId,
      pick: pick ? { kind: pick.kind, conf: pick.conf } : null,
      quad: variants.quad,
      rect: variants.rect,
      refined: variants.refined,
      refinedBox: variants.refinedBox,
      merged: variants.merged,
      refinedHow: fitted?.refined ?? null,
      engine: e ? { top1: e.top1Correct, confident: e.confident } : null,
    });
  }

  type R = (typeof results)[number];
  const right = (v: R['quad'], r: R) => !!v && v.top1 === r.cardId;
  const sure = (v: R['quad'], r: R) => right(v, r) && !!v?.confident;
  const wrongSure = (v: R['quad'], r: R) => !!v && v.confident && v.top1 !== r.cardId;
  const line = (label: string, rs: R[]) => {
    const n = rs.length;
    const eng = rs.filter((r) => r.engine);
    return (
      `  ${label.padEnd(26)} n=${String(n).padStart(3)}  quad: top-1 ${rs.filter((r) => right(r.quad, r)).length}, confident ${rs.filter((r) => sure(r.quad, r)).length}, confident wrong ${rs.filter((r) => wrongSure(r.quad, r)).length}` +
      `   rect: ${rs.filter((r) => right(r.rect, r)).length}/${rs.filter((r) => sure(r.rect, r)).length}/${rs.filter((r) => wrongSure(r.rect, r)).length}` +
      `   refined: ${rs.filter((r) => right(r.refined, r)).length}/${rs.filter((r) => sure(r.refined, r)).length}/${rs.filter((r) => wrongSure(r.refined, r)).length}` +
      `   refined box: ${rs.filter((r) => right(r.refinedBox, r)).length}/${rs.filter((r) => sure(r.refinedBox, r)).length}/${rs.filter((r) => wrongSure(r.refinedBox, r)).length}` +
      `   merged: ${rs.filter((r) => right(r.merged, r)).length}/${rs.filter((r) => sure(r.merged, r)).length}/${rs.filter((r) => wrongSure(r.merged, r)).length}` +
      `   engine: ${eng.filter((r) => r.engine!.top1).length}/${eng.filter((r) => r.engine!.top1 && r.engine!.confident).length} of ${eng.length}` +
      `   either (engine or merged): ${rs.filter((r) => right(r.merged, r) || r.engine?.top1).length}`
    );
  };
  console.log('\n## Recogniser after straightening from the detector (drag case: the user box crop)\n');
  console.log('  columns: top-1 right, confident and right, confident and wrong\n');
  console.log(line('all', results));
  for (const p of [...new Set(results.map((r) => r.production))]) console.log(line(p, results.filter((r) => r.production === p)));
  for (const t of ['perspective', 'tilted', 'defense', 'foil', 'occluded']) console.log(line(`tag: ${t}`, results.filter((r) => r.tags.includes(t))));
  const persp = results.filter((r) => r.tags.includes('perspective') && r.production === 'dp close-up');
  console.log('\n  dp close-ups, row by row:');
  for (const r of persp)
    console.log(
      `    ${r.id}: quad ${r.quad?.top1 === r.cardId ? 'RIGHT' : 'wrong'} ${r.quad?.score} ${r.quad?.confident ? 'confident' : ''} | merged ${r.merged?.top1 === r.cardId ? 'RIGHT' : 'wrong'} ${r.merged?.score} ${r.merged?.confident ? 'confident' : ''} | rect ${r.rect?.top1 === r.cardId ? 'RIGHT' : 'wrong'} ${r.rect?.score} | engine ${r.engine?.top1 ? 'right' : 'wrong'}` +
        ` | refined ${r.refined?.top1 === r.cardId ? 'RIGHT' : 'wrong'} ${r.refined?.score} (${r.refinedHow})` +
        (r.corner ? ` | corner error: refined ${r.corner.refinedPx} px, quad ${r.corner.quadPx} px, rect ${r.corner.rectPx} px (card ${r.corner.side} px wide)` : ''),
    );
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify({ model: path.relative(root, modelFile), embedder: spec.id, thresholds: spec.thresholds, results }, null, 1));
  console.log(`\nwrote ${path.relative(root, outFile)}`);
  await det.release();
  await embedder.release();
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
