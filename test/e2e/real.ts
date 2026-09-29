// Real-footage mode of the end-to-end test: npx tsx test/e2e/run.ts --real [--click [--fake-detect]]
// [--limit N] [--only cards|negatives] [--compare FILE|none]
//
// --click (click to scan): instead of dragging the row's box, wait for the detector's outlines after
// the shortcut and click the centre of the box. A click that lands on no outline leaves the frame
// frozen: that row's outcome is "no-outline" (a miss for a card, a pass for a negative). The crop is
// the detected card's, not eval-real's, so it is recorded but not compared pixel for pixel.
// Results go to test/e2e/out/real-click-results.json. When the build has no card detector (the first
// row's detection says exactly "no card detector in this build"), the run stops there with SKIPPED
// (exit 0). Any other detection failure, no detection at all, or one the tab never outlined fails
// that row (harness.ts checkDetection). --fake-detect sends the outlines from the harness instead
// (every labelled card's rotatedBox on the frame, set.json; the build's own detection is held back).
//
// The extension reads the real test set the way a user would: data/realset/set.json (120 face-up
// cards) and negatives.json (70 boxes that are not a card face), formats in tools/realset/README.md.
// - Each frame (data/debug/frames/<frame>.png) is shown at 1:1 CSS pixels, devicePixelRatio 1, and
//   the extension's selection is dragged with the mouse over the row's box (frame pixels).
// - The frame sits at the viewport's top-left, except where eval-real clips the box's 4% crop margin
//   at a frame edge: that edge is then put on the viewport's edge, where the content script clips
//   the margin the same way. So the extension crops what tools/eval-real.ts crops, and every crop
//   is checked against eval-real's own (tools/realset/lib/crop.ts), pixel for pixel.
// - The popover is read from its closed shadow root through the DevTools protocol: the card name,
//   "Not sure", "Face-down card" and "Couldn't match this".
// - Observation only: chrome.runtime.sendMessage is wrapped in the service worker to record each
//   crop sent to the offscreen engine and its raw result (scores, recogniser, timings).
//
// Pass: a card row passes when the popover's top card is the expected card (confident or "Not
// sure"), and no confident answer may be wrong; a negative passes unless the popover shows a
// confident card. Rows are compared with the engine-level eval's results file
// (default data/realset/results-engine-<model>.json, written by tools/eval-real.ts).
// Writes test/e2e/out/real-results.json, plus a screenshot and the crop of every row that fails,
// differs from the eval or crops other pixels, in test/e2e/out/real/.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type CDPSession, type Page, type WebWorker } from 'puppeteer';
import { CROP_MARGIN } from '../../src/content/capture';
import { DEFAULT_MODEL_ID } from '../../src/shared/models';
import type { RGBAImage } from '../../src/shared/preprocess';
import { CARD_BACK_ID } from '../../src/shared/types';
import { percentile } from '../../tools/lib/bench-stats';
import { loadDataUrl, loadRGBA } from '../../tools/lib/image';
import { PRODUCTIONS, productionOf, type Production } from '../../tools/realset/lib/constants';
import { buildCrop } from '../../tools/realset/lib/crop';
import type { AxisBox, NegativeBox, RealsetEntry } from '../../tools/realset/lib/types';
import {
  NoDetector,
  checkDetection,
  checkFakeDetection,
  clickStartsScan,
  closeOverlay,
  grantConsent,
  hostState,
  insideQuad,
  installTabTap,
  readTabTap,
  sendFakeDetection,
  settleInstall,
  skipMessage,
  waitForOutlines,
  waitForState,
  type Corners,
} from './harness';

export interface RealOptions {
  root: string;
  /** The E2E build (run.ts has just built it). */
  dist: string;
  outDir: string;
  /** Click the centre of each box on the detector's outlines instead of dragging it. */
  click?: boolean;
  /** With `click`: send the labelled cards' boxes as the detection (no detector needed). */
  fake?: boolean;
}

const VIEWPORT = { w: 1500, h: 1000 } as const;
/** captureVisibleTab allows 2 calls a second; scans start at least this far apart. */
const CAPTURE_GAP_MS = 600;
/** The popover's copy (src/content/popover.tsx COPY) that tells its answers apart. */
const COPY = {
  faceDown: 'Face-down card',
  nothing: "Couldn't match this",
  /** "Nothing" after a click on an outline (live check m6). */
  nothingPicked: "Couldn't read this card",
  /** "Nothing" for a card cut by the picture's edge (RecognitionResult.truncated; partial-report.md). */
  nothingTruncated: 'Part of this card is outside the picture',
  notSure: 'Not sure',
} as const;

type Outcome = 'confident' | 'unsure' | 'face-down' | 'nothing' | 'error' | 'no-outline';

interface Job {
  kind: 'card' | 'negative';
  id: string;
  frame: string;
  box: AxisBox;
  expected?: { cardId: number | null; name: string };
  design?: string;
}

/** What the popover shows (read from the closed shadow root). */
interface PopoverText {
  name: string | null;
  match: string | null;
  lead: string | null;
  groups: { label: string | null; names: string[] }[];
}

/** The offscreen engine's own answer, recorded in the service worker. */
interface RawAnswer {
  recognizer: string | null;
  confident: boolean;
  /** No reading cleared the floor, and a face-up card was picked: the closest cards, offered as "Not sure" (click-regression-report.md). */
  suggested: boolean;
  /** The answer came from reading the card with a simulator's count badge painted out (diag-t950-report.md). */
  countBadge: boolean;
  faceDown: boolean;
  error: string | null;
  best: unknown;
  candidates: { cardId: number; score: number; source?: string }[];
  timings: Record<string, number>;
}

