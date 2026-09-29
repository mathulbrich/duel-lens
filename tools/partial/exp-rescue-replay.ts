// Replays the rescue path on exp-rescue.ts's stored readings under a policy, without new embeddings
// (partial-report.md §3). Only samples whose normal answer was "nothing" are touched.
//
//   npx tsx tools/partial/exp-rescue-replay.ts <exp.json> [more.json ...] [--policy '<json>']
//   policy: { "tags": ["T-edge-v0", "O-mL", ...] | "families": ["T-edge", "O"],
//             "masks": ["mL", ...], "orot": "both" | "best", "floor": 0.74, "cap": true,
//             "tFirst": true }
//   "tFirst": the occlusion masks are read only when the cut readings (T-*) left the answer "nothing".
import { readFileSync } from 'node:fs';
import { decide, mergeCandidates } from '../../src/shared/search';
import { getModel } from '../../src/shared/models';
import type { Candidate } from '../../src/shared/types';

type Lite = [number, number][];
interface Row {
  set: string;
  id: string;
  kind: 'card' | 'neg';
  cardId: number | null;
  cut: string;
  side: string;
  fraction: number | null;
  base: { top: number | null; score: number | null; confident: boolean; nothing: boolean };
  baseLists?: Lite[];
  baseHyps?: string[];
  reached?: string[];
  rescue?: { tag: string; rot: number; list: Lite }[];
}

export interface Policy {
  /** Families to read: T-edge, T-mean (cut: every view), O (the masks below). */
  families: string[];
  /** Occlusion masks read (O-<mask>). */
  masks: string[];
  /** O masks at both rotations, or only at the rotation whose normal quad reading scored best. */
  orot: 'both' | 'best';
  /** T views read (v0 corners, v1 box, v2 grown). */
  tviews: number[];
  /** Rescue answers need a top score this high (the model's floor is 0.74). */
  floor: number;
  /** Rescue answers are never confident. */
  cap: boolean;
  /** The O masks are read only when the T readings left it "nothing" (T needs a cut card). */
  tFirst: boolean;
  /** The floor applies to the rescue readings' own best score (the normal readings can't lift an answer over it). */
  ownFloor: boolean;
  /** The cut card's readings in two stages: upright first, turned 180° only when that left it "nothing". */
  tStages: boolean;
  /** A rescue answer lists the rescue readings' candidates only (the normal readings can't head it). */
  rescueOnly: boolean;
  /** A rescue answer's first card must lead the next by this much. */
  lead: number;
}

export const DEFAULT_POLICY: Policy = { families: ['T-edge', 'O'], masks: ['mL', 'mR', 'mT', 'mB'], orot: 'best', tviews: [0, 1, 2], floor: 0.74, cap: true, tFirst: true, ownFloor: false, tStages: false, rescueOnly: false, lead: 0 };

const toCands = (l: Lite): Candidate[] => l.map(([cardId, score]) => ({ cardId, imageId: cardId, score }));

export interface Outcome {
  row: Row;
  touched: boolean;
  top: number | null;
  confident: boolean;
  nothing: boolean;
  /** The right card's place among the answer's first 4 (the popover shows the top card and up to 3 more). */
  rank4: number;
  /** Embeddings the rescue spent. */
  cost: number;
}

