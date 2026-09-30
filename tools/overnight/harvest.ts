// Overnight harvest (overnight-plan.md P2): card crops and pseudo-labels from TRAIN duel videos, CARDS ONLY.
//
//   npx tsx tools/overnight/harvest.ts --group N [--until HH:MM] [--moments-per-video K]
//       [--video id] [--max-moments N] [--engine-frames N] [--facedown-keep S] [--threads T]
//       [--order interleave|sequential] [--min-free-gb G] [--margin M] [--no-pipeline] [--headful] [--tag name] [--out dir]
//
// For every moment (K per video, spread from 5% to 95% of it, jittered; visited round-robin over the group's
// videos, each video's in a spread order, so a run stopped early still covers every video):
//   1. load the watch page at t (one page load per moment: an automated browser gets only ~20 s of video per
//      load), force hd1080 when offered (else the best under it), and record what was served;
//   2. grab 5 native frames at t … t+4 s (canvas, in memory only), running the card detector on each; a moment
//      whose first frame has fewer than 2 face-up cards (desk, talking heads, break screens) is skipped there;
//   3. tracks: the same card over the frames when its outlines overlap with polygon IoU ≥ 0.5 (kinds never mix);
//   4. the extension's engine (default model, thresholds, decide(), the click path: the crop the content script
//      cuts around a clicked card, with the detector's corners as the outline) reads each track's frames;
//   5. a track is labelled when ≥ 2 of its readings are confident on the same card and none confident on
//      another: 'confident' frames and 'propagated' ones; otherwise 'none', with the top 5 kept for P3;
//   6. every face-up detection is cut from its 4 corners with at most a 4% margin, straightened upright (warpQuad;
//      the way up from the track's readings) to 176×256, JPEG q90. Face-down tracks are read with the engine's
//      thresholds off (raw scores, as eval-real --raw) and kept only as possible overframe FRONTS, never labelled:
//      the detector unsure (FACE_DOWN_UNSURE), the first candidate a real card (not the card back) scoring
//      ≥ --facedown-keep, and no card of its top 3 shared with another face-down track of the moment or of the
//      video's other moments (a sleeve design repeats). Card backs, sleeves and the mat's zone art (which the
//      detector also calls face-down) are not saved. An unlabelled face-up track that the engine reads as nothing
//      gets one raw reading too (rawTop5), so P3 has candidates to check.
// FRAMES ARE NEVER WRITTEN: they are dropped once the crops are cut (no faces, table, overlays or logos saved).
// Only videos whose split is 'train' in data/overnight/videos.json are ever opened.
//
// Output: data/overnight/crops/<video>/m<t>-t<track>-f<frame>.jpg; data/overnight/labels/<video>.jsonl (one line
// per crop) and <video>.moments.jsonl (one line per moment, for resuming); data/overnight/harvest-<tag>.log and
// harvest-<tag>-summary.json (tag: the group number unless --tag). README.md next to this file.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { puppeteer, sleep, type Browser, type Page } from '../live-check/lib/harness';
import { BotCheck, forceQuality, grabFrame, openVideo, QUALITY_LABEL, seekAndPause, seekAtQuality } from '../live-check/lib/youtube';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';
import { loadCards } from '../realset/lib/cards';
import { CROP_MARGIN, MAX_CROP_SIDE } from '../../src/content/capture';
import { expandRect, type Rect } from '../../src/content/geometry';
import type { OwnCardDetector } from '../../src/offscreen/detector/detector';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine, type Embedder, type Engine, type UserBox } from '../../src/offscreen/engine';
import { warpQuad, type Quad } from '../../src/offscreen/geometry';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel, type EmbeddingModelSpec } from '../../src/shared/models';
import { decide } from '../../src/shared/search';
import { cropRGBA, resizeRGBA, type RGBAImage } from '../../src/shared/preprocess';
import { CARD_BACK_ID, type RecognitionResult } from '../../src/shared/types';
import {
  buildTracks,
  cardCorners,
  grownQuad,
  labelTrack,
  momentTimes,
  nextClock,
  orient,
  quadOf,
  readUpsideDown,
  spreadOrder,
  trackUp,
  upOf,
  type Det,
  type Reading,
  type Source,
  type UpVote,
} from './lib/tracks';

const ROOT = path.resolve(import.meta.dirname, '../..');
const MANIFEST = path.join(ROOT, 'data/overnight/videos.json');
/** Where crops, labels, the log and the summary go (--out; data/overnight by default). */
let OUT = path.join(ROOT, 'data/overnight');

/** Frames per moment, one second apart. */
const FRAMES = 5;
/** The saved crop: portrait, about 256 px on the long side, the card's aspect (59:86). */
const CROP_W = 176;
const CROP_H = 256;
const JPEG_QUALITY = 90;
/** A moment needs this many face-up cards on its first frame (fewer: a desk or a talking head). */
const MIN_FACE_UP = 2;
/**
 * A face-down track is a possible overframe FRONT only while the detector is unsure of it: the median of its
 * face-down confidences in [0.5, 0.72). The user's overframe Magician (data/debug/overframe, 12 frames) came at
 * 0.63–0.68; sleeves and card backs mostly at 0.75–0.96; the playmat's art near the 0.4 floor.
 */
const FACE_DOWN_UNSURE: [number, number] = [0.5, 0.72];

// ---------- CLI ----------

