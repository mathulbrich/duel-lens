// Experiment (partial-report.md §3): which extra readings recover a card cut by the picture's edge.
// For each synthetic partial card (lib/synth.ts, the drag crop), it mirrors the engine up to its
// hypotheses (the card detector in the crop, straightenPick, buildHypotheses), then, when the pick is cut
// by the picture's edge (truncation.ts: a crop side with a short margin that the card reaches), adds one
// family of extra readings at a time and replays the engine's decision (two stages, decide()) on the
// baseline's readings plus those:
//   fill-*:  the pick's own views (corners, box, grown) re-straightened with the unseen part filled:
//            black (today), edge (border stretched), grey, mean (card), art-mean (seen art)
//   pad-*:   the detector re-run on the crop padded with grey past the picture's edge, its pick's views
//   comp-*:  the cut side put back from the card's aspect and its whole side (truncation.completeQuad)
//   art-vis: the seen part of the art box alone
// Only runs where the baseline isn't confident count (the engine keeps a confident answer).
//
//   npx tsx tools/partial/exp-variants.ts [--every 3] [--sides ...] [--fractions ...] [--out file]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CARD_H, CARD_W } from '../../src/shared/card-layout';
import { hypothesisOptions, straightenPick, type StraightenedCard } from '../../src/offscreen/engine';
import { signedArea, type Point, type Quad, type Rect } from '../../src/offscreen/geometry';
import { buildHypotheses, userBox, type Hypothesis } from '../../src/offscreen/hypotheses';
import { fillUnseen, frameSides, padSides, sidesReached, warpQuadMasked, type MaskedWarp } from '../../src/offscreen/truncation';
import { artSeenShare, completeQuad } from './lib/exp-geometry';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { decide, mergeCandidates, topKByCard } from '../../src/shared/search';
import { cropRGBA, resizeRGBA, rotate180, type RGBAImage } from '../../src/shared/preprocess';
import type { Candidate } from '../../src/shared/types';
import type { DetectedCardBox } from '../../src/shared/messages';
import { loadRGBA } from '../lib/image';
import { buildCrop } from '../realset/lib/crop';
import type { NegativeBox, RealsetEntry } from '../realset/lib/types';
import { makeRig, ROOT } from './lib/engine';
import { boxInWindow, cutFrame, cutWindow, FRACTIONS, SIDES, type Side } from './lib/synth';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const every = Number(arg('--every') ?? 3);
const sides = (arg('--sides')?.split(',') ?? SIDES) as Side[];
const fractions = arg('--fractions') ? arg('--fractions')!.split(',').map(Number) : [...FRACTIONS];
const outPath = path.resolve(ROOT, arg('--out') ?? 'data/debug/partial/exp-variants.json');
const TOP_K = 10;
const COMBOS = ['pad-edge+comp-pad-as-found-edge', 'pad-edge+fill-edge', 'pad-edge+comp-pad-as-found-edge+fill-edge', 'pad-edge+artvis-pad', 'pad-art-mean+pad-edge'];
const set = arg('--set') ?? 'cards';

// ---- engine.ts private helpers, copied (cardCorners, alignedTo, grown) ----
const sideLength = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
function cardCorners(q: Quad): Quad {
  const [a, b, c, d] = signedArea(q) < 0 ? [q[0], q[3], q[2], q[1]] : q;
  return sideLength(a, b) + sideLength(c, d) > sideLength(b, c) + sideLength(d, a) ? [d, a, b, c] : [a, b, c, d];
}
function grown(q: Quad, k: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k })) as Quad;
}
const shift = (q: Quad, dx: number, dy: number) => q.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;

type Fill = 'black' | 'edge' | 'grey' | 'mean' | 'art-mean';
const FILLS: Fill[] = ['black', 'edge', 'grey', 'mean', 'art-mean'];

function straighten(img: RGBAImage, q: Quad, fill: Fill): { card: RGBAImage; warp: MaskedWarp } | null {
  const w = warpQuadMasked(img, q, CARD_W, CARD_H, fill === 'edge' ? 'edge' : 'black');
  if (!w) return null;
  const card = fill === 'black' || fill === 'edge' ? w.image : fillUnseen(w, fill);
  return { card, warp: w };
}