export function replay(row: Row, p: Policy): Outcome {
  const thresholds = getModel('dinov2-small-duel').thresholds;
  const out = (top: number | null, confident: boolean, nothing: boolean, merged: Candidate[], touched: boolean, cost: number): Outcome => {
    const rank4 = row.cardId === null || nothing ? 0 : merged.slice(0, 4).findIndex((c) => c.cardId === row.cardId) + 1;
    return { row, touched, top, confident, nothing, rank4, cost };
  };
  if (!row.base.nothing || !row.rescue) return out(row.base.top, row.base.confident, row.base.nothing, [], false, 0);
  const base = (row.baseLists ?? []).map(toCands);
  // The rotation the normal readings found the card at (their best quad score), for the O masks.
  let bestRot = 0;
  if (p.orot === 'best' && row.baseHyps) {
    let best = -Infinity;
    row.baseHyps.forEach((h, i) => {
      const s = base[i]?.[0]?.score ?? -Infinity;
      if (s > best) [best, bestRot] = [s, h.endsWith('@180') ? 180 : 0];
    });
  }
  const pick = (fam: 'T' | 'O') =>
    row.rescue!.filter((h) => {
      if (fam === 'T') {
        const m = /^T-(edge|mean)-v(\d)$/.exec(h.tag);
        return !!m && p.families.includes(`T-${m[1]}`) && p.tviews.includes(Number(m[2]));
      }
      const m = /^O-(.+)$/.exec(h.tag);
      return !!m && p.families.includes('O') && p.masks.includes(m[1]) && (p.orot === 'both' || h.rot === bestRot);
    });
  const noBack = (l: Candidate[]) => l.filter((c) => c.cardId !== -1);
  const decideWith = (lists: Candidate[][], own: Candidate[][]) => {
    const merged = mergeCandidates((p.rescueOnly ? own : lists).map(noBack), 10);
    const d = decide(merged, { ...thresholds, floor: p.floor });
    // ownFloor: the rescue readings' own best (card back aside) must clear the floor.
    const ownTop = mergeCandidates(own.map(noBack), 1)[0]?.score ?? -Infinity;
    const lead = (merged[0]?.score ?? 0) - (merged[1]?.score ?? 0);
    const nothing = own.length === 0 || d.nothing || (p.ownFloor && !(ownTop >= p.floor)) || lead < p.lead;
    return { merged, d: { ...d, nothing } };
  };
  const T = pick('T');
  const T0 = p.tStages ? T.filter((h) => h.rot === 0) : T;
  let own = T0.map((h) => toCands(h.list));
  let lists = [...base, ...own];
  let cost = T0.length;
  let { merged, d } = decideWith(lists, own);
  if (p.tStages && d.nothing) {
    const T180 = T.filter((h) => h.rot === 180);
    own = [...own, ...T180.map((h) => toCands(h.list))];
    lists = [...base, ...own];
    cost += T180.length;
    ({ merged, d } = decideWith(lists, own));
  }
  if (!p.tFirst || d.nothing) {
    const O = pick('O');
    if (O.length) {
      own = [...own, ...O.map((h) => toCands(h.list))];
      lists = [...base, ...own];
      cost += O.length;
      ({ merged, d } = decideWith(lists, own));
    }
  }
  if (d.nothing) return out(null, false, true, merged, true, cost);
  return out(merged[0].cardId, p.cap ? false : d.confident, false, merged, true, cost);
}

export function table(rows: Row[], p: Policy, label = ''): void {
  const groups = new Map<string, Outcome[]>();
  for (const r of rows) {
    const o = replay(r, p);
    const keys = [`${r.set} all`];
    if (r.set !== 'realset' && r.set !== 'realneg' && r.set !== 'real') keys.push(`${r.set} f=${r.fraction}`, `${r.set} ${r.side}`);
    for (const k of keys) groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  console.log(`\n${label} ${JSON.stringify(p)}`);
  console.log('group'.padEnd(24), 'n'.padStart(5), 'baseNothing'.padStart(12), 'rescued'.padStart(8), 'top1OK'.padStart(7), 'in4'.padStart(5), 'top1WRONG'.padStart(10), 'conf'.padStart(5), 'confWRONG'.padStart(10), 'avgCost'.padStart(8));
  for (const [k, os] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const touched = os.filter((o) => o.touched);
    const rescued = touched.filter((o) => !o.nothing);
    const top1 = rescued.filter((o) => o.top === o.row.cardId).length;
    const in4 = rescued.filter((o) => o.rank4 > 0).length;
    const conf = rescued.filter((o) => o.confident).length;
    const confWrong = rescued.filter((o) => o.confident && o.top !== o.row.cardId).length;
    const cost = touched.length ? touched.reduce((s, o) => s + o.cost, 0) / touched.length : 0;
    console.log(
      k.padEnd(24),
      String(os.length).padStart(5),
      String(touched.length).padStart(12),
      String(rescued.length).padStart(8),
      String(top1).padStart(7),
      String(in4).padStart(5),
      String(rescued.length - top1).padStart(10),
      String(conf).padStart(5),
      String(confWrong).padStart(10),
      cost.toFixed(1).padStart(8),
    );
  }
}

if (process.argv[1]?.endsWith('exp-rescue-replay.ts')) {
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--policy');
  const pi = process.argv.indexOf('--policy');
  const policy: Policy = { ...DEFAULT_POLICY, ...(pi >= 0 ? JSON.parse(process.argv[pi + 1]) : {}) };
  // One row per sample: runs may overlap (the real set sampled in two runs); the later file wins.
  const byKey = new Map<string, Row>();
  for (const f of files) for (const r of JSON.parse(readFileSync(f, 'utf8')) as Row[]) byKey.set(`${r.set}|${r.id}`, r);
  table([...byKey.values()], policy);
}