interface Args {
  group: number;
  until: Date | null;
  k: number;
  video: string | null;
  maxMoments: number;
  engineFrames: number;
  facedownKeep: number;
  threads: number;
  order: 'interleave' | 'sequential';
  minFreeGb: number;
  margin: number;
  pipeline: boolean;
  headful: boolean;
  tag: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
  };
  const int = (name: string, dflt: number, min: number, max = Infinity) => {
    const raw = value(name);
    const n = raw === undefined ? dflt : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} needs a whole number from ${min}${max < Infinity ? ` to ${max}` : ''}, got "${raw}"`);
    return n;
  };
  const groupRaw = value('--group');
  if (groupRaw === undefined) throw new Error('--group N is required (data/overnight/videos.json harvestGroup)');
  const group = Number(groupRaw);
  if (!Number.isInteger(group) || group < 1) throw new Error(`--group needs a positive whole number, got "${groupRaw}"`);
  const order = (value('--order') ?? 'interleave') as Args['order'];
  if (order !== 'interleave' && order !== 'sequential') throw new Error('--order is interleave or sequential');
  const margin = Number(value('--margin') ?? 0.04);
  if (!(margin >= 0 && margin <= 0.04)) throw new Error('--margin is at most 0.04 (4% per side: CARDS ONLY)');
  const minFreeGb = Number(value('--min-free-gb') ?? 20);
  if (!(minFreeGb >= 20)) throw new Error('--min-free-gb is at least 20 (the overnight plan\'s hard stop)');
  const until = value('--until');
  if (!(Number(value('--facedown-keep') ?? 0.55) >= 0)) throw new Error('--facedown-keep needs a score (0-1; above 1 keeps no face-down box)');
  return {
    group,
    until: until ? nextClock(until) : null,
    k: int('--moments-per-video', 60, 1, 2000),
    video: value('--video') ?? null,
    maxMoments: int('--max-moments', 1_000_000, 1),
    engineFrames: int('--engine-frames', FRAMES, 0, FRAMES),
    facedownKeep: Number(value('--facedown-keep') ?? 0.55),
    threads: int('--threads', 3, 1, 16),
    order,
    minFreeGb,
    margin,
    pipeline: !argv.includes('--no-pipeline'),
    headful: argv.includes('--headful'),
    tag: value('--tag') ?? String(group),
    out: path.resolve(ROOT, value('--out') ?? 'data/overnight'),
  };
}

// ---------- the manifest ----------

interface VideoEntry {
  id: string;
  hours: number;
  event: string;
  split: string;
  harvestGroup?: number;
}

/** Throws unless `v` is a TRAIN video: nothing is ever taken from a held-out one. */
function assertTrain(v: VideoEntry): void {
  if (v.split !== 'train') throw new Error(`REFUSED: video ${v.id} (${v.event}) has split "${v.split}", not "train"; nothing is harvested from held-out videos`);
}

function loadVideos(args: Args): VideoEntry[] {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { videos: VideoEntry[] };
  if (args.video) {
    const v = manifest.videos.find((x) => x.id === args.video);
    if (!v) throw new Error(`--video ${args.video} is not in ${path.relative(ROOT, MANIFEST)}`);
    assertTrain(v);
    if (v.harvestGroup !== args.group) throw new Error(`--video ${v.id} is in harvest group ${v.harvestGroup ?? 'none'}, not ${args.group}`);
    return [v];
  }
  const group = manifest.videos.filter((v) => v.harvestGroup === args.group);
  const refused = group.filter((v) => v.split !== 'train');
  if (refused.length > 0) throw new Error(`REFUSED: group ${args.group} lists non-train videos (${refused.map((v) => `${v.id}: ${v.split}`).join(', ')}); fix videos.json`);
  if (group.length === 0) throw new Error(`no videos in harvest group ${args.group}`);
  return group;
}

// ---------- output, log, resume ----------

const cropsDir = (video: string) => path.join(OUT, 'crops', video);
const labelsFile = (video: string) => path.join(OUT, 'labels', `${video}.jsonl`);
const momentsFile = (video: string) => path.join(OUT, 'labels', `${video}.moments.jsonl`);
const cropName = (t: number, track: number, frame: number) => `m${String(t).padStart(6, '0')}-t${String(track).padStart(2, '0')}-f${frame}.jpg`;

let logFile = '';
function log(msg: string): void {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const line = `[${local}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(logFile, `${line}\n`);
  } catch {
    // the log is best effort
  }
}

const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as T];
          } catch {
            return [];
          }
        })
    : [];

interface MomentRecord {
  video: string;
  t: number;
  status: 'done' | 'skipped' | 'error';
  reason?: string;
  error?: string;
  faceUp0?: number;
  frames?: number;
  tracks?: number;
  labelledTracks?: number;
  crops?: number;
  quality?: QualityRecord;
  secs?: { capture: number; analyze: number; total: number };
  readings?: number;
  faceDown?: { kept: number; dropped: number; front: number[]; seen?: number[] };
  at: string;
}

interface LabelLine {
  video: string;
  moment: number;
  t: number;
  frame: number;
  track: number;
  kind: string;
  cardId: number | null;
  source: Source;
  decision: string;
}

/** Free space on the data volume, GB (what df reports as available). */
function freeGb(): number {
  const s = statfsSync(OUT);
  return (Number(s.bavail) * Number(s.bsize)) / 1e9;
}

// ---------- the engine, as eval-real.ts builds it ----------

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
  /** The same engine with thresholds that never decide (eval-real --raw's NEVER_DECIDE): both stages, candidates under the floor too. */
  raw: Engine;
  spec: EmbeddingModelSpec;
  detector: OwnCardDetector;
  release(): Promise<void>;
}

async function loadModels(threads: number): Promise<Models> {
  const spec = getModel(DEFAULT_MODEL_ID);
  const [node, index, detector] = await Promise.all([createNodeEmbedder(spec, { threads }), loadIndexFromDisk(spec), createNodeCardDetector({ threads })]);
  const embedder: Embedder = { modelId: spec.id, embed: node.embed };
  // The extension's engine with the detector it registers (src/offscreen/index.ts): click-path reads take the
  // outline and never search the crop, but a pick that can't be straightened and the rescue path still use it.
  const inCrop = detector.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });
  const engine = createEngine({ embedder, index, spec, detector: inCrop });
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

// ---------- the click path's crop (src/content/capture.ts cropDetectedCard on a readable video frame) ----------

