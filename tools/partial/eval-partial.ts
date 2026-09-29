// Measures the engine on PARTLY VISIBLE cards (partial-report.md), the extension's engine as eval-real
// builds it (lib/engine.ts), on the sets of lib/samples.ts:
//
// - synth:  the 120 real-set cards with their frame cut so the card loses 25%, 40% or 55% of its extent on
//           one side (top, bottom, left, right) at the new frame's edge (lib/synth.ts);
// - neg:    the 70 non-card boxes cut the same way: nothing may become confident;
// - occ:    the 120 cards covered 20%, 35% or 50% by a hand, a flat patch or a patch of the frame (lib/occlude.ts);
// - negocc: the 70 non-card boxes covered the same way;
// - real:   real partly visible cards (and non-cards), labelled by hand (data/debug/partial/real.json);
// - realset / realneg: the real set as it is (tools/eval-real.ts's own rows, drag only).
//
// Each sample is scanned the two ways a user scans:
// - drag: the user's box (around the visible part up to the edge; around the whole card when covered),
//   cropped as the content script does (tools/realset/lib/crop.ts: a 4% margin, clipped to the frame);
// - click: click to scan's outline under the box's centre (the whole-frame detector run, face-up,
//   confidence >= 0.4), cropped from its bounds as cropDetectedCard does; "no outline" when none is there.
//
//   npx tsx tools/partial/eval-partial.ts [--sets synth,neg,occ,negocc,real] [--modes drag,click]
//     [--sides top,left] [--fractions 0.25,0.4] [--occluders hand,patch] [--coverages 0.2,0.35]
//     [--every N] [--limit N] [--only id,id] [--out data/debug/partial/results-<tag>.json] [--tag name]
//     [--no-rescue | --rescue '<RescueOptions json>']   (the engine without its rescue path, or other settings)
//
// Prints a table per set, mode, side (or occluder) and fraction, and writes every row to the JSON.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DetectedCardBox } from '../../src/shared/messages';
import { CARD_BACK_ID, type RecognitionResult } from '../../src/shared/types';
import { loadCards } from '../realset/lib/cards';
import { buildCrop } from '../realset/lib/crop';
import type { RescueOptions } from '../../src/offscreen/engine';
import { makeRig, ROOT } from './lib/engine';
import { COVERAGES, OCCLUDERS, type Occluder } from './lib/occlude';
import { clickBox, makeSamples, type Sample, type SetName } from './lib/samples';
import { FRACTIONS, SIDES, type Side } from './lib/synth';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const list = (name: string, all: readonly string[]) => (arg(name) ? arg(name)!.split(',') : [...all]);

type Mode = 'drag' | 'click';

export interface Row {
  set: SetName;
  id: string;
  source: string;
  kind: Sample['kind'];
  mode: Mode;
  cardId: number | null;
  name: string;
  cut: string;
  side: string;
  fraction: number | null;
  /** click: no face-up outline under the click. */
  noOutline?: boolean;
  outline?: [number, number][];
  top?: { cardId: number; name: string; score: number } | null;
  second?: number | null;
  /** The right card's place in the answer's list (1-based; 0: not in it), for cards. */
  rank?: number;
  confident: boolean;
  nothing: boolean;
  correct: boolean;
  truncated?: boolean;
  rescued?: boolean;
  best?: string;
  error?: string;
  ms: number;
}

