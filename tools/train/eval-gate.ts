// The combined retrain's gate sets (combined-retrain-report.md), through the extension's engine as tools/eval-real.ts
// builds it (our card detector, the model's thresholds; rescue, badge, suggestions and the low-match label as the
// engine has them), for several models side by side, each with its own index:
//   - drag:  the row's box, cropped as the content script crops a drag (tools/realset/lib/crop.ts);
//   - click: click to scan's outline under the box's centre (the whole-frame detector, face-up, the extension's
//            confidence), cropped from its bounds and passed to the engine as crop.outline, as capture.ts does; a click
//            on no outline is "no-outline" (a miss for a card, a pass for a non-card).
// A row: { id, frame (a PNG, relative to the repository root or absolute), box {x,y,w,h}, cardId (null: not a card),
// group, name? }. Verdicts: sure-right, sure-wrong, unsure-right, unsure-wrong, nothing (and no-outline). "unsure"
// includes low matches (suggested) and count-badge readings; they are counted apart too.
// --truth: also the right card's best score and rank over every reading the engine makes (drag only; the engine
// run again with thresholds that never decide).
//
//   npx tsx tools/train/eval-gate.ts --models dinov2-small-duel,dinov2-small-duel-v2 --set FILE [--modes drag,click]
//     [--truth] [--limit N] [--threads N] [--out FILE]
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';
import { loadCards, ROOT } from '../realset/lib/cards';
import { buildCrop } from '../realset/lib/crop';
import { createNodeCardDetector, haveCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine, type Embedder } from '../../src/offscreen/engine';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../../src/shared/index-format';
import type { DetectedCardBox } from '../../src/shared/messages';
import { getModel, type EmbeddingModelSpec } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';
import { CARD_BACK_ID, type RecognitionResult } from '../../src/shared/types';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const models = (arg('--models') ?? 'dinov2-small-duel').split(',').filter(Boolean);
const setPath = path.resolve(ROOT, arg('--set') ?? '');
const modes = (arg('--modes') ?? 'drag,click').split(',') as ('drag' | 'click')[];
const withTruth = process.argv.includes('--truth');
const limit = Number(arg('--limit') ?? 0);
/** onnxruntime intra-op threads per model (default: onnxruntime's choice, every performance core). */
const threads = arg('--threads') ? Number(arg('--threads')) : undefined;
const outPath = path.resolve(ROOT, arg('--out') ?? 'data/train/logs/eval-gate.json');

interface Row {
  id: string;
  frame: string;
  box: { x: number; y: number; w: number; h: number };
  cardId: number | null;
  group: string;
  name?: string;
}
type Verdict = 'sure-right' | 'sure-wrong' | 'unsure-right' | 'unsure-wrong' | 'nothing' | 'no-outline' | 'sure-noncard' | 'unsure-noncard';