/** src/content/capture.ts toPixels (private; copied verbatim): whole source pixels covering `r`. */
function toPixels(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** src/content/capture.ts innerBox (private; copied verbatim): the box inside the crop, in crop pixels. */
function innerBox(box: Rect, px: Rect, scale: number, outW: number, outH: number): UserBox {
  const clip = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const x0 = clip((box.x - px.x) * scale, outW);
  const y0 = clip((box.y - px.y) * scale, outH);
  const x1 = clip((box.x + box.w - px.x) * scale, outW);
  const y1 = clip((box.y + box.h - px.y) * scale, outH);
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}

/**
 * What the content script sends for a click on a detected card (cropBest's video branch): the card's bounds
 * plus CROP_MARGIN, clipped to the frame, downscaled past MAX_CROP_SIDE, with the card's corners as the outline.
 */
function clickCrop(frame: RGBAImage, pts: [number, number][]): { crop: RGBAImage; inner: UserBox; outline: [number, number][] } {
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
  return { crop, inner: innerBox(box, px, scale, outW, outH), outline };
}

// ---------- capture (the browser) ----------

interface QualityRecord {
  requested: string;
  served: string;
  w: number;
  h: number;
  auto: string;
}

interface CapFrame {
  t: number;
  img: RGBAImage;
  dets: Det[];
}

type Captured =
  | { status: 'captured'; video: VideoEntry; t: number; frames: CapFrame[]; quality: QualityRecord; secs: number; faceUp0: number }
  | { status: 'skipped'; video: VideoEntry; t: number; reason: string; quality?: QualityRecord; secs: number; faceUp0?: number }
  | { status: 'error'; video: VideoEntry; t: number; error: string; bot: boolean; fatal: boolean; secs: number };

const HEIGHT_OF: Record<string, number> = Object.fromEntries(Object.entries(QUALITY_LABEL).map(([h, label]) => [label, Number(h)]));

/** 1080 when offered, else the tallest offered under it (1080 when the list is empty or unreadable). */
function targetHeight(available: string[]): number {
  const heights = available.map((l) => HEIGHT_OF[l]).filter((h): h is number => Number.isFinite(h));
  if (heights.includes(1080)) return 1080;
  const under = heights.filter((h) => h < 1080);
  return under.length > 0 ? Math.max(...under) : 1080;
}

/** Errors after which the page (or the browser) is not worth another moment. */
const fatalError = (e: unknown) => /Target closed|Session closed|Protocol error|detached|Connection closed|browser has disconnected|Navigating frame was detached/i.test(String((e as Error)?.message ?? e));

class Browsing {
  browser: Browser | null = null;
  page: Page | null = null;
  momentsOnPage = 0;

  constructor(private readonly headful: boolean) {}

  async ensure(): Promise<Page> {
    if (this.browser && !this.browser.connected) await this.close();
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: !this.headful,
        pipe: true,
        protocolTimeout: 120000,
        defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
        // --disable-audio-output: without an audio sink the media clock never starts in an automated browser.
        // Small caches: YouTube's segments would otherwise fill the temporary profile.
        args: [
          '--window-size=1600,900',
          '--no-first-run',
          '--lang=en-US',
          '--autoplay-policy=no-user-gesture-required',
          '--disable-audio-output',
          '--mute-audio',
          '--disk-cache-size=67108864',
          '--media-cache-size=67108864',
        ],
      });
      log(`browser up: ${await this.browser.version()}`);
    }
    // A fresh page now and then (YouTube's page is a long-lived app).
    if (this.page && this.momentsOnPage >= 40) {
      await this.page.close().catch(() => {});
      this.page = null;
    }
    if (!this.page || this.page.isClosed()) {
      this.page = await this.browser.newPage();
      this.momentsOnPage = 0;
      // Only this page may be open: a background tab never loads its video.
      for (const p of await this.browser.pages()) if (p !== this.page) await p.close().catch(() => {});
    }
    this.momentsOnPage++;
    return this.page;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    this.page = null;
    if (b) await b.close().catch(() => {});
  }
}

async function grabAndDetect(page: Page, detector: OwnCardDetector, t: number): Promise<CapFrame> {
  const img = await loadRGBA(await grabFrame(page));
  const cards = await detector.findCards(img);
  const dets: Det[] = cards
    .filter((c) => c.conf >= CARD_DETECTOR.minConfidence && Array.isArray(c.pts) && c.pts.length === 4)
    .map((c) => ({ kind: c.kind, conf: c.conf, pts: c.pts.map(([x, y]) => [x, y] as [number, number]) }));
  return { t: Math.round(t * 100) / 100, img, dets };
}

async function capture(browsing: Browsing, detector: OwnCardDetector, video: VideoEntry, t: number): Promise<Captured> {
  const started = performance.now();
  const secs = () => Math.round(performance.now() - started) / 1000;
  const vlog = (m: string) => log(`  ${video.id}@${t}: ${m}`);
  try {
    assertTrain(video);
    const page = await browsing.ensure();
    const auto = await openVideo(page, video.id, t, vlog);
    const duration = Number(await page.evaluate(`(() => { try { return document.getElementById('movie_player').getDuration() || 0; } catch (e) { return 0; } })()`));
    if (duration > 0 && t + FRAMES > duration - 3) return { status: 'skipped', video, t, reason: `past the end (${Math.round(duration)} s)`, secs: secs() };
    const offered = await forceQuality(page, 'hd1080');
    const height = targetHeight(offered.available);
    const { seek, quality } = await seekAtQuality(page, t, height, vlog);
    if (seek.hung || !seek.videoWidth) throw new Error(`the seek to ${t} s never finished (readyState ${seek.readyState})`);
    const q: QualityRecord = {
      requested: quality.requested,
      served: seek.quality,
      w: seek.videoWidth,
      h: seek.videoHeight,
      auto: `${auto.autoHeight}p`,
    };
    const first = await grabAndDetect(page, detector, seek.currentTime);
    const faceUp0 = first.dets.filter((d) => d.kind === 'face-up').length;
    if (faceUp0 < MIN_FACE_UP) return { status: 'skipped', video, t, reason: `${faceUp0} face-up card(s) on the first frame`, quality: q, secs: secs(), faceUp0 };
    const frames = [first];
    for (let i = 1; i < FRAMES; i++) {
      const s = await seekAndPause(page, t + i);
      if (s.hung || !s.videoWidth) {
        vlog(`the seek to +${i} s hung; keeping ${frames.length} frame(s)`);
        break;
      }
      if (s.videoHeight !== seek.videoHeight) {
        // Tracks compare outlines in frame pixels: one scale per moment.
        vlog(`the quality changed to ${s.videoHeight}p at +${i} s; keeping ${frames.length} frame(s)`);
        break;
      }
      frames.push(await grabAndDetect(page, detector, s.currentTime));
    }
    return { status: 'captured', video, t, frames, quality: q, secs: secs(), faceUp0 };
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    return { status: 'error', video, t, error: message, bot: e instanceof BotCheck, fatal: fatalError(e), secs: secs() };
  }
}

