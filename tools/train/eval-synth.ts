// Seen vs unseen accuracy on tools/lib/degrade.ts's levels (the benchmark's own generator, which
// the fine-tuning never used) and on website images through the engine's hypotheses, for each
// model, against its full index. Groups come from data/train/split.json: seen, unseen-random
// (a random 5% of cards released before 2026), unseen-new (released 2026 or later).
//
// Usage: npx tsx tools/train/eval-synth.ts [--models a,b] [--n 300] [--seed 1]
//          [--levels clean,mild,video,extreme,video-lowres] [--out FILE] [--dump FILE]
//   --dump  also writes every query's top score, lead and correctness per model and level (for trying
//           other thresholds offline)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { buildHypotheses, SELECTION_MARGIN } from '../../src/offscreen/hypotheses';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../../src/shared/index-format';
import { getModel } from '../../src/shared/models';
import { rotate180, type RGBAImage } from '../../src/shared/preprocess';
import { mergeCandidates, topKByCard } from '../../src/shared/search';
import { CARD_BACK_ID, type Candidate } from '../../src/shared/types';
import { calibrateThresholds, evaluateThresholds, type ScoredQuery } from '../lib/bench-stats';
import { degrade, type DegradeLevel } from '../lib/degrade';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder, type NodeEmbedder } from '../lib/ort-node';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const K = 10;
const GROUPS = ['seen', 'unseen-random', 'unseen-new'] as const;

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadIndex(id: string): Promise<LoadedIndex> {
  const base = path.join(root, 'extension/data', `index-${id}`);
  const meta = JSON.parse(await readFile(`${base}.meta.json`, 'utf8')) as IndexMeta;
  const buf = await readFile(`${base}.bin`);
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

/** The user's box around a card image plus the content script's margin (white page background). */
async function framed(card: RGBAImage): Promise<RGBAImage> {
  const dx = Math.round(card.width * SELECTION_MARGIN);
  const dy = Math.round(card.height * SELECTION_MARGIN);
  const { data, info } = await sharp(Buffer.from(card.data.buffer, card.data.byteOffset, card.data.byteLength), {
    raw: { width: card.width, height: card.height, channels: 4 },
  })
    .extend({ top: dy, bottom: dy, left: dx, right: dx, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

const rankOf = (c: Candidate[], cardId: number) => c.findIndex((x) => x.cardId === cardId);

async function merged(e: NodeEmbedder, index: LoadedIndex, imgs: RGBAImage[]) {
  const vs = await e.embed(imgs);
  return mergeCandidates(vs.map((v) => topKByCard(v, index, K)), K);
}

async function main() {
  const models = (arg('--models') ?? 'dinov2-small-duel,dinov3-small-q4').split(',');
  const n = Number(arg('--n') ?? 300);
  const seed = Number(arg('--seed') ?? 1);
  const levels = (arg('--levels') ?? 'clean,mild,video,extreme,video-lowres').split(',') as DegradeLevel[];
  const split = JSON.parse(readFileSync(path.join(root, 'data/train/split.json'), 'utf8')) as { group: Record<string, string> };
  const meta = JSON.parse(readFileSync(path.join(root, `extension/data/index-${models[0]}.meta.json`), 'utf8')) as IndexMeta;
  const rnd = mulberry32(seed);
  const small = (imageId: number) =>
    [path.join(root, 'data/bench/cards-small', `${imageId}.jpg`), path.join(root, 'data/train/web-small', `${imageId}.jpg`)].find(existsSync);
  const shuffle = <T,>(xs: T[]) => {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  };
  const sample: Record<string, { imageId: number; cardId: number }[]> = {};
  const webSample: Record<string, { imageId: number; cardId: number }[]> = {};
  for (const g of GROUPS) {
    const pool = meta.entries.filter((e) => e.cardId !== CARD_BACK_ID && (split.group[e.cardId] ?? 'seen') === g);
    sample[g] = shuffle([...pool]).slice(0, n);
    // website images: the cards_small files already downloaded (bench sample + tools/train/evalsuite.py)
    webSample[g] = shuffle(pool.filter((e) => small(e.imageId))).slice(0, n);
  }

  const out: Record<string, Record<string, Record<string, { n: number; top1: number; top5: number }>>> = {};
  const calib: Record<string, unknown> = {};
  const dump: Record<string, Record<string, ScoredQuery[]>> = {};
  for (const id of models) {
    const spec = getModel(id);
    const e = await createNodeEmbedder(spec);
    const index = await loadIndex(id);
    out[id] = {};
    const scored: Record<string, ScoredQuery[]> = {};
    dump[id] = scored;
    const score = (level: string, c: Candidate[], cardId: number) =>
      (scored[level] ??= []).push({ s1: c[0]?.score ?? -1, s2: c[1]?.score ?? 0, correct: c[0]?.cardId === cardId });
    for (const g of GROUPS) {
      const ranks: Record<string, number[]> = {};
      for (const [i, s] of sample[g].entries()) {
        const art = await loadRGBA(path.join(root, 'data/artworks', `${s.imageId}.jpg`));
        for (const level of levels) {
          const img = await degrade(art, level, seed * 1_000_003 + i);
          const c = await merged(e, index, [img, rotate180(img)]);
          (ranks[level] ??= []).push(rankOf(c, s.cardId));
          score(level, c, s.cardId);
        }
      }
      for (const s of webSample[g]) {
        const hs = buildHypotheses(await framed(await loadRGBA(small(s.imageId)!)));
        const c = await merged(e, index, hs.map((h) => h.image));
        (ranks.web ??= []).push(rankOf(c, s.cardId));
        score('web', c, s.cardId);
      }
      out[id][g] = Object.fromEntries(
        Object.entries(ranks).map(([l, r]) => [
          l,
          { n: r.length, top1: (100 * r.filter((x) => x === 0).length) / r.length, top5: (100 * r.filter((x) => x >= 0 && x < 5).length) / r.length },
        ]),
      );
      console.error(`${id} ${g}: ${Object.entries(out[id][g]).map(([l, v]) => `${l} ${v.top1.toFixed(1)}/${v.top5.toFixed(1)} (n ${v.n})`).join(', ')}`);
    }
    await e.release();
    // thresholds calibrated per level (97% precision, floor = 2nd percentile of right answers), and
    // what the spec's current thresholds do on every level
    calib[id] = {
      perLevel: Object.fromEntries(Object.entries(scored).map(([l, q]) => [l, calibrateThresholds(q)])),
      atSpec: Object.fromEntries(Object.entries(scored).map(([l, q]) => [l, evaluateThresholds(q, spec.thresholds)])),
    };
    console.error(`${id} calibration: ${JSON.stringify(calib[id])}`);
  }
  const cols = [...levels, 'web'];
  console.log(`| Model | Cards | ${cols.map((c) => `${c} top-1 / top-5`).join(' | ')} |`);
  console.log(`|---|---|${cols.map(() => '---:').join('|')}|`);
  for (const [id, gs] of Object.entries(out)) {
    for (const [g, ls] of Object.entries(gs)) {
      console.log(`| ${id} | ${g} | ${cols.map((c) => (ls[c] ? `${ls[c].top1.toFixed(1)} / ${ls[c].top5.toFixed(1)}` : '-')).join(' | ')} |`);
    }
  }
  const file = arg('--out') ?? path.join(root, 'data/train/logs/eval-synth.json');
  writeFileSync(file, JSON.stringify({ n, seed, levels, sample, results: out, calibration: calib }, null, 1));
  console.error(`wrote ${path.relative(root, file)}`);
  const dumpFile = arg('--dump');
  if (dumpFile) writeFileSync(dumpFile, JSON.stringify(dump));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
