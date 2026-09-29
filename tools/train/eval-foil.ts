// The foil test set (foil-report.md): full-card foil prints (Starlight, Collector's, Quarter Century
// Secret Rare) that turn an artwork's colours to reflective grey, olive or rainbow metal.
//   - real: sightings in real footage (data/train/foil/real.json), each through the extension's engine as
//     tools/eval-real.ts runs it (the crop the content script sends for the box, our card detector, the
//     model's thresholds), plus the right card's best score and rank over every reading the engine makes
//     (its merged rank: the engine run again with thresholds that never decide, so all hypotheses run);
//   - synth: synthetic foil renderings of UNSEEN cards (never trained on; tools/train/foil_set.py), 224 px
//     art cuts as the engine embeds them, matched against the model's index alone (one reading, no
//     hypotheses), decided by the model's thresholds.
// Several models side by side, each with its own index (extension/data/index-<model>.*).
//
//   npx tsx tools/train/eval-foil.ts --models dinov2-small-duel,dinov2-small-duel-foil
//       [--set data/train/foil/real.json] [--synth data/train/foil/synth] [--no-synth] [--out FILE] [--identify]
// --identify: print each real row's top 5 (for labelling rows whose card is unknown: cardId null).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { DEFAULT_MODEL_ID, getModel, type EmbeddingModelSpec } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';
import { decide } from '../../src/shared/search';
import { CARD_BACK_ID } from '../../src/shared/types';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const models = (arg('--models') ?? DEFAULT_MODEL_ID).split(',').filter(Boolean);
const setPath = path.resolve(ROOT, arg('--set') ?? 'data/train/foil/real.json');
const synthDir = path.resolve(ROOT, arg('--synth') ?? 'data/train/foil/synth');
const withSynth = !process.argv.includes('--no-synth') && existsSync(path.join(synthDir, 'manifest.json'));
const withReal = !process.argv.includes('--no-real') && existsSync(setPath);
const identify = process.argv.includes('--identify');
const outPath = path.resolve(ROOT, arg('--out') ?? 'data/train/logs/eval-foil.json');

interface RealRow {
  id: string;
  /** Frame image, relative to the repository root (or absolute). */
  frame: string;
  box: { x: number; y: number; w: number; h: number };
  cardId: number | null;
  name?: string;
  /** Which kind of sighting: the diagnosed card, other real foils, the real set's foil rows. */
  group: string;
  note?: string;
}
interface SynthRow {
  file: string;
  cardId: number;
  imageId: number;
  group: string;
}

type Verdict = 'sure-right' | 'sure-wrong' | 'unsure-right' | 'unsure-wrong' | 'nothing';

interface RealResult {
  id: string;
  group: string;
  cardId: number | null;
  verdict: Verdict;
  top: { cardId: number; name: string; score: number } | null;
  second: { name: string; score: number } | null;
  truthRank: number | null;
  truthScore: number | null;
  top5?: string[];
}
interface SynthResult {
  file: string;
  group: string;
  cardId: number;
  verdict: Verdict;
  truthRank: number;
  truthScore: number;
  topScore: number;
}