// ---------- analysis (Node: the engine, tracks, labels, crops) ----------

interface Read {
  reading: Reading;
  result: RecognitionResult;
  /** Read with the thresholds off (the decision is decide() on its raw candidates). */
  raw: boolean;
}

/** A raw reading's decision: decide() with the model's thresholds on its candidates. */
function rawDecisionOf(r: RecognitionResult, spec: EmbeddingModelSpec): string {
  if (r.error) return 'error';
  if (r.candidates.length === 0) return 'nothing';
  const back = r.candidates[0].cardId === CARD_BACK_ID;
  const d = decide(r.candidates, spec.thresholds);
  if (d.nothing) return back ? 'below-floor-back' : 'below-floor';
  if (d.confident) return back ? 'confident-back' : 'confident';
  return back ? 'unsure-back' : 'unsure';
}

function decisionOf(r: RecognitionResult | undefined): string {
  if (!r) return 'not-run';
  if (r.error) return 'error';
  if (r.candidates.length === 0) return 'nothing';
  if (r.confident) return r.faceDown ? 'confident-back' : 'confident';
  if (r.suggested) return 'suggested';
  if (r.countBadge) return 'badge';
  return r.faceDown ? 'unsure-back' : 'unsure';
}

/** Up to `n` of `count` members, spread (first, last, then the middle ones). */
function spreadPick(count: number, n: number): number[] {
  if (n >= count) return Array.from({ length: count }, (_, i) => i);
  if (n <= 0) return [];
  if (n === 1) return [0];
  const out = new Set<number>();
  for (let i = 0; i < n; i++) out.add(Math.round((i * (count - 1)) / (n - 1)));
  return [...out].sort((a, b) => a - b);
}

interface Analysis {
  lines: object[];
  files: string[];
  tracks: number;
  labelledTracks: number;
  readings: number;
  engineMs: number;
  /** Face-down tracks kept (possible overframe fronts) and dropped (card backs, sleeves, the mat's zones). */
  faceDownKept: number;
  faceDownDropped: number;
  /** Each face-down track's best non-back raw score (to tune --facedown-keep). */
  faceDownFront: number[];
  /** The cards in this moment's face-down tracks' raw top 3 (the sleeve memory's entry). */
  faceDownSeen: number[];
}

/**
 * Per video: the cards in the raw top 3 of its face-down tracks, by moment. Sleeve designs recur across a video's
 * moments (event-issued sleeves, the same players), overframe fronts don't; resumed runs rebuild it from the
 * moments file (MomentRecord.faceDown.seen).
 */
type SleeveMemory = Map<number, Set<number>>;

