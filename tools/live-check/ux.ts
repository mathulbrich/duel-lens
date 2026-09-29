// UX walk-through on real YouTube pages (needs the network; not part of CI): the situations a user
// meets, each with screenshots for a person to look at, and the measurements that go with them.
//
//   npx tsx tools/live-check/ux.ts [--store] [--only name,name] [--headful]
//
// Scenarios: default / theater / fullscreen (outlines and popover placement), the player's controls
// over the bottom cards, scanning while the video plays, Esc and clicking outside (does the click reach
// the video?), a second scan while a popover is open, popovers near the edges, the hint, tiny cards,
// a frame with no cards, the side panel's history (the time link back to the video), and, with
// --store, the popover's own-crop picture. Output: test/e2e/out/live/ux-<build>/ (ux.json, *.png).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  closeOverlay,
  grantConsent,
  hostState,
  installTaps,
  puppeteer,
  readRuntimeTap,
  readTabTap,
  readUi,
  resetRuntimeTap,
  settleInstall,
  sleep,
  waitForOutlines,
  waitForState,
  type CDPSession,
  type Page,
  type UiRead,
  type WebWorker,
} from './lib/harness';
import { locate } from './lib/match';
import { grabFrame, hideControls, openVideo, seekAtQuality, setMode, showControls, videoBox, type VideoBox } from './lib/youtube';

const root = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const store = argv.includes('--store');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
// --viewport WxH and --dpr N: another screen (default: a 16-inch MacBook Pro's 1728x1000 at 2x).
const VIEW = (() => {
  const v = argv.includes('--viewport') ? argv[argv.indexOf('--viewport') + 1].split('x').map(Number) : [1728, 1000];
  const dpr = argv.includes('--dpr') ? Number(argv[argv.indexOf('--dpr') + 1]) : 2;
  return { w: v[0], h: v[1], dpr };
})();
// --real-window (with --headful): no emulated viewport, the real window at the screen's own scale, so
// fullscreen fills the real screen (headless fullscreen shrinks to an 800x600 screen).
const realWindow = argv.includes('--real-window');
const out = path.join(root, 'test/e2e/out/live', `ux-${store ? 'store' : 'personal'}${realWindow ? '-window' : ''}${argv.includes('--viewport') ? `-${VIEW.w}x${VIEW.h}` : ''}`);

interface Ctx {
  page: Page;
  worker: WebWorker;
  cdp: CDPSession;
  extId: string;
  lastScan: number;
}

const notes: Record<string, unknown> = {};
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function shot(ctx: Ctx, name: string): Promise<string> {
  const file = path.join(out, `${name}.png`);
  await ctx.page.screenshot({ path: file });
  return path.relative(root, file);
}

/** The shortcut: returns once the frozen frame shows its outlines (or none came). */
async function startScan(ctx: Ctx, outlinesMs = 20000) {
  await sleep(Math.max(0, ctx.lastScan + 700 - Date.now()));
  await installTaps(ctx.worker);
  await resetRuntimeTap(ctx.worker);
  const t0 = Date.now();
  ctx.lastScan = t0;
  await ctx.worker.evaluate('globalThis.duelLensDebug.startScan()');
  const frozen = await waitForState(ctx.page, ['selecting'], 10000);
  const toFrozen = frozen ? Date.now() - t0 : null;
  // The hint as it is before the detector answers ("Finding cards…").
  const early = await readUi(ctx.cdp);
  const n = await waitForOutlines(ctx.page, outlinesMs);
  const toOutlines = n === null ? null : Date.now() - t0;
  const tap = await readTabTap(ctx.worker);
  const det = tap?.detected.find((d) => d.capturedAt === tap.begin?.capturedAt) ?? null;
  const ui = await readUi(ctx.cdp);
  return { frozen: !!frozen, toFrozen, toOutlines, outlines: n, detection: det, shot: tap?.begin?.shot ?? null, earlyHint: early?.hint?.text ?? null, ui };
}

async function clickAndRead(ctx: Ctx, x: number, y: number) {
  const t0 = Date.now();
  await ctx.page.mouse.click(x, y);
  const started = await waitForState(ctx.page, ['scanning', 'result', 'error'], 1500);
  if (!started) return { started: false, ms: null, ui: await readUi(ctx.cdp), state: (await hostState(ctx.page))?.state ?? null };
  const st = await waitForState(ctx.page, ['result', 'error'], 60000);
  const ms = Date.now() - t0;
  await sleep(1500);
  return { started: true, ms, ui: await readUi(ctx.cdp), state: st?.state ?? null };
}