interface CropCheck {
  source: string;
  width: number;
  height: number;
  inner: AxisBox | null;
  eval: { width: number; height: number; inner: AxisBox };
  samePixels: boolean;
  sameInner: boolean;
  /** Largest RGB difference and pixels that differ at all, when both crops have the same size. */
  maxDiff: number | null;
  diffPixels: number | null;
}

type EvalKind = 'confident' | 'unsure' | 'face-down' | 'nothing' | 'error';

interface EvalView {
  kind: EvalKind;
  top: { cardId: number | null; name: string; score: number } | null;
  confident: boolean;
  answeredBy: string | null;
  ms: number;
}

interface RowResult {
  kind: Job['kind'];
  id: string;
  frame: string;
  production: Production;
  /** The box in frame pixels, and where the frame and the drag were in the viewport. */
  box: AxisBox;
  frameAt: { x: number; y: number };
  drag: { x0: number; y0: number; x1: number; y1: number };
  expected?: Job['expected'];
  design?: string;
  outcome: Outcome;
  /** The popover's top card: the card shown. */
  top: string | null;
  others: string[];
  popover: PopoverText | null;
  host: { card: string | null; confident: string | null } | null;
  message?: string;
  ok: boolean;
  /** Mouse up → the popover's answer (page clock). */
  ms: number | null;
  /** The offscreen engine's own time (decode + recognise), comparable to eval-real's ms. */
  engineMs: number | null;
  /** Size of the tab screenshot the selection froze on (1:1 means the viewport's size). */
  capture: { width: number; height: number } | null;
  raw: RawAnswer | null;
  crop: CropCheck | null;
  eval: EvalView | null;
  /** --click: where the click went, the outlines it had to hit, and the detected card's crop. */
  click?: {
    at: { x: number; y: number };
    /** Outlines on the frozen frame when clicking (null: no detection came). */
    outlines: number | null;
    /** The shortcut → the outlines on the frozen frame (harness clock). */
    outlineMs: number | null;
    /** The detector's own time, from its cards-detected. */
    detectorMs: number | null;
    detectionError: string | null;
    /** The crop sent for the clicked card (the detected card's bounds plus the margin), and the card's corners in it (crop.outline). */
    crop: { width: number; height: number; inner: AxisBox | null; outline: [number, number][] | null } | null;
    /** --fake-detect: the outline the click landed in (its index among the frame's labelled cards), if any. */
    insideOutline?: number | null;
  };
  /** Answers that differ from the eval: the top card, or confident / not sure / nothing / face-down. */
  differs: string[];
  /** Same answer, but another recogniser or a top score more than 0.005 away. */
  notes: string[];
}

// ---------- CLI and inputs ----------

function parseArgs(args: string[]) {
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const limitArg = value('--limit');
  const limit = limitArg === undefined ? undefined : Number(limitArg);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error(`--limit must be a positive integer, got "${limitArg}"`);
  const only = value('--only');
  if (only !== undefined && only !== 'cards' && only !== 'negatives') throw new Error(`--only must be "cards" or "negatives", got "${only}"`);
  return { limit, only: only as 'cards' | 'negatives' | undefined, compare: value('--compare') };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function loadJobs(root: string, limit: number | undefined, only: 'cards' | 'negatives' | undefined): Promise<Job[]> {
  const take = <T>(rows: T[]) => (limit ? rows.slice(0, limit) : rows);
  const cards =
    only === 'negatives' ? [] : take(await readJson<RealsetEntry[]>(path.join(root, 'data/realset/set.json')));
  const negatives =
    only === 'cards' ? [] : take(await readJson<NegativeBox[]>(path.join(root, 'data/realset/negatives.json')));
  return [
    ...cards.map((e): Job => ({ kind: 'card', id: e.id, frame: e.frame, box: e.userBox, expected: { cardId: e.cardId, name: e.name } })),
    ...negatives.map((n): Job => {
      const [x, y, w, h] = n.box;
      return { kind: 'negative', id: n.id, frame: n.frame, box: { x, y, w, h }, design: n.design };
    }),
  ];
}

// ---------- the engine-level eval to compare with ----------

interface EvalRow {
  id: string;
  candidates: { cardId: number | null; name: string; score: number }[];
  confident: boolean;
  answeredBy?: string;
  ms: number;
  error?: string;
}

interface Compare {
  file: string;
  writtenAt: string;
  /** The engine's code, model or index changed after the eval ran. */
  stale: boolean;
  rows: Map<string, EvalView>;
}

/** Newest modification time of the files under `dirs` (tests excluded). */
function newestMtime(dirs: string[]): number {
  let newest = 0;
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) for (const name of readdirSync(p)) walk(path.join(p, name));
    else if (!/\.test\.tsx?$/.test(p)) newest = Math.max(newest, st.mtimeMs);
  };
  for (const d of dirs) if (existsSync(d)) walk(d);
  return newest;
}

function evalView(row: EvalRow): EvalView {
  const top = row.candidates[0];
  const kind: EvalKind = row.error
    ? 'error'
    : !top
      ? 'nothing'
      : top.cardId === CARD_BACK_ID
        ? 'face-down'
        : row.confident
          ? 'confident'
          : 'unsure';
  return {
    kind,
    top: top ? { cardId: top.cardId, name: top.name, score: top.score } : null,
    confident: row.confident,
    answeredBy: row.answeredBy ?? null,
    ms: row.ms,
  };
}

