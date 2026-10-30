// Glare harvest: REAL examples of cards washed out or covered by glare, from duel frames already on this machine
// (read only), for a glare test set (another step labels them; this names no card). Test use only: everything stays
// on this machine under data/debug/glare/harvest/ (data/ is gitignored). It never goes online: frames come from the
// real test sets (data/debug/frames, data/realset2/frames) or from screenshots people send.
//
//   npx tsx tools/glare/harvest.ts --local <dir> --name <group> [--by-video] [--ext png] [--labels set.json,negatives.json]
//       [--every N] [--min-score 0.5] [--threads 4] [--tag name] [--out dir]
//   npx tsx tools/glare/harvest.ts --finalize [--out dir]                  (score every group again, sheets, candidates.jsonl)
//
// Each file in --local <dir> is one "moment", grouped as one video named --name (--by-video: one per YouTube id in the
// file name, as data/realset2's r2-<event>-<id>-t<T>). On each frame:
//   1. the extension's card detector at its native-frame scale (CARD_DETECTOR.frameLongSide): face-up cards at
//      >= minConfidence, whole inside the picture, at least MIN_SIDE px on their short side;
//   2. each card as click to scan reads it on a readable video (src/content/capture.ts cropBest's video branch: its
//      bounds + CROP_MARGIN, the detector's corners as the outline, the click at its centre), straightened as the
//      engine does (straightenOutline, the corners view);
//   3. the real engine (createEngine: default model, its thresholds) on that crop: the answer, top 5, the winning
//      hypothesis and rotation; and the engine with its thresholds off (eval-real --raw's NEVER_DECIDE), whose first
//      card's artwork the glare metrics compare against (tools/glare/metrics.ts), and which shows the labeller the
//      closest cards even when the engine said nothing;
//   4. every card's metrics go to allcards/<group>.jsonl; a card that could be glare (looseCandidate) is saved
//      (crop, card) with a line in videos/<group>.pending.jsonl.
// When a group is done, each pending card is scored against the group's typical card (metrics.ts glareScore,
// videoStats), and kept at --min-score or more unless it is a desk overlay: the same place in the picture read as the
// same first card at 2 other moments or more (booster packs and box art in a sponsor graphic). Kept cards go to
// videos/<group>.jsonl (indexed), the rest to videos/<group>.rejected.jsonl, a contact sheet is drawn, and
// candidates.jsonl is rebuilt from every videos/<group>.jsonl. With --labels (a real set's set.json, and its
// negatives files), a saved card whose outline overlaps a labelled box (polygon IoU >= LABEL_IOU) carries that label
// (card id and name, or the negative's design).
//
// Output (--out, default data/debug/glare/harvest/):
//   candidates.jsonl             every kept card
//   crops/<group>/<id>.png       the crop the engine read (native pixels); <id>-card.png: the card straightened
//   sheets/<group>.jpg           contact sheet: each kept card (crop + straightened card, index, score, the engine's answer)
//   videos/, allcards/, logs/<tag>.log
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';
import { loadCards } from '../realset/lib/cards';
import { CROP_MARGIN, MAX_CROP_SIDE } from '../../src/content/capture';
import { expandRect, type Rect } from '../../src/content/geometry';
import type { OwnCardDetector } from '../../src/offscreen/detector/detector';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine, straightenOutline, type Embedder, type Engine, type UserBox } from '../../src/offscreen/engine';
import { polygonIou, type Point } from '../../src/offscreen/geometry';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel, type EmbeddingModelSpec } from '../../src/shared/models';
import { cropRGBA, resizeRGBA, type RGBAImage } from '../../src/shared/preprocess';
import { CARD_BACK_ID, type Candidate, type RecognitionResult } from '../../src/shared/types';
import { coarseMetrics, glareMetrics, glareScore, looseCandidate, videoStats, type CoarseMetrics, type GlareMetrics } from './metrics';

const ROOT = path.resolve(import.meta.dirname, '../..');
/** Never written (existing test sets). */
const FORBIDDEN = ['data/realset', 'data/realset2', 'data/debug/frames'].map((p) => path.join(ROOT, p));
/** A card's short side must be at least this many frame pixels (smaller ones are mostly blur). */
const MIN_SIDE = 26;
/** A saved card takes a real set's label when its outline overlaps the labelled box this much (polygon IoU). */
const LABEL_IOU = 0.5;
/**
 * Desk overlays (booster packs and box art in a sponsor graphic): the same place (polygon IoU) read as the same first
 * card at this many other moments at least `apart` seconds away (a card in play stays put for one game at most).
 */
