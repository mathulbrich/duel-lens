// Live check on real YouTube pages (needs the network; not part of CI): the extension scans labelled
// cards of the real set (data/realset/set.json) on the live videos they were captured from, the way a
// user would, and the answers are compared with the truth and with the offline numbers.
//
//   npx tsx tools/live-check/run.ts [--store] [--limit N] [--only id,id] [--mode default|theater|fullscreen]
//                                   [--headful] [--dpr N] [--viewport WxH] [--no-drag] [--controls]
//                                   [--quality 720|480] [--name run-name]
//
// For each pick (tools/live-check/lib/picks.ts): open its video (consent: "Reject all"; ads waited out),
// force the quality the frame was captured at (setPlaybackQualityRange), seek near the capture time and
// pause, find the moment and the place the real-set frame came from (NCC template match of the frame
// against the live picture, lib/match.ts), trigger a scan through the E2E hook (duelLensDebug.startScan),
// wait for the outlines, click the labelled box's centre mapped onto the page, and read the popover.
// Picks marked `drag` are also scanned by dragging their box. --controls leaves the pointer on the
// picture, so the player's controls show in the screenshot (the default hides them first).
//
// Builds: release/live-build (personal: node build.mjs --e2e --out release/live-build) or, with --store,
// release/live-build-store (node build.mjs --e2e --no-remote-images --out release/live-build-store).
// Output: test/e2e/out/live/<run>/results.json, shots/ (screenshots, crops, aligned frames). Real footage
// stays on this machine: that folder is gitignored and nothing is uploaded.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  closeOverlay,
  grantConsent,
  hostState,
  insideQuad,
  installTaps,
  outcomeOf,
  puppeteer,
  readRuntimeTap,
  readTabTap,
  readUi,
  resetRuntimeTap,
  settleInstall,
  sleep,
  waitForOutlines,
  waitForState,
  type Browser,
  type CDPSession,
  type DetectedBox,
  type Outcome,
  type Page,
  type UiRead,
  type WebWorker,
} from './lib/harness';
import { locate, scoreAt, type Placement } from './lib/match';
import { loadPicks, offlineResults, type Pick } from './lib/picks';
import { BotCheck, grabFrame, hideControls, openVideo, seekAtQuality, setMode, showControls, videoBox, type QualityInfo, type SeekInfo, type VideoBox } from './lib/youtube';

const root = path.resolve(import.meta.dirname, '../..');

// ---------- CLI ----------

function parseArgs(argv: string[]) {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const limit = value('--limit') ? Number(value('--limit')) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new Error('--limit needs a positive integer');
  const mode = (value('--mode') ?? 'default') as 'default' | 'theater' | 'fullscreen';
  if (!['default', 'theater', 'fullscreen'].includes(mode)) throw new Error('--mode is default, theater or fullscreen');
  const [vw, vh] = (value('--viewport') ?? '1728x1000').split('x').map(Number);
  const dpr = Number(value('--dpr') ?? 2);
  return {
    store: argv.includes('--store'),
    limit,
    only: value('--only')?.split(',').filter(Boolean) ?? null,
    mode,
    headful: argv.includes('--headful'),
    dpr,
    viewport: { w: vw, h: vh },
    drag: !argv.includes('--no-drag'),
    controls: argv.includes('--controls'),
    /** Serve this frame height instead of the one the frame was captured at (e.g. 720 or 480). */
    quality: value('--quality') ? Number(value('--quality')) : null,
    name: value('--name'),
  };
}

// ---------- results ----------

type Verdict = 'right' | 'not sure (right top)' | 'not sure (wrong top)' | 'nothing' | 'wrong' | 'no outline' | 'error' | 'by eye';

