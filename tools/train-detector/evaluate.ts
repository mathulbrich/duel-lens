// Evaluates the card detector through the extension's own TypeScript module
// (src/offscreen/detector/, on onnxruntime-node or onnxruntime-web WASM) on real footage:
//
//   fullview   the labelled full-view frames (data/train-detector/eval/fullview-quads.json): recall at
//              polygon IoU >= 0.5 of face-up and face-down labels by production, the face-up/face-down
//              confusion of the matched ones, and false outlines per frame (a detection that matches no
//              label and lies in no ignore region) at several thresholds; outlined PNGs of every frame
//              in data/debug/fullview (labelled or not) into data/train-detector/eval/out/
//   realset    data/realset/set.json's 57 cards with a labelled rotatedBox (the teacher's boxes, see
//              tools/realset/README.md): recall of those boxes (loose IoU, recall only)
//              (a) on the whole frame, (b) in the content script's crop of the user's box (the drag case)
//   negatives  data/realset/negatives.json's 37 non-card boxes: what the detector outlines there
//              (face-up = bad; mat art must never be face-up), on the frame and in the box's crop
//
//   npx tsx tools/train-detector/evaluate.ts [--model <onnx>] [--runtime node|wasm] [--threads N]
//        [--out <json>] [--no-png | --png-dir <dir>] [--refine] [--path whole|tiles]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { RGBAImage } from '../../src/shared/preprocess';
import { createNodeCardDetector, CARD_DETECTOR_FILE } from '../../src/offscreen/detector/node';
import type { DetectedCard, OwnCardDetector } from '../../src/offscreen/detector/detector';
import { insideShare, polygonIoU, type Pt } from '../../src/offscreen/detector/geometry';
import { tiledCardDetector, tileModelOf } from '../lib/tiled-detector';
import { refineCard } from '../../src/offscreen/detector/refine';
import { loadRGBA } from '../lib/image';
import { buildCrop } from '../realset/lib/crop';
import type { NegativeBox, RealsetEntry } from '../realset/lib/types';

const root = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelFile = opt('--model') ?? CARD_DETECTOR_FILE;
const runtime = (opt('--runtime') ?? 'node') as 'node' | 'wasm';
const threads = opt('--threads') ? Number(opt('--threads')) : undefined;
const outFile = opt('--out') ?? path.join(root, 'data/train-detector/eval/results.json');
const pngDir = path.resolve(root, opt('--png-dir') ?? 'data/train-detector/eval/out');
const drawPngs = !args.includes('--no-png');
/** whole (default): one run on the whole screenshot (asCardDetector); tiles: click-D's tiledCardDetector over tileModelOf (face-up only). */
const searchPath = (opt('--path') ?? 'whole') as 'whole' | 'tiles';
/** Fit every detection's outline to the image (src/offscreen/detector/refine.ts) before scoring. */
const refine = args.includes('--refine');

const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
const IOU = 0.5;

type Cls = 'face-up' | 'face-down' | 'ignore';
interface Label {
  cls: Cls;
  pts: Pt[];
  kind: string;
  note: string;
  source: string;
}

/** The production a full-view frame comes from (its name's prefix; names read off each stream's overlay). */
export function productionOfFullview(name: string): string {
  if (name.startsWith('fv-ycsm')) return 'YCS Paris 2026 (main)';
  if (name.startsWith('fv-ycsg')) return 'YCS Paris 2026 (Genesys)';
  if (name.startsWith('fv-wcq')) return 'WCQ Stuttgart 2026';
  if (name.startsWith('fv-wc')) return 'WC 2026';
  if (name.startsWith('fv-ycsc')) return 'YCS Columbus 2026';
  if (name.startsWith('fv-hgg')) return 'Houston Game Guys (locals)';
  if (name.startsWith('fv-tsc')) return 'tsc (table-cam stream)';
  if (name.startsWith('fv-dlaw')) return 'dlaw (casual table stream)';
  if (name.startsWith('fv-dp')) return 'dp (oblique close-up)';
  return name.replace(/^fv-|-t\d+\.png$/g, '');
}

/** click-D's 7 frames (4 productions) vs the 10 frames the lead added on 2026-09-29 (5 more productions). */
const SET_OF = (name: string) => (/^fv-(ycsm|ycsg|wcq|wc)-/.test(name) ? 'set A: 7 frames, 4 productions' : 'set B: 10 frames, 5 new productions');

interface FrameScore {
  up: [number, number];
  down: [number, number];
  upAsDown: number;
  downAsUp: number;
  fp: number;
  /** Per matched label: mean distance of the 4 corners (px; best cyclic order) and that over the label's short side. */
  cornerPx: number[];
  cornerRel: number[];
  fpBoxes: DetectedCard[];
  missed: Label[];
}

