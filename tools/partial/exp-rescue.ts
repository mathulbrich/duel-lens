// Experiment for the rescue path (partial-report.md §3): every candidate rescue reading is embedded once
// per sample whose normal answer is "nothing", and its top candidates stored, so that any combination of
// readings and any decision policy can be replayed offline (exp-rescue-replay.ts) without new embeddings.
//
// Every reading's art is cut as the engine cuts it (buildHypotheses: at 180° the art box of the card
// turned, not the upright art box turned; an earlier version got that wrong, see partial-report.md §3).
// Per sample (lib/samples.ts, the drag crop), mirroring engine.ts: the card detector in the crop,
// straightenPick, buildHypotheses and the two-stage decision. When that decision is "nothing":
//   T-edge / T-mean: the crop padded with grey past the picture's edges the pick (or the box) reaches, the
//     detector run again, its face-up pick straightened in every view with the unseen part filled by the
//     border's pixels (edge) or the seen art's mean colour (mean);
//   O-<mask>: the face-up pick's straightened card (its corners view; else T's) with part of its art box
//     masked and filled with the seen art's mean colour: halves (mL mR mT mB), quadrants (qTL qTR qBL qBR),
//     diagonal pairs (dA: TL+BR, dB: TR+BL), the tight centre (tight: the middle 70%, no fill), skin-toned
//     pixels (skin), each read upright and turned 180°.
//
//   npx tsx tools/partial/exp-rescue.ts --sets synth,neg,occ,negocc,real,realset,realneg [--every N] --out file.json
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { CARD_H, CARD_W } from '../../src/shared/card-layout';
import { hypothesisOptions, straightenPick, type StraightenedCard } from '../../src/offscreen/engine';
import { signedArea, type Point, type Quad } from '../../src/offscreen/geometry';
import { buildHypotheses, userBox, type Hypothesis } from '../../src/offscreen/hypotheses';
import { fillUnseen, frameSides, padSides, sidesReached, warpQuadMasked } from '../../src/offscreen/truncation';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { decide, mergeCandidates, topKByCard } from '../../src/shared/search';
import { cropRGBA, resizeRGBA, type RGBAImage } from '../../src/shared/preprocess';
import type { Candidate } from '../../src/shared/types';
import type { DetectedCardBox } from '../../src/shared/messages';
import { buildCrop } from '../realset/lib/crop';
import { makeRig, ROOT } from './lib/engine';
import { COVERAGES, OCCLUDERS, type Occluder } from './lib/occlude';
import { makeSamples, type SetName } from './lib/samples';
import { FRACTIONS, SIDES, type Side } from './lib/synth';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const TOP_K = 10;

// ---- engine.ts private helpers, copied ----
const sideLength = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
function cardCorners(q: Quad): Quad {
  const [a, b, c, d] = signedArea(q) < 0 ? [q[0], q[3], q[2], q[1]] : q;
  return sideLength(a, b) + sideLength(c, d) > sideLength(b, c) + sideLength(d, a) ? [d, a, b, c] : [a, b, c, d];
}
const shift = (q: Quad, dx: number, dy: number) => q.map((p) => ({ x: p.x + dx, y: p.y + dy })) as Quad;

type Mask = 'mL' | 'mR' | 'mT' | 'mB' | 'qTL' | 'qTR' | 'qBL' | 'qBR' | 'dA' | 'dB' | 'tight' | 'skin';
const MASKS: Mask[] = ['mL', 'mR', 'mT', 'mB', 'qTL', 'qTR', 'qBL', 'qBR', 'dA', 'dB', 'tight', 'skin'];

/** Kovac et al.'s RGB skin rule (daylight). */
const isSkin = (r: number, g: number, b: number) => r > 95 && g > 40 && b > 20 && Math.max(r, g, b) - Math.min(r, g, b) > 15 && Math.abs(r - g) > 15 && r > g && r > b;

