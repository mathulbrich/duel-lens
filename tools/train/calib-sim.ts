// Gate-sim threshold calibration (overnight-p5-report.md §4): replays decide() (src/shared/search.ts) on eval-real's
// --raw readings, the embedding matcher's merged lists after stage 1 and after both stages with the card back's score
// put back in, for a grid of thresholds, on several result files at once (the real set and realset2, with their
// negatives). A row is confident when stage 1 is, or both stages are (the engine runs stage 2 only when stage 1 is not
// sure); rows the engine labelled `suggested` or `countBadge` stay never-confident. The sim is checked against the
// engine's own decisions at the thresholds the files were run with (agreement printed first).
//
// Usage: npx tsx tools/train/calib-sim.ts --files A.json,B.json [--model ID] [--max-neg 9] [--top 15] [--floors 0.66,0.80]
//   [--scores 0.74,0.92]
// Also the suggestions' floor (run eval-real with --suggest-floor 0.6 first): per floor, the rows the engine labelled
// `suggested` whose first card clears it, right / wrong lists, and non-card boxes with a list.
//   --max-neg: the most confident non-card boxes allowed over all files' negatives (v3b's realset2 count)
import { readFileSync } from 'node:fs';
import { decide } from '../../src/shared/search';
import { getModel, type EmbeddingModelSpec } from '../../src/shared/models';
import { CARD_BACK_ID, type Candidate } from '../../src/shared/types';

type T = EmbeddingModelSpec['thresholds'];
const arg = (n: string) => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
interface Raw { stage1: Candidate[]; all: Candidate[]; cardBack: { stage1: number | null; all: number | null } }
interface Row { cardId: number | null; confident: boolean; suggested?: boolean; countBadge?: boolean; candidates: Candidate[]; raw?: { embedding?: Raw } }
interface Item { file: string; cardId: number | null; l1: Candidate[]; la: Candidate[]; engineConf: boolean; never: boolean }

const withBack = (l: Candidate[], back: number | null): Candidate[] =>
  back === null || l.some((c) => c.cardId === CARD_BACK_ID)
    ? l
    : [...l, { cardId: CARD_BACK_ID, imageId: 0, score: back } as Candidate].sort((a, b) => b.score - a.score);

const items: Item[] = [];
for (const f of (arg('--files') ?? '').split(',').filter(Boolean)) {
  const d = JSON.parse(readFileSync(f, 'utf8')) as { thresholds: T; rows: Row[]; negatives?: { rows: Row[] } };
  for (const r of [...d.rows, ...(d.negatives?.rows ?? []).map((n) => ({ ...n, cardId: null }))]) {
    const e = r.raw?.embedding;
    if (!e) continue;
    items.push({
      file: f.split('/').slice(-2).join('/'),
      cardId: r.cardId ?? null,
      l1: withBack(e.stage1, e.cardBack.stage1),
      la: withBack(e.all, e.cardBack.all),
      engineConf: r.confident,
      never: !!(r.suggested || r.countBadge),
    });
  }
}
const sim = (it: Item, t: T) => {
  if (it.never) return { conf: false, top: it.la[0]?.cardId };
  const d1 = decide(it.l1, t);
  if (d1.confident) return { conf: true, top: it.l1[0].cardId };
  return { conf: decide(it.la, t).confident, top: it.la[0]?.cardId };
};
const tally = (t: T) => {
  const per: Record<string, { conf: number; wrong: number; neg: number }> = {};
  for (const it of items) {
    const p = (per[it.file] ??= { conf: 0, wrong: 0, neg: 0 });
    const s = sim(it, t);
    if (!s.conf) continue;
    if (it.cardId === null) p.neg++;
    else if (s.top === it.cardId) p.conf++;
    else p.wrong++;
  }
  return per;
};

const spec = getModel(arg('--model'));
const cur = spec.thresholds;
let agree = 0;
for (const it of items) agree += +(sim(it, cur).conf === it.engineConf);
console.log(`${items.length} readings; sim vs engine at ${spec.id}'s thresholds: ${agree}/${items.length} agree`);
console.log('current', JSON.stringify(cur), JSON.stringify(tally(cur)));

const maxNeg = Number(arg('--max-neg') ?? 9);
const out: { t: T; per: ReturnType<typeof tally>; conf: number; neg: number }[] = [];
const r2 = (v: number) => Math.round(v * 1000) / 1000;
const [f0, f1] = (arg('--floors') ?? '0.66,0.80').split(',').map(Number);
const [s0, s1] = (arg('--scores') ?? '0.74,0.92').split(',').map(Number);
for (let floor = f0; floor <= f1 + 1e-9; floor += 0.01)
  for (let score = s0; score <= s1 + 1e-9; score += 0.01)
    for (const margin of [0.01, 0.02, 0.03])
      for (const s2 of [null, 0.7, 0.72, 0.73, 0.74, 0.76, 0.78, 0.8, 0.82])
        for (const m2 of s2 === null ? [0] : [0.08, 0.1, 0.12, 0.14]) {
          if (score < floor) continue;
          const t: T = { score: r2(score), margin, floor: r2(floor), cardBackMargin: 0.1, ...(s2 !== null ? { second: { score: s2, margin: m2 } } : {}) };
          const per = tally(t);
          const vals = Object.values(per);
          if (vals.some((p) => p.wrong > 0)) continue;
          const neg = vals.reduce((a, p) => a + p.neg, 0);
          if (neg > maxNeg) continue;
          out.push({ t, per, conf: vals.reduce((a, p) => a + p.conf, 0), neg });
        }
out.sort((a, b) => b.conf - a.conf || a.neg - b.neg || b.t.score - a.t.score || b.t.floor - a.t.floor);
for (const o of out.slice(0, Number(arg('--top') ?? 15))) console.log(o.conf, o.neg, JSON.stringify(o.t), JSON.stringify(o.per));

// The suggestions' floor: lists the engine offered (suggested) at the run's floor, replayed at higher floors.
const sug: Record<string, { cardId: number | null; top: number; score: number }[]> = {};
for (const f of (arg('--files') ?? '').split(',').filter(Boolean)) {
  const d = JSON.parse(readFileSync(f, 'utf8')) as { rows: Row[]; negatives?: { rows: Row[] } };
  for (const r of [...d.rows, ...(d.negatives?.rows ?? []).map((n) => ({ ...n, cardId: null }))])
    if (r.suggested && r.candidates[0]) (sug[f.split('/').slice(-2).join('/')] ??= []).push({ cardId: r.cardId ?? null, top: r.candidates[0].cardId, score: r.candidates[0].score });
}
for (const [file, rs] of Object.entries(sug)) {
  console.log(`suggested lists, ${file}: floor -> right lists / wrong lists / non-card lists`);
  for (let fl = 0.6; fl <= 0.74 + 1e-9; fl += 0.005) {
    const on = rs.filter((r) => r.score >= fl);
    console.log(`  ${fl.toFixed(3)}  ${on.filter((r) => r.cardId !== null && r.top === r.cardId).length} / ${on.filter((r) => r.cardId !== null && r.top !== r.cardId).length} / ${on.filter((r) => r.cardId === null).length}`);
  }
}