const OVERLAY = { iou: 0.6, moments: 2, apart: 2700 };

// ---------- CLI ----------

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(name);

const localDir = arg('--local');
const OUT = path.resolve(ROOT, arg('--out') ?? 'data/debug/glare/harvest');
if (FORBIDDEN.some((f) => OUT === f || OUT.startsWith(f + path.sep))) throw new Error(`--out ${OUT} is inside an existing test set`);
if (!(OUT + path.sep).startsWith(path.join(ROOT, 'data/debug/glare/harvest') + path.sep)) throw new Error(`--out must be under data/debug/glare/harvest (got ${OUT})`);
const minScore = Number(arg('--min-score') ?? 0.5);
/** ONNX Runtime threads for the embedder and the detector. */
const threads = Number(arg('--threads') ?? 4);
const tag = arg('--tag') ?? (flag('--finalize') ? 'finalize' : 'local');

const dirs = {
  videos: path.join(OUT, 'videos'),
  crops: path.join(OUT, 'crops'),
  sheets: path.join(OUT, 'sheets'),
  allcards: path.join(OUT, 'allcards'),
  logs: path.join(OUT, 'logs'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const logFile = path.join(dirs.logs, `${tag}.log`);
function log(msg: string): void {
  const line = `[${new Date().toISOString().slice(0, 19)}] ${msg}`;
  appendFileSync(logFile, line + '\n');
  console.log(line);
}

// ---------- real-set labels (--labels) ----------

interface LabelBox {
  frame: string;
  id: string;
  pts: Point[];
  label: { kind: 'card'; cardId: number | null; name: string; verified?: boolean; source?: string } | { kind: 'negative'; design: string };
}

type Xywh = { x: number; y: number; w: number; h: number };
const rectPts = ({ x, y, w, h }: Xywh): Point[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

/** A set row's box: its oriented box (set.json), else its user box, else a negative's [x, y, w, h]. */
function boxPts(e: { rotatedBox?: { pts: [number, number][] } | null; userBox?: Xywh; box?: number[] }): Point[] | null {
  if (e.rotatedBox?.pts?.length === 4) return e.rotatedBox.pts.map(([x, y]) => ({ x, y }));
  if (e.userBox) return rectPts(e.userBox);
  if (Array.isArray(e.box) && e.box.length === 4) return rectPts({ x: e.box[0], y: e.box[1], w: e.box[2], h: e.box[3] });
  return null;
}

/** Rows of a set.json (cards: cardId, name) or a negatives file (design), by frame. */
function loadLabels(files: string[]): Map<string, LabelBox[]> {
  const byFrame = new Map<string, LabelBox[]>();
  for (const f of files) {
    const rows = JSON.parse(readFileSync(path.resolve(ROOT, f), 'utf8')) as any[];
    for (const e of rows) {
      const pts = boxPts(e);
      if (!pts || !e.frame) continue;
      const label: LabelBox['label'] = 'cardId' in e ? { kind: 'card', cardId: e.cardId, name: e.name, verified: e.verified, source: e.source } : { kind: 'negative', design: String(e.design ?? 'negative') };
      const list = byFrame.get(e.frame) ?? [];
      list.push({ frame: e.frame, id: `${path.basename(path.dirname(path.resolve(ROOT, f)))}/${path.basename(f)}#${e.id}`, pts, label });
      byFrame.set(e.frame, list);
    }
  }
  return byFrame;
}

const labels = arg('--labels') ? loadLabels(arg('--labels')!.split(',')) : null;

/** The labelled box the card's outline overlaps most (polygon IoU >= LABEL_IOU), if any. */
function labelFor(frame: string, pts: [number, number][]) {
  const q = pts.map(([x, y]) => ({ x, y }));
  let best: { box: LabelBox; iou: number } | null = null;
  for (const box of labels?.get(frame) ?? []) {
    const iou = polygonIou(q, box.pts);
    if (iou >= LABEL_IOU && (!best || iou > best.iou)) best = { box, iou };
  }
  return best ? { ...best.box.label, entry: best.box.id, iou: r3(best.iou) } : null;
}

// ---------- the engine, as tools/eval-real.ts builds it ----------

/** tools/eval-real.ts loadIndexFromDisk (itself tools/debug-scan.ts's; copied verbatim). */
async function loadIndexFromDisk(spec: EmbeddingModelSpec): Promise<LoadedIndex> {
  const base = path.join(ROOT, 'extension/data', `index-${spec.id}`);
  let meta: IndexMeta;
  let buf: Buffer;
  try {
    [meta, buf] = await Promise.all([readFile(`${base}.meta.json`, 'utf8').then((s) => JSON.parse(s) as IndexMeta), readFile(`${base}.bin`)]);
  } catch (e) {
    throw new Error(`Could not load ${base}.bin/.meta.json (run "npm run data:index -- --models ${spec.id}"?): ${(e as Error).message}`);
  }
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

interface Models {
  engine: Engine;
  raw: Engine;
  spec: EmbeddingModelSpec;
  detector: OwnCardDetector;
  release(): Promise<void>;
}

async function loadModels(): Promise<Models> {
  const spec = getModel(DEFAULT_MODEL_ID);
  const [node, index, detector] = await Promise.all([createNodeEmbedder(spec, { threads }), loadIndexFromDisk(spec), createNodeCardDetector({ threads })]);
  const embedder: Embedder = { modelId: spec.id, embed: node.embed };
  const inCrop = detector.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const engine = createEngine({ embedder, index, spec, detector: inCrop });
  // eval-real --raw's NEVER_DECIDE: both stages run, and candidates under the floor come back too.
  const raw = createEngine({ embedder, index, spec: { ...spec, thresholds: { score: Infinity, margin: 0, floor: -Infinity } }, detector: inCrop });
  return {
    engine,
    raw,
    spec,
    detector,
    release: async () => {
      await node.release();
      await detector.release();
    },
  };
}

// ---------- the click path's crop (src/content/capture.ts cropBest, video branch) ----------

/** src/content/capture.ts toPixels (private; copied verbatim). */
function toPixels(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** src/content/capture.ts innerBox (private; copied verbatim). */
function innerBox(box: Rect, px: Rect, scale: number, outW: number, outH: number): UserBox {
  const clip = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const x0 = clip((box.x - px.x) * scale, outW);
  const y0 = clip((box.y - px.y) * scale, outH);
  const x1 = clip((box.x + box.w - px.x) * scale, outW);
  const y1 = clip((box.y + box.h - px.y) * scale, outH);
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}

/** The crop the content script sends for a click on a detected card (as tools/overnight/harvest.ts clickCrop), plus the click at its centre. */
function clickCrop(frame: RGBAImage, pts: [number, number][]) {
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: frame.width, h: frame.height });
  const px = toPixels(region);
  const scale = Math.min(1, MAX_CROP_SIDE / Math.max(px.w, px.h));
  const outW = Math.max(1, Math.round(px.w * scale));
  const outH = Math.max(1, Math.round(px.h * scale));
  const cut = cropRGBA(frame, px.x, px.y, px.w, px.h);
  const crop = outW === cut.width && outH === cut.height ? cut : resizeRGBA(cut, outW, outH);
  const outline = pts.map(([x, y]): [number, number] => [r3((x - px.x) * scale), r3((y - px.y) * scale)]);
  const cx = outline.reduce((s, p) => s + p[0], 0) / 4;
  const cy = outline.reduce((s, p) => s + p[1], 0) / 4;
  return { crop, inner: innerBox(box, px, scale, outW, outH), outline, click: [r3(cx), r3(cy)] as [number, number] };
}

// ---------- reading one frame ----------

const cardsData = loadCards();
const nameOf = (id: number) => (id === CARD_BACK_ID ? 'Card back' : (cardsData.byId.get(id)?.name ?? `(unknown card ${id})`));
const top5 = (cs: readonly Candidate[]) => cs.slice(0, 5).map((c) => ({ cardId: c.cardId, imageId: c.imageId, name: nameOf(c.cardId), score: r3(c.score) }));

/** data/artworks/<imageId>.jpg (tools/fetch-artworks.ts), decoded once. */
const ARTWORKS = path.join(ROOT, 'data/artworks');
const artCache = new Map<number, Promise<RGBAImage | null>>();
function artwork(imageId: number): Promise<RGBAImage | null> {
  let p = artCache.get(imageId);
  if (!p) {
    const file = path.join(ARTWORKS, `${imageId}.jpg`);
    p = existsSync(file) ? loadRGBA(file).catch(() => null) : Promise.resolve(null);
    if (artCache.size > 400) artCache.clear();
    artCache.set(imageId, p);
  }
  return p;
}

function engineSummary(r: RecognitionResult) {
  return {
    confident: r.confident,
    answer: r.error ? 'error' : r.confident ? 'confident' : r.candidates.length === 0 ? 'nothing' : r.suggested ? 'suggested' : 'not-sure',
    ...(r.faceDown ? { faceDown: true } : {}),
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.error ? { error: r.error } : {}),
    best: r.best ?? null,
    top5: top5(r.candidates),
    ms: Math.round(r.timings.total ?? 0),
  };
}

interface CardRead {
  k: number;
  pts: [number, number][];
  conf: number;
  shortSide: number;
  crop: RGBAImage;
  card: RGBAImage;
  metrics: GlareMetrics;
  /** Against the raw first card's artwork (null: no artwork, or the card back). */
  coarse: (CoarseMetrics & { imageId: number }) | null;
  engine: ReturnType<typeof engineSummary>;
  raw: { top5: ReturnType<typeof top5>; best: RecognitionResult['best'] | null };
}

interface FrameRead {
  faceUp: number;
  cards: CardRead[];
  skipped: Record<string, number>;
}

const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

async function readFrame(models: Models, img: RGBAImage): Promise<FrameRead> {
  const found = await models.detector.findCards(img, { longSide: CARD_DETECTOR.frameLongSide });
  const faceUp = found.filter((c) => c.kind === 'face-up' && c.conf >= CARD_DETECTOR.minConfidence && Array.isArray(c.pts) && c.pts.length === 4);
  const out: FrameRead = { faceUp: faceUp.length, cards: [], skipped: {} };
  const skip = (why: string) => (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
  for (const [k, d] of faceUp.entries()) {
    const pts = d.pts.map(([x, y]) => [x, y] as [number, number]);
    if (pts.some(([x, y]) => x < -1 || y < -1 || x > img.width + 1 || y > img.height + 1)) {
      skip('cut by the picture edge');
      continue;
    }
    const q = pts.map(([x, y]) => ({ x, y }));
    const shortSide = Math.min(side(q[0], q[1]) + side(q[2], q[3]), side(q[1], q[2]) + side(q[3], q[0])) / 2;
    if (shortSide < MIN_SIDE) {
      skip('too small');
      continue;
    }
    const { crop, inner, outline, click } = clickCrop(img, pts);
    const card = straightenOutline(crop, outline)?.cards[0];
    if (!card) {
      skip('could not straighten');
      continue;
    }
    const result = await models.engine.recognize(crop, inner, outline, click);
    const rawResult = await models.raw.recognize(crop, inner, outline, click);
    const first = rawResult.candidates[0];
    const art = first && first.cardId !== CARD_BACK_ID ? await artwork(first.imageId) : null;
    out.cards.push({
      k,
      pts,
      conf: r3(d.conf),
      shortSide: Math.round(shortSide),
      crop,
      card,
      metrics: glareMetrics(card),
      coarse: art && first ? { imageId: first.imageId, ...coarseMetrics(card, art) } : null,
      engine: engineSummary(result),
      raw: { top5: top5(rawResult.candidates), best: rawResult.best ?? null },
    });
  }
  return out;
}

// ---------- files ----------

const rel = (p: string) => path.relative(OUT, p);

async function writeRGBA(img: RGBAImage, file: string, opts: { jpeg?: number; resize?: { w: number; h: number } } = {}): Promise<void> {
  let s = sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), { raw: { width: img.width, height: img.height, channels: 4 } });
  if (opts.resize) s = s.resize(opts.resize.w, opts.resize.h, { fit: 'fill' });
  await (opts.jpeg ? s.removeAlpha().jpeg({ quality: opts.jpeg }) : s.png()).toFile(file);
}

function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/** Written to a temporary file, then renamed (atomic: another process may read it). */
function writeAtomic(file: string, lines: string[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '');
  renameSync(tmp, file);
}

function rebuildCandidates(): number {
  const lines: string[] = [];
  for (const f of readdirSync(dirs.videos).sort()) {
    if (!f.endsWith('.jsonl') || f.endsWith('.pending.jsonl') || f.endsWith('.rejected.jsonl')) continue;
    lines.push(...readFileSync(path.join(dirs.videos, f), 'utf8').split('\n').filter(Boolean));
  }
  writeAtomic(path.join(OUT, 'candidates.jsonl'), lines);
  return lines.length;
}

// ---------- one frame, one moment ----------

/** A line of allcards/<video>.jsonl: every face-up card read. */
interface AllCardsLine {
  moment: number;
  frame: string;
  t: number | null;
  k: number;
  pts: [number, number][];
  conf: number;
  shortSide: number;
  metrics: GlareMetrics;
  coarse: CardRead['coarse'];
  answer: string;
  rawFirst: { cardId: number; score: number } | null;
}

interface Loose {
  read: CardRead;
  frameKey: string;
  img: RGBAImage;
  t: number | null;
}

async function analyzeFrame(models: Models, vid: string, moment: number, frameKey: string, t: number | null, img: RGBAImage): Promise<{ fr: FrameRead; loose: Loose[] }> {
  const fr = await readFrame(models, img);
  const loose: Loose[] = [];
  const lines: string[] = [];
  for (const c of fr.cards) {
    const line: AllCardsLine = {
      moment,
      frame: frameKey,
      t,
      k: c.k,
      pts: c.pts.map(([x, y]) => [Math.round(x), Math.round(y)]),
      conf: c.conf,
      shortSide: c.shortSide,
      metrics: c.metrics,
      coarse: c.coarse,
      answer: c.engine.answer,
      rawFirst: c.raw.top5[0] ? { cardId: c.raw.top5[0].cardId, score: c.raw.top5[0].score } : null,
    };
    lines.push(JSON.stringify(line));
    if (looseCandidate(c.metrics, c.coarse)) loose.push({ read: c, frameKey, img, t });
  }
  if (lines.length) appendFileSync(path.join(dirs.allcards, `${vid}.jsonl`), lines.join('\n') + '\n');
  return { fr, loose };
}

/** A rough brightness rank before the video's stats are known: the same card on two frames of a moment, once. */
const brightness = (l: Loose) => l.read.metrics.card.p02 + (l.read.coarse && l.read.coarse.darkN >= 4 ? l.read.coarse.darkLift / 2 : 0);

function dedupe(loose: Loose[]): Loose[] {
  const sorted = [...loose].sort((a, b) => brightness(b) - brightness(a));
  const out: Loose[] = [];
  const quad = (l: Loose) => l.read.pts.map(([x, y]) => ({ x, y }));
  for (const l of sorted) {
    if (out.some((o) => o.frameKey !== l.frameKey && polygonIou(quad(o), quad(l)) >= 0.5)) continue;
    out.push(l);
  }
  return out;
}

/** A pending (and, once scored, kept or rejected) card. */
interface PendingLine {
  id: string;
  video: string;
  moment: number;
  event?: string;
  split?: string;
  url?: string;
  t?: number | null;
  frame: string;
  frameSize: { w: number; h: number };
  quality?: string;
  crop: string;
  card: string;
  quad: [number, number][];
  detector: { conf: number; kind: 'face-up' };
  shortSide: number;
  metrics: GlareMetrics;
  coarse: CardRead['coarse'];
  engine: { modelId: string; path: string } & ReturnType<typeof engineSummary>;
  raw: CardRead['raw'];
  /** The real set's label for this card (--labels), or null: none overlaps it. */
  label?: ReturnType<typeof labelFor>;
  at: string;
}

async function savePending(models: Models, moment: number, loose: Loose[], meta: { source?: string; group?: string }): Promise<void> {
  const vid = meta.group ?? 'local';
  mkdirSync(path.join(dirs.crops, vid), { recursive: true });
  for (const l of loose) {
    const id = `${l.frameKey}-c${l.read.k}`;
    const cropFile = path.join(dirs.crops, vid, `${id}.png`);
    const cardFile = path.join(dirs.crops, vid, `${id}-card.png`);
    await writeRGBA(l.read.crop, cropFile);
    await writeRGBA(l.read.card, cardFile, { resize: { w: 295, h: 430 } });
    const line: PendingLine = {
      id,
      video: vid,
      moment,
      frame: meta.source ?? '',
      frameSize: { w: l.img.width, h: l.img.height },
      crop: rel(cropFile),
      card: rel(cardFile),
      quad: l.read.pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
      detector: { conf: l.read.conf, kind: 'face-up' },
      shortSide: l.read.shortSide,
      metrics: l.read.metrics,
      coarse: l.read.coarse,
      engine: { modelId: models.spec.id, path: 'click to scan (outline + centre click, native frame)', ...l.read.engine },
      raw: l.read.raw,
      ...(labels ? { label: labelFor(l.frameKey, l.read.pts) } : {}),
      at: new Date().toISOString(),
    };
    appendFileSync(path.join(dirs.videos, `${vid}.pending.jsonl`), JSON.stringify(line) + '\n');
  }
}

// ---------- scoring a finished video ----------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const CELL = { w: 300, h: 236, img: 200 };

/** A grid of the video's kept cards: the crop the engine read and the straightened card, index, score, the engine's answer. */
async function contactSheet(video: string, title: string, rows: { index: number; crop: string; card: string; glare: { score: number; wash: number; dark: number; patch: number }; engine: { answer: string }; label?: { kind: string } | null }[]): Promise<string | null> {
  const file = path.join(dirs.sheets, `${video}.jpg`);
  if (rows.length === 0) return null;
  const cols = Math.min(6, rows.length);
  const head = 40;
  const W = cols * CELL.w;
  const H = head + Math.ceil(rows.length / cols) * CELL.h;
  const layers: OverlayOptions[] = [];
  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><style>text{font-family:Helvetica,Arial,sans-serif}</style>`;
  svg += `<text x="10" y="27" font-size="20" fill="#fff">${esc(title)}: ${rows.length} kept (glare score &gt;= ${minScore})</text>`;
  for (const [i, row] of rows.entries()) {
    const x = (i % cols) * CELL.w;
    const y = head + Math.floor(i / cols) * CELL.h;
    const cropFile = path.join(OUT, row.crop);
    const cardFile = path.join(OUT, row.card);
    if (existsSync(cropFile)) layers.push({ input: await sharp(cropFile).resize(CELL.img - 50, CELL.img, { fit: 'contain', background: '#202020' }).png().toBuffer(), left: x + 4, top: y + 4 });
    if (existsSync(cardFile)) layers.push({ input: await sharp(cardFile).resize(Math.round(CELL.img * (59 / 86)), CELL.img, { fit: 'fill' }).png().toBuffer(), left: x + CELL.img - 40, top: y + 4 });
    const a = row.engine.answer;
    const color = a === 'confident' ? '#7ee787' : a === 'nothing' ? '#ff7b72' : '#f2cc60';
    const g = row.glare;
    const part = g.wash >= g.dark && g.wash >= g.patch ? 'wash' : g.dark >= g.patch ? 'dark' : 'patch';
    const tag = row.label ? (row.label.kind === 'card' ? ' [labelled]' : ' [negative]') : '';
    svg += `<text x="${x + 6}" y="${y + CELL.img + 22}" font-size="16" fill="#fff">#${row.index}  ${g.score.toFixed(2)} (${part})${tag}</text>`;
    svg += `<text x="${x + CELL.w - 10}" y="${y + CELL.img + 22}" font-size="15" text-anchor="end" fill="${color}">${esc(a)}</text>`;
  }
  svg += '</svg>';
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111' } }).composite(layers).jpeg({ quality: 85 }).toFile(file);
  return file;
}