/** `art` with the `mask` region painted the mean colour of the rest (null when the mask is empty or everything). */
function masked(art: RGBAImage, mask: Mask): RGBAImage | null {
  const { width: W, height: H, data } = art;
  if (mask === 'tight') return cropRGBA(art, Math.round(0.15 * W), Math.round(0.15 * H), Math.round(0.7 * W), Math.round(0.7 * H));
  const inMask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const l = x < W / 2;
      const t = y < H / 2;
      let m = false;
      switch (mask) {
        case 'mL': m = l; break;
        case 'mR': m = !l; break;
        case 'mT': m = t; break;
        case 'mB': m = !t; break;
        case 'qTL': m = l && t; break;
        case 'qTR': m = !l && t; break;
        case 'qBL': m = l && !t; break;
        case 'qBR': m = !l && !t; break;
        case 'dA': m = l === t; break;
        case 'dB': m = l !== t; break;
        case 'skin': {
          const o = (y * W + x) * 4;
          m = isSkin(data[o], data[o + 1], data[o + 2]);
          break;
        }
      }
      if (m) inMask[y * W + x] = 1;
    }
  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < W * H; i++) {
    if (inMask[i]) continue;
    n++;
    sum[0] += data[i * 4];
    sum[1] += data[i * 4 + 1];
    sum[2] += data[i * 4 + 2];
  }
  const share = 1 - n / (W * H);
  if (mask === 'skin' && (share < 0.03 || share > 0.6)) return null;
  if (n === 0 || share === 0) return null;
  const out = new Uint8ClampedArray(data);
  for (let i = 0; i < W * H; i++) {
    if (!inMask[i]) continue;
    out[i * 4] = sum[0] / n;
    out[i * 4 + 1] = sum[1] / n;
    out[i * 4 + 2] = sum[2] / n;
  }
  return { data: out, width: W, height: H };
}