async function loadCompare(root: string, arg: string | undefined): Promise<Compare | null> {
  if (arg === 'none') return null;
  const file = arg ? path.resolve(root, arg) : path.join(root, `data/realset/results-engine-${DEFAULT_MODEL_ID}.json`);
  if (!existsSync(file)) {
    console.log(`(no engine-level results at ${path.relative(root, file)}: run tools/eval-real.ts first to compare)`);
    return null;
  }
  const data = await readJson<{ rows?: EvalRow[]; negatives?: { rows?: EvalRow[] } }>(file);
  const rows = new Map<string, EvalView>();
  for (const r of [...(data.rows ?? []), ...(data.negatives?.rows ?? [])]) rows.set(r.id, evalView(r));
  const written = statSync(file).mtimeMs;
  const engine = newestMtime(['src/offscreen', 'src/shared', 'extension/data', 'extension/models'].map((d) => path.join(root, d)));
  return { file: path.relative(root, file), writtenAt: new Date(written).toISOString(), stale: engine > written, rows };
}

// ---------- page, frames and crops ----------

function serve(root: string): Promise<http.Server> {
  const page = path.join(root, 'test/e2e/real.html');
  const frames = path.join(root, 'data/debug/frames');
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const frame = /^\/frames\/([\w.-]+\.png)$/.exec(url)?.[1];
    const file = url === '/' ? page : frame ? path.join(frames, frame) : '';
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/png' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Where the frame's near edge goes on one axis (frame size `size`, viewport `view`) for a box at
 * `start` of `length`: on the viewport's near edge, or on its far edge when eval-real clips the
 * box's margin at the frame's far edge (the content script clips it at the viewport's edge).
 */
function frameOffset(size: number, view: number, start: number, length: number): number {
  const margin = length * CROP_MARGIN;
  if (start - margin < 0) return 0;
  if (start + length + margin > size) return view - size;
  if (size <= view) return 0;
  return Math.max(view - size, Math.min(0, Math.round(view / 2 - (start + length / 2))));
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Compares the extension's crop with the one eval-real builds for the same box. */
async function checkCrop(crop: { dataUrl: string; source: string; inner?: AxisBox }, frame: RGBAImage, box: AxisBox): Promise<CropCheck> {
  const ext = await loadDataUrl(crop.dataUrl);
  const ev = buildCrop(frame, box);
  const same = ext.width === ev.cropImg.width && ext.height === ev.cropImg.height;
  let maxDiff: number | null = null;
  let diffPixels: number | null = null;
  if (same) {
    maxDiff = 0;
    diffPixels = 0;
    const a = ext.data;
    const b = ev.cropImg.data;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      if (d > 0) diffPixels++;
      if (d > maxDiff) maxDiff = d;
    }
  }
  const inner = crop.inner ?? null;
  const sameInner =
    inner !== null && (['x', 'y', 'w', 'h'] as const).every((k) => Math.abs(inner[k] - ev.inner[k]) < 1e-6);
  return {
    source: crop.source,
    width: ext.width,
    height: ext.height,
    inner,
    eval: { width: ev.cropImg.width, height: ev.cropImg.height, inner: ev.inner },
    samePixels: same && maxDiff === 0,
    sameInner,
    maxDiff,
    diffPixels,
  };
}

// ---------- the extension, through the DevTools protocol ----------
// tsx compiles with keepNames, which wraps nested functions in a __name() helper that pages and
// workers don't have, so the code evaluated there is written as plain strings.

/** Records every crop the service worker sends to the offscreen engine, and the engine's answer. */
const INSTALL_TAP = `(() => {
  if (globalThis.__duelLensE2eTap) return true;
  const runtime = chrome.runtime;
  const original = runtime.sendMessage;
  const tap = { last: null };
  const wrapped = function (...args) {
    const msg = args[0];
    const out = original.apply(runtime, args);
    if (msg && msg.target === 'offscreen' && msg.type === 'recognize') {
      const rec = { crop: msg.crop, result: null, error: null };
      tap.last = rec;
      Promise.resolve(out).then((r) => { rec.result = (r && r.result) || null; }, (e) => { rec.error = String(e); });
    }
    return out;
  };
  try { runtime.sendMessage = wrapped; } catch (e) {}
  if (runtime.sendMessage !== wrapped) {
    try { Object.defineProperty(runtime, 'sendMessage', { value: wrapped, configurable: true, writable: true }); } catch (e) {}
  }
  if (runtime.sendMessage !== wrapped) return false;
  globalThis.__duelLensE2eTap = tap;
  return true;
})()`;

/** Runs with `this` = the host's closed shadow root. */
const READ_POPOVER = `function () {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
  const shot = this.querySelector('img.shot');
  return {
    name: clean(this.querySelector('.dv-name')),
    match: clean(this.querySelector('.dv-match b')),
    lead: clean(this.querySelector('.dv-msg .lead')),
    groups: Array.from(this.querySelectorAll('.dv-alts')).map((g) => ({
      label: g.getAttribute('aria-label'),
      names: Array.from(g.querySelectorAll('.alt em')).map(clean),
    })),
    shot: shot && shot.naturalWidth ? { width: shot.naturalWidth, height: shot.naturalHeight } : null,
  };
}`;

type ShadowRead = PopoverText & { shot: { width: number; height: number } | null };

/** READ_POPOVER on the Duel Lens host's closed shadow root; null when there is no host. */
async function readShadow(cdp: CDPSession): Promise<ShadowRead | null> {
  const { result: host } = await cdp.send('Runtime.evaluate', { expression: "document.getElementById('duel-lens-host')" });
  if (!host.objectId) return null;
  let rootId: string | undefined;
  try {
    const { node } = await cdp.send('DOM.describeNode', { objectId: host.objectId, depth: 1, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    rootId = (await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId })).object.objectId;
    if (!rootId) return null;
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: rootId,
      functionDeclaration: READ_POPOVER,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`Reading the popover failed: ${exceptionDetails.text}`);
    return result.value as ShadowRead;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: host.objectId }).catch(() => {});
    if (rootId) await cdp.send('Runtime.releaseObject', { objectId: rootId }).catch(() => {});
  }
}

