// Benchmark: how well each candidate model finds the right card from degraded artworks.
//
// Samples N indexed artworks, degrades each at every level (tools/lib/degrade.ts), embeds the
// result and searches the model's full index (extension/data/index-<model>.*). Reports top-1
// and top-5 accuracy per level and model, the median embedding time, calibrates each model's
// decision thresholds on the 'video' level and picks the default model.
//
// Usage: npx tsx tools/benchmark.ts [--models a,b,c] [--n 1000] [--seed 1]
//          [--levels clean,mild,video,extreme,video-lowres] [--web] [--real set.json] [--threads N]
//          [--out data/bench/report-<date>.json] [--index-dir DIR] [--write]
//   --web    also test real website images: YGOPRODeck's small card images (cards_small, 168 px
//            wide, downloaded once to data/bench/cards-small/) framed by the user's box plus the
//            content script's margin, through the engine's art-crop hypotheses.
//   --real   a real test set exported by the options page: [{ dataUrl, cardId }].
//   --write  write the calibrated thresholds and the chosen DEFAULT_MODEL_ID into src/shared/models.ts.
//   --apply report.json  only write the thresholds and default model of an earlier report into models.ts.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../src/shared/index-format';
import { DEFAULT_MODEL_ID, MODELS, type EmbeddingModelSpec } from '../src/shared/models';
import { rotate180, type RGBAImage } from '../src/shared/preprocess';
import { mergeCandidates, topKByCard } from '../src/shared/search';
import { CARD_BACK_ID, type Candidate } from '../src/shared/types';
import { calibrateThresholds, evaluateThresholds, median, type Calibration, type ScoredQuery } from './lib/bench-stats';
import { degrade, DEGRADE_LEVELS, STRESS_LEVELS, type DegradeLevel } from './lib/degrade';
import { createRateLimiter, politeFetch } from './lib/http';
import { loadDataUrl, loadRGBA } from './lib/image';
import { createNodeEmbedder, modelPath, type NodeEmbedder } from './lib/ort-node';

const root = path.resolve(import.meta.dirname, '..');
const ARTWORKS = path.join(root, 'data/artworks');
const CARD_BACK = path.join(root, 'data/card-back.jpg');
const SMALL_DIR = path.join(root, 'data/bench/cards-small');
const MODELS_TS = path.join(root, 'src/shared/models.ts');
const K = 10;
const MAX_MODEL_MB = 30;
const MAX_EMBED_MS = 80;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(name);

type Level = DegradeLevel | 'web';

interface LevelResult {
  /** Rank of the right card in the upright query's candidates (-1 = not in the top 10). */
  ranks: number[];
  /** Rank after merging with the 180°-turned query, as the engine does. */
  mergedRanks: number[];
  /** Merged candidates' top two scores, for threshold calibration. */
  scored: ScoredQuery[];
}

interface ModelRun {
  spec: EmbeddingModelSpec;
  embedder: NodeEmbedder;
  index: LoadedIndex;
  sizeMB: number;
  embedMs: number[];
  levels: Partial<Record<Level, LevelResult>>;
}

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const indexDir = () => path.resolve(arg('--index-dir') ?? path.join(root, 'extension/data'));