/** Greedy matching, strongest detection first: each takes the unmatched label it overlaps most (IoU >= 0.5). */
function scoreFrame(cards: DetectedCard[], labels: Label[], thr: number): FrameScore {
  const dets = cards.filter((c) => c.conf >= thr).sort((a, b) => b.conf - a.conf);
  const real = labels.filter((l) => l.cls !== 'ignore');
  const ignore = labels.filter((l) => l.cls === 'ignore');
  const taken = new Map<number, DetectedCard>();
  const fpBoxes: DetectedCard[] = [];
  for (const d of dets) {
    let best = -1;
    let bestIoU = IOU;
    real.forEach((l, i) => {
      if (taken.has(i)) return;
      const u = polygonIoU(d.pts as Pt[], l.pts);
      if (u >= bestIoU) [best, bestIoU] = [i, u];
    });
    if (best >= 0) {
      taken.set(best, d);
      continue;
    }
    // a second detection on a matched card, or one on an ignore region, is not a false outline
    const onLabel = real.some((l) => polygonIoU(d.pts as Pt[], l.pts) >= 0.3);
    const onIgnore = ignore.some((l) => insideShare(d.pts as Pt[], l.pts) >= 0.5 || polygonIoU(d.pts as Pt[], l.pts) >= 0.3);
    if (!onLabel && !onIgnore) fpBoxes.push(d);
  }
  const count = (c: Cls) => real.filter((l) => l.cls === c).length;
  const found = (c: Cls) => real.filter((l, i) => l.cls === c && taken.has(i)).length;
  const cornerPx: number[] = [];
  const cornerRel: number[] = [];
  for (const [i, d] of taken) {
    const l = real[i].pts;
    let best = Infinity;
    for (let sft = 0; sft < 4; sft++) {
      let e = 0;
      for (let k = 0; k < 4; k++) e += Math.hypot(d.pts[(k + sft) % 4][0] - l[k][0], d.pts[(k + sft) % 4][1] - l[k][1]);
      best = Math.min(best, e / 4);
    }
    const side = Math.min(Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]), Math.hypot(l[3][0] - l[0][0], l[3][1] - l[0][1]));
    cornerPx.push(best);
    cornerRel.push(best / Math.max(1, side));
  }
  return {
    cornerPx,
    cornerRel,
    up: [found('face-up'), count('face-up')],
    down: [found('face-down'), count('face-down')],
    upAsDown: real.filter((l, i) => l.cls === 'face-up' && taken.get(i)?.kind === 'face-down').length,
    downAsUp: real.filter((l, i) => l.cls === 'face-down' && taken.get(i)?.kind === 'face-up').length,
    fp: fpBoxes.length,
    fpBoxes,
    missed: real.filter((_, i) => !taken.has(i)),
  };
}

