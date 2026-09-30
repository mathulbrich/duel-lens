// realset2 report: eval-real's results on data/realset2 broken down by the set's own fields (category,
// tag, event) and the negatives by category, as Markdown tables. eval-real prints its production table
// (a data/realset notion: every realset2 frame falls in its default bucket), so read this one instead.
//
//   npx tsx tools/realset2/report.ts [--results data/realset2/results-engine-dinov2-small-duel.json]
//        [--set data/realset2/set.json] [--negatives data/realset2/negatives.json] [--rows]
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const resultsPath = path.resolve(ROOT, arg('--results') ?? 'data/realset2/results-engine-dinov2-small-duel.json');
const setPath = path.resolve(ROOT, arg('--set') ?? 'data/realset2/set.json');
const negPath = path.resolve(ROOT, arg('--negatives') ?? 'data/realset2/negatives.json');

interface Row {
  id: string;
  top1Correct: boolean;
  top5Correct: boolean;
  confident: boolean;
  error?: string;
  candidates: { name: string; score: number }[];
  name: string;
}
interface NegRow {
  id: string;
  confident: boolean;
  nothing: boolean;
  error?: string;
  candidates: { name: string; score: number }[];
}
interface SetRow {
  id: string;
  category: string;
  tags: string[];
  event: string;
}

const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as { model: string; rows: Row[]; negatives?: { rows: NegRow[] } };
const set = new Map((JSON.parse(readFileSync(setPath, 'utf8')) as SetRow[]).map((r) => [r.id, r]));
const negSet = new Map((JSON.parse(readFileSync(negPath, 'utf8')) as { id: string; category: string }[]).map((r) => [r.id, r]));

const pct = (a: number, n: number) => (n ? `${((100 * a) / n).toFixed(1)}%` : 'n/a');
function table(title: string, groups: Map<string, Row[]>) {
  console.log(`\n### ${title}\n`);
  console.log('| group | n | top-1 | top-5 | confident | confident wrong | errors |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const [g, rows] of groups) {
    const n = rows.length;
    const t1 = rows.filter((r) => r.top1Correct).length;
    const t5 = rows.filter((r) => r.top5Correct).length;
    const c = rows.filter((r) => r.confident).length;
    const cw = rows.filter((r) => r.confident && !r.top1Correct).length;
    const e = rows.filter((r) => r.error).length;
    console.log(`| ${g} | ${n} | ${t1} (${pct(t1, n)}) | ${t5} (${pct(t5, n)}) | ${c} (${pct(c, n)}) | ${cw} | ${e} |`);
  }
}
const group = <T>(rows: T[], key: (r: T) => string[], order?: string[]) => {
  const m = new Map<string, T[]>();
  for (const k of order ?? []) m.set(k, []);
  for (const r of rows) for (const k of key(r)) m.set(k, [...(m.get(k) ?? []), r]);
  for (const [k, v] of m) if (v.length === 0) m.delete(k);
  return m;
};

const rows = results.rows.filter((r) => set.has(r.id));
if (rows.length !== results.rows.length) console.error(`[report] ${results.rows.length - rows.length} result rows are not in the set (ignored)`);
console.log(`## realset2: ${path.relative(ROOT, resultsPath)} (model ${results.model})`);
const ORDER = ['normal', 'tilted', 'small', 'cut', 'covered', 'foil', 'overframe', 'digital'];
table('Overall', new Map([['all', rows]]));
table('By category (each card once, its main difficulty)', group(rows, (r) => [set.get(r.id)!.category], ORDER));
table('By tag (a card counts under every tag it has)', group(rows, (r) => set.get(r.id)!.tags, ['sideways', 'tilted', 'rot180', 'small', 'cut', 'covered', 'stacked', 'foil', 'overframe', 'digital']));
table('By event', group(rows, (r) => [set.get(r.id)!.event]));

const negRows = (results.negatives?.rows ?? []).filter((r) => negSet.has(r.id));
if (negRows.length) {
  console.log('\n### Negatives (non-card boxes; a confident answer is wrong)\n');
  console.log('| category | n | confident | not sure | nothing | errors |');
  console.log('|---|---:|---:|---:|---:|---:|');
  const groups = group(negRows, (r) => [negSet.get(r.id)!.category, 'all']);
  for (const [g, rs] of groups) {
    const c = rs.filter((r) => !r.error && r.confident).length;
    const nothing = rs.filter((r) => r.nothing).length;
    const e = rs.filter((r) => r.error).length;
    console.log(`| ${g} | ${rs.length} | ${c} | ${rs.length - c - nothing - e} | ${nothing} | ${e} |`);
  }
  const sure = negRows.filter((r) => r.confident);
  if (sure.length) console.log(`\nConfident on: ${sure.map((r) => `${r.id} -> ${r.candidates[0]?.name} (${r.candidates[0]?.score.toFixed(3)})`).join('; ')}`);
}
if (process.argv.includes('--rows')) {
  console.log('\n### Confident wrong and misses\n');
  for (const r of rows.filter((x) => !x.top1Correct || (x.confident && !x.top1Correct))) {
    const s = set.get(r.id)!;
    console.log(`- ${r.confident ? 'CONFIDENT WRONG' : 'miss'} [${s.category}] ${r.id}: truth ${r.name}; got ${r.candidates[0] ? `${r.candidates[0].name} (${r.candidates[0].score.toFixed(3)})` : 'nothing'}`);
  }
}