/** The popover's answer, as a user reads it. */
function readOutcome(state: string | null, p: PopoverText | null): { outcome: Outcome; top: string | null; others: string[]; message?: string } {
  const group = (label: string) => p?.groups.find((g) => g.label === label)?.names ?? [];
  if (!p) return { outcome: 'error', top: null, others: [], message: 'no popover' };
  if (state === 'error') return { outcome: 'error', top: null, others: [], message: p.lead ?? 'error' };
  if (p.lead?.startsWith(COPY.faceDown)) return { outcome: 'face-down', top: null, others: [] };
  if (p.lead?.startsWith(COPY.nothing) || p.lead?.startsWith(COPY.nothingPicked) || p.lead?.startsWith(COPY.nothingTruncated)) {
    return { outcome: 'nothing', top: null, others: [] };
  }
  if (p.name) {
    const unsure = p.match?.startsWith(COPY.notSure) ?? false;
    return { outcome: unsure ? 'unsure' : 'confident', top: p.name, others: group('Other matches') };
  }
  return { outcome: 'error', top: null, others: [], message: `unrecognised popover: ${JSON.stringify(p)}` };
}

function rawAnswer(result: any): RawAnswer | null {
  if (!result) return null;
  return {
    recognizer: result.recognizer ?? null,
    confident: result.confident === true,
    suggested: result.suggested === true,
    countBadge: result.countBadge === true,
    faceDown: result.faceDown === true,
    error: result.error ?? null,
    best: result.best ?? null,
    candidates: (result.candidates ?? []).slice(0, 5).map((c: any) => ({ cardId: c.cardId, score: c.score, ...(c.source ? { source: c.source } : {}) })),
    timings: result.timings ?? {},
  };
}

/** The answer compared with the eval's: `differs` for another answer, `notes` for the same answer reached otherwise. */
function compareWithEval(r: RowResult, ev: EvalView): { differs: string[]; notes: string[] } {
  const differs: string[] = [];
  const notes: string[] = [];
  if (r.outcome !== ev.kind) differs.push(`answer: ${ev.kind} in the eval, ${r.outcome} here`);
  const evalTop = ev.top?.cardId ?? null;
  const top = r.raw ? (r.raw.candidates[0]?.cardId ?? null) : undefined;
  if (top !== undefined ? top !== evalTop : r.top !== (ev.top?.name ?? null)) {
    differs.push(`top card: ${ev.top?.name ?? 'none'} in the eval, ${r.top ?? (top === CARD_BACK_ID ? 'the card back' : 'none')} here`);
  }
  if (r.raw && ev.answeredBy && r.raw.recognizer !== ev.answeredBy) notes.push(`recogniser: ${ev.answeredBy} in the eval, ${r.raw.recognizer} here`);
  const score = r.raw?.candidates[0]?.score;
  if (top === evalTop && ev.top && score !== undefined && Math.abs(score - ev.top.score) > 0.005) {
    notes.push(`top score: ${ev.top.score.toFixed(3)} in the eval, ${score.toFixed(3)} here`);
  }
  return { differs, notes };
}

// ---------- one row ----------

interface Context {
  root: string;
  page: Page;
  worker: WebWorker;
  cdp: CDPSession;
  evidenceDir: string;
  compare: Compare | null;
  frames: Map<string, Promise<RGBAImage>>;
  lastScanAt: number;
  click: boolean;
  /** --fake-detect: every labelled card's corners, by frame (frame pixels). */
  fakeBoxes: Map<string, Corners[]> | null;
  /** How long to wait for the outlines; shortened once a scan shows the detector isn't answering. */
  outlineTimeoutMs: number;
  /** --click: whether the first scan has shown the build can outline cards. */
  detectorChecked: boolean;
}

function loadFrame(ctx: Context, frame: string): Promise<RGBAImage> {
  let p = ctx.frames.get(frame);
  if (!p) {
    p = loadRGBA(path.join(ctx.root, 'data/debug/frames', `${frame}.png`));
    ctx.frames.set(frame, p);
  }
  return p;
}

/**
 * Starts a scan like the shortcut does and waits for the frozen frame (retried if the capture quota
 * hit). Returns when the scan was triggered (the shortcut's moment, harness clock).
 */
async function startSelection(ctx: Context): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    await sleep(Math.max(0, ctx.lastScanAt + CAPTURE_GAP_MS - Date.now()));
    ctx.lastScanAt = Date.now();
    await ctx.worker.evaluate(INSTALL_TAP);
    if (ctx.click) await installTabTap(ctx.worker, ctx.fakeBoxes !== null);
    await ctx.worker.evaluate(() => {
      const tap = (globalThis as any).__duelLensE2eTap;
      if (tap) tap.last = null;
    });
    const triggered = Date.now();
    await ctx.worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
    try {
      await waitForState(ctx.page, ['selecting'], 5000);
      return triggered;
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(1100);
    }
  }
}

/** Escape, and once more when the first only cancelled an armed corner (a click beside the outlines starts a two-click box). */
async function closePopover(page: Page) {
  await closeOverlay(page);
}

/** A row before the scan: an error until the popover says otherwise. */
function emptyRow(job: Job, compare: Compare | null): RowResult {
  return {
    kind: job.kind,
    id: job.id,
    frame: job.frame,
    production: productionOf(job.frame),
    box: job.box,
    frameAt: { x: 0, y: 0 },
    drag: { x0: 0, y0: 0, x1: 0, y1: 0 },
    ...(job.expected ? { expected: job.expected } : {}),
    ...(job.design ? { design: job.design } : {}),
    outcome: 'error',
    top: null,
    others: [],
    popover: null,
    host: null,
    ok: false,
    ms: null,
    engineMs: null,
    capture: null,
    raw: null,
    crop: null,
    eval: compare?.rows.get(job.id) ?? null,
    differs: [],
    notes: [],
  };
}