async function loadIndex(spec: EmbeddingModelSpec): Promise<LoadedIndex> {
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  const [meta, buf] = await Promise.all([
    readFile(`${base}.meta.json`, 'utf8').then((s) => JSON.parse(s) as IndexMeta),
    readFile(`${base}.bin`),
  ]);
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
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

/** Click to scan's outline under the box's centre: the smallest face-up detection containing it. */
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

const NEVER_DECIDE = { score: Infinity, margin: 0, floor: -Infinity };

async function main() {
  const cards = loadCards();
  const nameOf = (id: number) => (id === CARD_BACK_ID ? 'Card back' : (cards.byId.get(id)?.name ?? `(card ${id})`));
  let rows: Row[] = JSON.parse(readFileSync(setPath, 'utf8'));
  if (limit > 0) rows = rows.slice(0, limit);
  if (!haveCardDetector()) throw new Error('the card detector model is missing');
  const det = await createNodeCardDetector(threads ? { threads } : {});
  const detector = det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const rigs = [];
  for (const id of models) {
    const spec = getModel(id);
    const [node, index] = await Promise.all([createNodeEmbedder(spec, threads ? { threads } : {}), loadIndex(spec)]);
    let captured: Float32Array[] = [];
    const embedder: Embedder = { modelId: spec.id, embed: node.embed };
    const capturing: Embedder = {
      modelId: spec.id,
      embed: async (images) => {
        const v = await node.embed(images);
        captured.push(...v);
        return v;
      },
    };
    rigs.push({
      id,
      spec,
      index,
      node,
      engine: createEngine({ embedder, index, spec, detector }),
      all: createEngine({ embedder: capturing, index, spec: { ...spec, thresholds: NEVER_DECIDE }, detector, suggest: false, rescue: false, badge: false }),
      take: () => {
        const v = captured;
        captured = [];
        return v;
      },
    });
  }
  const out: Record<string, unknown>[] = [];
  const t0 = Date.now();
  let lastFrame = '';
  let frame: RGBAImage | null = null;
  let outlines: DetectedCardBox[] | null = null;
  for (const [n, row] of rows.entries()) {
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
          const rec: Record<string, unknown> = { id: row.id, group: row.group, cardId: row.cardId, mode };
          for (const r of rigs) rec[r.id] = { verdict: row.cardId === null ? 'nothing' : 'no-outline', noOutline: true };
          out.push(rec);
          continue;
        }
        box = hit.box;
        outline = hit.pts.map(([x, y]) => [x, y] as [number, number]);
      }
      const { cropImg, inner, px, outW, outH } = buildCrop(frame!, box);
      const scale = outW / px.w;
      const inCrop = outline?.map(([x, y]) => [(x - px.x) * scale, (y - px.y) * (outH / px.h)] as [number, number]) ?? null;
      const rec: Record<string, unknown> = { id: row.id, group: row.group, cardId: row.cardId, mode };
      for (const r of rigs) {
        const res: RecognitionResult = await r.engine.recognize(cropImg, inner, inCrop);
        const top = res.candidates[0];
        let verdict: Verdict;
        if (!top) verdict = 'nothing';
        else if (row.cardId === null) verdict = res.confident ? 'sure-noncard' : 'unsure-noncard';
        else verdict = res.confident ? (top.cardId === row.cardId ? 'sure-right' : 'sure-wrong') : top.cardId === row.cardId ? 'unsure-right' : 'unsure-wrong';
        const m: Record<string, unknown> = {
          verdict,
          top: top ? { cardId: top.cardId, name: nameOf(top.cardId), score: +top.score.toFixed(4) } : null,
          second: res.candidates[1] ? +res.candidates[1].score.toFixed(4) : null,
          rank: row.cardId === null ? undefined : res.candidates.findIndex((c) => c.cardId === row.cardId) + 1,
          ...(res.suggested ? { suggested: true } : {}),
          ...(res.countBadge ? { countBadge: true } : {}),
          ...(res.truncated ? { truncated: true } : {}),
          best: res.best ? `${res.best.hypothesis}@${res.best.rotation}` : undefined,
          ...(res.error ? { error: res.error } : {}),
        };
        if (withTruth && mode === 'drag' && row.cardId !== null) {
          r.take();
          await r.all.recognize(cropImg, inner, inCrop);
          const qs = r.take();
          const { dim, count, entries } = r.index.meta;
          const v = r.index.vectors;
          const sc = v instanceof Int8Array ? 1 / 127 : 1;
          const best = new Map<number, number>();
          for (const q of qs)
            for (let i = 0; i < count; i++) {
              let dot = 0;
              const off = i * dim;
              for (let d = 0; d < dim; d++) dot += q[d] * v[off + d];
              const s = dot * sc;
              const c = entries[i].cardId;
              if (!(best.get(c)! >= s)) best.set(c, s);
            }
          const ts = best.get(row.cardId) ?? -1;
          let rank = 1;
          for (const [c, s] of best) if (c !== row.cardId && c !== CARD_BACK_ID && s > ts) rank++;
          m.truthScore = +ts.toFixed(4);
          m.truthRank = rank;
        }
        rec[r.id] = m;
      }
      out.push(rec);
    }
    if ((n + 1) % 25 === 0 || n === rows.length - 1) {
      console.error(`[eval-gate] ${n + 1}/${rows.length} rows (${Math.round((Date.now() - t0) / 1000)} s)`);
      writeFileSync(outPath, JSON.stringify({ models, set: setPath, rows: out }, null, 1));
    }
  }
  // summary per group x mode x model
  const summary: Record<string, Record<string, Record<string, number>>> = {};
  for (const rec of out) {
    const key = `${rec.group} ${rec.mode}`;
    for (const id of models) {
      const m = rec[id] as { verdict: Verdict; suggested?: boolean; countBadge?: boolean; truthRank?: number };
      const s = ((summary[key] ??= {})[id] ??= { n: 0 });
      s.n++;
      s[m.verdict] = (s[m.verdict] ?? 0) + 1;
      if (m.suggested) s.lowMatch = (s.lowMatch ?? 0) + 1;
      if (m.countBadge) s.badgeReading = (s.badgeReading ?? 0) + 1;
      if (m.truthRank === 1) s.truthFirst = (s.truthFirst ?? 0) + 1;
    }
  }
  for (const [key, per] of Object.entries(summary)) {
    for (const [id, s] of Object.entries(per)) {
      const right = (s['sure-right'] ?? 0) + (s['unsure-right'] ?? 0);
      console.log(`${key.padEnd(34)} ${id.padEnd(24)} n ${s.n} right ${right} (sure ${s['sure-right'] ?? 0}) sureWrong ${s['sure-wrong'] ?? 0} unsureWrong ${s['unsure-wrong'] ?? 0} nothing ${(s.nothing ?? 0) + (s['no-outline'] ?? 0)} ` +
        (s['sure-noncard'] || s['unsure-noncard'] ? `nonCardSure ${s['sure-noncard'] ?? 0} nonCardUnsure ${s['unsure-noncard'] ?? 0} ` : '') +
        (s.lowMatch ? `lowMatch ${s.lowMatch} ` : '') + (s.badgeReading ? `badgeReading ${s.badgeReading} ` : '') + (s.truthFirst ? `truthFirst ${s.truthFirst}` : ''));
    }
  }
  writeFileSync(outPath, JSON.stringify({ models, set: setPath, rows: out, summary }, null, 1));
  for (const r of rigs) await r.node.release();
  await det.release?.();
  console.log(`wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