async function analyze(
  models: Models,
  cap: Extract<Captured, { status: 'captured' }>,
  args: Args,
  names: Map<number, string>,
  sleeves: SleeveMemory,
): Promise<Analysis> {
  const { frames, video, t } = cap;
  const tracks = buildTracks(frames.map((f) => f.dets), 0.5);
  const dir = cropsDir(video.id);
  mkdirSync(dir, { recursive: true });
  const out: Analysis = { lines: [], files: [], tracks: tracks.length, labelledTracks: 0, readings: 0, engineMs: 0, faceDownKept: 0, faceDownDropped: 0, faceDownFront: [], faceDownSeen: [] };

  const read = async (frame: number, det: number, raw = false): Promise<Read> => {
    const { crop, inner, outline } = clickCrop(frames[frame].img, frames[frame].dets[det].pts);
    const result = await (raw ? models.raw : models.engine).recognize(crop, inner, outline);
    out.readings++;
    out.engineMs += result.timings.total ?? 0;
    const confident = !result.error && (raw ? rawDecisionOf(result, models.spec).startsWith('confident') : result.confident);
    return { reading: { confident, top: result.candidates[0]?.cardId ?? null }, result, raw };
  };
  const round4 = (v: number) => Math.round(v * 10000) / 10000;
  const top5Of = (r: RecognitionResult | undefined) => (r ? r.candidates.slice(0, 5).map((c) => ({ cardId: c.cardId, score: round4(c.score) })) : []);

  // Face-down tracks: possible overframe FRONTS only. Each one's middle frame is read raw first; a track is kept when
  // the detector is unsure it is face-down (FACE_DOWN_UNSURE), its first candidate is a real card (not the card back)
  // scoring ≥ --facedown-keep, and its top 3 shares no card
  // with another face-down track's, in this moment or in the video's other moments (the sleeve memory): a sleeve's
  // design shows on several face-down cards (the set cards, the deck, the extra deck; upright and upside down) and
  // again moment after moment; an overframe front is one of a kind.
  const middleOf = (track: (typeof tracks)[number]) => Math.floor((track.members.length - 1) / 2);
  const firstRead = new Map<number, Read>();
  for (const track of tracks) {
    if (track.kind !== 'face-down') continue;
    const m = track.members[middleOf(track)];
    firstRead.set(track.id, await read(m.frame, m.det, true));
  }
  const top3 = new Map([...firstRead].map(([id, r]) => [id, new Set(r.result.candidates.slice(0, 3).map((c) => c.cardId).filter((c) => c !== CARD_BACK_ID))]));
  const keepFaceDown = (track: (typeof tracks)[number]): boolean => {
    const id = track.id;
    const r = firstRead.get(id)!;
    const top = r.result.candidates[0];
    out.faceDownFront.push(round4(r.result.candidates.find((c) => c.cardId !== CARD_BACK_ID)?.score ?? 0));
    const confs = track.members.map((m) => frames[m.frame].dets[m.det].conf).sort((a, b) => a - b);
    const conf = confs[Math.floor((confs.length - 1) / 2)];
    if (!(conf >= FACE_DOWN_UNSURE[0] && conf < FACE_DOWN_UNSURE[1])) return false;
    if (!top || top.cardId === CARD_BACK_ID || top.score < args.facedownKeep) return false;
    const mine = top3.get(id)!;
    for (const [other, theirs] of top3) if (other !== id && [...mine].some((c) => theirs.has(c))) return false;
    for (const [moment, seen] of sleeves) if (moment !== t && [...mine].some((c) => seen.has(c))) return false;
    return true;
  };
  const seenNow = new Set<number>();
  for (const ids of top3.values()) for (const c of ids) seenNow.add(c);
  out.faceDownSeen = [...seenNow];

  for (const track of tracks) {
    const members = track.members;
    const middle = middleOf(track);
    // Not `new Array(n)`: its holes would be skipped by map().
    const reads: (Read | undefined)[] = Array.from({ length: members.length }, () => undefined);
    if (track.kind === 'face-down') {
      if (!keepFaceDown(track)) {
        out.faceDownDropped++;
        continue;
      }
      out.faceDownKept++;
      reads[middle] = firstRead.get(track.id)!;
      for (let i = 0; i < members.length; i++) if (!reads[i]) reads[i] = await read(members[i].frame, members[i].det, true);
    } else {
      for (const i of spreadPick(members.length, args.engineFrames)) reads[i] = await read(members[i].frame, members[i].det);
    }
    let label = labelTrack(reads.map((r) => r?.reading));
    // A subset that already reads one frame confidently: read the rest too, so the track can still be labelled.
    if (label.cardId === null && reads.some((r) => r?.reading.confident)) {
      for (let i = 0; i < members.length; i++) if (!reads[i]) reads[i] = await read(members[i].frame, members[i].det, track.kind === 'face-down');
      label = labelTrack(reads.map((r) => r?.reading));
    }
    // Face-down tracks are never labelled here: their raw readings leave the card back out of decide()'s list (looser
    // than the product), so they stay candidates for the checkers (P3), with each frame's raw top 5.
    if (track.kind === 'face-down') label = { cardId: null, sources: members.map((): Source => 'none') };
    if (label.cardId !== null) out.labelledTracks++;
    // An unlabelled face-up track the engine read as nothing: one raw reading, so the checkers have candidates.
    let rawTop5: { cardId: number; score: number }[] | null = null;
    if (label.cardId === null && track.kind === 'face-up' && !reads.some((r) => r && r.result.candidates.length > 0)) {
      const extra = await read(members[middle].frame, members[middle].det, true);
      rawTop5 = top5Of(extra.result);
      if (!reads[middle]) reads[middle] = extra;
    }

    // Which way up: the readings of the label (or, unlabelled, every reading), each weighted by its score.
    const corners = members.map((m) => cardCorners(quadOf(frames[m.frame].dets[m.det].pts)));
    const votes: UpVote[] = [];
    reads.forEach((r, i) => {
      const top = r?.result.candidates[0];
      if (!r || !top || (label.cardId !== null && top.cardId !== label.cardId)) return;
      const upside = readUpsideDown(corners[i], r.result.best);
      if (upside === null) return;
      const u = upOf(corners[i]);
      votes.push({ up: upside ? { x: -u.x, y: -u.y } : u, weight: Math.max(0.01, top.score) });
    });
    const up = trackUp(votes);

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const f = frames[m.frame];
      const det = f.dets[m.det];
      const q = orient(corners[i], up);
      const warped = warpQuad(f.img, grownQuad(q, 1 + 2 * args.margin), 2 * CROP_W, 2 * CROP_H);
      if (!warped) continue;
      const jpeg = await sharp(Buffer.from(warped.data.buffer, warped.data.byteOffset, warped.data.byteLength), { raw: { width: 2 * CROP_W, height: 2 * CROP_H, channels: 4 } })
        .removeAlpha()
        .resize(CROP_W, CROP_H, { fit: 'fill' })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      const name = cropName(t, track.id, m.frame);
      const file = path.join(dir, name);
      await writeFile(file, jpeg);
      out.files.push(file);
      const side = (a: number, b: number) => Math.hypot(q[b].x - q[a].x, q[b].y - q[a].y);
      const w = (side(0, 1) + side(3, 2)) / 2;
      const h = (side(0, 3) + side(1, 2)) / 2;
      const r = reads[i]?.result;
      const r1 = (v: number) => Math.round(v * 10) / 10;
      out.lines.push({
        video: video.id,
        moment: t,
        t: f.t,
        frame: m.frame,
        track: track.id,
        kind: det.kind,
        conf: det.conf,
        // The card's top-left, top-right, bottom-right and bottom-left in the frame, as cut (before the margin).
        corners: q.map((p) => [r1(p.x), r1(p.y)]),
        px: [Math.round(Math.min(w, h)), Math.round(Math.max(w, h))],
        file: path.relative(ROOT, file),
        cardId: label.cardId,
        name: label.cardId === null ? null : (names.get(label.cardId) ?? null),
        source: label.sources[i],
        decision: reads[i]?.raw ? rawDecisionOf(r!, models.spec) : decisionOf(r),
        top5: top5Of(r),
        ...(reads[i]?.raw ? { raw: true } : {}),
        ...(rawTop5 ? { rawTop5 } : {}),
        quality: { served: cap.quality.served, w: f.img.width, h: f.img.height },
        orientation: up ? 'engine' : 'unknown',
      });
    }
  }
  if (seenNow.size > 0) sleeves.set(t, seenNow);
  return out;
}