async function scanRow(ctx: Context, job: Job): Promise<RowResult> {
  const { page } = ctx;
  const frame = await loadFrame(ctx, job.frame);
  const row = emptyRow(job, ctx.compare);
  const at = {
    x: frameOffset(frame.width, VIEWPORT.w, job.box.x, job.box.w),
    y: frameOffset(frame.height, VIEWPORT.h, job.box.y, job.box.h),
  };
  const shown = await page.evaluate((src, x, y) => (window as any).showFrame(src, x, y), `/frames/${job.frame}.png`, at.x, at.y);
  if (shown.w !== frame.width || shown.h !== frame.height || shown.dpr !== 1 || shown.vw !== VIEWPORT.w || shown.vh !== VIEWPORT.h) {
    throw new Error(`The frame isn't shown 1:1 in a ${VIEWPORT.w}x${VIEWPORT.h} viewport at devicePixelRatio 1: ${JSON.stringify(shown)}`);
  }
  row.frameAt = at;
  // The pointer can't leave the viewport; the selection clamps a drag there the same way.
  const drag = {
    x0: clamp(at.x + job.box.x, 0, VIEWPORT.w),
    y0: clamp(at.y + job.box.y, 0, VIEWPORT.h),
    x1: clamp(at.x + job.box.x + job.box.w, 0, VIEWPORT.w),
    y1: clamp(at.y + job.box.y + job.box.h, 0, VIEWPORT.h),
  };
  row.drag = drag;

  const t0 = await startSelection(ctx);
  // The frozen frame: the tab's screenshot, drawn over the viewport.
  for (let i = 0; i < 40 && !row.capture; i++) {
    row.capture = (await readShadow(ctx.cdp))?.shot ?? null;
    if (!row.capture) await sleep(50);
  }
  let state: Awaited<ReturnType<typeof waitForState>>;
  if (ctx.click) {
    const scanned = await clickRow(ctx, job, row, at, t0);
    if (!scanned) return finishNoOutline(ctx, job, row);
    state = await waitForState(page, ['result', 'error'], 60000);
  } else {
    await page.evaluate(() => {
      (window as any).scanClock = { up: 0, done: 0 };
    });
    await page.mouse.move(drag.x0, drag.y0);
    await page.mouse.down();
    await page.mouse.move((drag.x0 + drag.x1) / 2, (drag.y0 + drag.y1) / 2, { steps: 5 });
    await page.mouse.move(drag.x1, drag.y1, { steps: 5 });
    await page.mouse.up();
    state = await waitForState(page, ['result', 'error'], 60000);
  }
  const clock = await page.evaluate(() => (window as any).scanClock as { up: number; done: number });
  if (clock.up && clock.done) row.ms = Math.round(clock.done - clock.up);

  const shadow = await readShadow(ctx.cdp);
  row.popover = shadow && { name: shadow.name, match: shadow.match, lead: shadow.lead, groups: shadow.groups };
  row.host = { card: state.card, confident: state.confident };
  Object.assign(row, readOutcome(state.state, row.popover));

  const tap = await ctx.worker.evaluate(() => (globalThis as any).__duelLensE2eTap?.last ?? null);
  row.raw = rawAnswer(tap?.result);
  row.engineMs = row.raw?.timings.total ?? null;
  if (row.click) {
    // The detected card's crop, not the row's box: nothing to compare with eval-real's pixels.
    if (tap?.crop) row.click.crop = { width: tap.crop.width, height: tap.crop.height, inner: tap.crop.inner ?? null, outline: tap.crop.outline ?? null };
    // A click sends the card's corners with its crop, for the engine to straighten it from (click-regression-report.md).
    if (tap?.crop && !(Array.isArray(tap.crop.outline) && tap.crop.outline.length === 4)) row.notes.push('the click sent no outline (crop.outline) with its crop');
  } else if (tap?.crop) {
    row.crop = await checkCrop(tap.crop, frame, job.box);
  }

  if (job.kind === 'card') {
    row.ok = row.top === job.expected!.name && (row.outcome === 'confident' || row.outcome === 'unsure');
  } else {
    row.ok = row.outcome !== 'confident' && row.outcome !== 'error';
  }
  const hostSure = row.outcome === 'confident' ? 'true' : row.outcome === 'unsure' ? 'false' : null;
  if (hostSure !== null && state.confident !== hostSure) row.notes.push(`the host says confident=${state.confident}, the popover reads ${row.outcome}`);
  if (row.eval) {
    const c = compareWithEval(row, row.eval);
    row.differs.push(...c.differs);
    row.notes.push(...c.notes);
  }

  const cropOff = row.crop !== null && !(row.crop.samePixels && row.crop.sameInner);
  if (!row.ok || row.differs.length > 0 || cropOff || (row.click && job.kind === 'negative')) {
    await page.screenshot({ path: path.join(ctx.evidenceDir, `${job.id}.png`) });
    if (tap?.crop?.dataUrl) {
      await writeFile(path.join(ctx.evidenceDir, `${job.id}.crop.png`), Buffer.from(tap.crop.dataUrl.split(',')[1], 'base64'));
    }
  }
  await closePopover(page);
  return row;
}

/**
 * --click: after the shortcut, wait for the outlines (sending them first with --fake-detect), then
 * click the centre of the row's box. Returns whether the click started a scan.
 */