/** Where a card of a real-set frame is on the page now: NCC-locate the frame's crop in the live frame, map the box. */
async function cardOnPage(ctx: Ctx, template: string, box: { x: number; y: number; w: number; h: number }, templateScale = 1) {
  const frame = await grabFrame(ctx.page);
  const vb = await videoBox(ctx.page);
  const place = await locate(frame, template, { scales: [(templateScale * vb.videoHeight) / 1080] });
  const k = vb.w / vb.videoWidth;
  const x = vb.x + (place.x + box.x * place.scale) * k;
  const y = vb.y + (place.y + box.y * place.scale) * k;
  return { x, y, w: box.w * place.scale * k, h: box.h * place.scale * k, cx: x + (box.w * place.scale * k) / 2, cy: y + (box.h * place.scale * k) / 2, ncc: place.score, vb };
}

const inside = (r: { x: number; y: number; w: number; h: number } | null | undefined, v: { w: number; h: number } = VIEW) => !!r && r.x >= 0 && r.y >= 0 && r.x + r.w <= v.w && r.y + r.h <= v.h;

// ---------- the moments used ----------

const F = (f: string) => path.join(root, 'data/debug/frames', `${f}.png`);
const USER = { video: 'bBbjafm1u2Q', t: 26192.5, template: path.join(root, 'data/debug/fullview/fv-ycsm-t26191.png'), scale: 1920 / 1456 };
const OVERTAKE = { x: 457, y: 598, w: 91, h: 119 }; // in the full-view frame's px
const GY_RIGHT = { x: 1058, y: 456, w: 89, h: 115 };
const BUSY = { video: 'xS4oTSltEfs', t: 10402, template: F('native-t10400-mid') }; // 9 labelled cards
const PONIX = { x: 861, y: 3, w: 102, h: 141 };
const TINY = { video: 'OcVdanpRg5g', t: 7200, template: F('native-wc-t7200-top') };
const COMBINED = { x: 350, y: 177, w: 76, h: 109 };

async function goTo(ctx: Ctx, video: string, t: number, mode: 'default' | 'theater' | 'fullscreen' = 'default') {
  await openVideo(ctx.page, video, t - 1, log);
  await setMode(ctx.page, mode, log);
  await seekAtQuality(ctx.page, t, 1080, log);
  await hideControls(ctx.page);
}

// ---------- scenarios ----------