async function outline(img: RGBAImage, cards: DetectedCard[], labels: Label[], thr: number, missed: Label[], file: string) {
  const stroke = Math.max(2, Math.round(img.width / 700));
  const font = Math.max(11, Math.round(img.width / 110));
  const poly = (pts: Pt[]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const lab = labels
    .map((l) => `<polygon points="${poly(l.pts)}" fill="none" stroke="${l.cls === 'ignore' ? '#8e8e93' : '#ffffff'}" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="${l.cls === 'ignore' ? '3,3' : '0'}"/>`)
    .join('');
  const miss = missed.map((l) => `<polygon points="${poly(l.pts)}" fill="none" stroke="#ff375f" stroke-width="${stroke}" stroke-dasharray="${4 * stroke},${3 * stroke}"/>`).join('');
  const dets = cards
    .filter((c) => c.conf >= thr)
    .map((c) => {
      const col = c.kind === 'face-up' ? '#30d158' : '#ff9f0a';
      const [lx, ly] = c.pts[0];
      return `<polygon points="${poly(c.pts as Pt[])}" fill="none" stroke="${col}" stroke-width="${stroke}"/><text x="${lx.toFixed(1)}" y="${(ly - 3).toFixed(1)}" fill="${col}" font-size="${font}" font-family="monospace" font-weight="bold">${c.kind === 'face-up' ? 'U' : 'D'}${c.conf.toFixed(2)}</text>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${img.width}" height="${img.height}">${lab}${miss}${dets}</svg>`;
  await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(file);
}

const pct = (a: number, b: number) => (b ? `${a}/${b} (${((100 * a) / b).toFixed(0)}%)` : '-');

type Source = (name: string, img: RGBAImage) => Promise<DetectedCard[]>;

async function fullview(source: Source, report: Record<string, unknown>, drawThr: number) {
  const dir = path.join(root, 'data/debug/fullview');
  const all: Record<string, Label[]> = {};
  for (const f of ['fullview-quads.json', 'fullview-quads-new.json']) {
    const file = path.join(root, 'data/train-detector/eval', f);
    if (existsSync(file)) Object.assign(all, JSON.parse(readFileSync(file, 'utf8')));
  }
  delete (all as Record<string, unknown>)._format;
  const frames = readdirSync(dir).filter((f) => /^fv-.*\.png$/.test(f)).sort();
  const perFrame: Record<string, { production: string; ms: number; scores: Record<string, Omit<FrameScore, 'fpBoxes' | 'missed'>>; cards: DetectedCard[] }> = {};
  if (drawPngs) await mkdir(pngDir, { recursive: true });
  for (const f of frames) {
    const img = await loadRGBA(path.join(dir, f));
    const t = performance.now();
    const cards = await source(f, img);
    const ms = performance.now() - t;
    const labels = all[f];
    const scores: Record<string, Omit<FrameScore, 'fpBoxes' | 'missed'>> = {};
    let missedAtDraw: Label[] = [];
    if (labels) {
      for (const thr of THRESHOLDS) {
        const s = scoreFrame(cards, labels, thr);
        const { fpBoxes: _f, missed, ...rest } = s;
        scores[thr] = rest;
        if (thr === drawThr) missedAtDraw = missed;
      }
    }
    perFrame[f] = { production: productionOfFullview(f), ms: Math.round(ms), scores, cards };
    if (drawPngs) await outline(img, cards, labels ?? [], drawThr, missedAtDraw, path.join(pngDir, f));
  }
  // totals by production and overall
  type Agg = { up: [number, number]; down: [number, number]; upAsDown: number; downAsUp: number; fp: number; frames: number; cornerPx: number[]; cornerRel: number[] };
  const table: Record<string, Record<string, Agg>> = {};
  for (const thr of THRESHOLDS) {
    const rows: Record<string, Agg> = {};
    for (const [f, r] of Object.entries(perFrame)) {
      const s = r.scores[thr];
      if (!s) continue;
      for (const key of [r.production, SET_OF(f), 'all']) {
        const acc = (rows[key] ??= { up: [0, 0], down: [0, 0], upAsDown: 0, downAsUp: 0, fp: 0, frames: 0, cornerPx: [], cornerRel: [] });
        acc.cornerPx.push(...s.cornerPx);
        acc.cornerRel.push(...s.cornerRel);
        acc.up = [acc.up[0] + s.up[0], acc.up[1] + s.up[1]];
        acc.down = [acc.down[0] + s.down[0], acc.down[1] + s.down[1]];
        acc.upAsDown += s.upAsDown;
        acc.downAsUp += s.downAsUp;
        acc.fp += s.fp;
        acc.frames += 1;
      }
      void f;
    }
    table[thr] = rows;
  }
  report.fullview = { perFrame: Object.fromEntries(Object.entries(perFrame).map(([k, v]) => [k, { production: v.production, ms: v.ms, scores: v.scores, cards: v.cards.filter((c) => c.conf >= 0.2) }])), table };
  console.log('\n## Full-view frames (recall at polygon IoU >= 0.5; FP = false outlines)\n');
  for (const thr of THRESHOLDS) {
    console.log(`threshold ${thr}:`);
    for (const [k, r] of Object.entries(table[thr])) {
      const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
      console.log(
        `  ${k.padEnd(26)} face-up ${pct(...r.up).padEnd(13)} face-down ${pct(...r.down).padEnd(13)} up->down ${r.upAsDown}  down->up ${r.downAsUp}  FP ${r.fp} (${(r.fp / r.frames).toFixed(2)}/frame)` +
          `  corners ${mean(r.cornerPx).toFixed(1)} px (${(100 * mean(r.cornerRel)).toFixed(1)}% of width)`,
      );
    }
  }
}

async function realset(det: OwnCardDetector, report: Record<string, unknown>, thr: number) {
  const set = JSON.parse(readFileSync(path.join(root, 'data/realset/set.json'), 'utf8')) as RealsetEntry[];
  const negs = JSON.parse(readFileSync(path.join(root, 'data/realset/negatives.json'), 'utf8')) as NegativeBox[];
  const negCFile = path.join(root, 'data/realset/staging-C-negatives.json');
  const negsC = existsSync(negCFile) ? (JSON.parse(readFileSync(negCFile, 'utf8')) as NegativeBox[]) : [];
  const frameCache = new Map<string, Promise<{ img: RGBAImage; cards: DetectedCard[] }>>();
  const frame = (name: string) => {
    let p = frameCache.get(name);
    if (!p) {
      p = (async () => {
        const img = await loadRGBA(path.join(root, 'data/debug/frames', `${name}.png`));
        return { img, cards: await det.findCards(img, { minScore: 0.1 }) };
      })();
      frameCache.set(name, p);
    }
    return p;
  };
  const prod = (f: string) => (f.startsWith('native-wcq-') ? 'WCQ Stuttgart 2026' : f.startsWith('native-wc-') ? 'WC 2026' : 'YCS Paris 2026');
  interface RealRow {
    id: string;
    production: string;
    source: string;
    frameIoU: number;
    frameKind: string | null;
    frameConf: number | null;
    cropIoU: number;
    cropKind: string | null;
    cropConf: number | null;
  }
  const rows: RealRow[] = [];
  for (const e of set) {
    if (!e.rotatedBox) continue; // capture-C's rows (merged 2026-09-29) have no labelled box
    const { img, cards } = await frame(e.frame);
    const truth = e.rotatedBox.pts as Pt[];
    const best = (cs: DetectedCard[]) => cs.reduce<{ iou: number; c: DetectedCard | null }>((b, c) => { const u = polygonIoU(c.pts as Pt[], truth); return u > b.iou ? { iou: u, c } : b; }, { iou: 0, c: null });
    const onFrame = best(cards.filter((c) => c.conf >= thr));
    // the drag case: the content script's crop of the user's box, the detector's first pick
    const crop = buildCrop(img, e.userBox);
    const inCrop = await det.findInCrop(crop.cropImg);
    const s = crop.outW / crop.px.w;
    const truthInCrop = truth.map(([x, y]) => [(x - crop.px.x) * s, (y - crop.px.y) * s] as Pt);
    const pick = inCrop.find((c) => c.conf >= thr) ?? null;
    const pickIoU = pick ? polygonIoU(pick.pts as Pt[], truthInCrop) : 0;
    rows.push({ id: e.id, production: prod(e.frame), source: e.source, frameIoU: +onFrame.iou.toFixed(3), frameKind: onFrame.c?.kind ?? null, frameConf: onFrame.c?.conf ?? null, cropIoU: +pickIoU.toFixed(3), cropKind: pick?.kind ?? null, cropConf: pick?.conf ?? null });
  }
  /**
   * A negative box holds either a face-down object (a pile or a sleeve: a face-down outline is right,
   * a face-up one wrong) or nothing a detector should outline (mat art, an empty zone, a phone, a deck
   * box, hands, a photo token: any outline is wrong).
   */
  const nothingThere = (design: string) => /^(MAT ART|EMPTY ZONE|PHONE|HANDS?|PHOTO)\b|deck box/i.test(design);
  const negRows = [];
  for (const [set, list] of [
    ['negatives.json', negs],
    ['staging-C-negatives.json', negsC],
  ] as const) {
    for (const n of list) {
      const { img, cards } = await frame(n.frame);
      const [x, y, w, h] = n.box;
      const boxPts: Pt[] = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const inside = cards.filter((c) => c.conf >= thr && (insideShare(c.pts as Pt[], boxPts) >= 0.5 || polygonIoU(c.pts as Pt[], boxPts) >= 0.3));
      const crop = buildCrop(img, { x, y, w, h });
      const inCrop = (await det.findInCrop(crop.cropImg)).filter((c) => c.conf >= thr);
      negRows.push({
        set,
        id: n.id,
        design: n.design,
        production: prod(n.frame),
        object: nothingThere(n.design) ? ('nothing' as const) : ('face-down' as const),
        matArt: /MAT ART/i.test(n.design),
        frameUp: inside.filter((c) => c.kind === 'face-up').map((c) => c.conf),
        frameDown: inside.filter((c) => c.kind === 'face-down').map((c) => c.conf),
        cropTop: inCrop[0] ? { kind: inCrop[0].kind, conf: inCrop[0].conf } : null,
      });
    }
  }
  report.realset = { threshold: thr, rows, negatives: negRows };
  const by = (k: string) => rows.filter((r) => k === 'all' || r.production === k);
  console.log(`\n## Real set (57 cards with a labelled rotatedBox, recall only) at threshold ${thr}\n`);
  for (const k of ['all', 'YCS Paris 2026', 'WC 2026', 'WCQ Stuttgart 2026']) {
    const rs = by(k);
    const n = rs.length;
    console.log(
      `  ${k.padEnd(20)} frame IoU>=0.3 ${pct(rs.filter((r) => r.frameIoU >= 0.3).length, n).padEnd(13)} >=0.5 ${pct(rs.filter((r) => r.frameIoU >= 0.5).length, n).padEnd(13)} ` +
        `face-up ${rs.filter((r) => r.frameIoU >= 0.3 && r.frameKind === 'face-up').length}/${rs.filter((r) => r.frameIoU >= 0.3).length}   ` +
        `user box: IoU>=0.3 ${pct(rs.filter((r) => r.cropIoU >= 0.3).length, n).padEnd(13)} >=0.5 ${pct(rs.filter((r) => r.cropIoU >= 0.5).length, n).padEnd(13)} face-up ${rs.filter((r) => r.cropIoU >= 0.3 && r.cropKind === 'face-up').length}`,
    );
  }
  for (const set of ['negatives.json', 'staging-C-negatives.json']) {
    const rs = negRows.filter((r) => r.set === set);
    if (!rs.length) continue;
    const objs = rs.filter((r) => r.object === 'face-down');
    const none = rs.filter((r) => r.object === 'nothing');
    console.log(`\n## ${set}: ${rs.length} non-card boxes (${objs.length} piles/sleeves, ${none.length} with nothing to outline) at threshold ${thr}\n`);
    console.log(
      `  piles/sleeves on the frame: face-down outline ${objs.filter((r) => r.frameDown.length && !r.frameUp.length).length}, face-up outline ${objs.filter((r) => r.frameUp.length).length}, none ${objs.filter((r) => !r.frameUp.length && !r.frameDown.length).length}` +
        `   | in the box's crop: face-down ${objs.filter((r) => r.cropTop?.kind === 'face-down').length}, face-up ${objs.filter((r) => r.cropTop?.kind === 'face-up').length}, none ${objs.filter((r) => !r.cropTop).length}`,
    );
    console.log(
      `  nothing there (mat art, empty zones, UI...): outlined on the frame ${none.filter((r) => r.frameUp.length || r.frameDown.length).length} (face-up ${none.filter((r) => r.frameUp.length).length})` +
        `   | in the box's crop: face-up ${none.filter((r) => r.cropTop?.kind === 'face-up').length}, face-down ${none.filter((r) => r.cropTop?.kind === 'face-down').length}, none ${none.filter((r) => !r.cropTop).length}`,
    );
    console.log(`  mat art as face-up: frame ${rs.filter((r) => r.matArt && r.frameUp.length).length}/${rs.filter((r) => r.matArt).length}, crop ${rs.filter((r) => r.matArt && r.cropTop?.kind === 'face-up').length}/${rs.filter((r) => r.matArt).length}`);
    for (const r of rs.filter((x) => x.frameUp.length || x.cropTop?.kind === 'face-up' || (x.object === 'nothing' && (x.frameDown.length || x.cropTop))))
      console.log(`    ${r.id} (${r.design.slice(0, 60)}): frame up [${r.frameUp.join(', ')}] down [${r.frameDown.join(', ')}], crop ${r.cropTop ? `${r.cropTop.kind} ${r.cropTop.conf}` : '-'}`);
  }
}

async function main() {
  const drawThr = Number(opt('--draw-threshold') ?? 0.4);
  const report: Record<string, unknown> = { model: path.relative(root, modelFile), runtime, threads: threads ?? null, path: searchPath, refine, date: new Date().toISOString() };
  if (!existsSync(modelFile)) throw new Error(`No model at ${modelFile} (see tools/train-detector/README.md)`);
  const det = await createNodeCardDetector({ file: modelFile, runtime, threads });
  const source: Source =
    searchPath === 'tiles'
      ? (() => {
          const tiled = tiledCardDetector(tileModelOf(det), { minConfidence: 0.1 });
          return async (_name, img) => (await tiled.detect(img)).map((c) => ({ ...c, kind: 'face-up' as const, scores: { 'face-up': c.conf, 'face-down': 0 } }));
        })()
      : refine
        ? async (_name, img) =>
            (await det.findCards(img, { minScore: 0.1 })).map((c) => {
              const r = refineCard(img, c);
              return { ...c, pts: r.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as [number, number]), angle: r.angle };
            })
        : (_name, img) => det.findCards(img, { minScore: 0.1 });
  await fullview(source, report, drawThr);
  if (searchPath === 'whole') await realset(det, report, Number(opt('--realset-threshold') ?? drawThr));
  await det.release();
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(report, null, 1));
  console.log(`\nwrote ${path.relative(root, outFile)}${drawPngs ? ` and outlined PNGs in ${path.relative(root, pngDir)}/` : ''}`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
