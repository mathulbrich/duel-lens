// Row-by-row comparison of two result files (partial-report.md §4): tools/eval-real.ts's JSON (cards and
// negatives) or tools/partial/eval-partial.ts's. Lists every row whose answer differs (top card, sure or
// not, nothing) and says whether each change is an improvement, and the largest score change otherwise.
//
//   npx tsx tools/partial/compare.ts <before.json> <after.json>
import { readFileSync } from 'node:fs';

interface Answer {
  top: number | null;
  score: number | null;
  confident: boolean;
  nothing: boolean;
  truth: number | null;
  kind: 'card' | 'neg';
}

function rowsOf(file: string): Map<string, Answer> {
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Map<string, Answer>();
  if (Array.isArray(j.rows) && j.rows.length && 'mode' in j.rows[0]) {
    // eval-partial
    for (const r of j.rows) {
      out.set(`${r.set}|${r.mode}|${r.id}`, {
        top: r.noOutline || r.nothing ? null : (r.top?.cardId ?? null),
        score: r.top?.score ?? null,
        confident: r.confident,
        nothing: !!r.nothing,
        truth: r.cardId,
        kind: r.kind,
      });
    }
    return out;
  }
  for (const r of j.rows ?? []) {
    const c = r.candidates?.[0];
    out.set(`card|${r.id}`, { top: c?.cardId ?? null, score: c?.score ?? null, confident: r.confident, nothing: !c, truth: r.cardId, kind: 'card' });
  }
  for (const r of j.negatives?.rows ?? []) {
    const c = r.candidates?.[0];
    out.set(`neg|${r.id}`, { top: c?.cardId ?? null, score: c?.score ?? null, confident: r.confident, nothing: !c, truth: null, kind: 'neg' });
  }
  return out;
}

const state = (a: Answer) => (a.nothing ? 'nothing' : `${a.kind === 'card' ? (a.top === a.truth ? 'right' : 'WRONG') : 'NEG'}-${a.confident ? 'sure' : 'unsure'}`);

/** An improvement: a card from nothing (or wrong) to right, or from unsure-right to sure-right; never a negative gaining an answer. */
function improvement(b: Answer, a: Answer): boolean {
  if (a.kind === 'neg') return !a.confident && a.nothing && !b.nothing;
  const rightA = !a.nothing && a.top === a.truth;
  const rightB = !b.nothing && b.top === b.truth;
  if (rightA && !rightB) return true;
  if (rightA && rightB && a.confident && !b.confident) return true;
  return false;
}

const [beforeFile, afterFile] = process.argv.slice(2);
const before = rowsOf(beforeFile);
const after = rowsOf(afterFile);
let same = 0;
let maxDelta = 0;
const changes: string[] = [];
const transitions = new Map<string, number>();
for (const [k, b] of before) {
  const a = after.get(k);
  if (!a) {
    changes.push(`MISSING in after: ${k}`);
    continue;
  }
  const differs = b.top !== a.top || b.confident !== a.confident || b.nothing !== a.nothing;
  if (!differs) {
    same++;
    if (b.score !== null && a.score !== null) maxDelta = Math.max(maxDelta, Math.abs(b.score - a.score));
    continue;
  }
  const t = `${state(b)} -> ${state(a)}${improvement(b, a) ? ' (improvement)' : ''}`;
  const group = k.split('|').slice(0, k.startsWith('card|') || k.startsWith('neg|') ? 1 : 2).join(' ');
  transitions.set(`${group}: ${t}`, (transitions.get(`${group}: ${t}`) ?? 0) + 1);
  changes.push(`${k}: ${t}  [${b.top} ${b.score?.toFixed(3) ?? '-'} -> ${a.top} ${a.score?.toFixed(3) ?? '-'}]`);
}
for (const k of after.keys()) if (!before.has(k)) changes.push(`NEW in after: ${k}`);
console.log(`${before.size} rows before, ${after.size} after; ${same} identical answers (largest score change among them ${maxDelta.toFixed(4)}); ${changes.length} differ`);
for (const [t, n] of [...transitions.entries()].sort()) console.log(`  ${String(n).padStart(5)}  ${t}`);
if (process.argv.includes('--list')) for (const c of changes) console.log('  ' + c);