const scenarios: Record<string, (ctx: Ctx) => Promise<unknown>> = {
  /** Default, theater and fullscreen: do the outlines sit on the cards, and does the popover show inside the screen? */
  async modes(ctx) {
    const res: Record<string, unknown> = {};
    for (const mode of ['default', 'theater', 'fullscreen'] as const) {
      await goTo(ctx, USER.video, USER.t, mode);
      const card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
      const scan = await startScan(ctx);
      const outlineShot = await shot(ctx, `modes-${mode}-outlines`);
      // The outline nearest the card: how far its box is from the card's.
      const near = (scan.ui?.outlines ?? []).filter(Boolean).map((o) => ({ o: o!, d: Math.hypot(o!.x + o!.w / 2 - card.cx, o!.y + o!.h / 2 - card.cy) })).sort((a, b) => a.d - b.d)[0];
      const click = await clickAndRead(ctx, card.cx, card.cy);
      const answerShot = await shot(ctx, `modes-${mode}-answer`);
      res[mode] = {
        videoBox: card.vb,
        card: { x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.w), h: Math.round(card.h), ncc: card.ncc },
        outlines: scan.outlines,
        nearestOutline: near ? { ...near.o, centreOffPx: Math.round(near.d) } : null,
        toOutlines: scan.toOutlines,
        screenshot: scan.shot,
        answer: click.ui?.name ?? click.ui?.lead ?? null,
        match: click.ui?.matchLine ?? null,
        popover: click.ui?.popover ?? null,
        popoverInside: inside(click.ui?.popover, card.vb.viewport),
        popoverSide: click.ui?.popoverSide ?? null,
        clickToAnswer: click.ms,
        shots: [outlineShot, answerShot],
      };
      // Esc in fullscreen: does it close the popover, leave fullscreen, or both?
      if (mode === 'fullscreen') {
        await ctx.page.keyboard.press('Escape');
        await sleep(800);
        const after = await videoBox(ctx.page);
        (res[mode] as Record<string, unknown>).escInFullscreen = { popoverGone: !(await hostState(ctx.page)), stillFullscreen: after.mode === 'fullscreen' };
        await shot(ctx, `modes-fullscreen-after-esc`);
        await closeOverlay(ctx.page);
        await ctx.page.evaluate('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
        await sleep(600);
      } else {
        await closeOverlay(ctx.page);
      }
      log(`modes/${mode}: ${JSON.stringify(res[mode]).slice(0, 400)}`);
    }
    return res;
  },

  /** The player's controls showing (the pointer on the picture) when the shortcut is pressed: do they cover the bottom cards? */
  async controls(ctx) {
    await goTo(ctx, USER.video, USER.t, 'default');
    const card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    await showControls(ctx.page);
    const bar = (await ctx.page.evaluate(`(() => { const b = document.querySelector('.ytp-chrome-bottom'); const g = document.querySelector('.ytp-gradient-bottom'); const r = (e) => { if (!e) return null; const x = e.getBoundingClientRect(); return { x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height), opacity: getComputedStyle(e).opacity }; }; return { bar: r(b), gradient: r(g), hidden: document.getElementById('movie_player').classList.contains('ytp-autohide') }; })()`)) as Record<string, unknown>;
    const scan = await startScan(ctx);
    const s1 = await shot(ctx, 'controls-outlines');
    const click = await clickAndRead(ctx, card.cx, card.cy);
    const s2 = await shot(ctx, 'controls-answer');
    await closeOverlay(ctx.page);
    // The bottom row of the busy frame, with the controls showing.
    await goTo(ctx, BUSY.video, BUSY.t, 'default');
    const low = await cardOnPage(ctx, BUSY.template, { x: 1032, y: 367, w: 99, h: 140 }); // Mudragon, the lowest labelled card there
    await showControls(ctx.page);
    const scan2 = await startScan(ctx);
    const s3 = await shot(ctx, 'controls-busy-outlines');
    const click2 = await clickAndRead(ctx, low.cx, low.cy);
    const s4 = await shot(ctx, 'controls-busy-answer');
    await closeOverlay(ctx.page);
    return {
      controls: bar,
      overtake: { card: { y: Math.round(card.y), h: Math.round(card.h) }, outlines: scan.outlines, answer: click.ui?.name ?? click.ui?.lead ?? (click.started ? null : 'no scan: no outline under the click') },
      busyLowest: { card: { y: Math.round(low.y), h: Math.round(low.h), bottom: Math.round(low.y + low.h) }, videoBottom: Math.round(low.vb.y + low.vb.h), outlines: scan2.outlines, answer: click2.ui?.name ?? click2.ui?.lead ?? (click2.started ? null : 'no scan: no outline under the click') },
      shots: [s1, s2, s3, s4],
    };
  },

  /** The shortcut while the video plays: the frame freezes, the video keeps playing underneath. */
  async playing(ctx) {
    await goTo(ctx, BUSY.video, BUSY.t, 'default');
    await ctx.page.evaluate(`document.getElementById('movie_player').playVideo()`);
    await sleep(1500);
    const before = await videoBox(ctx.page);
    const card = await cardOnPage(ctx, BUSY.template, PONIX);
    const scan = await startScan(ctx);
    const s1 = await shot(ctx, 'playing-outlines');
    await sleep(1500);
    const during = await videoBox(ctx.page);
    const click = await clickAndRead(ctx, card.cx, card.cy);
    const s2 = await shot(ctx, 'playing-answer');
    const after = await videoBox(ctx.page);
    const raw = await readRuntimeTap(ctx.worker);
    await closeOverlay(ctx.page);
    await ctx.page.evaluate(`document.getElementById('movie_player').pauseVideo()`);
    return {
      paused: { before: before.paused, whileFrozen: during.paused, afterAnswer: after.paused },
      time: { atShortcut: before.currentTime, whileFrozen: during.currentTime, atAnswer: after.currentTime },
      outlines: scan.outlines,
      answer: click.ui?.name ?? click.ui?.lead ?? null,
      match: click.ui?.matchLine ?? null,
      cropSource: raw?.crop?.source ?? null,
      shots: [s1, s2],
    };
  },

  /** Esc and clicking outside; and whether that outside click reaches the video (play/pause). */
  async dismiss(ctx) {
    await goTo(ctx, USER.video, USER.t, 'default');
    const card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    const res: Record<string, unknown> = {};
    // Esc on the frozen frame.
    await startScan(ctx);
    await ctx.page.keyboard.press('Escape');
    await sleep(500);
    res.escOnFrozenFrame = { closed: !(await hostState(ctx.page)) };
    // Esc on the popover.
    await startScan(ctx);
    await clickAndRead(ctx, card.cx, card.cy);
    await ctx.page.keyboard.press('Escape');
    await sleep(500);
    res.escOnPopover = { closed: !(await hostState(ctx.page)), videoPaused: (await videoBox(ctx.page)).paused };
    // A click outside the popover, on the video picture (away from the card).
    await startScan(ctx);
    const pop = await clickAndRead(ctx, card.cx, card.cy);
    const vb = await videoBox(ctx.page);
    const before = vb.paused;
    await ctx.page.mouse.click(vb.x + vb.w * 0.5, vb.y + vb.h * 0.35);
    await sleep(900);
    const afterBox = await videoBox(ctx.page);
    res.clickOnVideo = { popoverClosed: !(await hostState(ctx.page)), pausedBefore: before, pausedAfter: afterBox.paused, popover: pop.ui?.popover ?? null };
    await shot(ctx, 'dismiss-after-click-on-video');
    await ctx.page.evaluate(`document.getElementById('movie_player').pauseVideo()`);
    // A click outside, on the page (the title area below the player).
    await seekAtQuality(ctx.page, USER.t, 1080, log);
    await hideControls(ctx.page);
    await startScan(ctx);
    await clickAndRead(ctx, card.cx, card.cy);
    await ctx.page.mouse.click(vb.x + 40, vb.y + vb.h + 40);
    await sleep(600);
    res.clickOnPage = { popoverClosed: !(await hostState(ctx.page)), url: ctx.page.url() };
    // Clicking empty space on the frozen frame (no outline under it): what happens?
    await startScan(ctx);
    await ctx.page.mouse.click(vb.x + vb.w * 0.5, vb.y + vb.h * 0.35);
    await sleep(700);
    res.clickOnEmptyFrozen = { state: (await hostState(ctx.page))?.state ?? null, hint: (await readUi(ctx.cdp))?.hint?.text ?? null };
    await shot(ctx, 'dismiss-click-on-empty-frozen');
    await closeOverlay(ctx.page);
    return res;
  },

  /** A second shortcut while a popover is open. */
  async second(ctx) {
    await goTo(ctx, USER.video, USER.t, 'default');
    const card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    await startScan(ctx);
    await clickAndRead(ctx, card.cx, card.cy);
    const s1 = await shot(ctx, 'second-first-popover');
    const scan = await startScan(ctx);
    const s2 = await shot(ctx, 'second-frozen-again');
    // Did the old popover end up in the new screenshot? Look at the frozen frame where it was.
    const click = await clickAndRead(ctx, card.cx, card.cy);
    const s3 = await shot(ctx, 'second-answer');
    await closeOverlay(ctx.page);
    return { frozen: scan.frozen, toFrozen: scan.toFrozen, outlines: scan.outlines, answer: click.ui?.name ?? null, shots: [s1, s2, s3] };
  },

  /** Popovers near the edges: a card at the right edge in theater mode, and in fullscreen. */
  async edges(ctx) {
    const res: Record<string, unknown> = {};
    for (const mode of ['theater', 'fullscreen'] as const) {
      await goTo(ctx, USER.video, USER.t, mode);
      const card = await cardOnPage(ctx, USER.template, GY_RIGHT, USER.scale);
      await startScan(ctx);
      const click = await clickAndRead(ctx, card.cx, card.cy);
      const s = await shot(ctx, `edges-${mode}-gy`);
      const p = click.ui?.popover;
      const overlap = p ? !(p.x + p.w <= card.x || card.x + card.w <= p.x || p.y + p.h <= card.y || card.y + card.h <= p.y) : null;
      res[mode] = { card: { x: Math.round(card.x), y: Math.round(card.y), w: Math.round(card.w), h: Math.round(card.h) }, viewport: card.vb.viewport, popover: p, side: click.ui?.popoverSide, inside: inside(p, card.vb.viewport), coversCard: overlap, scroll: click.ui?.scroll, answer: click.ui?.name ?? null, shot: s };
      await closeOverlay(ctx.page);
      if (mode === 'fullscreen') await ctx.page.evaluate('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
      await sleep(600);
    }
    // A card near the bottom of the viewport: the lowest card of the busy frame in theater mode.
    await goTo(ctx, BUSY.video, BUSY.t, 'theater');
    const low = await cardOnPage(ctx, BUSY.template, { x: 1032, y: 367, w: 99, h: 140 });
    await startScan(ctx);
    const click = await clickAndRead(ctx, low.cx, low.cy);
    res.theaterLowCard = { card: { y: Math.round(low.y), h: Math.round(low.h) }, popover: click.ui?.popover, side: click.ui?.popoverSide, inside: inside(click.ui?.popover), shot: await shot(ctx, 'edges-theater-low') };
    await closeOverlay(ctx.page);
    return res;
  },

  /** Tiny cards (World Championship, ~70x95 px at 1080p): their size on the page, outlines and answers. */
  async tiny(ctx) {
    await goTo(ctx, TINY.video, TINY.t, 'default');
    const card = await cardOnPage(ctx, TINY.template, COMBINED);
    const scan = await startScan(ctx);
    const s1 = await shot(ctx, 'tiny-outlines');
    const click = await clickAndRead(ctx, card.cx, card.cy);
    const s2 = await shot(ctx, 'tiny-answer');
    await closeOverlay(ctx.page);
    return { cardCss: { w: Math.round(card.w), h: Math.round(card.h) }, ncc: card.ncc, outlines: scan.outlines, detections: scan.detection?.boxes.length ?? null, answer: click.ui?.name ?? click.ui?.lead ?? (click.started ? null : 'no scan'), match: click.ui?.matchLine ?? null, shots: [s1, s2] };
  },

  /** A frame with no cards (a caster/desk shot): what the hint says, and a drag on nothing. */
  async nocards(ctx) {
    // The WC stream's opening minutes show the stage and casters, not the table.
    await openVideo(ctx.page, 'OcVdanpRg5g', 60, log);
    await setMode(ctx.page, 'default', log);
    await seekAtQuality(ctx.page, 62, 1080, log);
    await hideControls(ctx.page);
    const scan = await startScan(ctx, 20000);
    await sleep(1800); // past FINDING_MS
    const ui = await readUi(ctx.cdp);
    const s1 = await shot(ctx, 'nocards-frozen');
    // A drag over something that is not a card.
    const vb = await videoBox(ctx.page);
    await ctx.page.mouse.move(vb.x + vb.w * 0.4, vb.y + vb.h * 0.4);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(vb.x + vb.w * 0.47, vb.y + vb.h * 0.5, { steps: 5 });
    await ctx.page.mouse.move(vb.x + vb.w * 0.52, vb.y + vb.h * 0.6, { steps: 5 });
    await ctx.page.mouse.up();
    await waitForState(ctx.page, ['result', 'error'], 30000);
    await sleep(800);
    const answer = await readUi(ctx.cdp);
    const s2 = await shot(ctx, 'nocards-drag-answer');
    await closeOverlay(ctx.page);
    return { outlines: scan.outlines, toOutlines: scan.toOutlines, earlyHint: scan.earlyHint, hint: ui?.hint?.text ?? null, dragAnswer: answer?.lead ?? answer?.name ?? null, notes: answer?.notes ?? null, shots: [s1, s2] };
  },

  /**
   * What the detector outlines on busy frames: the frozen frame with every face-up outline drawn in
   * magenta and its confidence (outlines-<frame>.png), to judge legibility and false outlines.
   */
  async outlines(ctx) {
    const frames = [
      { name: 'wc-t7200', video: 'OcVdanpRg5g', t: 7200 },
      { name: 'ycs-t10400', video: BUSY.video, t: 10400 },
      { name: 'tsc-t1201', video: 'iDSpAMCBfgM', t: 1202 },
      { name: 'dlaw-t1201', video: 'tfyHIQUcAV8', t: 1204 },
      { name: 'hgg-t2951', video: 'hLbNCdBs0Hc', t: 2951.5 },
    ];
    const res: Record<string, unknown> = {};
    for (const f of frames) {
      await goTo(ctx, f.video, f.t, 'default');
      const scan = await startScan(ctx);
      const plain = path.join(out, `outlines-${f.name}.png`);
      await ctx.page.screenshot({ path: plain });
      const det = scan.detection;
      const vw = (await ctx.page.evaluate('innerWidth')) as number;
      if (det && det.width) {
        const k = (VIEW.dpr * vw) / det.width; // screenshot px -> page screenshot device px
        const shapes = det.boxes
          .map((b) => {
            const pts = b.pts.map(([x, y]) => `${(x * k).toFixed(1)},${(y * k).toFixed(1)}`).join(' ');
            const [x0, y0] = b.pts[0];
            const colour = b.kind === 'face-down' ? '#00e5ff' : '#ff00d4';
            return `<polygon points="${pts}" fill="none" stroke="${colour}" stroke-width="4"/><text x="${(x0 * k).toFixed(0)}" y="${(y0 * k - 6).toFixed(0)}" fill="${colour}" font-size="26" font-family="Helvetica" font-weight="bold">${b.conf.toFixed(2)}${b.kind === 'face-down' ? ' fd' : ''}</text>`;
          })
          .join('');
        const { default: sharp } = await import('sharp');
        const meta = await sharp(plain).metadata();
        const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${shapes}</svg>`);
        await sharp(plain).composite([{ input: svg, top: 0, left: 0 }]).toFile(path.join(out, `outlines-${f.name}-marked.png`));
      }
      res[f.name] = { outlines: scan.outlines, boxes: det?.boxes.map((b) => ({ conf: Math.round(b.conf * 100) / 100, kind: b.kind })) ?? null, detectorMs: det?.ms ?? null, toOutlines: scan.toOutlines };
      await closeOverlay(ctx.page);
    }
    return res;
  },

  /**
   * The player's own keys while Duel Lens is open: F (fullscreen) with the popover showing, and T
   * (theater) on the frozen frame. Does the overlay follow the new layout?
   */
  async layout(ctx) {
    const res: Record<string, unknown> = {};
    await goTo(ctx, USER.video, USER.t, 'default');
    let card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    await startScan(ctx);
    const first = await clickAndRead(ctx, card.cx, card.cy);
    await ctx.page.keyboard.press('f');
    await sleep(1500);
    const afterF = await videoBox(ctx.page);
    const ui = await readUi(ctx.cdp);
    const cardNow = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    res.fWithPopover = {
      mode: afterF.mode,
      popoverStillOpen: !!(await hostState(ctx.page)),
      popoverBefore: first.ui?.popover ?? null,
      popoverAfter: ui?.popover ?? null,
      anchorBox: ui?.selection ?? null,
      cardNow: { x: Math.round(cardNow.x), y: Math.round(cardNow.y), w: Math.round(cardNow.w), h: Math.round(cardNow.h) },
      shot: await shot(ctx, 'layout-f-with-popover'),
    };
    await closeOverlay(ctx.page);
    await ctx.page.evaluate('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
    await sleep(1000);
    await setMode(ctx.page, 'default', log);
    await hideControls(ctx.page);
    card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    await startScan(ctx);
    await ctx.page.keyboard.press('t');
    await sleep(1500);
    const afterT = await videoBox(ctx.page);
    const s1 = await shot(ctx, 'layout-t-on-frozen-frame');
    const click = await clickAndRead(ctx, card.cx, card.cy);
    const cardLive = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    res.tOnFrozenFrame = {
      mode: afterT.mode,
      answer: click.ui?.name ?? click.ui?.lead ?? null,
      anchorBox: click.ui?.selection ?? null,
      cardWhereItIsNow: { x: Math.round(cardLive.x), y: Math.round(cardLive.y), w: Math.round(cardLive.w), h: Math.round(cardLive.h) },
      shots: [s1, await shot(ctx, 'layout-t-answer')],
    };
    await closeOverlay(ctx.page);
    await setMode(ctx.page, 'default', log);
    return res;
  },

  /** The stream's own featured-card panel (a clean, large card image inside the video): outlined, and read? */
  async panel(ctx) {
    await goTo(ctx, USER.video, USER.t, 'default');
    const card = await cardOnPage(ctx, USER.template, { x: 1225, y: 505, w: 200, h: 290 }, USER.scale);
    const scan = await startScan(ctx);
    const click = await clickAndRead(ctx, card.cx, card.cy);
    const s = await shot(ctx, 'panel-answer');
    await closeOverlay(ctx.page);
    return { outlines: scan.outlines, started: click.started, answer: click.ui?.name ?? click.ui?.lead ?? null, match: click.ui?.matchLine ?? null, shot: s };
  },

  /** The side panel's history: entries, their time link back to the video. */
  async sidepanel(ctx) {
    await goTo(ctx, USER.video, USER.t, 'default');
    const card = await cardOnPage(ctx, USER.template, OVERTAKE, USER.scale);
    await startScan(ctx);
    const click = await clickAndRead(ctx, card.cx, card.cy);
    // "Keep in side panel" (K): what happens without a real side panel to open?
    await ctx.page.keyboard.press('k');
    await sleep(1500);
    const afterKeep = { host: await hostState(ctx.page), ui: await readUi(ctx.cdp) };
    const s0 = await shot(ctx, 'sidepanel-after-keep');
    await closeOverlay(ctx.page);
    const browser = ctx.page.browser();
    const panel = await browser.newPage();
    await panel.setViewport({ width: 400, height: 1000, deviceScaleFactor: 2 });
    await panel.goto(`chrome-extension://${ctx.extId}/sidepanel.html`, { waitUntil: 'load' });
    await sleep(1500);
    const links = (await panel.evaluate(`Array.from(document.querySelectorAll('a')).map((a) => ({ text: a.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80), href: a.href }))`)) as { text: string; href: string }[];
    const text = (await panel.evaluate('document.body.innerText.slice(0, 1500)')) as string;
    const s1 = path.relative(root, path.join(out, 'sidepanel.png'));
    await panel.screenshot({ path: path.join(root, s1), fullPage: true });
    await panel.close();
    await ctx.page.bringToFront();
    return { scanned: click.ui?.name ?? null, scannedAt: USER.t, afterKeep: { state: afterKeep.host?.state ?? null, toast: afterKeep.ui?.notes ?? null }, links, text, shots: [s0, s1] };
  },
};

async function main() {
  await mkdir(out, { recursive: true });
  // Scenarios run with --only add to (or replace their entries in) the folder's earlier ux.json.
  try {
    Object.assign(notes, JSON.parse(await readFile(path.join(out, 'ux.json'), 'utf8')));
  } catch {
    // No earlier results.
  }
  const build = path.join(root, store ? 'release/live-build-store' : 'release/live-build');
  const browser = await puppeteer.launch({
    headless: !argv.includes('--headful'),
    pipe: true,
    enableExtensions: [build],
    defaultViewport: realWindow ? null : { width: VIEW.w, height: VIEW.h, deviceScaleFactor: VIEW.dpr },
    args: [
      `--window-size=${VIEW.w},${realWindow ? 1117 : VIEW.h}`,
      ...(realWindow ? [] : [`--force-device-scale-factor=${VIEW.dpr}`]),
      '--no-first-run',
      '--lang=en-US',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-audio-output',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 20000 });
    const worker = (await sw.worker())!;
    const extId = new URL(sw.url()).host;
    await settleInstall(browser, page);
    await grantConsent(worker);
    await installTaps(worker);
    const ctx: Ctx = { page, worker, cdp: await page.createCDPSession(), extId, lastScan: 0 };
    for (const [name, run] of Object.entries(scenarios)) {
      if (only && !only.includes(name)) continue;
      if (store && !['modes', 'sidepanel', 'edges'].includes(name) && !only) continue; // --store (the crop build): the picture and the panel
      log(`scenario ${name}`);
      try {
        notes[name] = await run(ctx);
      } catch (e) {
        notes[name] = { error: (e as Error).stack };
        log(`  ${name} failed: ${(e as Error).message}`);
        await page.screenshot({ path: path.join(out, `${name}-error.png`) }).catch(() => {});
        await closeOverlay(page).catch(() => false);
        await page.evaluate('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
      }
      log(`  ${name}: ${JSON.stringify(notes[name]).slice(0, 600)}`);
      await writeFile(path.join(out, 'ux.json'), JSON.stringify(notes, null, 2));
    }
  } finally {
    await writeFile(path.join(out, 'ux.json'), JSON.stringify(notes, null, 2));
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export type { UiRead, VideoBox };