async function finalizeVideo(vid: string, title: string): Promise<{ kept: number; rejected: number; overlays: number }> {
  const all = readJsonl<AllCardsLine>(path.join(dirs.allcards, `${vid}.jsonl`));
  const pending = readJsonl<PendingLine>(path.join(dirs.videos, `${vid}.pending.jsonl`));
  const stats = videoStats(all);
  const quadOf = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));
  const kept: object[] = [];
  const rejected: string[] = [];
  let overlays = 0;
  const seen = new Set<string>();
  for (const p of pending) {
    if (seen.has(p.id)) continue; // a moment captured twice (a rerun after a crash)
    seen.add(p.id);
    const glare = glareScore(p.metrics, p.coarse, stats);
    // A desk overlay: the same place, read as the same first card, at OVERLAY.moments other moments or more, far apart.
    const first = p.raw.top5[0]?.cardId;
    const q = quadOf(p.quad);
    const elsewhere = new Set(
      all
        .filter((c) => Math.abs(c.moment - p.moment) >= OVERLAY.apart && first !== undefined && c.rawFirst?.cardId === first && polygonIou(quadOf(c.pts), q) >= OVERLAY.iou)
        .map((c) => c.moment),
    );
    const overlay = elsewhere.size >= OVERLAY.moments;
    const line = { ...p, glare: { ...glare, video: stats, ...(overlay ? { overlay: elsewhere.size } : {}) } };
    if (glare.score >= minScore && !overlay) kept.push(line);
    else {
      if (glare.score >= minScore) overlays++;
      rejected.push(JSON.stringify(line));
    }
  }
  const indexed = kept.map((l, index) => ({ index, ...l }) as PendingLine & { index: number; glare: ReturnType<typeof glareScore> });
  writeAtomic(path.join(dirs.videos, `${vid}.jsonl`), indexed.map((l) => JSON.stringify(l)));
  writeAtomic(path.join(dirs.videos, `${vid}.rejected.jsonl`), rejected);
  await contactSheet(vid, title, indexed);
  return { kept: indexed.length, rejected: rejected.length, overlays };
}
// ---------- local frames (calibration, read only) ----------