async function clickRow(ctx: Context, job: Job, row: RowResult, at: { x: number; y: number }, t0: number): Promise<boolean> {
  const { page, worker } = ctx;
  const x = clamp(at.x + job.box.x + job.box.w / 2, 0, VIEWPORT.w - 1);
  const y = clamp(at.y + job.box.y + job.box.h / 2, 0, VIEWPORT.h - 1);
  const click: NonNullable<RowResult['click']> = { at: { x, y }, outlines: null, outlineMs: null, detectorMs: null, detectionError: null, crop: null };
  row.click = click;
  if (ctx.fakeBoxes) {
    const boxes = (ctx.fakeBoxes.get(job.frame) ?? []).map((pts) => pts.map(([px, py]): [number, number] => [px + at.x, py + at.y]));
    await sendFakeDetection(worker, boxes, { width: VIEWPORT.w, height: VIEWPORT.h });
    const inside = boxes.findIndex((pts) => insideQuad(pts, x, y));
    click.insideOutline = inside < 0 ? null : inside;
  }
  const waited = ctx.outlineTimeoutMs;
  try {
    click.outlines = await waitForOutlines(page, waited);
    click.outlineMs = Date.now() - t0;
  } catch {
    if (ctx.outlineTimeoutMs > 5000) {
      console.log(`(no cards-detected within ${ctx.outlineTimeoutMs / 1000} s: is detect-cards wired up? Waiting 5 s per row from now on)`);
      ctx.outlineTimeoutMs = 5000;
    }
  }
  const tabTap = await readTabTap(worker);
  const detection = tabTap?.detected.find((d) => d.capturedAt === tabTap.begin?.capturedAt);
  if (detection && !ctx.fakeBoxes) {
    click.detectorMs = detection.ms ?? null;
    click.detectionError = detection.error;
  }
  // Skipped only when the build says it has no card detector, on the first row; any other failure
  // to outline fails the row (click-review I2).
  const first = !ctx.detectorChecked;
  ctx.detectorChecked = true;
  const verdict = ctx.fakeBoxes ? checkFakeDetection(click.outlines, waited) : checkDetection(click.outlines, detection, waited);
  if (verdict && 'skip' in verdict && first) throw new NoDetector(verdict.skip);
  if (verdict) throw new Error(`click to scan: ${'skip' in verdict ? `a later scan says ${verdict.skip}` : verdict.fail}`);
  await page.evaluate(() => {
    (window as any).scanClock = { up: 0, done: 0 };
  });
  return clickStartsScan(page, x, y);
}

/** --click, no outline under the click: the frame stays frozen and nothing is scanned. */
async function finishNoOutline(ctx: Context, job: Job, row: RowResult): Promise<RowResult> {
  row.outcome = 'no-outline';
  row.message = `no outline under the click (${row.click?.outlines ?? 'no'} outlines)`;
  row.ok = job.kind === 'negative';
  const inside = row.click?.insideOutline;
  if (inside !== undefined && inside !== null) {
    // --fake-detect knows the outlines: a click inside one that started no scan is the UI's failure.
    row.message = `the click landed inside outline ${inside + 1} of ${row.click?.outlines ?? '?'}, but no scan started`;
    row.ok = false;
  }
  await ctx.page.screenshot({ path: path.join(ctx.evidenceDir, `${job.id}.png`) });
  await closePopover(ctx.page);
  return row;
}

// ---------- report ----------

function cardTotals(rows: RowResult[]) {
  const count = (f: (r: RowResult) => boolean) => rows.filter(f).length;
  return {
    n: rows.length,
    top1: count((r) => r.ok),
    confident: count((r) => r.outcome === 'confident'),
    confidentWrong: count((r) => r.outcome === 'confident' && !r.ok),
    unsureRight: count((r) => r.outcome === 'unsure' && r.ok),
    miss: count((r) => !r.ok),
    faceDown: count((r) => r.outcome === 'face-down'),
    nothing: count((r) => r.outcome === 'nothing'),
    error: count((r) => r.outcome === 'error'),
    noOutline: count((r) => r.outcome === 'no-outline'),
  };
}

function negativeTotals(rows: RowResult[]) {
  const count = (o: Outcome) => rows.filter((r) => r.outcome === o).length;
  return {
    n: rows.length,
    pass: rows.filter((r) => r.ok).length,
    confident: count('confident'),
    unsure: count('unsure'),
    faceDown: count('face-down'),
    nothing: count('nothing'),
    error: count('error'),
    noOutline: count('no-outline'),
  };
}

const byProduction = <T>(rows: RowResult[], totals: (rows: RowResult[]) => T) =>
  Object.fromEntries(PRODUCTIONS.map((p) => [p, totals(rows.filter((r) => r.production === p))])) as Record<Production, T>;

function stats(values: number[]) {
  return values.length ? { n: values.length, median: percentile(values, 50), p90: percentile(values, 90) } : null;
}

const fmtMs = (s: { median: number; p90: number } | null) => (s ? `median ${s.median.toFixed(0)} ms, p90 ${s.p90.toFixed(0)} ms` : 'n/a');

function rowLine(r: RowResult): string {
  const verdict = r.ok ? 'ok  ' : r.kind === 'card' ? 'MISS' : 'FAIL';
  const tag = r.kind === 'card' ? 'card' : 'neg ';
  const truth = r.kind === 'card' && !r.ok ? `  [expected: ${r.expected!.name}]` : '';
  const flags = [
    r.ms !== null ? `${r.ms} ms` : '',
    r.crop && !(r.crop.samePixels && r.crop.sameInner) ? 'CROP≠eval' : '',
    r.differs.length ? `≠eval: ${r.differs.join('; ')}` : '',
    r.message ? `(${r.message})` : '',
  ].filter(Boolean);
  return `${verdict} ${tag} ${r.id.padEnd(32)} ${r.outcome.padEnd(9)} ${(r.top ?? '-').slice(0, 44).padEnd(44)} ${flags.join('  ')}${truth}`;
}