interface Row {
  id: string;
  how: 'click' | 'drag';
  production: string;
  video: string;
  truth: string | null;
  tags: string[];
  /** The moment scanned (the frame the NCC search picked) and how well the live picture matched the real-set frame. */
  t: number;
  tNominal: number;
  ncc: number;
  quality: { captured: number; auto: string | null; requested: string; reported: string; available: string[]; served: string };
  mode: string;
  controlsHidden: boolean;
  videoBox: { x: number; y: number; w: number; h: number };
  /** The labelled card on the page (CSS px) and where the pointer went. */
  cardCss: { x: number; y: number; w: number; h: number };
  at: { x: number; y: number };
  drag?: { x0: number; y0: number; x1: number; y1: number };
  screenshot: { width: number; height: number; bytes: number } | null;
  outlines: number | null;
  /** The click point inside a face-up detection (screenshot px); the nearest detection's centre distance otherwise (CSS px). */
  inOutline: boolean | null;
  nearestOutlinePx: number | null;
  /** faceUpOutsideVideo: outlines whose centre lies outside the video picture (page thumbnails, UI). */
  detection: { boxes: number; faceUp: number; faceUpOutsideVideo: number; error: string | null; ms: number | null } | null;
  outcome: Outcome;
  verdict: Verdict;
  top: string | null;
  others: string[];
  matchLine: string | null;
  confidentScore: number | null;
  raw: { recognizer: string | null; confident: boolean; top: { cardId: number; score: number }[]; timings: Record<string, number> } | null;
  crop: { source: string; width: number; height: number; videoHeight: number | null } | null;
  timings: { toFrozen: number | null; toOutlines: number | null; detector: number | null; clickToAnswer: number | null; engine: number | null };
  ui: UiRead | null;
  offline: { eval: string | null; click: string | null } | null;
  shots: { outlines?: string; answer?: string; crop?: string };
  message?: string;
}

function verdictOf(pick: Pick, outcome: Outcome, top: string | null): Verdict {
  if (outcome === 'no-outline') return 'no outline';
  if (outcome === 'error') return 'error';
  if (outcome === 'nothing' || outcome === 'face-down') return 'nothing';
  if (!pick.truth) return 'by eye';
  const right = top === pick.truth.name;
  if (outcome === 'confident') return right ? 'right' : 'wrong';
  return right ? 'not sure (right top)' : 'not sure (wrong top)';
}

// ---------- one frame: find the moment and the place ----------

interface Alignment {
  /** What YouTube picked by itself on load (before the quality was forced). */
  auto?: { autoQuality: string; autoHeight: number };
  t: number;
  ncc: number;
  place: Placement;
  seek: SeekInfo;
  quality: QualityInfo;
  frameShot: string;
}

async function align(ctx: Ctx, pick: Pick): Promise<Alignment> {
  const { page, log } = ctx;
  let place: (Placement & { height: number }) | null = null;
  let best: { t: number; score: number; place: Placement } | null = null;
  const tried: { t: number; score: number; h: number }[] = [];
  const want = ctx.args.quality ?? pick.capturedHeight;
  const measure = async (t: number) => {
    const { seek } = await seekAtQuality(page, t, want, log);
    if (seek.hung || !seek.videoWidth) {
      tried.push({ t, score: -1, h: seek.videoHeight });
      return -1;
    }
    const frame = await grabFrame(page);
    const scale = (pick.templateScale * seek.videoHeight) / pick.capturedHeight;
    let score: number;
    if (!place || place.score < 0.6 || place.height !== seek.videoHeight) {
      const prior = pick.origin ? { x: (pick.origin.x * seek.videoHeight) / pick.capturedHeight, y: (pick.origin.y * seek.videoHeight) / pick.capturedHeight } : undefined;
      let p = await locate(frame, pick.template, { scales: [scale], prior, priorRadius: 30 });
      if (p.score < 0.6 && prior) p = await locate(frame, pick.template, { scales: [scale] });
      place = { ...p, height: seek.videoHeight };
      score = p.score;
    } else {
      score = await scoreAt(frame, pick.template, place, 2);
    }
    tried.push({ t: seek.currentTime, score: Math.round(score * 1000) / 1000, h: seek.videoHeight });
    if (!best || score > best.score) best = { t: seek.currentTime, score, place: { x: place.x, y: place.y, scale: place.scale, score } };
    return score;
  };
  // Whole seconds over the window (stopping early only on a near-identical frame), then ±0.5 s around
  // the best: a card whose score sits near the floor can flip on a neighbouring frame (Ponix, t=10399
  // vs 10400), so the moment must be the capture's, not merely close to it.
  for (let dt = pick.search[0]; dt <= pick.search[1]; dt += 1) {
    const s = await measure(pick.t + dt);
    if (s >= 0.997) break;
  }
  const b0 = best!;
  if (b0.score < 0.997) {
    for (const d of [-0.5, 0.5]) await measure(b0.t + d);
  }
  const b = best as unknown as { t: number; score: number; place: Placement };
  const { seek, quality } = await seekAtQuality(page, b.t, want, log);
  const frame = await grabFrame(page, 'image/png');
  const shot = path.join(ctx.shots, `${path.basename(pick.template, '.png')}-t${Math.round(b.t * 10) / 10}.png`);
  await writeFile(shot, frame);
  const final = await scoreAt(frame, pick.template, b.place, 2);
  log(`  aligned ${path.basename(pick.template)} at t=${seek.currentTime.toFixed(2)} (nominal ${pick.t}) ncc ${final.toFixed(3)}; served ${seek.videoWidth}x${seek.videoHeight} (${seek.quality}); tried ${tried.map((x) => `${x.t.toFixed(1)}:${x.score}`).join(' ')}`);
  return { t: seek.currentTime, ncc: final, place: { ...b.place, score: final }, seek, quality, frameShot: path.relative(root, shot) };
}

