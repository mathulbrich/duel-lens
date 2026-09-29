// Evaluates the recogniser against data/realset/set.json: top-1/top-5 accuracy, confident
// answers (and confident wrong ones) and median latency, overall and broken down by label
// source (human-identified vs teacher pseudo-labels, and within the teacher labels, confident
// (teacherRatio >= RATIO_GATE) vs uncertain; tools/realset/README.md) and by production (the stream a
// frame comes from; see productionOf in tools/realset/lib/constants.ts). The recogniser is the
// extension's engine as the extension builds it: the embedding matcher, with our card detector
// (extension/models/detector/card-detector.onnx, on onnxruntime-node) finding the card in the crop.
// --no-detector runs it as a --no-detector build does, on the user's box alone.
//
// It sees the exact crop the content script would send: a 4% margin around the chosen box
// (--input userBox|rotatedBox), downscaled if huge — see tools/realset/lib/crop.ts, itself
// copied from tools/debug-scan.ts's own private helpers (cited there).
//
// --negatives <file> (data/realset/negatives.json, format in tools/realset/README.md): boxes
// around things that are not a face-up card (deck piles, sleeved face-down cards, mat art). Each
// goes through the same recogniser; the run reports how many came back confident (always a
// wrong answer there) and which cards those named, how many "not sure" and how many "nothing".
//
// --raw: also records what the thresholds act on, with none applied, per row and per negative
// (`raw`), for calibrating a model's score/margin/floor (src/shared/models.ts):
// raw.embedding.stage1 / .all are the embedding matcher's merged candidates (top 10, one per card)
// after its first stage (upright and sideways hypotheses) and after both stages (plus the 180°
// ones). They come from the engine itself, run again with thresholds that never decide (all: never
// confident and never "nothing", so both stages run; stage1: always confident, so only the first
// runs). Like the engine's answers, the lists leave the card back out unless it is first, but
// decide() sees it, so its merged score is raw.embedding.cardBack (from the same query vectors).
//
// Usage:
//   npx tsx tools/eval-real.ts [--recognizer engine] [--model dinov2-small-duel] [--input userBox] [--no-detector]
//   [--set data/realset/set.json] [--negatives data/realset/negatives.json] [--raw] [--limit N] [--out FILE]
//
// Writes data/realset/results-engine-<model>.json (or --out).
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { median } from './lib/bench-stats';
import { loadRGBA } from './lib/image';
import { createNodeEmbedder } from './lib/ort-node';
import { loadCards, ROOT } from './realset/lib/cards';
import { buildCrop } from './realset/lib/crop';
import type { AxisBox, NegativeBox, RealsetEntry } from './realset/lib/types';
import { PRODUCTIONS, productionOf, RATIO_GATE, type Production } from './realset/lib/constants';
import type { CardDetector } from '../src/offscreen/detect-cards';
import { CARD_DETECTOR_FILE, createNodeCardDetector, haveCardDetector } from '../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../src/offscreen/detector/spec';
import { createEngine, type Embedder, type Engine } from '../src/offscreen/engine';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel, type EmbeddingModelSpec } from '../src/shared/models';
import type { RGBAImage } from '../src/shared/preprocess';
import { CARD_BACK_ID, type Candidate } from '../src/shared/types';

// ---------- CLI ----------

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type InputMode = 'userBox' | 'rotatedBox';

/** The one recogniser: the extension's engine (the flag stays for the results file's name and old commands). */
const recognizer = arg('--recognizer') ?? 'engine';
if (recognizer !== 'engine') throw new Error(`--recognizer must be "engine" (the extension's engine), got "${recognizer}"`);
const inputMode = (arg('--input') ?? 'userBox') as InputMode;
if (inputMode !== 'userBox' && inputMode !== 'rotatedBox') {
  throw new Error(`--input must be "userBox" or "rotatedBox", got "${inputMode}"`);
}
const engineModelId = arg('--model') ?? DEFAULT_MODEL_ID;
const withDetector = !process.argv.includes('--no-detector');
const setPath = arg('--set') ?? path.join(ROOT, 'data/realset/set.json');
const negativesPath = arg('--negatives');
const raw = process.argv.includes('--raw');
const limit = arg('--limit') ? Number(arg('--limit')) : undefined;
const modelTag = engineModelId;
const outPath = arg('--out') ?? path.join(ROOT, `data/realset/results-${recognizer}-${modelTag}.json`);

