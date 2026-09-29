// Before/after tables for partial-report.md from tools/partial/eval-partial.ts's JSON files: per set, scan
// mode and cut (side or occluder, and fraction), the cards named right (top-1), sure, sure-but-wrong,
// "Not sure" right or wrong, the right card among the 4 the popover shows, and nothing; for non-cards, any
// answer is wrong. Then the rescue's cost (the scan time added where it ran).
//
//   npx tsx tools/partial/summarize.ts --before a.json[,b.json] --after c.json[,d.json] [--by side|fraction|all]
import { readFileSync } from 'node:fs';
import { getModel } from '../../src/shared/models';
import { decide } from '../../src/shared/search';
import type { Row } from './eval-partial';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const load = (files: string) => files.split(',').flatMap((f) => (JSON.parse(readFileSync(f, 'utf8')) as { rows: Row[] }).rows);
const before = load(arg('--before')!);
const after = load(arg('--after')!);
const by = arg('--by') ?? 'all';
const key = (r: Row) => `${r.set}|${r.mode}|${r.id}`;
const beforeBy = new Map(before.map((r) => [key(r), r]));

interface Tally {
  n: number;
  right: number;
  sure: number;
  sureWrong: number;
  unsureRight: number;
  unsureWrong: number;
  in4: number;
  nothing: number;
  noOutline: number;
}
const tally = (rows: Row[]): Tally => {
  const t: Tally = { n: 0, right: 0, sure: 0, sureWrong: 0, unsureRight: 0, unsureWrong: 0, in4: 0, nothing: 0, noOutline: 0 };
  for (const r of rows) {
    t.n++;
    if (r.noOutline) {
      t.noOutline++;
      continue;
    }
    if (r.nothing) {
      t.nothing++;
      continue;
    }
    const right = r.kind === 'card' && r.correct;
    if (right) t.right++;
    if (r.confident) {
      t.sure++;
      if (!right) t.sureWrong++;
    } else if (right) t.unsureRight++;
    else t.unsureWrong++;
    // The popover shows the top card and up to 3 more: rank 1-4 (only recorded by the newer runs).
    if (r.kind === 'card' && (r.rank ?? (right ? 1 : 0)) >= 1 && (r.rank ?? (right ? 1 : 0)) <= 4) t.in4++;
  }
  return t;
};

const groupOf = (r: Row) => {
  if (r.set === 'real') return `real ${r.kind === 'card' ? 'cards' : 'non-cards'} ${r.mode}`;
  if (by === 'all' || r.fraction === null) return `${r.set} ${r.mode}`;
  return by === 'side' ? `${r.set} ${r.mode} ${r.side}` : `${r.set} ${r.mode} ${r.fraction}`;
};
const groups = [...new Set(after.map(groupOf))].sort();
const cell = (t: Tally, card: boolean) =>
  card
    ? `${t.right} / ${t.sure} (${t.sureWrong}) / ${t.unsureRight}+${t.unsureWrong} / ${t.in4} / ${t.nothing}${t.noOutline ? ` (+${t.noOutline} no outline)` : ''}`
    : `${t.sure} / ${t.unsureWrong} / ${t.nothing}${t.noOutline ? ` (+${t.noOutline} no outline)` : ''}`;
console.log('| group | n | before | after |');
console.log('|---|--:|---|---|');
for (const g of groups) {
  const a = after.filter((r) => groupOf(r) === g);
  const b = a.map((r) => beforeBy.get(key(r))).filter((r): r is Row => !!r);
  const card = a[0].kind === 'card';
  console.log(`| ${g} | ${a.length} | ${cell(tally(b), card)} | ${cell(tally(a), card)} |`);
}
console.log('\ncards: right / sure (sure but wrong) / not sure right+wrong / right card among the 4 shown / nothing');
console.log('non-cards: sure / not sure / nothing (every answer is wrong)');

// What changed, row by row.
const moves = new Map<string, number>();
const state = (r: Row) => (r.noOutline ? 'no-outline' : r.nothing ? 'nothing' : `${r.kind === 'card' ? (r.correct ? 'right' : 'WRONG') : 'ANSWER'}-${r.confident ? 'sure' : 'unsure'}`);
let rescueMs: number[] = [];
let wouldBeSure = 0;
let wouldBeSureWrong = 0;
const t = getModel('dinov2-small-duel').thresholds;
for (const a of after) {
  const b = beforeBy.get(key(a));
  if (!b) continue;
  const m = `${a.set} ${a.mode}: ${state(b)} -> ${state(a)}`;
  if (state(b) !== state(a) || (a.top?.cardId ?? null) !== (b.top?.cardId ?? null)) moves.set(m, (moves.get(m) ?? 0) + 1);
  if (b.nothing && !a.nothing && !a.noOutline) {
    rescueMs.push(a.ms - b.ms);
    // Would the model's own gate have called this rescue answer sure (the evidence for lifting the cap)?
    const d = decide(
      [
        { cardId: 1, imageId: 1, score: a.top!.score },
        ...(a.second != null ? [{ cardId: 2, imageId: 2, score: a.second }] : []),
      ],
      t,
    );
    if (d.confident) {
      wouldBeSure++;
      if (!a.correct) wouldBeSureWrong++;
    }
  }
}
console.log('\nrow-by-row changes (before -> after):');
for (const [m, n] of [...moves.entries()].sort()) console.log(`  ${String(n).padStart(5)}  ${m}`);
// Every scan the rescue read more for (a cut face-up card found: truncated), answered or not.
const ranMs = after
  .filter((a) => a.truncated && beforeBy.get(key(a))?.nothing)
  .map((a) => a.ms - beforeBy.get(key(a))!.ms)
  .sort((x, y) => x - y);
if (ranMs.length)
  console.log(`\nscans the rescue read more for (a cut card found): ${ranMs.length}; extra time (Node, this machine, under load): median ${ranMs[Math.floor(ranMs.length / 2)].toFixed(0)} ms, p90 ${ranMs[Math.floor(0.9 * ranMs.length)].toFixed(0)} ms`);
rescueMs = rescueMs.sort((x, y) => x - y);
const q = (p: number) => rescueMs[Math.min(rescueMs.length - 1, Math.floor(p * rescueMs.length))];
if (rescueMs.length)
  console.log(`\nrescue answers: ${rescueMs.length}; extra scan time where they came from (Node, this machine): median ${q(0.5).toFixed(0)} ms, p90 ${q(0.9).toFixed(0)} ms`);
console.log(`rescue answers the model's own gate would call sure: ${wouldBeSure}, of which wrong: ${wouldBeSureWrong} (capped at "Not sure" all the same)`);