async function main() {
  const sets = (arg('--sets')?.split(',') ?? ['synth', 'neg', 'occ', 'negocc', 'real', 'realset', 'realneg']) as SetName[];
  const samples = makeSamples({
    sets,
    sides: SIDES,
    fractions: FRACTIONS,
    occluders: OCCLUDERS as Occluder[],
    coverages: COVERAGES,
    every: Number(arg('--every') ?? 1),
  });
  const outPath = path.resolve(ROOT, arg('--out') ?? 'data/debug/partial/exp-rescue.json');
  console.error(`[exp-rescue] ${samples.length} samples (${sets.join(', ')})`);
  const rig = await makeRig();
  const detector = rig.det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const hypothesisMax = 3 * rig.spec.inputSize;
  const lite = (l: Candidate[]) => l.map((c) => [c.cardId, Math.round(c.score * 10000) / 10000]);
  const rows: Record<string, unknown>[] = [];
  const t0 = Date.now();
  for (const [si, s] of samples.entries()) {
    const frame = await s.frame();
    if (!frame) continue;
    const { cropImg: img, inner } = buildCrop(frame, s.box);
    const user = userBox(img, inner);
    const boxes: DetectedCardBox[] = await detector.detectInCrop!(img);
    const found0 = straightenPick(img, boxes, user);
    const found: StraightenedCard | null = found0 && found0.cards.length > 0 ? found0 : null;
    const source =
      Math.max(img.width, img.height) > hypothesisMax
        ? resizeRGBA(img, Math.max(1, Math.round((img.width * hypothesisMax) / Math.max(img.width, img.height))), Math.max(1, Math.round((img.height * hypothesisMax) / Math.max(img.width, img.height))))
        : img;
    const sx = source.width / img.width;
    const sy = source.height / img.height;
    const base = buildHypotheses(source, found?.cards ?? null, { x: inner.x * sx, y: inner.y * sy, w: inner.w * sx, h: inner.h * sy }, hypothesisOptions(found, true));
    const embedLists = async (hs: RGBAImage[]) => (hs.length ? (await rig.embedder.embed(hs)).map((v) => topKByCard(v, rig.index, TOP_K)) : []);
    // The engine's two stages.
    const s1 = base.filter((h) => h.rotation !== 180);
    const s2 = base.filter((h) => h.rotation === 180);
    let lists = await embedLists(s1.map((h) => h.image));
    let hyps: Hypothesis[] = s1;
    let d = decide(mergeCandidates(lists, TOP_K), rig.spec.thresholds);
    if (!d.confident && s2.length) {
      lists = [...lists, ...(await embedLists(s2.map((h) => h.image)))];
      hyps = [...s1, ...s2];
      d = decide(mergeCandidates(lists, TOP_K), rig.spec.thresholds);
    }
    const merged = mergeCandidates(lists, TOP_K);
    const row: Record<string, unknown> = {
      set: s.set, id: s.id, kind: s.kind, cardId: s.cardId, cut: s.cut, side: s.side, fraction: s.fraction,
      base: { top: merged[0]?.cardId ?? null, score: merged[0]?.score ?? null, confident: d.confident, nothing: d.nothing },
      pick: found ? { kind: found.pick.kind ?? null, conf: found.pick.conf } : null,
    };
    if (d.nothing) {
      row.baseLists = lists.map(lite);
      row.baseHyps = hyps.map((h) => `${h.id}@${h.rotation}`);
      const fsides = frameSides(img.width, img.height, inner);
      const tol = Math.max(2, 0.02 * Math.min(img.width, img.height));
      const pickQuad = found ? cardCorners(found.pick.pts.map(([x, y]) => ({ x, y })) as Quad) : null;
      const userQuad: Point[] = [{ x: user.x, y: user.y }, { x: user.x + user.w, y: user.y }, { x: user.x + user.w, y: user.y + user.h }, { x: user.x, y: user.y + user.h }];
      const reached = sidesReached(pickQuad ?? userQuad, img.width, img.height, fsides, tol);
      row.frameSides = fsides;
      row.reached = reached;
      const rescue: { tag: string; rot: number; img: RGBAImage }[] = [];
      let tCard: RGBAImage | null = null;
      if (reached.length > 0) {
        const padded = padSides(img, reached, Math.max(img.width, img.height), 114);
        const pboxes = (await detector.detectInCrop!(padded.image)).filter((b) => b.kind !== 'face-down');
        const pf = straightenPick(padded.image, pboxes, { x: user.x + padded.dx, y: user.y + padded.dy, w: user.w, h: user.h });
        row.padPick = pf ? { kind: pf.pick.kind ?? null, conf: pf.pick.conf } : null;
        if (pf) {
          const quads = pf.quads.map((q) => shift(q, -padded.dx, -padded.dy));
          quads.forEach((q, vi) => {
            const w = warpQuadMasked(img, q, CARD_W, CARD_H, 'edge');
            const wb = warpQuadMasked(img, q, CARD_W, CARD_H, 'black');
            if (!w || !wb) return;
            if (vi === 0) row.padSeen = Math.round(wb.seenShare * 1000) / 1000;
            const edge = w.image;
            const mean = fillUnseen(wb, 'art-mean');
            if (vi === 0) tCard = edge;
            // The art box as the engine cuts it (buildHypotheses): at 180° the art box of the card turned.
            for (const [tag, card] of [['T-edge', edge], ['T-mean', mean]] as const)
              for (const h of buildHypotheses(source, [card], null, { userBoxWithCard: false })) rescue.push({ tag: `${tag}-v${vi}`, rot: h.rotation, img: h.image });
          });
        }
      }
      // Occlusion masks on the face-up pick's corners view, else T's first view.
      const oCard = found && found.pick.kind !== 'face-down' ? found.cards[0] : tCard;
      row.oFrom = found && found.pick.kind !== 'face-down' ? 'pick' : tCard ? 'pad' : null;
      if (oCard) {
        for (const h of buildHypotheses(source, [oCard], null, { userBoxWithCard: false })) {
          const rot = h.rotation;
          const art = h.image;
          for (const m of MASKS) {
            const mi = masked(art, m);
            if (mi) rescue.push({ tag: `O-${m}`, rot, img: mi });
          }
        }
      }
      const rl = await embedLists(rescue.map((r) => r.img));
      row.rescue = rescue.map((r, i) => ({ tag: r.tag, rot: r.rot, list: lite(rl[i]) }));
    }
    rows.push(row);
    if ((si + 1) % 50 === 0) console.error(`[exp-rescue] ${si + 1}/${samples.length} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  await rig.release();
  writeFileSync(outPath, JSON.stringify(rows));
  console.error(`[exp-rescue] wrote ${path.relative(ROOT, outPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
