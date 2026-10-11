// Measurement (not shipped, not a test): two tools/eval-real.ts results files row by row (cards and
// negatives): the answer (top card, confident, recogniser, face-down, truncated), the top 5 cards and the
// largest score difference. Prints the totals of each and every row that changed.
// Usage: npx tsx src/offscreen/__measure__/webgpu-compare.ts <a.json> <b.json>
import { readFileSync } from 'node:fs';

interface Row {
  id: string;
  candidates?: { cardId: number; score: number }[];
  confident?: boolean;
  recognizer?: string | null;
  faceDown?: boolean;
  truncated?: boolean;
  error?: string;
}
const load = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as { overall: unknown; rows: Row[]; negatives?: { overall: unknown; rows?: Row[] } };
const [a, b] = process.argv.slice(2).map(load);
const answer = (r: Row) => JSON.stringify([r.candidates?.[0]?.cardId ?? null, !!r.confident, r.recognizer ?? null, !!r.faceDown, !!r.truncated, r.error ?? null]);
let maxScore = 0;
let top5Changed = 0;
const changed: string[] = [];
function compare(as: Row[], bs: Row[], what: string) {
  const byId = new Map(bs.map((r) => [r.id, r]));
  if (as.length !== bs.length) changed.push(`${what}: ${as.length} rows against ${bs.length}`);
  for (const r of as) {
    const s = byId.get(r.id);
    if (!s) {
      changed.push(`${what} ${r.id}: missing`);
      continue;
    }
    if (answer(r) !== answer(s)) changed.push(`${what} ${r.id}: ${answer(r)} -> ${answer(s)}`);
    const ca = (r.candidates ?? []).slice(0, 5);
    const cb = (s.candidates ?? []).slice(0, 5);
    if (ca.length !== cb.length || ca.some((c, i) => c.cardId !== cb[i].cardId)) top5Changed++;
    else ca.forEach((c, i) => (maxScore = Math.max(maxScore, Math.abs(c.score - cb[i].score))));
  }
}
compare(a.rows, b.rows, 'card');
compare(a.negatives?.rows ?? [], b.negatives?.rows ?? [], 'negative');
console.log(JSON.stringify({ a: { cards: a.overall, negatives: a.negatives?.overall }, b: { cards: b.overall, negatives: b.negatives?.overall } }));
console.log(`rows: ${a.rows.length} cards, ${a.negatives?.rows?.length ?? 0} negatives; answers changed: ${changed.length}; top-5 lists changed: ${top5Changed}; largest top-5 score difference (same lists): ${maxScore.toExponential(2)}`);
for (const c of changed) console.log(`  ${c}`);
process.exitCode = changed.length ? 1 : 0;