/** The largest axis-aligned part of the art box whose pixels were all seen (shrinking from the unseen side). */
function artVisible(w: MaskedWarp): RGBAImage | null {
  const W = w.image.width;
  const H = w.image.height;
  let x0 = Math.round(0.118 * W);
  let x1 = Math.round(0.883 * W);
  let y0 = Math.round(0.181 * H);
  let y1 = Math.round(0.706 * H);
  const colSeen = (x: number) => {
    let s = 0;
    for (let y = y0; y < y1; y++) s += w.seen[y * W + x];
    return s / (y1 - y0);
  };
  const rowSeen = (y: number) => {
    let s = 0;
    for (let x = x0; x < x1; x++) s += w.seen[y * W + x];
    return s / (x1 - x0);
  };
  for (let guard = 0; guard < 2000; guard++) {
    const cands = [colSeen(x0), colSeen(x1 - 1), rowSeen(y0), rowSeen(y1 - 1)];
    const worst = Math.min(...cands);
    if (worst >= 0.98) break;
    const k = cands.indexOf(worst);
    if (k === 0) x0++;
    else if (k === 1) x1--;
    else if (k === 2) y0++;
    else y1--;
    if (x1 - x0 < 0.3 * W * 0.765 || y1 - y0 < 0.3 * H * 0.525) return null;
  }
  return cropRGBA(w.image, x0, y0, x1 - x0, y1 - y0);
}

interface Sample {
  id: string;
  cardId: number;
  side: Side;
  fraction: number;
  frame: string;
  win: { x: number; y: number; w: number; h: number };
  box: Rect;
}