// ---------- the crop's box, per --input ----------

/** Axis-aligned bounds of the row's labelled oriented quad (frame pixels), unrounded. */
function aabbOfRotatedBox(box: NonNullable<RealsetEntry['rotatedBox']>): AxisBox {
  const xs = box.pts.map((p) => p[0]);
  const ys = box.pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The row's box per --input; a row without a labelled oriented box (capture-C's) keeps its user box. */
function boxFor(entry: RealsetEntry): AxisBox {
  return inputMode === 'userBox' || !entry.rotatedBox ? entry.userBox : aabbOfRotatedBox(entry.rotatedBox);
}

// ---------- shared frame cache ----------

const frameCache = new Map<string, Promise<RGBAImage>>();
function loadFrame(frame: string): Promise<RGBAImage> {
  let p = frameCache.get(frame);
  if (!p) {
    p = loadRGBA(path.join(ROOT, 'data/debug/frames', `${frame}.png`));
    frameCache.set(frame, p);
  }
  return p;
}

// ---------- per-entry result ----------

interface PredictedCandidate {
  cardId: number | null;
  name: string;
  score: number;
  /** Which recogniser the candidate came from, when the engine says ('embedding'). */
  source?: string;
}

/** What the thresholds act on, before any is applied (--raw). */
interface RawReading {
  /**
   * The embedding matcher's merged candidates after stage 1 and after both stages, and the card
   * back's merged score after each (the lists leave it out unless it is first; null: no card back
   * in the index).
   */
  embedding?: {
    stage1: PredictedCandidate[];
    all: PredictedCandidate[];
    cardBack: { stage1: number | null; all: number | null };
    hypothesis?: string;
  };
}

interface Recognition {
  candidates: PredictedCandidate[];
  confident: boolean;
  /** The engine's recogniser for this answer ('embedding'). */
  answeredBy?: string;
  ms: number;
  error?: string;
  raw?: RawReading;
}

interface EntryResult extends Recognition {
  id: string;
  frame: string;
  production: Production;
  cardId: number | null;
  name: string;
  source: RealsetEntry['source'];
  verified: boolean;
  /** The teacher pseudo-label's top-1/top-2 ratio (provenance; null on rows a person labelled from scratch). */
  teacherRatio: number | null;
  occluded?: boolean;
  top1Correct: boolean;
  top5Correct: boolean;
}

interface NegativeResult extends Recognition {
  id: string;
  frame: string;
  production: Production;
  design: string;
  /** No candidate at all: "nothing found". Never true for an error, which is not a pass. */
  nothing: boolean;
}

type Recognize = (frame: string, box: AxisBox) => Promise<Recognition>;

// ---------- engine recogniser ----------