function printSummary(rows: RowResult[], compare: Compare | null, timing: ReturnType<typeof timingOf>) {
  const cards = rows.filter((r) => r.kind === 'card');
  const negatives = rows.filter((r) => r.kind === 'negative');
  if (cards.length) {
    console.log(`\n=== cards: popover top card = expected (confident / Not sure) ===`);
    const line = (label: string, t: ReturnType<typeof cardTotals>) =>
      console.log(
        `${label.padEnd(20)} n=${String(t.n).padEnd(3)} top-1 ${`${t.top1}/${t.n}`.padEnd(6)} confident ${String(t.confident).padEnd(3)}` +
          ` (wrong ${t.confidentWrong})  right but Not sure ${t.unsureRight}  miss ${t.miss}` +
          ` (face-down ${t.faceDown}, nothing ${t.nothing}, error ${t.error}${t.noOutline ? `, no outline under the click ${t.noOutline}` : ''})`,
      );
    line('overall', cardTotals(cards));
    for (const [p, t] of Object.entries(byProduction(cards, cardTotals))) if (t.n) line(p, t);
  }
  if (negatives.length) {
    console.log(`\n=== negatives: never a confident card ===`);
    const line = (label: string, t: ReturnType<typeof negativeTotals>) =>
      console.log(
        `${label.padEnd(20)} n=${String(t.n).padEnd(3)} pass ${`${t.pass}/${t.n}`.padEnd(6)} confident ${String(t.confident).padEnd(3)}` +
          ` Not sure ${String(t.unsure).padEnd(3)} face-down ${String(t.faceDown).padEnd(3)}` +
          ` nothing ${String(t.nothing).padEnd(3)} error ${t.error}` +
          (t.noOutline ? `  no outline under the click ${t.noOutline} (scanned ${t.n - t.noOutline})` : ''),
      );
    line('overall', negativeTotals(negatives));
    for (const [p, t] of Object.entries(byProduction(negatives, negativeTotals))) if (t.n) line(p, t);
  }
  console.log(`\n=== timing ===`);
  if (timing.outlines) {
    console.log(`shortcut → outlines on the frozen frame: ${fmtMs(timing.outlines)} over ${timing.outlines.n} later scans; first (cold detector) ${timing.firstOutlinesMs ?? 'n/a'} ms`);
    if (timing.detector) console.log(`detector's own time (cards-detected ms): ${fmtMs(timing.detector)}`);
  }
  console.log(`scan (mouse up → popover answer): ${fmtMs(timing.scan)} over ${timing.scan?.n ?? 0} warm scans; first scan (cold engine) ${timing.firstScanMs ?? 'n/a'} ms`);
  console.log(`engine in the offscreen document (decode + recognise): ${fmtMs(timing.engine)}` + (timing.evalEngine ? `; eval-real's engine: ${fmtMs(timing.evalEngine)}` : ''));
  const crops = rows.filter((r) => r.crop);
  const sameCrops = crops.filter((r) => r.crop!.samePixels && r.crop!.sameInner);
  const captures = rows.filter((r) => r.capture);
  const oneToOne = captures.filter((r) => r.capture!.width === VIEWPORT.w && r.capture!.height === VIEWPORT.h);
  console.log(`\n=== capture ===`);
  console.log(`tab screenshots at 1:1 (${VIEWPORT.w}x${VIEWPORT.h}): ${oneToOne.length}/${captures.length}; crops identical to eval-real's (pixels and inner box): ${sameCrops.length}/${crops.length}`);
  for (const r of crops.filter((r) => !(r.crop!.samePixels && r.crop!.sameInner))) {
    const c = r.crop!;
    console.log(
      `  ${r.id}: ${c.width}x${c.height} vs eval ${c.eval.width}x${c.eval.height}` +
        (c.maxDiff !== null ? `, ${c.diffPixels} px differ (max ${c.maxDiff})` : '') +
        `, inner ${JSON.stringify(c.inner)} vs ${JSON.stringify(c.eval.inner)}`,
    );
  }
  if (compare) {
    console.log(`\n=== vs the engine-level eval: ${compare.file} (written ${compare.writtenAt}) ===`);
    if (compare.stale) console.log('WARNING: the engine, model or index changed after that file was written; re-run tools/eval-real.ts for a fair comparison');
    const compared = rows.filter((r) => r.eval);
    const evalCards = compared.filter((r) => r.kind === 'card');
    const evalNeg = compared.filter((r) => r.kind === 'negative');
    const evalRight = (r: RowResult) => r.eval!.top?.cardId === r.expected?.cardId;
    console.log(
      `eval on these rows: cards top-1 ${evalCards.filter(evalRight).length}/${evalCards.length}, confident ${evalCards.filter((r) => r.eval!.kind === 'confident').length}` +
        ` (wrong ${evalCards.filter((r) => r.eval!.kind === 'confident' && !evalRight(r)).length}); negatives confident ${evalNeg.filter((r) => r.eval!.kind === 'confident').length}/${evalNeg.length}`,
    );
    const differ = compared.filter((r) => r.differs.length);
    console.log(`answers that differ from the eval: ${differ.length}/${compared.length}`);
    for (const r of differ) console.log(`  ${r.id}: ${r.differs.join('; ')}`);
    const noted = compared.filter((r) => !r.differs.length && r.notes.length);
    if (noted.length) {
      console.log(`same answer, reached otherwise: ${noted.length}`);
      for (const r of noted) console.log(`  ${r.id}: ${r.notes.join('; ')}`);
    }
    const missing = rows.filter((r) => !r.eval).map((r) => r.id);
    if (missing.length) console.log(`not in the eval's file: ${missing.join(', ')}`);
  }
}