async function loadIndex(modelId: string): Promise<LoadedIndex> {
  const base = path.join(indexDir(), `index-${modelId}`);
  const meta = JSON.parse(await readFile(`${base}.meta.json`, 'utf8')) as IndexMeta;
  const buf = await readFile(`${base}.bin`);
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

const rankOf = (cands: Candidate[], cardId: number) => cands.findIndex((c) => c.cardId === cardId);
const scoredOf = (cands: Candidate[], cardId: number): ScoredQuery => ({
  s1: cands[0]?.score ?? -1,
  s2: cands[1]?.score ?? 0,
  correct: cands[0]?.cardId === cardId,
});

function record(run: ModelRun, level: Level, cardId: number, upright: Candidate[], merged: Candidate[]) {
  const r = (run.levels[level] ??= { ranks: [], mergedRanks: [], scored: [] });
  r.ranks.push(rankOf(upright, cardId));
  r.mergedRanks.push(rankOf(merged, cardId));
  r.scored.push(scoredOf(merged, cardId));
}

/** Upright and merged (upright + 180°) candidates for one query image. */
async function query(run: ModelRun, img: RGBAImage, timed: boolean) {
  const t0 = performance.now();
  const [v] = await run.embedder.embed([img]);
  if (timed) run.embedMs.push(performance.now() - t0);
  const upright = topKByCard(v, run.index, K);
  const [v180] = await run.embedder.embed([rotate180(img)]);
  return { upright, merged: mergeCandidates([upright, topKByCard(v180, run.index, K)], K) };
}

/** Median ms of one session.run on a single image, after warm-up. */
async function inferenceMs(spec: EmbeddingModelSpec, threads?: number, runs = 30): Promise<number> {
  const e = await createNodeEmbedder(spec, { threads });
  const s = spec.inputSize;
  const rnd = mulberry32(7);
  const x = new ort.Tensor('float32', Float32Array.from({ length: 3 * s * s }, () => rnd() * 2 - 1), [1, 3, s, s]);
  const times: number[] = [];
  for (let i = 0; i < runs + 3; i++) {
    const t0 = performance.now();
    await e.session.run({ [spec.inputName]: x });
    if (i >= 3) times.push(performance.now() - t0);
  }
  await e.release();
  return median(times);
}

// ---------- website images (cards_small) through the engine's hypotheses ----------

const smallLimiter = createRateLimiter(8);

async function smallCard(imageId: number): Promise<RGBAImage | undefined> {
  const file = path.join(SMALL_DIR, `${imageId}.jpg`);
  if (!existsSync(file)) {
    const res = await politeFetch(`https://images.ygoprodeck.com/images/cards_small/${imageId}.jpg`, { limiter: smallLimiter });
    if (!res.ok) return undefined;
    await mkdir(SMALL_DIR, { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return loadRGBA(file);
}

type Hypotheses = typeof import('../src/offscreen/hypotheses');

/** The user's box around the card image, plus the content script's margin of page background. */
async function framed(card: RGBAImage, margin: number): Promise<RGBAImage> {
  const dx = Math.round(card.width * margin);
  const dy = Math.round(card.height * margin);
  const { data, info } = await sharp(Buffer.from(card.data.buffer, card.data.byteOffset, card.data.byteLength), {
    raw: { width: card.width, height: card.height, channels: 4 },
  })
    .extend({ top: dy, bottom: dy, left: dx, right: dx, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** Candidates from every hypothesis of a selection, merged by max score per card. */
async function queryHypotheses(run: ModelRun, hyp: Hypotheses, selection: RGBAImage) {
  const hs = hyp.buildHypotheses(selection);
  const vecs = await run.embedder.embed(hs.map((h) => h.image));
  const lists = vecs.map((v) => topKByCard(v, run.index, K));
  const merged = mergeCandidates(lists, K);
  const uprightLists = lists.filter((_, i) => hs[i].rotation === 0 || hs[i].rotation === 90);
  return { upright: mergeCandidates(uprightLists, K), merged };
}

// ---------- report ----------

const pct = (xs: number[], ok: (r: number) => boolean) => (xs.length ? (100 * xs.filter(ok).length) / xs.length : NaN);
const top1 = (ranks: number[]) => pct(ranks, (r) => r === 0);
const top5 = (ranks: number[]) => pct(ranks, (r) => r >= 0 && r < 5);
const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '–');

interface ModelSummary {
  id: string;
  file: string;
  sizeMB: number;
  medianEmbedMs: number;
  inferenceMs: number;
  inferenceMs1Thread: number;
  levels: Record<string, { n: number; top1: number; top5: number; top1With180: number; top5With180: number }>;
  thresholds?: Calibration;
  atThresholds?: Record<string, ReturnType<typeof evaluateThresholds>>;
  negatives?: Record<string, { cardId: number; score: number; belowFloor: boolean }>;
  cardBack?: { n: number; top1: number };
  eligible: boolean;
}

async function writeModelsTs(summaries: ModelSummary[], chosen: string, note: string) {
  let src = readFileSync(MODELS_TS, 'utf8');
  for (const s of summaries) {
    if (!s.thresholds) continue;
    const start = src.indexOf(`  '${s.id}': {`);
    const next = src.indexOf("\n  '", start + 1);
    const at = src.indexOf('    thresholds: {', start);
    if (start < 0 || at < 0 || (next > 0 && at > next)) throw new Error(`Cannot find thresholds of ${s.id} in models.ts`);
    const lineStart = src.lastIndexOf('\n', at - 1) + 1;
    const prevStart = src.lastIndexOf('\n', lineStart - 2) + 1;
    const prev = src.slice(prevStart, lineStart);
    const from = /^\s*\/\/ (Placeholder values|Calibrated by tools\/benchmark\.ts)/.test(prev) ? prevStart : lineStart;
    const end = src.indexOf('\n', at) + 1;
    const t = s.thresholds;
    const comment = t.achieved
      ? `    // Calibrated by tools/benchmark.ts (${note}): ${(100 * t.precision).toFixed(1)}% precise, ${(100 * t.coverage).toFixed(1)}% confident on 'video'.\n`
      : `    // Calibrated by tools/benchmark.ts (${note}): 97% precision is out of reach on 'video', so never confident.\n`;
    src = `${src.slice(0, from)}${comment}    thresholds: { score: ${t.score}, margin: ${t.margin}, floor: ${t.floor} },\n${src.slice(end)}`;
  }
  const defaultLine = /export const DEFAULT_MODEL_ID = '[^']*';/;
  if (!defaultLine.test(src)) throw new Error('Cannot find DEFAULT_MODEL_ID in models.ts');
  src = src.replace(defaultLine, `export const DEFAULT_MODEL_ID = '${chosen}';`);
  await writeFile(`${MODELS_TS}.tmp`, src);
  await rename(`${MODELS_TS}.tmp`, MODELS_TS);
}

async function main() {
  const applyFile = arg('--apply');
  if (applyFile) {
    const r = JSON.parse(await readFile(applyFile, 'utf8')) as { date: string; n: number; seed: number; models: ModelSummary[]; chosen?: string };
    if (!r.chosen) throw new Error(`${applyFile} chose no model`);
    await writeModelsTs(r.models, r.chosen, `${r.date}, n=${r.n}, seed ${r.seed}`);
    console.error(`wrote thresholds and DEFAULT_MODEL_ID = '${r.chosen}' from ${applyFile} to ${path.relative(root, MODELS_TS)}`);
    return;
  }
  const n = Number(arg('--n') ?? 1000);
  const seed = Number(arg('--seed') ?? 1);
  const threads = Number(arg('--threads') ?? 0) || undefined;
  const known: readonly DegradeLevel[] = [...DEGRADE_LEVELS, ...STRESS_LEVELS];
  const levels = (arg('--levels')?.split(',') ?? known) as DegradeLevel[];
  for (const l of levels) if (!known.includes(l)) throw new Error(`Unknown level "${l}" (known: ${known})`);
  const ids =
    arg('--models')?.split(',') ??
    Object.keys(MODELS).filter((id) => existsSync(path.join(indexDir(), `index-${id}.bin`)));
  if (ids.length === 0) throw new Error('No models with an index; run tools/build-index.ts first');

  const runs: ModelRun[] = [];
  for (const id of ids) {
    const spec = MODELS[id];
    if (!spec) throw new Error(`Unknown model "${id}"`);
    runs.push({
      spec,
      embedder: await createNodeEmbedder(spec, { threads }),
      index: await loadIndex(id),
      sizeMB: statSync(modelPath(spec)).size / 1e6,
      embedMs: [],
      levels: {},
    });
  }

  // Sample N artworks present in every index (never the card back).
  const inAll = runs
    .map((r) => new Set(r.index.meta.entries.filter((e) => e.cardId !== CARD_BACK_ID).map((e) => e.imageId)))
    .reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  const pool = runs[0].index.meta.entries.filter((e) => inAll.has(e.imageId) && existsSync(path.join(ARTWORKS, `${e.imageId}.jpg`)));
  const rnd = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const sample = pool.slice(0, Math.min(n, pool.length));
  console.error(`benchmark: ${sample.length} artworks × [${levels}] × [${ids}], seed ${seed}`);

  let hyp: Hypotheses | undefined;
  if (has('--web') || arg('--real')) {
    try {
      hyp = await import('../src/offscreen/hypotheses');
    } catch (err) {
      console.error(`engine hypotheses unavailable (${(err as Error).message}); skipping --web/--real`);
    }
  }

  const t0 = performance.now();
  for (const [i, s] of sample.entries()) {
    const art = await loadRGBA(path.join(ARTWORKS, `${s.imageId}.jpg`));
    for (const level of levels) {
      const img = await degrade(art, level, seed * 1_000_003 + i);
      for (const run of runs) {
        const { upright, merged } = await query(run, img, true);
        record(run, level, s.cardId, upright, merged);
      }
    }
    if (hyp && has('--web')) {
      const small = await smallCard(s.imageId);
      if (small) {
        const selection = await framed(small, hyp.SELECTION_MARGIN);
        for (const run of runs) {
          const { upright, merged } = await queryHypotheses(run, hyp, selection);
          record(run, 'web', s.cardId, upright, merged);
        }
      }
    }
    if ((i + 1) % 50 === 0 || i + 1 === sample.length) {
      const secs = (performance.now() - t0) / 1000;
      const v = runs.map((r) => `${r.spec.id} ${f1(top1(r.levels.video?.ranks ?? []))}/${f1(top5(r.levels.video?.ranks ?? []))}`);
      console.error(`  ${i + 1}/${sample.length} · ${secs.toFixed(0)} s · video top-1/top-5: ${v.join(', ')}`);
    }
  }

  // Real test set, if given.
  const real: Record<string, { n: number; top1: number; top5: number }> = {};
  const realFile = arg('--real');
  if (realFile && hyp) {
    const set = JSON.parse(await readFile(realFile, 'utf8')) as { dataUrl: string; cardId: number }[];
    for (const run of runs) {
      const ranks: number[] = [];
      for (const item of set) {
        const { merged } = await queryHypotheses(run, hyp, await loadDataUrl(item.dataUrl));
        ranks.push(rankOf(merged, item.cardId));
      }
      real[run.spec.id] = { n: ranks.length, top1: top1(ranks), top5: top5(ranks) };
    }
  }

  // Summaries, calibration and negatives.
  const summaries: ModelSummary[] = [];
  for (const run of runs) {
    const lv: ModelSummary['levels'] = {};
    for (const [level, r] of Object.entries(run.levels)) {
      lv[level] = {
        n: r.ranks.length,
        top1: top1(r.ranks),
        top5: top5(r.ranks),
        top1With180: top1(r.mergedRanks),
        top5With180: top5(r.mergedRanks),
      };
    }
    const s: ModelSummary = {
      id: run.spec.id,
      file: run.spec.file,
      sizeMB: run.sizeMB,
      medianEmbedMs: median(run.embedMs),
      inferenceMs: await inferenceMs(run.spec, threads),
      inferenceMs1Thread: await inferenceMs(run.spec, 1),
      levels: lv,
      eligible: false,
    };
    s.eligible = s.sizeMB <= MAX_MODEL_MB && s.medianEmbedMs <= MAX_EMBED_MS;
    const video = run.levels.video;
    if (video) {
      const t = calibrateThresholds(video.scored);
      s.thresholds = t;
      s.atThresholds = Object.fromEntries(Object.entries(run.levels).map(([l, r]) => [l, evaluateThresholds(r.scored, t)]));
      // Blank or noisy crops (e.g. a DRM black frame) should fall below the floor.
      const size = 256;
      const solid = (v: number): RGBAImage => ({ data: new Uint8ClampedArray(size * size * 4).fill(v), width: size, height: size });
      const r2 = mulberry32(3);
      const noise: RGBAImage = { data: Uint8ClampedArray.from({ length: size * size * 4 }, () => r2() * 256), width: size, height: size };
      s.negatives = {};
      for (const [name, img] of Object.entries({ black: solid(0), grey: solid(128), white: solid(255), noise })) {
        const { merged } = await query(run, img, false);
        s.negatives[name] = { cardId: merged[0].cardId, score: merged[0].score, belowFloor: merged[0].score < t.floor };
      }
      if (existsSync(CARD_BACK) && run.index.meta.entries.some((e) => e.cardId === CARD_BACK_ID)) {
        const back = await loadRGBA(CARD_BACK);
        let hits = 0;
        const tries = 20;
        for (let k = 0; k < tries; k++) {
          const { merged } = await query(run, await degrade(back, 'video', 900 + k), false);
          if (merged[0]?.cardId === CARD_BACK_ID) hits++;
        }
        s.cardBack = { n: tries, top1: (100 * hits) / tries };
      }
    }
    summaries.push(s);
    await run.embedder.release();
  }

  const eligible = summaries.filter((s) => s.eligible && s.levels.video);
  eligible.sort((a, b) => b.levels.video.top5 - a.levels.video.top5 || b.levels.video.top1 - a.levels.video.top1);
  const chosen = eligible[0]?.id;

  // Markdown to stdout.
  const shown: Level[] = [...levels, ...(summaries.some((s) => s.levels.web) ? (['web'] as const) : [])];
  const out: string[] = [];
  out.push(`### Benchmark: ${sample.length} artworks, seed ${seed}, ${new Date().toISOString().slice(0, 10)}`, '');
  out.push(`| Model | MB | ms/embed | ${shown.map((l) => `${l} top-1 / top-5`).join(' | ')} |`);
  out.push(`|---|---:|---:|${shown.map(() => '---:').join('|')}|`);
  for (const s of summaries) {
    const cells = shown.map((l) => (s.levels[l] ? `${f1(s.levels[l].top1)} / ${f1(s.levels[l].top5)}` : '–'));
    out.push(`| ${s.id}${s.id === chosen ? ' ★' : ''} | ${s.sizeMB.toFixed(1)} | ${s.medianEmbedMs.toFixed(1)} | ${cells.join(' | ')} |`);
  }
  out.push('', `With the 180° hypothesis merged in (as the engine does), top-1 / top-5:`, '');
  out.push(`| Model | ${shown.join(' | ')} |`, `|---|${shown.map(() => '---:').join('|')}|`);
  for (const s of summaries) {
    out.push(`| ${s.id} | ${shown.map((l) => (s.levels[l] ? `${f1(s.levels[l].top1With180)} / ${f1(s.levels[l].top5With180)}` : '–')).join(' | ')} |`);
  }
  out.push('', `Timing (median ms): full embed incl. preprocessing of the query; model only; model only on 1 thread.`, '');
  out.push('| Model | embed | model | model, 1 thread |', '|---|---:|---:|---:|');
  for (const s of summaries) {
    out.push(`| ${s.id} | ${s.medianEmbedMs.toFixed(1)} | ${s.inferenceMs.toFixed(1)} | ${s.inferenceMs1Thread.toFixed(1)} |`);
  }
  if (summaries.some((s) => s.thresholds)) {
    out.push('', `Thresholds calibrated on 'video' (merged candidates; target 97% precision):`, '');
    out.push(
      `| Model | floor | score | margin | ${shown.map((l) => `${l}: precise / confident / nothing`).join(' | ')} |`,
      `|---|---:|---:|---:|${shown.map(() => '---:').join('|')}|`,
    );
    for (const s of summaries) {
      if (!s.thresholds || !s.atThresholds) continue;
      const t = s.thresholds;
      const cells = shown.map((l) => {
        const e = s.atThresholds![l];
        return e ? `${f1(100 * e.precision)} / ${f1(100 * e.coverage)} / ${f1(100 * e.nothing)}` : '–';
      });
      out.push(`| ${s.id}${t.achieved ? '' : ' (97% not reached)'} | ${t.floor} | ${t.score} | ${t.margin} | ${cells.join(' | ')} |`);
    }
    out.push('', 'Blank crops (top score; ✓ = below the floor, i.e. "no card found") and the card back under video degradation:', '');
    out.push('| Model | black | grey | white | noise | card back top-1 |', '|---|---:|---:|---:|---:|---:|');
    for (const s of summaries) {
      if (!s.negatives) continue;
      const neg = ['black', 'grey', 'white', 'noise'].map((k) => `${s.negatives![k].score.toFixed(3)} ${s.negatives![k].belowFloor ? '✓' : '✗'}`);
      out.push(`| ${s.id} | ${neg.join(' | ')} | ${s.cardBack ? `${f1(s.cardBack.top1)}%` : '–'} |`);
    }
  }
  if (Object.keys(real).length) {
    out.push('', `Real test set (${realFile}):`, '', '| Model | n | top-1 | top-5 |', '|---|---:|---:|---:|');
    for (const [id, r] of Object.entries(real)) out.push(`| ${id} | ${r.n} | ${f1(r.top1)} | ${f1(r.top5)} |`);
  }
  out.push(
    '',
    chosen
      ? `Default model: **${chosen}** (best video top-5 among models ≤ ${MAX_MODEL_MB} MB and ≤ ${MAX_EMBED_MS} ms per embedding).`
      : levels.includes('video')
        ? `No model is ≤ ${MAX_MODEL_MB} MB and ≤ ${MAX_EMBED_MS} ms; DEFAULT_MODEL_ID stays ${DEFAULT_MODEL_ID}.`
        : `The 'video' level was not run, so no model is chosen; DEFAULT_MODEL_ID stays ${DEFAULT_MODEL_ID}.`,
  );
  console.log(out.join('\n'));

  const date = new Date().toISOString().slice(0, 10);
  const reportFile = arg('--out') ?? path.join(root, 'data/bench', `report-${date}.json`);
  await mkdir(path.dirname(reportFile), { recursive: true });
  const report = { date, n: sample.length, seed, levels, models: summaries, real, chosen, sample: sample.map((s) => s.imageId) };
  await writeFile(reportFile, JSON.stringify(report, null, 1));
  console.error(`report: ${path.relative(root, reportFile)}`);

  if (has('--write') && chosen) {
    await writeModelsTs(summaries, chosen, `${date}, n=${sample.length}, seed ${seed}`);
    console.error(`wrote thresholds and DEFAULT_MODEL_ID = '${chosen}' to ${path.relative(root, MODELS_TS)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