// ---------- totals and the summary ----------

interface Counts {
  moments: { done: number; skipped: number; error: number };
  tracks: { total: number; labelled: number; byKind: Record<string, { total: number; labelled: number }> };
  crops: { total: number; bySource: Record<string, number>; byKind: Record<string, number>; bySourceKind: Record<string, number>; labelledCards: number };
  perVideo: Record<string, { event: string; done: number; skipped: number; error: number; crops: number; labelled: number }>;
}

function emptyCounts(): Counts {
  return {
    moments: { done: 0, skipped: 0, error: 0 },
    tracks: { total: 0, labelled: 0, byKind: {} },
    crops: { total: 0, bySource: { confident: 0, propagated: 0, none: 0 }, byKind: {}, bySourceKind: {}, labelledCards: 0 },
    perVideo: {},
  };
}

function addLines(c: Counts, video: VideoEntry, lines: LabelLine[]): void {
  const pv = (c.perVideo[video.id] ??= { event: video.event, done: 0, skipped: 0, error: 0, crops: 0, labelled: 0 });
  const tracks = new Map<string, { kind: string; labelled: boolean }>();
  const cards = new Set<number>();
  for (const l of lines) {
    c.crops.total++;
    pv.crops++;
    c.crops.bySource[l.source] = (c.crops.bySource[l.source] ?? 0) + 1;
    c.crops.byKind[l.kind] = (c.crops.byKind[l.kind] ?? 0) + 1;
    c.crops.bySourceKind[`${l.source}/${l.kind}`] = (c.crops.bySourceKind[`${l.source}/${l.kind}`] ?? 0) + 1;
    if (l.cardId !== null) pv.labelled++;
    if (l.cardId !== null && l.cardId !== CARD_BACK_ID) cards.add(l.cardId);
    tracks.set(`${l.moment}:${l.track}`, { kind: l.kind, labelled: l.cardId !== null });
  }
  c.crops.labelledCards += cards.size;
  for (const tr of tracks.values()) {
    c.tracks.total++;
    const k = (c.tracks.byKind[tr.kind] ??= { total: 0, labelled: 0 });
    k.total++;
    if (tr.labelled) {
      c.tracks.labelled++;
      k.labelled++;
    }
  }
}

function addMoment(c: Counts, video: VideoEntry, status: MomentRecord['status']): void {
  const pv = (c.perVideo[video.id] ??= { event: video.event, done: 0, skipped: 0, error: 0, crops: 0, labelled: 0 });
  c.moments[status]++;
  pv[status]++;
}

const median = (xs: number[]) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor((s.length - 1) / 2)] * 10) / 10 : null;
};
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

// ---------- main ----------