async function main() {
  const sets = list('--sets', ['synth', 'neg', 'occ', 'negocc', 'real']) as SetName[];
  const modes = list('--modes', ['drag', 'click']) as Mode[];
  const limit = arg('--limit') ? Number(arg('--limit')) : undefined;
  const only = arg('--only') ? new Set(arg('--only')!.split(',')) : null;
  const tag = arg('--tag') ?? 'run';
  const outPath = path.resolve(ROOT, arg('--out') ?? `data/debug/partial/results-${tag}.json`);
  const cards = loadCards();
  const nameOf = (id: number) => (id === CARD_BACK_ID ? 'Card back' : (cards.byId.get(id)?.name ?? `(card ${id})`));
  let samples = makeSamples({
    sets,
    sides: list('--sides', SIDES) as Side[],
    fractions: arg('--fractions') ? arg('--fractions')!.split(',').map(Number) : FRACTIONS,
    occluders: list('--occluders', OCCLUDERS) as Occluder[],
    coverages: arg('--coverages') ? arg('--coverages')!.split(',').map(Number) : COVERAGES,
    every: Number(arg('--every') ?? 1),
  });
  if (only) samples = samples.filter((s) => only.has(s.id) || only.has(s.source));
  if (limit) samples = samples.slice(0, limit);
  console.error(`[eval-partial] ${samples.length} samples × ${modes.join('+')} (${sets.join(', ')})`);
  const rescue = process.argv.includes('--no-rescue') ? false : arg('--rescue') ? (JSON.parse(arg('--rescue')!) as Partial<RescueOptions>) : undefined;
  const rig = await makeRig(undefined, rescue);
  const rows: Row[] = [];
  const t0 = Date.now();
  let skipped = 0;
  for (const [i, s] of samples.entries()) {
    const frame = await s.frame();
    if (!frame) {
      skipped++;
      continue;
    }
    let outlines: DetectedCardBox[] | null = null;
    for (const mode of modes) {
      if (mode === 'click' && (s.set === 'realset' || s.set === 'realneg')) continue; // eval-real and E2E cover those
      const base = { set: s.set, id: s.id, source: s.source, kind: s.kind, mode, cardId: s.cardId, name: s.name, cut: s.cut, side: s.side, fraction: s.fraction };
      let box = s.box;
      let outline: [number, number][] | undefined;
      if (mode === 'click') {
        outlines ??= await rig.outlines(frame);
        const hit = clickBox(outlines, s.box);
        if (!hit) {
          rows.push({ ...base, noOutline: true, confident: false, nothing: true, correct: false, ms: 0 });
          continue;
        }
        outline = hit.outline;
        box = hit.box;
      }
      const { cropImg, inner } = buildCrop(frame, box);
      const r: RecognitionResult = await rig.engine.recognize(cropImg, inner);
      const top = r.candidates[0];
      const rank = s.cardId === null ? undefined : r.candidates.findIndex((c) => c.cardId === s.cardId) + 1;
      rows.push({
        ...base,
        ...(outline ? { outline } : {}),
        top: top ? { cardId: top.cardId, name: nameOf(top.cardId), score: Math.round(top.score * 10000) / 10000 } : null,
        second: r.candidates[1] ? Math.round(r.candidates[1].score * 10000) / 10000 : null,
        ...(rank !== undefined ? { rank } : {}),
        confident: r.confident,
        nothing: !r.error && r.candidates.length === 0,
        correct: !!top && s.kind === 'card' && top.cardId === s.cardId,
        ...(r.truncated !== undefined ? { truncated: r.truncated } : {}),
        // The rescue path ran (timings.rescue) and gave the answer.
        ...(r.timings.rescue !== undefined && r.candidates.length > 0 ? { rescued: true } : {}),
        best: r.best ? `${r.best.hypothesis}@${r.best.rotation}` : undefined,
        ...(r.error ? { error: r.error } : {}),
        ms: r.timings.total,
      });
    }
    if ((i + 1) % 100 === 0) console.error(`[eval-partial] ${i + 1}/${samples.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  await rig.release();
  if (skipped) console.error(`[eval-partial] ${skipped} occlusion samples skipped (the occluder couldn't reach its coverage)`);
  writeFileSync(outPath, JSON.stringify({ tag, at: new Date().toISOString(), sets, modes, rescue: rescue ?? 'default', rows }, null, 1));
  printTables(rows);
  console.log(`\nwrote ${path.relative(ROOT, outPath)}`);
}

export function printTables(rows: Row[]): void {
  const groups = new Map<string, Row[]>();
  const add = (k: string, r: Row) => groups.set(k, [...(groups.get(k) ?? []), r]);
  for (const r of rows) {
    add(`${r.set} ${r.mode} | all`, r);
    if (r.fraction !== null && r.set !== 'real' && r.set !== 'realset' && r.set !== 'realneg') {
      add(`${r.set} ${r.mode} | f=${r.fraction}`, r);
      add(`${r.set} ${r.mode} | ${r.side}`, r);
      add(`${r.set} ${r.mode} | ${r.side} ${r.fraction}`, r);
    }
  }
  console.log('');
  console.log('group'.padEnd(34), 'n'.padStart(5), 'right'.padStart(6), 'conf'.padStart(5), 'confOK'.padStart(7), 'confWRONG'.padStart(10), 'notSure'.padStart(8), 'inList'.padStart(7), 'nothing'.padStart(8), 'noOutl'.padStart(7));
  for (const [k, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const n = g.length;
    const right = g.filter((r) => r.correct).length;
    const conf = g.filter((r) => r.confident).length;
    const confOk = g.filter((r) => r.confident && r.correct).length;
    const nothing = g.filter((r) => r.nothing && !r.noOutline).length;
    const noOutl = g.filter((r) => r.noOutline).length;
    const notSure = n - conf - nothing - noOutl;
    const inList = g.filter((r) => (r.rank ?? 0) > 0).length;
    console.log(
      k.padEnd(34),
      String(n).padStart(5),
      String(right).padStart(6),
      String(conf).padStart(5),
      String(confOk).padStart(7),
      String(conf - confOk).padStart(10),
      String(notSure).padStart(8),
      String(inList).padStart(7),
      String(nothing).padStart(8),
      String(noOutl).padStart(7),
    );
  }
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
