// Real-set accuracy of registered embedders with the real set's labelled boxes as input, through the
// extension's own code path (onnxruntime-node, embedImages/preprocess, int8 index, topKByCard).
//
// Queries are the crops written by tools/train/prepare.py real (data/train/real/manifest.json):
// for each real card sighting, the ART_BOX of the card straightened from its labelled rotated box
// (quad0; quad5 = that box inset 5% per side for the sleeve) at 0 and 180 degrees, and the
// 'whole' hypothesis on the plain box (box). Rotations (and, for `quad`/`all`, variants) are
// merged by max score per card, as the engine merges hypotheses.
//
// Usage: npx tsx tools/train/eval-gt.ts [--models a,b] [--index-dir DIR] [--out FILE]
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../../src/shared/index-format';
import { getModel } from '../../src/shared/models';
import { mergeCandidates, topKByCard } from '../../src/shared/search';
import type { Candidate } from '../../src/shared/types';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const ALL = 20000;

interface Crop {
  file: string;
  id: string;
  set: 'realset' | 'lowres';
  res: string;
  cardId: number;
  source: string;
  variant: 'quad0' | 'quad5' | 'box';
  rotation: number;
}

async function loadIndex(id: string, dir: string): Promise<LoadedIndex> {
  const base = path.join(dir, `index-${id}`);
  const meta = JSON.parse(await readFile(`${base}.meta.json`, 'utf8')) as IndexMeta;
  const buf = await readFile(`${base}.bin`);
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

const rankOf = (c: Candidate[], cardId: number) => c.findIndex((x) => x.cardId === cardId) + 1 || Infinity;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function main() {
  const models = (arg('--models') ?? 'dinov2-small-duel,dinov3-small-q4').split(',');
  const indexDir = path.resolve(arg('--index-dir') ?? path.join(root, 'extension/data'));
  const realDir = path.join(root, 'data/train/real');
  const man = JSON.parse(readFileSync(path.join(realDir, 'manifest.json'), 'utf8')) as Crop[];
  const imgs = await Promise.all(man.map((m) => loadRGBA(path.join(realDir, m.file))));
  // seen = the card was in the fine-tuning set (data/train/split.json); unseen = never trained on
  const split = JSON.parse(readFileSync(path.join(root, 'data/train/split.json'), 'utf8')) as { group: Record<string, string> };
  const seen = (s: Crop) => (split.group[s.cardId] ?? 'seen') === 'seen';
  const groups: Record<string, (s: Crop) => boolean> = {
    human: (s) => s.set === 'realset' && s.source === 'human',
    teacher: (s) => s.set === 'realset' && s.source !== 'human',
    real29: (s) => s.set === 'realset',
    'real29 seen': (s) => s.set === 'realset' && seen(s),
    'real29 unseen': (s) => s.set === 'realset' && !seen(s),
    lowres: (s) => s.set === 'lowres',
    'lowres seen': (s) => s.set === 'lowres' && seen(s),
    'lowres unseen': (s) => s.set === 'lowres' && !seen(s),
  };
  const variants: Record<string, (c: Crop) => boolean> = {
    quad0: (c) => c.variant === 'quad0',
    quad5: (c) => c.variant === 'quad5',
    box: (c) => c.variant === 'box',
    quad: (c) => c.variant !== 'box',
    all: () => true,
  };
  const out: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const id of models) {
    const spec = getModel(id);
    const embedder = await createNodeEmbedder(spec);
    const index = await loadIndex(id, indexDir);
    const cands: Candidate[][] = [];
    const ms: number[] = [];
    for (const img of imgs) {
      const t0 = performance.now();
      const [v] = await embedder.embed([img]);
      ms.push(performance.now() - t0);
      cands.push(topKByCard(v, index, ALL));
    }
    await embedder.release();
    const sightings = [...new Set(man.map((m) => m.id))];
    const per: Record<string, Record<string, number>> = {};
    for (const sid of sightings) {
      per[sid] = {};
      for (const [v, f] of Object.entries(variants)) {
        const ks = man.map((m, k) => (m.id === sid && f(m) ? k : -1)).filter((k) => k >= 0);
        per[sid][v] = rankOf(mergeCandidates(ks.map((k) => cands[k]), ALL), man[ks[0]].cardId);
      }
    }
    const summary: Record<string, Record<string, { n: number; top1: number; top5: number; median: number }>> = {};
    for (const [g, f] of Object.entries(groups)) {
      const ids = sightings.filter((sid) => f(man.find((m) => m.id === sid)!));
      summary[g] = {};
      for (const v of Object.keys(variants)) {
        const rk = ids.map((sid) => per[sid][v]);
        summary[g][v] = { n: rk.length, top1: rk.filter((r) => r === 1).length, top5: rk.filter((r) => r <= 5).length, median: median(rk) };
      }
    }
    out[id] = { summary, perSighting: per, medianEmbedMs: median(ms) };
    for (const g of Object.keys(groups)) {
      const s = summary[g];
      lines.push(
        `| ${id} | ${g} (${s.quad0.n}) | ${Object.keys(variants).map((v) => `${s[v].top1} / ${s[v].top5} (med ${s[v].median})`).join(' | ')} |`,
      );
    }
    console.error(`${id}: done, median ${median(ms).toFixed(1)} ms per crop`);
  }
  console.log(`| Model | Set | ${Object.keys(variants).map((v) => `${v} top-1 / top-5`).join(' | ')} |`);
  console.log(`|---|---|${Object.keys(variants).map(() => '---:').join('|')}|`);
  console.log(lines.join('\n'));
  const file = arg('--out') ?? path.join(root, 'data/train/logs/eval-gt.json');
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.error(`wrote ${path.relative(root, file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