interface Planned {
  video: VideoEntry;
  t: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  OUT = args.out;
  mkdirSync(path.join(OUT, 'labels'), { recursive: true });
  mkdirSync(path.join(OUT, 'crops'), { recursive: true });
  logFile = path.join(OUT, `harvest-${args.tag}.log`);
  const summaryFile = path.join(OUT, `harvest-${args.tag}-summary.json`);
  // One runner per group (tag): a second one would harvest the same moments. Its pid is what to signal.
  const pidFile = path.join(OUT, `harvest-${args.tag}.pid`);
  if (existsSync(pidFile)) {
    const other = Number(readFileSync(pidFile, 'utf8').trim());
    let alive = false;
    try {
      alive = other > 0 && other !== process.pid && (process.kill(other, 0), true);
    } catch {
      alive = false;
    }
    if (alive) throw new Error(`another harvest runs with tag ${args.tag} (pid ${other}, ${path.relative(ROOT, pidFile)}); stop it first`);
  }
  writeFileSync(pidFile, String(process.pid));
  const dropPid = () => {
    try {
      if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile);
    } catch {
      // gone already
    }
  };
  process.on('exit', dropPid);
  const videos = loadVideos(args);
  for (const v of videos) assertTrain(v);

  // The plan: K moments per video; what is done (labels or moments on disk) is skipped.
  const history = emptyCounts();
  const done = new Map<string, Set<number>>();
  const errorsAt = new Map<string, Map<number, number>>();
  const sleeves = new Map<string, SleeveMemory>();
  for (const v of videos) {
    const lines = readJsonl<LabelLine>(labelsFile(v.id));
    const records = readJsonl<MomentRecord>(momentsFile(v.id));
    addLines(history, v, lines);
    const set = new Set<number>(lines.map((l) => l.moment));
    const errs = new Map<number, number>();
    const memory: SleeveMemory = new Map();
    sleeves.set(v.id, memory);
    for (const r of records) {
      if (r.faceDown?.seen?.length) memory.set(r.t, new Set(r.faceDown.seen));
      addMoment(history, v, r.status);
      if (r.status === 'error') errs.set(r.t, (errs.get(r.t) ?? 0) + 1);
      else set.add(r.t);
    }
    done.set(v.id, set);
    errorsAt.set(v.id, errs);
  }
  const perVideo = videos.map((v) => {
    const times = momentTimes(v.id, v.hours * 3600, args.k);
    return spreadOrder(times.length)
      .map((i) => times[i])
      .filter((t) => !done.get(v.id)!.has(t) && (errorsAt.get(v.id)!.get(t) ?? 0) < 2)
      .map((t): Planned => ({ video: v, t }));
  });
  const plan: Planned[] = [];
  if (args.order === 'sequential') for (const list of perVideo) plan.push(...list);
  else for (let r = 0; perVideo.some((l) => r < l.length); r++) for (const list of perVideo) if (r < list.length) plan.push(list[r]);

  log(
    `harvest group ${args.group} (tag ${args.tag}): ${videos.length} train video(s), ${args.k} moments each, ${plan.length} to do ` +
      `(${history.moments.done + history.moments.skipped} done before); order ${args.order}; engine frames ${args.engineFrames} per face-up track; face-down kept from ${args.facedownKeep}; ` +
      `threads ${args.threads}; margin ${args.margin}; ${args.pipeline ? 'pipelined' : 'sequential'}; until ${args.until ? args.until.toString() : '-'}; free ${freeGb().toFixed(1)} GB`,
  );

  const names = new Map<number, string>(loadCards().cards.map((c) => [c.id, c.name]));
  names.set(CARD_BACK_ID, 'Card back');
  const models = await loadModels(args.threads);
  const browsing = new Browsing(args.headful);

  const run = { counts: emptyCounts(), capture: [] as number[], analyze: [] as number[], total: [] as number[], engineMs: [] as number[], readings: 0, faceDownKept: 0, faceDownDropped: 0 };
  const runStarted = Date.now();
  let stopReason: string | null = null;
  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals === 1) {
      stopReason = `signal ${sig}`;
      log(`${sig}: stopping after the moment in hand (again to stop now)`);
    } else {
      log(`${sig} again: closing the browser and exiting`);
      void browsing.close().finally(() => process.exit(130));
    }
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('unhandledRejection', (e) => log(`unhandled rejection (ignored): ${String((e as Error)?.stack ?? e).slice(0, 400)}`));

  const writeSummary = () => {
    const all = emptyCounts();
    // history (before this run) plus this run
    const merge = (a: Counts, b: Counts) => {
      for (const k of ['done', 'skipped', 'error'] as const) a.moments[k] += b.moments[k];
      a.tracks.total += b.tracks.total;
      a.tracks.labelled += b.tracks.labelled;
      for (const [k, v] of Object.entries(b.tracks.byKind)) {
        const t = (a.tracks.byKind[k] ??= { total: 0, labelled: 0 });
        t.total += v.total;
        t.labelled += v.labelled;
      }
      a.crops.total += b.crops.total;
      a.crops.labelledCards += b.crops.labelledCards;
      for (const key of ['bySource', 'byKind', 'bySourceKind'] as const) for (const [k, v] of Object.entries(b.crops[key])) a.crops[key][k] = (a.crops[key][k] ?? 0) + v;
      for (const [id, v] of Object.entries(b.perVideo)) {
        const p = (a.perVideo[id] ??= { event: v.event, done: 0, skipped: 0, error: 0, crops: 0, labelled: 0 });
        p.done += v.done;
        p.skipped += v.skipped;
        p.error += v.error;
        p.crops += v.crops;
        p.labelled += v.labelled;
      }
    };
    merge(all, history);
    merge(all, run.counts);
    const processed = run.counts.moments.done + run.counts.moments.skipped + run.counts.moments.error;
    const hours = (Date.now() - runStarted) / 3.6e6;
    const summary = {
      group: args.group,
      tag: args.tag,
      updatedAt: new Date().toISOString(),
      startedAt: new Date(runStarted).toISOString(),
      stopReason,
      args: { ...args, until: args.until?.toISOString() ?? null },
      videos: { inGroup: videos.length, touched: Object.keys(all.perVideo).length },
      totals: all,
      thisRun: {
        moments: run.counts.moments,
        crops: run.counts.crops,
        tracks: run.counts.tracks,
        hours: Math.round(hours * 1000) / 1000,
        momentsPerHour: hours > 0 ? Math.round(processed / hours) : null,
        secondsPerMoment: processed > 0 ? Math.round(((Date.now() - runStarted) / 1000 / processed) * 10) / 10 : null,
        captureSecs: { median: median(run.capture), mean: mean(run.capture) },
        analyzeSecs: { median: median(run.analyze), mean: mean(run.analyze) },
        engineMsPerReading: run.readings ? Math.round(run.engineMs.reduce((a, b) => a + b, 0) / run.readings) : null,
        readings: run.readings,
        faceDownTracks: { kept: run.faceDownKept, dropped: run.faceDownDropped },
        cropsPerDoneMoment: run.counts.moments.done ? Math.round((run.counts.crops.total / run.counts.moments.done) * 10) / 10 : null,
      },
      freeGb: Math.round(freeGb() * 10) / 10,
    };
    writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  };

  const record = (rec: MomentRecord) => appendFileSync(momentsFile(rec.video), `${JSON.stringify(rec)}\n`);

  let next = 0;
  let processed = 0;
  /** Videos that failed 3 times in this run without a single moment captured: set aside until the next run. */
  const failures = new Map<string, { errors: number; ok: number }>();
  const setAside = (id: string) => {
    const f = failures.get(id);
    return !!f && f.ok === 0 && f.errors >= 3;
  };
  let errorStreak = 0;
  let botStreak = 0;
  const shouldStop = (): string | null => {
    if (stopReason) return stopReason;
    if (args.until && Date.now() >= args.until.getTime()) return `--until ${args.until.toTimeString().slice(0, 5)} reached`;
    const free = freeGb();
    if (free < args.minFreeGb) return `free disk ${free.toFixed(1)} GB < ${args.minFreeGb} GB`;
    if (processed >= args.maxMoments) return `--max-moments ${args.maxMoments} reached`;
    if (next >= plan.length) return 'the group is done';
    return null;
  };
  const startNext = (): Promise<Captured> | null => {
    const why = shouldStop();
    if (why) {
      stopReason ??= why;
      return null;
    }
    while (next < plan.length && setAside(plan[next].video.id)) next++;
    if (next >= plan.length) {
      stopReason ??= 'the group is done (videos that kept failing were set aside)';
      return null;
    }
    const m = plan[next++];
    processed++;
    return capture(browsing, models.detector, m.video, m.t);
  };

  try {
    let pending = startNext();
    while (pending) {
      const cap = await pending;
      pending = null;
      const vf = failures.get(cap.video.id) ?? { errors: 0, ok: 0 };
      if (cap.status === 'error') vf.errors++;
      else vf.ok++;
      failures.set(cap.video.id, vf);
      if (setAside(cap.video.id) && vf.errors === 3) log(`video ${cap.video.id} failed 3 times with no moment captured: set aside for this run`);
      const at = new Date().toISOString();
      if (cap.status === 'error') {
        record({ video: cap.video.id, t: cap.t, status: 'error', error: cap.error, secs: { capture: cap.secs, analyze: 0, total: cap.secs }, at });
        addMoment(run.counts, cap.video, 'error');
        run.capture.push(cap.secs);
        log(`ERROR ${cap.video.id}@${cap.t} after ${cap.secs} s: ${cap.error}`);
        errorStreak++;
        if (cap.bot) {
          botStreak++;
          await browsing.close();
          if (botStreak >= 3) stopReason = 'YouTube asked 3 times in a row to confirm this is not a bot';
          else {
            log(`bot check ${botStreak}/3: a new browser in ${60 * botStreak} s`);
            await sleep(60000 * botStreak);
          }
        } else if (cap.fatal || errorStreak % 5 === 0) {
          log(`${cap.fatal ? 'the page or browser died' : `${errorStreak} errors in a row`}: a new browser`);
          await browsing.close();
          if (errorStreak >= 5) await sleep(30000);
        }
        if (errorStreak >= 15) stopReason = `${errorStreak} errors in a row`;
        pending = startNext();
        writeSummary();
        continue;
      }
      errorStreak = 0;
      botStreak = 0;
      if (cap.status === 'skipped') {
        record({ video: cap.video.id, t: cap.t, status: 'skipped', reason: cap.reason, faceUp0: cap.faceUp0, quality: cap.quality, secs: { capture: cap.secs, analyze: 0, total: cap.secs }, at });
        addMoment(run.counts, cap.video, 'skipped');
        run.capture.push(cap.secs);
        run.total.push(cap.secs);
        log(`skip  ${cap.video.id}@${cap.t}: ${cap.reason} (${cap.quality ? `${cap.quality.served} ${cap.quality.w}x${cap.quality.h}, ` : ''}${cap.secs} s)`);
        pending = startNext();
        writeSummary();
        continue;
      }
      // Captured: the next moment loads while this one is analysed (the browser waits on the network, the engine on the CPU).
      if (args.pipeline) pending = startNext();
      const t0 = performance.now();
      let analysis: Analysis | null = null;
      try {
        analysis = await analyze(models, cap, args, names, sleeves.get(cap.video.id)!);
        appendFileSync(labelsFile(cap.video.id), analysis.lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
      } catch (e) {
        for (const f of analysis?.files ?? []) {
          try {
            unlinkSync(f);
          } catch {
            // already gone
          }
        }
        const message = String((e as Error)?.stack ?? e).slice(0, 400);
        record({ video: cap.video.id, t: cap.t, status: 'error', error: `analysis: ${message}`, secs: { capture: cap.secs, analyze: 0, total: cap.secs }, at });
        addMoment(run.counts, cap.video, 'error');
        log(`ERROR ${cap.video.id}@${cap.t} (analysis): ${message}`);
        analysis = null;
      }
      const analyzeSecs = Math.round(performance.now() - t0) / 1000;
      if (analysis) {
        const lines = analysis.lines as unknown as LabelLine[];
        addLines(run.counts, cap.video, lines);
        addMoment(run.counts, cap.video, 'done');
        run.capture.push(cap.secs);
        run.analyze.push(analyzeSecs);
        run.total.push(cap.secs + analyzeSecs);
        run.engineMs.push(analysis.engineMs);
        run.readings += analysis.readings;
        run.faceDownKept += analysis.faceDownKept;
        run.faceDownDropped += analysis.faceDownDropped;
        const src = (s: Source) => lines.filter((l) => l.source === s).length;
        record({
          video: cap.video.id,
          t: cap.t,
          status: 'done',
          faceUp0: cap.faceUp0,
          frames: cap.frames.length,
          tracks: analysis.tracks,
          labelledTracks: analysis.labelledTracks,
          crops: lines.length,
          readings: analysis.readings,
          faceDown: { kept: analysis.faceDownKept, dropped: analysis.faceDownDropped, front: analysis.faceDownFront, seen: analysis.faceDownSeen },
          quality: cap.quality,
          secs: { capture: cap.secs, analyze: analyzeSecs, total: Math.round((cap.secs + analyzeSecs) * 10) / 10 },
          at,
        });
        log(
          `done  ${cap.video.id}@${cap.t}: ${cap.quality.served} ${cap.quality.w}x${cap.quality.h} (auto ${cap.quality.auto}), ${cap.frames.length} frames, ` +
            `${cap.faceUp0} face-up on the first; ${analysis.tracks} tracks, ${analysis.labelledTracks} labelled; ${lines.length} crops ` +
            `(confident ${src('confident')}, propagated ${src('propagated')}, none ${src('none')}); face-down tracks kept ${analysis.faceDownKept}, dropped ${analysis.faceDownDropped}; ${analysis.readings} readings; ` +
            `capture ${cap.secs} s, analysis ${analyzeSecs} s`,
        );
      }
      // Frames go out of scope here: nothing of them but the crops was kept.
      if (!args.pipeline) pending = startNext();
      writeSummary();
    }
  } finally {
    stopReason ??= 'stopped';
    log(`stopping: ${stopReason}`);
    writeSummary();
    await browsing.close();
    await models.release().catch(() => {});
    const s = run.counts;
    log(
      `this run: ${s.moments.done} moments done, ${s.moments.skipped} skipped, ${s.moments.error} errors; ${s.crops.total} crops ` +
        `(${JSON.stringify(s.crops.bySource)}); summary ${path.relative(ROOT, summaryFile)}`,
    );
  }
}

main().catch((e) => {
  try {
    log(`FATAL: ${String((e as Error)?.stack ?? e)}`);
  } catch {
    console.error(e);
  }
  process.exit(1);
});