async function loadIndex(spec: EmbeddingModelSpec): Promise<LoadedIndex> {
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  const [meta, buf] = await Promise.all([
    readFile(`${base}.meta.json`, 'utf8').then((s) => JSON.parse(s) as IndexMeta),
    readFile(`${base}.bin`),
  ]);
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

/** Every card's best score over `queries` (max over its artworks and over the queries). */
function cardScores(queries: Float32Array[], index: LoadedIndex): Map<number, number> {
  const { dim, count, entries } = index.meta;
  const v = index.vectors;
  const scale = v instanceof Int8Array ? 1 / 127 : 1;
  const best = new Map<number, number>();
  for (const q of queries) {
    for (let i = 0; i < count; i++) {
      let dot = 0;
      const off = i * dim;
      for (let d = 0; d < dim; d++) dot += q[d] * v[off + d];
      const s = dot * scale;
      const c = entries[i].cardId;
      const prev = best.get(c);
      if (prev === undefined || s > prev) best.set(c, s);
    }
  }
  return best;
}

function rankOf(scores: Map<number, number>, cardId: number): { rank: number; score: number } {
  const s = scores.get(cardId) ?? -Infinity;
  let rank = 1;
  for (const [c, x] of scores) if (c !== cardId && c !== CARD_BACK_ID && x > s) rank++;
  return { rank, score: s };
}

const NEVER_DECIDE = { score: Infinity, margin: 0, floor: -Infinity };
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const cards = loadCards();
  const nameOf = (id: number | null) =>
    id === null ? '?' : id === CARD_BACK_ID ? 'Card back' : (cards.byId.get(id)?.name ?? `(unknown ${id})`);
  const realRows: RealRow[] = withReal ? JSON.parse(readFileSync(setPath, 'utf8')) : [];
  const synthRows: SynthRow[] = withSynth ? JSON.parse(readFileSync(path.join(synthDir, 'manifest.json'), 'utf8')) : [];
  if (!haveCardDetector()) throw new Error('the card detector model is missing (extension/models/detector/card-detector.onnx)');
  const det = await createNodeCardDetector();
  const detector = det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const frames = new Map<string, Promise<RGBAImage>>();
  const frame = (f: string) => {
    let p = frames.get(f);
    if (!p) frames.set(f, (p = loadRGBA(path.resolve(ROOT, f))));
    return p;
  };
  const synthImgs = await Promise.all(synthRows.map((r) => loadRGBA(path.join(synthDir, r.file))));
  const out: Record<string, unknown> = { models, set: path.relative(ROOT, setPath), synth: withSynth ? path.relative(ROOT, synthDir) : null };

  for (const id of models) {
    const spec = getModel(id);
    const [node, index] = await Promise.all([createNodeEmbedder(spec), loadIndex(spec)]);
    let queries: Float32Array[] = [];
    const embedder: Embedder = { modelId: spec.id, embed: node.embed };
    const capturing: Embedder = {
      modelId: spec.id,
      embed: async (images) => {
        const v = await node.embed(images);
        queries.push(...v);
        return v;
      },
    };
    const engine = createEngine({ embedder, index, spec, detector });
    const allReadings = createEngine({ embedder: capturing, index, spec: { ...spec, thresholds: NEVER_DECIDE }, detector });

    // ---- real sightings, through the engine
    const real: RealResult[] = [];
    for (const row of realRows) {
      const img = await frame(row.frame);
      const { cropImg, inner } = buildCrop(img, row.box);
      const res = await engine.recognize(cropImg, inner);
      queries = [];
      await allReadings.recognize(cropImg, inner);
      const scores = cardScores(queries, index);
      const top = res.candidates[0];
      const right = row.cardId !== null && top?.cardId === row.cardId;
      const verdict: Verdict = !top ? 'nothing' : res.confident ? (right ? 'sure-right' : 'sure-wrong') : right ? 'unsure-right' : 'unsure-wrong';
      const truth = row.cardId === null ? null : rankOf(scores, row.cardId);
      const r: RealResult = {
        id: row.id,
        group: row.group,
        cardId: row.cardId,
        verdict,
        top: top ? { cardId: top.cardId, name: nameOf(top.cardId), score: +top.score.toFixed(4) } : null,
        second: res.candidates[1] ? { name: nameOf(res.candidates[1].cardId), score: +res.candidates[1].score.toFixed(4) } : null,
        truthRank: truth?.rank ?? null,
        truthScore: truth ? +truth.score.toFixed(4) : null,
        // every reading's best cards (thresholds that never decide), for labelling
        top5: identify
          ? [...scores.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([c, s]) => `${nameOf(c)} ${s.toFixed(3)}`)
          : undefined,
      };
      real.push(r);
      console.log(
        `[${id}] ${r.verdict.padEnd(12)} ${row.id.padEnd(40)} ${(r.top ? `${r.top.name} ${r.top.score.toFixed(3)}` : '(nothing)').padEnd(48)} ` +
          (truth ? `truth #${truth.rank} ${truth.score.toFixed(3)}` : '') + (identify ? `\n      ${r.top5?.join(' | ')}` : ''),
      );
    }

    // ---- synthetic foil art cuts, one reading each
    const synth: SynthResult[] = [];
    for (let s = 0; s < synthRows.length; s += 16) {
      const vecs = await node.embed(synthImgs.slice(s, s + 16));
      vecs.forEach((q, j) => {
        const row = synthRows[s + j];
        const scores = cardScores([q], index);
        const truth = rankOf(scores, row.cardId);
        const cands = [...scores.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([cardId, score]) => ({ cardId, imageId: 0, score }));
        const d = decide(cands, spec.thresholds);
        const right = cands[0]?.cardId === row.cardId;
        const verdict: Verdict = d.nothing ? 'nothing' : d.confident ? (right ? 'sure-right' : 'sure-wrong') : right ? 'unsure-right' : 'unsure-wrong';
        synth.push({ file: row.file, group: row.group, cardId: row.cardId, verdict, truthRank: truth.rank, truthScore: +truth.score.toFixed(4), topScore: +cands[0].score.toFixed(4) });
      });
    }
    await node.release();

    const summarise = (rows: { verdict: Verdict; truthRank: number | null; truthScore: number | null }[]) => {
      const n = rows.length;
      const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
      const ranks = rows.map((r) => r.truthRank ?? Infinity);
      return {
        n,
        top1: count('sure-right') + count('unsure-right'),
        sureRight: count('sure-right'),
        sureWrong: count('sure-wrong'),
        unsureRight: count('unsure-right'),
        unsureWrong: count('unsure-wrong'),
        nothing: count('nothing'),
        truthTop5: ranks.filter((k) => k <= 5).length,
        medianTruthRank: median(ranks),
        medianTruthScore: +median(rows.map((r) => r.truthScore ?? NaN)).toFixed(4),
      };
    };
    const groups = [...new Set(real.map((r) => r.group))];
    const realSummary = Object.fromEntries(groups.map((g) => [g, summarise(real.filter((r) => r.group === g && r.cardId !== null))]));
    const synthGroups = [...new Set(synth.map((r) => r.group))];
    const synthSummary = {
      all: summarise(synth),
      ...Object.fromEntries(synthGroups.map((g) => [g, summarise(synth.filter((r) => r.group === g))])),
    };
    out[id] = { thresholds: spec.thresholds, real: { summary: realSummary, rows: real }, synth: { summary: synthSummary, rows: synth } };
    console.log(`\n=== ${id} (thresholds ${JSON.stringify(spec.thresholds)}) ===`);
    for (const [g, s] of Object.entries(realSummary)) console.log(`real  ${g.padEnd(16)} ${JSON.stringify(s)}`);
    for (const [g, s] of Object.entries(synthSummary)) console.log(`synth ${g.padEnd(16)} ${JSON.stringify(s)}`);
    console.log('');
  }
  await det.release?.();
  writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