// ---------- one scan ----------

interface Ctx {
  browser: Browser;
  page: Page;
  worker: WebWorker;
  cdp: CDPSession;
  out: string;
  shots: string;
  args: ReturnType<typeof parseArgs>;
  offline: ReturnType<typeof offlineResults>;
  log: (m: string) => void;
  lastScanAt: number;
}

async function shoot(ctx: Ctx, name: string, clip?: { x: number; y: number; w: number; h: number }): Promise<string> {
  const file = path.join(ctx.shots, `${name}.jpg`);
  const vp = ctx.page.viewport()!;
  const c = clip && {
    x: Math.max(0, Math.floor(clip.x)),
    y: Math.max(0, Math.floor(clip.y)),
    width: Math.min(vp.width, Math.ceil(clip.x + clip.w)) - Math.max(0, Math.floor(clip.x)),
    height: Math.min(vp.height, Math.ceil(clip.y + clip.h)) - Math.max(0, Math.floor(clip.y)),
  };
  await ctx.page.screenshot({ path: file, type: 'jpeg', quality: 82, ...(c ? { clip: c } : {}) });
  return path.relative(root, file);
}

async function scan(ctx: Ctx, pick: Pick, al: Alignment, how: 'click' | 'drag'): Promise<Row> {
  const { page, worker, cdp, log } = ctx;
  const controlsHidden = ctx.args.controls ? (await showControls(page), false) : await hideControls(page);
  const vb: VideoBox = await videoBox(page);
  const k = vb.w / vb.videoWidth; // CSS px per video px
  const scale = (al.place.scale * vb.videoHeight) / (al.seek.videoHeight || vb.videoHeight);
  const css = (px: number, py: number) => ({ x: vb.x + (al.place.x + px * scale) * k, y: vb.y + (al.place.y + py * scale) * k });
  const tl = css(pick.box.x, pick.box.y);
  const br = css(pick.box.x + pick.box.w, pick.box.y + pick.box.h);
  const centre = { x: (tl.x + br.x) / 2, y: (tl.y + br.y) / 2 };
  const cardCss = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const row: Row = {
    id: pick.id,
    how,
    production: pick.production,
    video: `https://youtu.be/${pick.videoId}?t=${Math.floor(al.t)}`,
    truth: pick.truth?.name ?? null,
    tags: pick.tags,
    t: Math.round(al.t * 100) / 100,
    tNominal: pick.t,
    ncc: Math.round(al.ncc * 1000) / 1000,
    quality: { captured: pick.capturedHeight, auto: al.auto ? `${al.auto.autoHeight}p (${al.auto.autoQuality})` : null, requested: al.quality.requested, reported: al.seek.quality, available: al.quality.available, served: `${vb.videoWidth}x${vb.videoHeight}` },
    mode: vb.mode,
    controlsHidden,
    videoBox: { x: r1(vb.x), y: r1(vb.y), w: r1(vb.w), h: r1(vb.h) },
    cardCss: { x: r1(cardCss.x), y: r1(cardCss.y), w: r1(cardCss.w), h: r1(cardCss.h) },
    at: { x: r1(centre.x), y: r1(centre.y) },
    screenshot: null,
    outlines: null,
    inOutline: null,
    nearestOutlinePx: null,
    detection: null,
    outcome: 'error',
    verdict: 'error',
    top: null,
    others: [],
    matchLine: null,
    confidentScore: null,
    raw: null,
    crop: null,
    timings: { toFrozen: null, toOutlines: null, detector: null, clickToAnswer: null, engine: null },
    ui: null,
    offline: ctx.offline.get(pick.id) ?? null,
    shots: {},
  };
  const tag = `${pick.id}-${how}`;

  // The shortcut (captureVisibleTab allows 2 a second).
  await sleep(Math.max(0, ctx.lastScanAt + 700 - Date.now()));
  await installTaps(worker);
  await resetRuntimeTap(worker);
  const t0 = Date.now();
  ctx.lastScanAt = t0;
  await worker.evaluate('globalThis.duelLensDebug.startScan()');
  if (!(await waitForState(page, ['selecting'], 10000))) {
    row.message = 'the frozen frame never appeared';
    row.shots.answer = await shoot(ctx, `${tag}-nofreeze`);
    return row;
  }
  row.timings.toFrozen = Date.now() - t0;
  const n = await waitForOutlines(page, 30000);
  row.timings.toOutlines = n === null ? null : Date.now() - t0;
  row.outlines = n;
  const tap = await readTabTap(worker);
  row.screenshot = tap?.begin?.shot ? { ...tap.begin.shot, bytes: tap.begin.bytes } : null;
  const det = tap?.detected.find((d) => d.capturedAt === tap.begin?.capturedAt);
  if (det) {
    const faceUp = det.boxes.filter((b: DetectedBox) => b.kind !== 'face-down');
    const sx = det.width / vb.viewport.w;
    const sy = det.height / vb.viewport.h;
    const outside = faceUp.filter((b) => {
      const cx = b.pts.reduce((s, q) => s + q[0], 0) / 4 / sx;
      const cy = b.pts.reduce((s, q) => s + q[1], 0) / 4 / sy;
      return cx < vb.x || cy < vb.y || cx > vb.x + vb.w || cy > vb.y + vb.h;
    }).length;
    row.detection = { boxes: det.boxes.length, faceUp: faceUp.length, faceUpOutsideVideo: outside, error: det.error, ms: det.ms ?? null };
    row.timings.detector = det.ms ?? null;
    const p = [centre.x * sx, centre.y * sy];
    row.inOutline = faceUp.some((b) => insideQuad(b.pts, p[0], p[1]));
    let nearest = Infinity;
    for (const b of faceUp) {
      const cx = b.pts.reduce((s, q) => s + q[0], 0) / 4 / sx;
      const cy = b.pts.reduce((s, q) => s + q[1], 0) / 4 / sy;
      nearest = Math.min(nearest, Math.hypot(cx - centre.x, cy - centre.y));
    }
    row.nearestOutlinePx = Number.isFinite(nearest) ? Math.round(nearest) : null;
  }
  const pad = 60;
  row.shots.outlines = await shoot(ctx, `${tag}-outlines`, { x: vb.x - pad, y: vb.y - pad, w: vb.w + 2 * pad, h: vb.h + 2 * pad });

  // The click (or the drag).
  const tClick = Date.now();
  if (how === 'click') {
    await page.mouse.click(centre.x, centre.y);
  } else {
    const d = { x0: tl.x - 4, y0: tl.y - 4, x1: br.x + 4, y1: br.y + 4 };
    row.drag = { x0: r1(d.x0), y0: r1(d.y0), x1: r1(d.x1), y1: r1(d.y1) };
    await page.mouse.move(d.x0, d.y0);
    await page.mouse.down();
    await page.mouse.move((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2, { steps: 5 });
    await page.mouse.move(d.x1, d.y1, { steps: 5 });
    await page.mouse.up();
  }
  const started = await waitForState(page, ['scanning', 'result', 'error'], 1500);
  if (!started) {
    row.outcome = 'no-outline';
    row.verdict = 'no outline';
    row.message = `no scan started: the click fell on no outline (${n ?? 'no'} outlines; nearest centre ${row.nearestOutlinePx ?? '-'} CSS px away)`;
    row.shots.answer = await shoot(ctx, `${tag}-nooutline`);
    await closeOverlay(page);
    return row;
  }
  const state = await waitForState(page, ['result', 'error'], 60000);
  row.timings.clickToAnswer = state ? Date.now() - tClick : null;
  await sleep(1500); // the card image (personal builds) arrives after the answer
  const ui = await readUi(cdp);
  row.ui = ui;
  const oc = outcomeOf(state?.state ?? null, ui);
  row.outcome = oc.outcome;
  row.top = oc.top;
  row.others = oc.others;
  row.matchLine = ui?.matchLine ?? null;
  if (oc.message) row.message = oc.message;
  row.verdict = verdictOf(pick, oc.outcome, oc.top);
  const raw = await readRuntimeTap(worker);
  if (raw?.result) {
    const r = raw.result;
    row.raw = {
      recognizer: r.recognizer ?? null,
      confident: r.confident === true,
      top: (r.candidates ?? []).slice(0, 3).map((c: { cardId: number; score: number }) => ({ cardId: c.cardId, score: Math.round(c.score * 1000) / 1000 })),
      timings: r.timings ?? {},
    };
    row.timings.engine = r.timings?.total ?? null;
    row.confidentScore = r.candidates?.[0]?.score ?? null;
  }
  if (raw?.crop) {
    row.crop = { source: raw.crop.source, width: raw.crop.width, height: raw.crop.height, videoHeight: raw.crop.videoHeight ?? null };
    const file = path.join(ctx.shots, `${tag}-crop.png`);
    await writeFile(file, Buffer.from(raw.crop.dataUrl.split(',')[1], 'base64'));
    row.shots.crop = path.relative(root, file);
  }
  row.shots.answer = await shoot(ctx, `${tag}-answer`);
  if (!(await closeOverlay(page))) row.message = `${row.message ? `${row.message}; ` : ''}Esc did not close the popover`;
  return row;
}

// ---------- main ----------

function summarise(rows: Row[]) {
  const by = (f: (r: Row) => boolean) => rows.filter(f).length;
  return {
    n: rows.length,
    right: by((r) => r.verdict === 'right'),
    notSureRightTop: by((r) => r.verdict === 'not sure (right top)'),
    notSureWrongTop: by((r) => r.verdict === 'not sure (wrong top)'),
    nothing: by((r) => r.verdict === 'nothing'),
    wrong: by((r) => r.verdict === 'wrong'),
    noOutline: by((r) => r.verdict === 'no outline'),
    error: by((r) => r.verdict === 'error'),
    byEye: by((r) => r.verdict === 'by eye'),
  };
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const build = path.join(root, args.store ? 'release/live-build-store' : 'release/live-build');
  if (!existsSync(path.join(build, 'manifest.json'))) {
    throw new Error(`no build at ${path.relative(root, build)}: run node build.mjs --e2e${args.store ? ' --no-remote-images' : ''} --out ${path.relative(root, build)}`);
  }
  let picks = loadPicks();
  if (args.only) picks = picks.filter((p) => args.only!.includes(p.id));
  if (args.limit) picks = picks.slice(0, args.limit);
  const run = args.name ?? `${args.store ? 'store' : 'personal'}-${args.mode}${args.controls ? '-controls' : ''}${args.quality ? `-${args.quality}p` : ''}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const out = path.join(root, 'test/e2e/out/live', run);
  const shots = path.join(out, 'shots');
  await mkdir(shots, { recursive: true });
  const logLines: string[] = [];
  const log = (m: string) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
    logLines.push(line);
    console.log(line);
  };

  const browser = await puppeteer.launch({
    headless: !args.headful,
    pipe: true,
    enableExtensions: [build],
    defaultViewport: { width: args.viewport.w, height: args.viewport.h, deviceScaleFactor: args.dpr },
    // --disable-audio-output: a fake audio sink. Without it the media clock never starts here (no audio
    // device for the automated browser), so a playing video never advances.
    args: [`--window-size=${args.viewport.w},${args.viewport.h}`, `--force-device-scale-factor=${args.dpr}`, '--no-first-run', '--lang=en-US', '--autoplay-policy=no-user-gesture-required', '--disable-audio-output'],
  });
  const rows: Row[] = [];
  const aligned: Record<string, Omit<Alignment, 'place'> & { place: Placement }> = {};
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
    const worker = (await sw.worker())!;
    await settleInstall(browser, page);
    await grantConsent(worker);
    if (!(await installTaps(worker))) log('could not tap the service worker (no raw answers or detections)');
    const ctx: Ctx = { browser, page, worker, cdp: await page.createCDPSession(), out, shots, args, offline: offlineResults(), log, lastScanAt: 0 };
    log(`${picks.length} picks, ${args.store ? 'store' : 'personal'} build, ${args.mode} view, viewport ${args.viewport.w}x${args.viewport.h} at devicePixelRatio ${args.dpr}, ${args.headful ? 'headful' : 'headless'} (${await browser.version()})`);

    // Picks grouped by video, then by frame (one alignment per frame).
    const videos = new Map<string, Pick[]>();
    for (const p of picks) videos.set(p.videoId, [...(videos.get(p.videoId) ?? []), p]);
    for (const [videoId, vpicks] of videos) {
      log(`video ${videoId}: ${vpicks.length} picks`);
      const frames = new Map<string, Pick[]>();
      for (const p of vpicks) frames.set(`${p.template}@${p.t}`, [...(frames.get(`${p.template}@${p.t}`) ?? []), p]);
      for (const group of frames.values()) {
        // One page load per moment: YouTube serves automated browsers only ~20 s after a load (openVideo).
        let auto: { autoQuality: string; autoHeight: number };
        try {
          auto = await openVideo(page, videoId, group[0].t + group[0].search[0], log);
          await setMode(page, args.mode, log);
        } catch (e) {
          if (e instanceof BotCheck) throw e;
          log(`  could not open ${videoId} at ${group[0].t}: ${(e as Error).message}`);
          await page.screenshot({ path: path.join(shots, `open-${videoId}-${group[0].t}.jpg`), type: 'jpeg', quality: 70 }).catch(() => {});
          continue;
        }
        let al: Alignment;
        try {
          al = await align(ctx, group[0]);
        } catch (e) {
          log(`  alignment failed for ${group[0].id}: ${(e as Error).message}`);
          continue;
        }
        al.auto = auto;
        aligned[path.basename(group[0].template)] = al;
        for (const pick of group) {
          for (const how of pick.drag && args.drag ? (['click', 'drag'] as const) : (['click'] as const)) {
            let row: Row;
            try {
              row = await scan(ctx, pick, al, how);
            } catch (e) {
              log(`  ${pick.id} ${how}: ERROR ${(e as Error).stack}`);
              await closeOverlay(page).catch(() => false);
              continue;
            }
            rows.push(row);
            log(
              `  ${row.verdict.padEnd(20)} ${pick.id} (${how}): ${row.top ?? row.outcome}` +
                `${row.truth && row.top !== row.truth ? ` [truth ${row.truth}]` : ''} · ${row.matchLine ?? ''} · served ${row.quality.served}` +
                ` · outlines ${row.outlines ?? '-'} (${row.detection?.faceUpOutsideVideo ?? '-'} outside the video; hit ${row.inOutline}) · shortcut→outlines ${row.timings.toOutlines ?? '-'} ms, click→answer ${row.timings.clickToAnswer ?? '-'} ms` +
                ` · card ${Math.round(row.cardCss.w)}x${Math.round(row.cardCss.h)} CSS px${row.message ? ` · ${row.message}` : ''}`,
            );
            // The popover must be gone before the next scan (it is taken off the page before a capture anyway).
            if (await hostState(page)) await closeOverlay(page);
          }
        }
      }
    }
  } finally {
    const clicks = rows.filter((r) => r.how === 'click');
    const drags = rows.filter((r) => r.how === 'drag');
    const summary = {
      at: new Date().toISOString(),
      build: args.store ? 'release/live-build-store' : 'release/live-build',
      args,
      chrome: await browser.version().catch(() => null),
      clicks: summarise(clicks),
      drags: summarise(drags),
      timing: {
        toOutlinesMedian: median(clicks.map((r) => r.timings.toOutlines ?? NaN)),
        detectorMedian: median(clicks.map((r) => r.timings.detector ?? NaN)),
        clickToAnswerMedian: median(clicks.map((r) => r.timings.clickToAnswer ?? NaN)),
        engineMedian: median(clicks.map((r) => r.timings.engine ?? NaN)),
      },
      served: Object.fromEntries(Object.entries(aligned).map(([k, a]) => [k, { t: a.t, ncc: a.ncc, auto: a.auto ?? null, served: `${a.seek.videoWidth}x${a.seek.videoHeight}`, reported: a.seek.quality, frame: a.frameShot }])),
      rows,
    };
    await writeFile(path.join(out, 'results.json'), JSON.stringify(summary, null, 2));
    await writeFile(path.join(out, 'log.txt'), logLines.join('\n'));
    console.log(`\nclicks: ${JSON.stringify(summary.clicks)}\ndrags: ${JSON.stringify(summary.drags)}\ntiming: ${JSON.stringify(summary.timing)}`);
    console.log(`wrote ${path.relative(root, path.join(out, 'results.json'))}`);
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