function timingOf(rows: RowResult[], compare: Compare | null) {
  const timed = rows.filter((r) => r.ms !== null);
  const warm = timed.slice(1);
  const evalMs = compare ? rows.map((r) => r.eval?.ms).filter((m): m is number => typeof m === 'number') : [];
  const outlined = rows.map((r) => r.click?.outlineMs).filter((m): m is number => typeof m === 'number');
  const detector = rows.map((r) => r.click?.detectorMs).filter((m): m is number => typeof m === 'number');
  return {
    firstScanMs: timed[0]?.ms ?? null,
    scan: stats(warm.map((r) => r.ms!)),
    engine: stats(rows.slice(1).map((r) => r.engineMs).filter((m): m is number => m !== null)),
    evalEngine: stats(evalMs),
    firstOutlinesMs: outlined[0] ?? null,
    outlines: stats(outlined.slice(1)),
    detector: stats(detector.slice(1)),
  };
}

// ---------- main ----------

/** --fake-detect: the corners of every labelled card, by frame (frame pixels); rows without a labelled box (capture-C's) have none. */
async function labelledBoxes(root: string): Promise<Map<string, Corners[]>> {
  const byFrame = new Map<string, Corners[]>();
  for (const e of await readJson<RealsetEntry[]>(path.join(root, 'data/realset/set.json'))) {
    if (e.rotatedBox) byFrame.set(e.frame, [...(byFrame.get(e.frame) ?? []), e.rotatedBox.pts]);
  }
  return byFrame;
}

export async function runReal({ root, dist, outDir, click = false, fake = false }: RealOptions): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const jobs = await loadJobs(root, args.limit, args.only);
  const compare = await loadCompare(root, args.compare);
  const evidenceDir = path.join(outDir, click ? 'real-click' : 'real');
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });

  const server = await serve(root);
  const port = (server.address() as AddressInfo).port;
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [dist],
    defaultViewport: { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1 },
    args: [`--window-size=${VIEWPORT.w},${VIEWPORT.h}`, '--force-device-scale-factor=1', '--no-first-run'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[page error]', e));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.bringToFront();
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
    const worker = (await sw.worker())!;
    // A fresh profile: close the welcome page the install opened, and agree to the first-run consent
    // (without it, every scan opens the consent step instead; run.ts checks that gate).
    await settleInstall(browser, page);
    await grantConsent(worker);
    const tapped = (await worker.evaluate(INSTALL_TAP)) as boolean;
    if (!tapped) console.log('(could not wrap chrome.runtime.sendMessage: no raw results or crop checks)');
    if (click && !(await installTabTap(worker, fake))) {
      // Without it, a detection's error (the only reason to skip) can't be read.
      throw new Error(`--click needs chrome.tabs.sendMessage wrapped in the service worker (${fake ? 'to send the fake detection' : 'to read the detection'}), and it could not be`);
    }
    const ctx: Context = {
      root,
      page,
      worker,
      cdp: await page.createCDPSession(),
      evidenceDir,
      compare,
      frames: new Map(),
      lastScanAt: 0,
      click,
      fakeBoxes: fake ? await labelledBoxes(root) : null,
      outlineTimeoutMs: 30000,
      detectorChecked: false,
    };
    const indexUpdateAtStart = await worker.evaluate(() => chrome.storage.local.get('indexUpdate'));

    const how = click ? (fake ? 'click to scan, fake detector (labelled boxes)' : 'click to scan') : 'drag';
    console.log(`Real footage (${how}): ${jobs.filter((j) => j.kind === 'card').length} cards, ${jobs.filter((j) => j.kind === 'negative').length} negatives (Chrome ${await browser.version()})\n`);
    const rows: RowResult[] = [];
    for (const job of jobs) {
      let row: RowResult;
      try {
        row = await scanRow(ctx, job);
      } catch (e) {
        if (e instanceof NoDetector) {
          await closePopover(page).catch(() => {});
          console.log(`\n${skipMessage(e.message)}`);
          return 0;
        }
        row = { ...emptyRow(job, compare), message: `ERROR ${(e as Error).message}` };
        await page.screenshot({ path: path.join(evidenceDir, `${job.id}.png`) }).catch(() => {});
        await closePopover(page).catch(() => {});
      }
      rows.push(row);
      console.log(rowLine(row));
    }
    const indexUpdateAtEnd = await worker.evaluate(() => chrome.storage.local.get('indexUpdate'));

    const timing = timingOf(rows, compare);
    printSummary(rows, compare, timing);
    const cards = rows.filter((r) => r.kind === 'card');
    const negatives = rows.filter((r) => r.kind === 'negative');
    const outFile = path.join(outDir, click ? 'real-click-results.json' : 'real-results.json');
    await writeFile(
      outFile,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          chrome: await browser.version(),
          build: path.relative(root, dist),
          viewport: { ...VIEWPORT, devicePixelRatio: 1 },
          args: { limit: args.limit ?? null, only: args.only ?? null, click, fakeDetect: fake },
          rawResultsRecorded: tapped,
          indexUpdate: { atStart: indexUpdateAtStart.indexUpdate ?? null, atEnd: indexUpdateAtEnd.indexUpdate ?? null },
          compare: compare && { file: compare.file, writtenAt: compare.writtenAt, stale: compare.stale },
          cards: { overall: cardTotals(cards), byProduction: byProduction(cards, cardTotals) },
          negatives: { overall: negativeTotals(negatives), byProduction: byProduction(negatives, negativeTotals) },
          timing,
          differences: rows.filter((r) => r.differs.length).map((r) => ({ id: r.id, differs: r.differs, notes: r.notes })),
          rows,
        },
        null,
        2,
      ),
    );
    const failed = rows.filter((r) => !r.ok).length;
    console.log(`\nE2E real: ${rows.length - failed}/${rows.length} rows pass; wrote ${path.relative(root, outFile)}`);
    return failed === 0 ? 0 : 1;
  } finally {
    await browser.close();
    server.close();
  }
}