async function main() {
  const entries =
    set === 'neg'
      ? (JSON.parse(readFileSync(path.join(ROOT, 'data/realset/negatives.json'), 'utf8')) as NegativeBox[]).map(
          (n) => ({ id: n.id, frame: n.frame, userBox: { x: n.box[0], y: n.box[1], w: n.box[2], h: n.box[3] }, cardId: -999 }) as unknown as RealsetEntry,
        )
      : (JSON.parse(readFileSync(path.join(ROOT, 'data/realset/set.json'), 'utf8')) as RealsetEntry[]).filter((_, i) => i % every === 0);
  const rig = await makeRig();
  const detector = rig.det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const samples: Sample[] = [];
  const size = (f: string) => {
    const b = readFileSync(path.join(ROOT, 'data/debug/frames', `${f}.png`)).subarray(16, 24);
    return { w: b.readUInt32BE(0), h: b.readUInt32BE(4) };
  };
  for (const e of entries) {
    const s = size(e.frame);
    for (const side of sides)
      for (const fraction of fractions) {
        const win = cutWindow(s.w, s.h, e.userBox, side, fraction);
        const box = win && boxInWindow(e.userBox, win);
        if (win && box) samples.push({ id: `${e.id}|${side}|${fraction}`, cardId: e.cardId!, side, fraction, frame: e.frame, win, box });
      }
  }
  console.error(`[exp] ${samples.length} samples`);
  const frames = new Map<string, RGBAImage>();
  const rows: Record<string, unknown>[] = [];
  const hypothesisMax = 3 * rig.spec.inputSize;
  const t0 = Date.now();
  for (const [si, s] of samples.entries()) {
    if (!frames.has(s.frame)) {
      if (frames.size > 6) frames.delete(frames.keys().next().value!);
      frames.set(s.frame, await loadRGBA(path.join(ROOT, 'data/debug/frames', `${s.frame}.png`)));
    }
    const frame = cutFrame(frames.get(s.frame)!, s.win);
    const { cropImg: img, inner } = buildCrop(frame, s.box);
    const user = userBox(img, inner);
    const boxes: DetectedCardBox[] = await detector.detectInCrop!(img);
    const found0 = straightenPick(img, boxes, user);
    const found: StraightenedCard | null = found0 && found0.cards.length > 0 ? found0 : null;
    const fsides = frameSides(img.width, img.height, inner);
    const tol = Math.max(2, 0.02 * Math.min(img.width, img.height));
    const pickQuad = found ? cardCorners(found.pick.pts.map(([x, y]) => ({ x, y })) as Quad) : null;
    const reached = pickQuad ? sidesReached(pickQuad, img.width, img.height, fsides, tol) : sidesReached(
      [{ x: user.x, y: user.y }, { x: user.x + user.w, y: user.y }, { x: user.x + user.w, y: user.y + user.h }, { x: user.x, y: user.y + user.h }], img.width, img.height, fsides, tol);
    const source = img.width > hypothesisMax || img.height > hypothesisMax ? resizeRGBA(img, Math.round(img.width * hypothesisMax / Math.max(img.width, img.height)), Math.round(img.height * hypothesisMax / Math.max(img.width, img.height))) : img;
    const sx = source.width / img.width;
    const sy = source.height / img.height;
    const base = buildHypotheses(source, found?.cards ?? null, { x: inner.x * sx, y: inner.y * sy, w: inner.w * sx, h: inner.h * sy }, hypothesisOptions(found, true));
    const embedLists = async (hs: Hypothesis[]) => (await rig.embedder.embed(hs.map((h) => h.image))).map((v) => topKByCard(v, rig.index, TOP_K));
    const baseLists = await embedLists(base);
    const replay = (hs: Hypothesis[], lists: Candidate[][]) => {
      const s1 = lists.filter((_, i) => hs[i].rotation !== 180);
      let merged = mergeCandidates(s1, TOP_K);
      let d = decide(merged, rig.spec.thresholds);
      if (!d.confident && s1.length < lists.length) {
        merged = mergeCandidates(lists, TOP_K);
        d = decide(merged, rig.spec.thresholds);
      }
      const top = merged[0];
      const truth = merged.find((c) => c.cardId === s.cardId);
      return { top: d.nothing ? null : top?.cardId ?? null, score: top?.score ?? null, confident: d.confident, nothing: d.nothing, truthScore: truth?.score ?? null };
    };
    const r0 = replay(base, baseLists);
    const row: Record<string, unknown> = {
      id: s.id, side: s.side, fraction: s.fraction, cardId: s.cardId, sides: fsides, reached, found: !!found,
      pickKind: found?.pick.kind ?? null, base: r0,
    };
    const truncated = reached.length > 0;
    row.truncated = truncated;
    if (truncated && !r0.confident) {
      const variants: Record<string, Hypothesis[]> = {};
      const quadHyps = (cards: RGBAImage[]) => buildHypotheses(source, cards, null, { userBoxWithCard: false });
      // fill-*: the pick's own views
      if (found) {
        for (const fill of FILLS) {
          const cards = found.quads.map((q) => straighten(img, q, fill)?.card).filter((c): c is RGBAImage => !!c);
          variants[`fill-${fill}`] = quadHyps(cards);
        }
      }
      // pad-*: re-detect on the padded crop
      const pad = Math.max(img.width, img.height);
      const padded = padSides(img, reached, pad, 114);
      const pboxes = await detector.detectInCrop!(padded.image);
      const pfound0 = straightenPick(padded.image, pboxes, { x: user.x + padded.dx, y: user.y + padded.dy, w: user.w, h: user.h });
      const pquads = pfound0 ? pfound0.quads.map((q) => shift(q, -padded.dx, -padded.dy)) : [];
      row.padFound = !!pfound0;
      for (const fill of ['grey', 'art-mean', 'edge'] as Fill[]) {
        const cards = pquads.map((q) => straighten(img, q, fill)?.card).filter((c): c is RGBAImage => !!c);
        if (cards.length) variants[`pad-${fill}`] = quadHyps(cards);
      }
      // comp-*: complete from the aspect (the pick's corners and the padded pick's corners)
      const compFrom = (q: Quad | null, tag: string) => {
        if (!q) return;
        for (const orient of ['as-found', 'turned'] as const) {
          const c = completeQuad(cardCorners(q), img.width, img.height, reached, tol, orient);
          if (!c) continue;
          for (const fill of ['art-mean', 'edge'] as Fill[]) {
            const cards = [c, grown(c, 1.08)].map((qq) => straighten(img, qq, fill)?.card).filter((x): x is RGBAImage => !!x);
            if (cards.length) variants[`comp-${tag}-${orient}-${fill}`] = quadHyps(cards);
          }
        }
      };
      compFrom(pickQuad, 'pick');
      compFrom(pquads[0] ?? null, 'pad');
      // art-vis: the seen art alone, from the pick's corners (or the padded pick's)
      const visFrom = (q: Quad | undefined, tag: string) => {
        if (!q) return;
        const w = warpQuadMasked(img, q, CARD_W, CARD_H, 'black');
        if (!w) return;
        row[`artSeen-${tag}`] = Math.round(artSeenShare(w) * 1000) / 1000;
        const a = artVisible(w);
        if (a) variants[`artvis-${tag}`] = [{ id: 'quad', rotation: 0, image: a }, { id: 'quad', rotation: 180, image: rotate180(a) }];
      };
      visFrom(found?.quads[0], 'pick');
      visFrom(pquads[0], 'pad');
      const results: Record<string, unknown> = {};
      const embedded = new Map<string, { hs: Hypothesis[]; lists: Candidate[][] }>();
      for (const [name, hs] of Object.entries(variants)) {
        if (hs.length === 0) continue;
        const lists = await embedLists(hs);
        embedded.set(name, { hs, lists });
        results[name] = { ...replay([...base, ...hs], [...baseLists, ...lists]), n: hs.length, alone: replay(hs, lists) };
      }
      // Combinations of families (no new embeddings).
      for (const combo of COMBOS) {
        const parts = combo.split('+').map((k) => embedded.get(k)).filter((x): x is { hs: Hypothesis[]; lists: Candidate[][] } => !!x);
        if (parts.length === 0) continue;
        const hs = parts.flatMap((p) => p.hs);
        const lists = parts.flatMap((p) => p.lists);
        results[combo] = { ...replay([...base, ...hs], [...baseLists, ...lists]), n: hs.length, alone: replay(hs, lists) };
      }
      row.variants = results;
    }
    rows.push(row);
    if ((si + 1) % 50 === 0) console.error(`[exp] ${si + 1}/${samples.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  await rig.release();
  writeFileSync(outPath, JSON.stringify(rows, null, 1));
  summarize(rows);
}

export function summarize(rows: Record<string, any>[]): void {
  const n = rows.length;
  const trunc = rows.filter((r) => r.truncated);
  const base = (rs: any[]) => ({ right: rs.filter((r) => r.base.top === r.cardId).length, conf: rs.filter((r) => r.base.confident).length, confWrong: rs.filter((r) => r.base.confident && r.base.top !== r.cardId).length });
  console.log(`samples ${n}; gate fires on ${trunc.length}; baseline all:`, base(rows), 'baseline gated:', base(trunc));
  const names = new Set<string>();
  for (const r of trunc) for (const k of Object.keys(r.variants ?? {})) names.add(k);
  console.log('variant'.padEnd(34), 'n'.padStart(4), 'right'.padStart(6), 'conf'.padStart(5), 'confOK'.padStart(7), 'confWRONG'.padStart(10), 'nothing'.padStart(8), '| alone: right conf confWRONG');
  // Rows where the variant didn't run (baseline confident, or no such variant): the baseline counts.
  for (const name of [...names].sort()) {
    let right = 0;
    let conf = 0;
    let confOk = 0;
    let nothing = 0;
    let aRight = 0;
    let aConf = 0;
    let aWrong = 0;
    for (const r of trunc) {
      const v = r.variants?.[name];
      const d = v ?? r.base;
      if (d.top === r.cardId) right++;
      if (d.confident) conf++;
      if (d.confident && d.top === r.cardId) confOk++;
      if (d.nothing) nothing++;
      const a = v?.alone ?? r.base;
      if (a.top === r.cardId) aRight++;
      if (a.confident) aConf++;
      if (a.confident && a.top !== r.cardId) aWrong++;
    }
    console.log(name.padEnd(34), String(trunc.length).padStart(4), String(right).padStart(6), String(conf).padStart(5), String(confOk).padStart(7), String(conf - confOk).padStart(10), String(nothing).padStart(8), `| ${aRight} ${aConf} ${aWrong}`);
  }
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
