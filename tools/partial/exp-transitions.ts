// Reads tools/partial/exp-variants.ts's JSON and tabulates, for one variant, how each gated sample's
// answer moves from the baseline under three adoption policies:
//   open:   the new decision replaces the baseline's (baseline not confident, gate fired)
//   strict: it replaces it only when it is confident
//   capped: it replaces it, but a confident new answer is reported "not sure"
//
//   npx tsx tools/partial/exp-transitions.ts <exp.json> <variant> [--neg]
import { readFileSync } from 'node:fs';

type D = { top: number | null; confident: boolean; nothing: boolean };
const [file, variant] = process.argv.slice(2);
const neg = process.argv.includes('--neg');
const rows = JSON.parse(readFileSync(file, 'utf8')) as { cardId: number; truncated: boolean; base: D; variants?: Record<string, D> }[];

const cls = (d: D, cardId: number): string => {
  if (d.nothing || d.top === null) return 'nothing';
  if (neg) return d.confident ? 'CONFIDENT' : 'not-sure';
  const right = d.top === cardId;
  return `${right ? 'right' : 'WRONG'}-${d.confident ? 'conf' : 'unsure'}`;
};

for (const policy of ['open', 'strict', 'capped'] as const) {
  const t = new Map<string, number>();
  for (const r of rows) {
    if (!r.truncated) continue;
    const v = r.variants?.[variant];
    let after: D = r.base;
    if (v && !r.base.confident) {
      if (policy === 'open') after = v;
      else if (policy === 'strict') after = v.confident ? v : r.base;
      else after = { ...v, confident: false };
    }
    const k = `${cls(r.base, r.cardId)} -> ${cls(after, r.cardId)}`;
    t.set(k, (t.get(k) ?? 0) + 1);
  }
  console.log(`\n${variant} (${policy}):`);
  for (const [k, n] of [...t.entries()].sort()) console.log(`  ${k.padEnd(36)} ${n}`);
}