async function runLocal(models: Models, dir: string): Promise<void> {
  const every = Number(arg('--every') ?? 1);
  const ext = arg('--ext');
  const name = arg('--name') ?? 'local';
  const files = readdirSync(dir)
    .filter((f) => (ext ? f.toLowerCase().endsWith(`.${ext}`) : /\.(png|jpe?g)$/i.test(f)))
    .sort()
    .filter((_, i) => i % every === 0);
  log(`glare scoring on ${files.length} local frame(s) in ${path.relative(ROOT, dir)} (read only), as "${name}"${flag('--by-video') ? ' by video' : ''}${labels ? `, labels from ${arg('--labels')}` : ''}`);
  const groups = new Set<string>();
  let n = 0;
  for (const [i, f] of files.entries()) {
    const key = f.replace(/\.[^.]+$/, '');
    const yt = flag('--by-video') ? /-([A-Za-z0-9_-]{11})-t\d+$/.exec(key)?.[1] : undefined;
    const group = yt ? `${name}-${yt}` : name;
    groups.add(group);
    // The frame's video time when its name has one (r2-...-t11685, native-t5200-top): the overlay check's moment.
    const t = Number(/-t(\d+)(?:-|$)/.exec(key)?.[1] ?? NaN);
    const moment = Number.isFinite(t) ? t : 1e7 + i * 1e5;
    const img = await loadRGBA(path.join(dir, f));
    const { fr, loose } = await analyzeFrame(models, group, moment, key, Number.isFinite(t) ? t : null, img);
    n += fr.cards.length;
    await savePending(models, moment, dedupe(loose), { source: path.relative(ROOT, path.join(dir, f)), group });
  }
  let kept = 0;
  for (const g of groups) {
    const r = await finalizeVideo(g, `${g} (local frames, ${path.relative(ROOT, dir)})`);
    kept += r.kept;
    log(`${g}: ${r.kept} kept, ${r.rejected} rejected (${r.overlays} as desk overlays)`);
  }
  log(`done: ${files.length} frames, ${n} face-up cards read, ${kept} kept; candidates.jsonl now ${rebuildCandidates()}`);
}

async function main() {
  if (flag('--finalize')) {
    for (const f of readdirSync(dirs.videos).filter((f) => f.endsWith('.pending.jsonl'))) {
      const vid = f.replace(/\.pending\.jsonl$/, '');
      const r = await finalizeVideo(vid, vid);
      log(`${vid}: ${r.kept} kept, ${r.rejected} rejected (${r.overlays} as desk overlays)`);
    }
    log(`candidates.jsonl: ${rebuildCandidates()} lines`);
    return;
  }
  if (!localDir) throw new Error('usage: --local <dir> --name <group> (frames on this machine), or --finalize');
  const models = await loadModels();
  try {
    await runLocal(models, path.resolve(ROOT, localDir));
  } finally {
    await models.release();
  }
}

main().catch((e) => {
  log(`FAILED: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