/** Same as tools/debug-scan.ts's private loadIndexFromDisk (cited there; copied verbatim). */
async function loadIndexFromDisk(spec: EmbeddingModelSpec): Promise<LoadedIndex> {
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  let meta: IndexMeta;
  let buf: Buffer;
  try {
    [meta, buf] = await Promise.all([
      readFile(`${base}.meta.json`, 'utf8').then((s) => JSON.parse(s) as IndexMeta),
      readFile(`${base}.bin`),
    ]);
  } catch (e) {
    throw new Error(
      `Could not load ${base}.bin/.meta.json (run "npm run data:index -- --models ${spec.id}"?): ${(e as Error).message}`,
    );
  }
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

/** Thresholds that never decide: never confident (so both stages run) and never "nothing". */
const NEVER_DECIDE = { score: Infinity, margin: 0, floor: -Infinity };
/** Thresholds that always decide after stage 1: always confident. */
const STAGE1_ONLY = { score: -Infinity, margin: -Infinity, floor: -Infinity };

/** The extension's card detector (src/offscreen/index.ts registers the same), on onnxruntime-node; null with --no-detector. */
async function engineDetector(): Promise<CardDetector | null> {
  if (!withDetector) return null;
  if (!haveCardDetector()) {
    throw new Error(`The card detector's model is missing (${path.relative(ROOT, CARD_DETECTOR_FILE)}; tools/train-detector/README.md rebuilds it). Or run with --no-detector.`);
  }
  return (await createNodeCardDetector()).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
}

async function makeEngineRecognizer(): Promise<{ recognize: Recognize; release: () => Promise<void> }> {
  const spec = getModel(engineModelId);
  const [node, index, detector] = await Promise.all([createNodeEmbedder(spec), loadIndexFromDisk(spec), engineDetector()]);
  console.error(
    detector
      ? `[eval-real] engine: the embedding matcher, finding the card with the card detector (${path.relative(ROOT, CARD_DETECTOR_FILE)}, confidence >= ${CARD_DETECTOR.minConfidence})`
      : "[eval-real] engine: the embedding matcher on the user's box alone (--no-detector)",
  );
  const embedder: Embedder = { modelId: spec.id, embed: node.embed };
  const engine: Engine = createEngine({ embedder, index, spec, detector });
  // The --raw engines' query vectors (one list per embed() call), to score the card back with.
  let queries: Float32Array[][] = [];
  const capturing: Embedder = {
    modelId: spec.id,
    embed: async (images) => {
      const vectors = await node.embed(images);
      queries.push(vectors);
      return vectors;
    },
  };
  const rawEngine = (thresholds: EmbeddingModelSpec['thresholds']) =>
    createEngine({ embedder: capturing, index, spec: { ...spec, thresholds }, detector });
  const rawEngines = raw ? { all: rawEngine(NEVER_DECIDE), stage1: rawEngine(STAGE1_ONLY) } : null;
  /** The card back's best score over `vectors`, as topKByCard scores the index (src/shared/search.ts). */
  const backAt = index.meta.entries.findIndex((e) => e.cardId === CARD_BACK_ID);
  const cardBackScore = (vectors: Float32Array[]): number | null => {
    if (backAt < 0 || vectors.length === 0) return null;
    const { dim } = index.meta;
    const scale = index.vectors instanceof Int8Array ? 1 / 127 : 1;
    let best = -Infinity;
    for (const q of vectors) {
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += q[d] * index.vectors[backAt * dim + d];
      best = Math.max(best, dot * scale);
    }
    return best;
  };
  const cards = loadCards();
  const nameOf = (cardId: number) =>
    cardId === CARD_BACK_ID ? 'Card back (face-down)' : (cards.byId.get(cardId)?.name ?? `(unknown card ${cardId})`);
  const predicted = (cs: readonly Candidate[]): PredictedCandidate[] =>
    cs.map((c) => ({ cardId: c.cardId, name: nameOf(c.cardId), score: c.score, ...(c.source ? { source: c.source } : {}) }));

  const recognize: Recognize = async (frameName, box) => {
    const frame = await loadFrame(frameName);
    const { cropImg, inner } = buildCrop(frame, box);
    const result = await engine.recognize(cropImg, inner);
    const out: Recognition = {
      candidates: predicted(result.candidates),
      confident: result.confident,
      answeredBy: result.recognizer,
      ms: result.timings.total,
      error: result.error,
    };
    if (rawEngines) {
      queries = [];
      const all = await rawEngines.all.recognize(cropImg, inner);
      const allQueries = queries.flat();
      queries = [];
      const stage1 = await rawEngines.stage1.recognize(cropImg, inner);
      const stage1Queries = queries.flat();
      for (const r of [all, stage1]) if (r.error) console.error(`[eval-real] --raw run failed on ${frameName}: ${r.error}`);
      out.raw = {
        embedding: {
          stage1: predicted(stage1.candidates),
          all: predicted(all.candidates),
          cardBack: { stage1: cardBackScore(stage1Queries), all: cardBackScore(allQueries) },
          hypothesis: all.best?.hypothesis,
        },
      };
    }
    return out;
  };
  return {
    recognize,
    release: async () => {
      await node.release();
      await detector?.release?.();
    },
  };
}

// ---------- aggregation ----------

interface Bucket {
  n: number;
  top1: number;
  top5: number;
  /** Answers the recogniser was sure of, and how many of those were wrong. */
  confident: number;
  confidentWrong: number;
  /** Rows where recognition failed (counted as misses). */
  errors: number;
  medianMs: number;
}

function aggregate(rows: EntryResult[]): Bucket {
  const n = rows.length;
  const top1 = rows.filter((r) => r.top1Correct).length;
  const top5 = rows.filter((r) => r.top5Correct).length;
  const confident = rows.filter((r) => r.confident).length;
  const confidentWrong = rows.filter((r) => r.confident && !r.top1Correct).length;
  const errors = rows.filter((r) => r.error).length;
  return { n, top1, top5, confident, confidentWrong, errors, medianMs: n ? median(rows.map((r) => r.ms)) : NaN };
}

/** Non-card boxes: every confident answer is wrong; "nothing" is the right one. */
interface NegativeBucket {
  n: number;
  confident: number;
  notSure: number;
  nothing: number;
  /** Recognition failed: neither a pass nor a confident answer, and it fails the run. */
  errors: number;
}

function aggregateNegatives(rows: NegativeResult[]): NegativeBucket {
  const errors = rows.filter((r) => r.error).length;
  const confident = rows.filter((r) => !r.error && r.confident).length;
  const nothing = rows.filter((r) => r.nothing).length;
  return { n: rows.length, confident, notSure: rows.length - confident - nothing - errors, nothing, errors };
}

const byProduction = <T extends { production: Production }, B>(rows: T[], agg: (rows: T[]) => B) =>
  Object.fromEntries(PRODUCTIONS.map((p) => [p, agg(rows.filter((r) => r.production === p))])) as Record<Production, B>;

const pct = (num: number, den: number) => (den ? `${((100 * num) / den).toFixed(1)}%` : 'n/a');

function printBucket(label: string, b: Bucket) {
  console.log(
    `${label.padEnd(20)} n=${String(b.n).padEnd(4)} top1 ${`${b.top1}/${b.n}`.padEnd(6)} ${pct(b.top1, b.n).padEnd(7)} ` +
      `top5 ${pct(b.top5, b.n).padEnd(7)} confident ${String(b.confident).padEnd(3)} confident-wrong ${String(b.confidentWrong).padEnd(3)} ` +
      `errors ${String(b.errors).padEnd(3)} ` +
      `median ${Number.isFinite(b.medianMs) ? b.medianMs.toFixed(1) : 'n/a'}ms`,
  );
}

function printNegativeBucket(label: string, b: NegativeBucket) {
  console.log(
    `${label.padEnd(20)} n=${String(b.n).padEnd(4)} confident ${String(b.confident).padEnd(3)} ` +
      `not sure ${String(b.notSure).padEnd(3)} nothing ${String(b.nothing).padEnd(3)} errors ${b.errors}`,
  );
}

const topText = (c: PredictedCandidate | undefined) => (c ? `${c.name} (${c.score.toFixed(3)})` : '(nothing)');

// ---------- main ----------

async function main() {
  const entries = JSON.parse(readFileSync(setPath, 'utf8')) as RealsetEntry[];
  const set = limit ? entries.slice(0, limit) : entries;
  const negativesFile = negativesPath ? path.resolve(ROOT, negativesPath) : undefined;
  const allNegatives = negativesFile ? (JSON.parse(readFileSync(negativesFile, 'utf8')) as NegativeBox[]) : [];
  const negatives = limit ? allNegatives.slice(0, limit) : allNegatives;
  console.error(
    `[eval-real] recognizer=${recognizer} model=${modelTag} input=${inputMode} set=${path.relative(ROOT, setPath)} (${set.length} entries)` +
      (negativesFile ? ` negatives=${path.relative(ROOT, negativesFile)} (${negatives.length} boxes)` : '') +
      (raw ? ' raw' : ''),
  );

  const { recognize, release } = await makeEngineRecognizer();

  const rows: EntryResult[] = [];
  for (const entry of set) {
    const r = await recognize(entry.frame, boxFor(entry));
    const top1Correct = r.candidates.length > 0 && r.candidates[0].cardId === entry.cardId;
    const top5Correct = r.candidates.slice(0, 5).some((c) => c.cardId === entry.cardId);
    rows.push({
      id: entry.id,
      frame: entry.frame,
      production: productionOf(entry.frame),
      cardId: entry.cardId,
      name: entry.name,
      source: entry.source,
      verified: entry.verified,
      teacherRatio: entry.teacherRatio ?? null,
      occluded: entry.occluded,
      ...r,
      top1Correct,
      top5Correct,
    });
  }
  const negRows: NegativeResult[] = [];
  for (const neg of negatives) {
    const [x, y, w, h] = neg.box;
    const r = await recognize(neg.frame, { x, y, w, h });
    const production = productionOf(neg.frame);
    negRows.push({ id: neg.id, frame: neg.frame, production, design: neg.design, nothing: !r.error && r.candidates.length === 0, ...r });
  }
  await release();

  const overall = aggregate(rows);
  const human = aggregate(rows.filter((r) => r.source === 'human'));
  const teacher = rows.filter((r) => r.source !== 'human');
  const teacherConfident = aggregate(teacher.filter((r) => (r.teacherRatio ?? 0) >= RATIO_GATE));
  const teacherUncertain = aggregate(teacher.filter((r) => (r.teacherRatio ?? 0) < RATIO_GATE));
  const productions = byProduction(rows, aggregate);

  console.log('');
  for (const r of rows) {
    console.log(
      `${r.top1Correct ? 'ok  ' : 'MISS'} ${r.id.padEnd(30)} ${(r.answeredBy ?? '').padEnd(9)} ${r.confident ? 'sure  ' : 'unsure'} ` +
        `${topText(r.candidates[0])}${r.top1Correct ? '' : `  [truth: ${r.name}]`}`,
    );
  }
  console.log('');
  console.log(`=== ${recognizer} (model ${modelTag}, input ${inputMode}, ${withDetector ? 'card detector' : 'no card detector'}) ===`);
  printBucket('overall', overall);
  printBucket('human-verified', human);
  printBucket('teacher (ratio>=5)', teacherConfident);
  printBucket('teacher (uncertain)', teacherUncertain);
  for (const p of PRODUCTIONS) printBucket(p, productions[p]);

  let negativesOut: Record<string, unknown> | undefined;
  if (negativesFile) {
    const negOverall = aggregateNegatives(negRows);
    const negProductions = byProduction(negRows, aggregateNegatives);
    console.log('');
    for (const r of negRows) {
      const verdict = r.error ? 'ERROR   ' : r.confident ? 'SURE    ' : r.nothing ? 'nothing ' : 'unsure  ';
      console.log(`${verdict} ${r.id.padEnd(30)} ${(r.answeredBy ?? '').padEnd(9)} ${topText(r.candidates[0])}  [${r.design}]`);
    }
    console.log('');
    console.log(`=== negatives: ${path.relative(ROOT, negativesFile)} (non-card boxes; a confident answer is wrong) ===`);
    printNegativeBucket('overall', negOverall);
    for (const p of PRODUCTIONS) printNegativeBucket(p, negProductions[p]);
    const via = (r: NegativeResult) => r.answeredBy ?? recognizer;
    const sure = negRows.filter((r) => r.confident).map((r) => `${r.id} -> ${topText(r.candidates[0])} via ${via(r)}`);
    console.log(sure.length ? `confident on ${sure.length}: ${sure.join('; ')}` : 'confident on none');
    negativesOut = {
      file: path.relative(ROOT, negativesFile),
      overall: negOverall,
      byProduction: negProductions,
      rows: negRows,
    };
  }

  writeFileSync(
    outPath,
    JSON.stringify(
      {
        recognizer,
        model: modelTag,
        input: inputMode,
        set: path.relative(ROOT, setPath),
        thresholds: getModel(engineModelId).thresholds,
        detector: withDetector ? { file: path.relative(ROOT, CARD_DETECTOR_FILE), minConfidence: CARD_DETECTOR.minConfidence } : null,
        raw,
        n: rows.length,
        overall,
        bySource: { human, teacherConfident, teacherUncertain },
        byProduction: productions,
        rows,
        ...(negativesOut ? { negatives: negativesOut } : {}),
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
  const failed = [...rows, ...negRows].filter((r) => r.error);
  if (failed.length > 0) {
    console.error(`[eval-real] ${failed.length} row(s) failed to recognise; the numbers above are not trustworthy:`);
    for (const r of failed) console.error(`  ${r.id}: ${r.error}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
