// Renders the README's pictures (docs/media/): a GIF for each feature and three stills, all from the
// REAL extension. It drives an E2E-flavoured build (node build.mjs --e2e --out release/readme-build:
// the store build's UI plus the debug hook that stands in for the shortcut, which Puppeteer can't
// press) on the store screenshots' synthetic scene (tools/store-shots/scene.html: the E2E fixture cards
// on a plain playmat, played as a video; no broadcast frames, logos or people). Nothing is staged:
// every answer shown is the engine's own and is checked before it is kept, and the run stops when a
// check fails. The pointer, the click ripples and the key badges are drawn afterwards by make_gif.py
// from the logged input, so the page (and Duel Lens's own screenshot of it) never has them.
//
// Run from the repository root:  npx tsx tools/readme-media/render.ts [options]
//   --no-build            reuse release/readme-build instead of building it again
//   --only=<name>[,...]   only these pictures; the others are left as they are
//   --encode-only         re-encode the GIFs from the last recordings (release/readme-raw), no browser
// Pictures: live-check, live-check-picture, click-to-scan, hover-preview, leave-scan-mode, drag-a-box,
// two-clicks, not-sure, keep-and-side-panel, cut-card, read-the-board (GIFs), popover-anatomy,
// welcome-consent, options (PNG). README.md in this folder has the details.
//
// Scan mode stays open after a read (a click on another outline replaces the card box; Esc closes the
// box, then leaves). With "Show card details: Full details on hover" (the default since 0.9.4) a pointer
// resting on an outline opens the full card box unpinned (no numbers line, links or actions), and a click
// pins it; while a card is pinned, resting on another outline shows the quick preview beside it. Live
// check (the toolbar popup's switch, settings.live.check) needs no shortcut: a pointer resting on a card
// in a playing video, or in a picture, opens its card box beside it. The scenes use all of these, and
// check them, as a user meets them.
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import type { Browser, CDPSession, Page, WebWorker } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import * as H from '../store-shots/harness';
import { Actor, duelLensCursor, inShadowRoot, LIVE_HOST, now, Screencast, type Cursor, type Frame, type TimelineEvent } from './recorder';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TOOL = path.join(ROOT, 'tools/readme-media');
const SCENE = path.join(ROOT, 'tools/store-shots/scene.html');
/** Live check on a picture: a made-up deck list, drawn from the same card images into an <img> (deck-picture.html). */
const PICTURE_PAGE = path.join(ROOT, 'tools/readme-media/deck-picture.html');
const BUILD = path.join(ROOT, 'release/readme-build');
const RAW = path.join(ROOT, 'release/readme-raw');
const OUT = path.join(ROOT, 'docs/media');
const PYTHON = process.env.PYTHON ?? path.join(ROOT, 'data/venv-train/bin/python');

const GIFS = [
  'live-check',
  'live-check-picture',
  'click-to-scan',
  'hover-preview',
  'leave-scan-mode',
  'drag-a-box',
  'two-clicks',
  'not-sure',
  'keep-and-side-panel',
  'cut-card',
  'read-the-board',
] as const;
const STILLS = ['popover-anatomy', 'welcome-consent', 'options'] as const;
type GifName = (typeof GIFS)[number];
type Name = GifName | (typeof STILLS)[number];
const ALL: readonly Name[] = [...GIFS, ...STILLS];

const args = process.argv.slice(2);
const encodeOnly = args.includes('--encode-only');
const noBuild = args.includes('--no-build') || encodeOnly;
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = new Set<Name>(onlyArg ? (onlyArg.slice('--only='.length).split(',') as Name[]) : ALL);
for (const n of ONLY) if (!ALL.includes(n)) throw new Error(`--only: unknown picture "${n}" (${ALL.join(', ')})`);
const wanted = (n: Name) => ONLY.has(n);

/** The size budget: each GIF at most 4 MB, everything in docs/media at most 25 MB. */
const GIF_MAX = 4 * 1024 * 1024;
const TOTAL_MAX = 25 * 1024 * 1024;

const DARK_REDUCED = [
  { name: 'prefers-color-scheme', value: 'dark' },
  // No animation between frames (the popover's foil edge, the scanning sweep): smaller GIFs, same UI.
  { name: 'prefers-reduced-motion', value: 'reduce' },
];

/** Every key badge the GIFs show. */
const KEY_LABELS = ['Alt + Shift + Y', 'S', 'B', 'Tab', 'Enter', '→', '←', 'Esc'];

/**
 * Duel Lens's own UI parts the scenes look for in its closed shadow root, beside the pinned card box
 * (`.pop` without `.hovering`): the card box a resting pointer opens unpinned ("Full details on hover",
 * popover.tsx: `.pop.hovering`), the quick preview that stands in for it while a card is pinned
 * (preview.tsx: `.pv`), and the scan-mode bar's ✕, whose aria-label the spec fixes (ux1-stay-open-brief.md).
 * Check them against src/content when its UI changes: a scene that finds none stops with the classes it did
 * find.
 */
const HOVER_BOX = '.pop.hovering';
const QUICK_PREVIEW = '.pv';
const EXIT_BUTTON = 'button[aria-label="Exit Duel Lens"]';

/** The video's clock in the scene (scene.html ?clock=): it runs only while the video plays. */
const CLOCK_QUERY = 'clock=2467';

/** The cards the fixtures lack come from the benchmark's card images (data/bench/cards-small, YGOPRODeck's small images). */
const ANATOMY_CARDS = [
  // A Limited monster with a Level, Genesys points, an archetype and prices: every part the card box can show (the
  // Level's star, the Limited mark and frame, the Genesys hexagon, the Passcode / Archetype / Price line).
  { add: 'bench/90953320@964,366,0.6', name: 'T.G. Hyper Librarian' },
  { add: 'bench/94145021@964,366,0.6', name: 'Droll & Lock Bird' },
  { add: 'bench/33854624@964,366,0.6', name: 'Bystial Magnamhut' },
];

/**
 * "Not sure", then "Low match": two cards caught mid-motion (motion blur) on one page. The engine's
 * windows for both are narrow, and they move with the engine and the page's size, so the scenes are
 * tried in order: the first that gives both honest answers is recorded (a scene without `low` records
 * the "Not sure" alone). `height` is the page's: the unsure popover needs more than 720 px. Found by a
 * search on 2026-09-29, once clicks straightened from the clicked outline: Blue-Eyes blurred 26 px reads
 * "Not sure · 76%" with 3 other matches, Accesscode Talker blurred 30–32 px reads "Low match".
 */
const NOT_SURE_SCENES: {
  query: string;
  height: number;
  notSure: { card: string; how: 'click' | 'box' };
  low?: { card: string; how: 'click' | 'box' };
}[] = [
  { query: '?fx=bewd:blur:26:15;link:blur:32:15', height: 760, notSure: { card: 'bewd', how: 'click' }, low: { card: 'link', how: 'click' } },
  { query: '?fx=bewd:blur:26:15;link:blur:30:15', height: 760, notSure: { card: 'bewd', how: 'click' }, low: { card: 'link', how: 'click' } },
  { query: '?fx=pend:blur:18:15;bewd:blur:30:15', height: 760, notSure: { card: 'pend', how: 'box' }, low: { card: 'bewd', how: 'click' } },
  { query: '?fx=bewd:blur:26:15', height: 760, notSure: { card: 'bewd', how: 'click' } },
  { query: '?fx=pend:blur:18:15', height: 760, notSure: { card: 'pend', how: 'box' } },
];

/**
 * The cut-off cards, on the picture's top edge: one cut by about a quarter (the engine's second try
 * gives "Not sure" with the right card first) and one cut by a third (it says part of the card is
 * outside the picture). Pairs are tried in order; the first whose two answers are those is used.
 */
const CUT_PAIRS = [
  {
    rescued: { add: 'bench/97268402@964,40,0.5', name: 'Effect Veiler' },
    tooCut: { add: 'bench/70781052@1126,30,-0.5', name: 'Summoned Skull' },
  },
  {
    rescued: { add: 'bench/97268402@964,40,0.5', name: 'Effect Veiler' },
    tooCut: { add: 'bench/70781052@1126,24,-0.5', name: 'Summoned Skull' },
  },
  {
    rescued: { add: 'bench/97268402@964,40,0.5', name: 'Effect Veiler' },
    tooCut: { add: 'bench/70781052@1126,18,-0.5', name: 'Summoned Skull' },
  },
  {
    rescued: { add: 'bench/70781052@964,40,0.5', name: 'Summoned Skull' },
    tooCut: { add: 'bench/97268402@1126,30,-0.5', name: 'Effect Veiler' },
  },
  {
    rescued: { add: 'bench/38033126@964,40,0.5', name: 'Dark Magician Girl' },
    tooCut: { add: 'bench/74677423@1126,30,-0.5', name: 'Red-Eyes Black Dragon' },
  },
];
const TRUNCATED_MESSAGE = "Part of this card is outside the picture. Try when it's fully in view, or box just its artwork.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const checks: Record<string, unknown> = { startedAt: new Date().toISOString() };
function expect(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`check failed: ${message}`);
}

// ---------- build ----------

async function build(): Promise<void> {
  // The store build's UI (official card pictures, D2) plus the E2E-only hooks the script drives it
  // with. Never plain `node build.mjs`: that rebuilds dist/, the user's installed build.
  execFileSync('node', ['build.mjs', '--e2e', '--out', BUILD], { cwd: ROOT, stdio: 'inherit' });
}

/** The E2E build is named "Duel Lens (E2E)" (build.mjs): the pictures show the store's name. */
async function storeName(): Promise<void> {
  const file = path.join(BUILD, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.name = 'Duel Lens – Card Reader';
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

// ---------- the scene's server ----------

/**
 * The scene, the deck-list picture (/picture, for Live check on a picture), the fixture cards (cards/) and, for the
 * cards the fixtures lack, the benchmark's card images (bench/).
 */
function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = '';
    if (url === '/') file = SCENE;
    else if (url === '/picture') file = PICTURE_PAGE;
    else if (/^\/cards\/\d+\.jpg$/.test(url)) file = path.join(ROOT, 'test/fixtures', url);
    else if (/^\/bench\/\d+\.jpg$/.test(url)) file = path.join(ROOT, 'data/bench/cards-small', url.slice('/bench/'.length));
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [BUILD],
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    args: ['--window-size=1280,900', '--no-first-run', '--lang=en-US', '--hide-scrollbars', '--force-color-profile=srgb'],
  });
}

// ---------- the scene ----------

interface Placed {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  bounds: { x: number; y: number; w: number; h: number };
}
interface Geometry {
  faceUp: Placed[];
  extra: Placed[];
  faceDown: Placed[];
}

interface Ctx {
  browser: Browser;
  worker: WebWorker;
  extId: string;
  sceneUrl(query?: string): string;
}

/** A page on the scene, with what every picture does there. */
class Scene {
  geo!: Geometry;
  constructor(
    readonly ctx: Ctx,
    readonly page: Page,
    readonly cdp: CDPSession,
  ) {}

  static async create(ctx: Ctx, page: Page): Promise<Scene> {
    await page.emulateMediaFeatures(DARK_REDUCED);
    return new Scene(ctx, page, await page.createCDPSession());
  }

  async open(query = ''): Promise<Geometry> {
    await this.page.goto(this.ctx.sceneUrl(query), { waitUntil: 'load' });
    await this.page.evaluate('window.scene.ready');
    await H.refocus(this.page);
    await H.settle(this.page, 300);
    this.geo = (await this.page.evaluate('window.scene.geometry()')) as Geometry;
    return this.geo;
  }

  card(id: string): Placed {
    const c = [...this.geo.faceUp, ...this.geo.extra].find((x) => x.id === id);
    if (!c) throw new Error(`no card "${id}" in the scene`);
    return c;
  }

  /** What Alt+Shift+Y does (the E2E hook), then the detector's outlines; returns how many. */
  async begin(): Promise<number> {
    await H.startScan(this.ctx.worker);
    await H.waitForState(this.page, ['selecting'], 15000);
    const n = await H.waitForOutlines(this.page, 20000);
    await H.settle(this.page, 250);
    return n;
  }

  async result(timeoutMs = 60000): Promise<H.HostState> {
    return H.waitForState(this.page, ['result', 'error'], timeoutMs);
  }

  /**
   * The next answer after `before`: scan mode stays open, so the last answer may still be showing (or,
   * after Esc, none is). A new card, or a message instead of one, is the next answer.
   */
  async nextResult(before: H.HostState | null, timeoutMs = 60000): Promise<H.HostState> {
    const start = Date.now();
    for (;;) {
      const s = await H.hostState(this.page);
      if (s && (s.state === 'result' || s.state === 'error') && (s.state !== before?.state || s.card !== before?.card)) return s;
      if (Date.now() - start > timeoutMs) throw new Error(`no new answer after ${JSON.stringify(before)} (last: ${JSON.stringify(s)})`);
      await sleep(100);
    }
  }

  /** The popover once its pictures are in (a message has none to wait for). */
  async popover(): Promise<H.PopoverView> {
    const view = await H.readPopover(this.cdp);
    if (view?.name) return H.waitForPictures(this.cdp);
    expect(view, 'no popover to read');
    return view;
  }

  async close(): Promise<void> {
    expect(await leave(this.page), 'Escape did not close Duel Lens');
    await sleep(700); // captureVisibleTab allows 2 calls a second
  }

  /** Scans the card at (x, y) with a click and closes: the answer, with its pictures cached as for a user who saw it before. */
  async trial(x: number, y: number): Promise<{ state: H.HostState; popover: H.PopoverView }> {
    await this.begin();
    await this.page.mouse.click(x, y);
    const state = await this.result();
    const popover = await this.popover();
    await this.close();
    return { state, popover };
  }

  /**
   * One scan of `c`, by a click on the part of it inside the picture (`at`, its middle by default) or
   * a box around it, then closed. Null when no answer came: a click on no outline only sets a corner.
   */
  async attempt(c: Placed, how: 'click' | 'box', at?: [number, number]): Promise<Attempt | null> {
    await this.begin();
    if (how === 'click') await this.page.mouse.click(...(at ?? [c.x, c.y]));
    else await H.drag(this.page, ...boxAround(c));
    const state = await this.result(20000).catch(() => null);
    const popover = state?.state === 'result' ? await this.popover() : null;
    const low = popover ? await lowNote(this.cdp) : null;
    await this.close();
    return state && popover ? { state, popover, low } : null;
  }

  actor(start: [number, number], layer = 0): Actor {
    return new Actor(this.page, duelLensCursor(this.cdp), start, layer);
  }
}

interface Attempt {
  state: H.HostState;
  popover: H.PopoverView;
  /** The "Low match" line (the engine's suggestions: RecognitionResult.suggested), or null. */
  low: string | null;
}

/** An honest "Not sure": unsure, the right card first, at least two other matches, and not a "Low match". */
const isNotSure = (t: Attempt | null, name: string) =>
  !!t && t.state.confident === 'false' && t.popover.unsure && t.popover.name === name && !t.low && t.popover.chips.length >= 2;
/** An honest "Low match": the engine's suggestions, the right card first. */
const isLowMatch = (t: Attempt | null, name: string) => !!t && t.state.confident === 'false' && !!t.low && t.popover.name === name;

/** The popover's "Low match" line, or null. */
async function lowNote(cdp: CDPSession): Promise<string | null> {
  return inShadowRoot<string | null>(cdp, 'function () { const l = this.querySelector(".pop .note.low"); return l ? l.textContent.trim() : null; }');
}

/**
 * Leaves Duel Lens as a user does, with Escape. In scan mode each press closes one thing (a hover
 * preview, a first corner, the popover) until nothing is open, and the next one leaves. True once
 * Duel Lens's host is gone.
 */
async function leave(page: Page, tries = 6): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (!(await H.hostState(page))) return true;
    await page.keyboard.press('Escape');
    const gone = await page
      .waitForFunction("!document.getElementById('duel-lens-host')", { polling: 'mutation', timeout: 600 })
      .then(
        () => true,
        () => false,
      );
    if (gone) return true;
  }
  return false;
}

type Box = { x: number; y: number; w: number; h: number };

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Whether a pinned card box is open (not the unpinned one a resting pointer opens, nor the quick preview). */
async function popoverOpen(cdp: CDPSession): Promise<boolean> {
  return !!(await inShadowRoot<boolean>(cdp, 'function () { return !!this.querySelector(".pop:not(.hovering)"); }'));
}

/**
 * The parts of 0.10.3's card box every pinned box has, whatever the card: the brand row ("Duel Lens" and its ×),
 * no Copy button (gone in 0.10.3), and, for a card, the numbers line (Passcode) and the links. Null when they are
 * all there, else what is wrong.
 */
async function boxProblems(cdp: CDPSession): Promise<string | null> {
  return inShadowRoot<string | null>(
    cdp,
    `function () {
      const pop = this.querySelector('.pop:not(.hovering)');
      if (!pop) return 'no pinned card box';
      const wrong = [];
      const brand = pop.querySelector('.ov-top .brand');
      if (!brand || brand.textContent.trim() !== 'Duel Lens') wrong.push('no "Duel Lens" brand row (' + (brand && brand.textContent) + ')');
      if (!pop.querySelector('.ov-top .x')) wrong.push('no × on the brand row');
      if (Array.from(pop.querySelectorAll('button')).some((b) => /copy/i.test(b.textContent))) wrong.push('a Copy button');
      if (pop.querySelector('.dv-name')) {
        const ids = pop.querySelector('.dv-meta .dv-ids');
        if (!ids || !/Passcode/i.test(ids.textContent)) wrong.push('no Passcode line');
        if (!Array.from(pop.querySelectorAll('.dv-links a')).some((a) => /YGOPRODeck/.test(a.textContent))) wrong.push('no YGOPRODeck link');
      }
      return wrong.length ? wrong.join('; ') : null;
    }`,
  );
}

/** The classes in Duel Lens's shadow root, for the message when a selector here no longer matches its UI. */
async function shadowClasses(cdp: CDPSession): Promise<string> {
  const list = await inShadowRoot<string[]>(
    cdp,
    'function () { return Array.from(new Set(Array.from(this.querySelectorAll("[class]")).flatMap((e) => String(e.getAttribute("class")).split(/\\s+/)))).filter(Boolean).sort(); }',
  );
  return (list ?? []).join(' ');
}

interface HoverView {
  /** The full card box, unpinned ('box', "Full details on hover"), or the quick preview ('preview', while a card is pinned). */
  kind: 'box' | 'preview';
  /** The card it names (the box's name, the preview's top line), and all its text. */
  name: string | null;
  text: string;
  box: Box;
  /** The box's picture has loaded (a preview has none: true). */
  pictureLoaded: boolean;
}

/** What a resting pointer (or the keyboard's focus) shows of an outlined card: the unpinned card box or the quick preview, laid out and not hidden; or null. */
async function readHover(cdp: CDPSession): Promise<HoverView | null> {
  return inShadowRoot<HoverView | null>(
    cdp,
    `function (boxSel, pvSel) {
      const shown = (e) => {
        const r = e.getBoundingClientRect();
        const st = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05 && !e.classList.contains('measuring');
      };
      const text = (e) => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : null);
      const box = Array.from(this.querySelectorAll(boxSel)).find(shown);
      const el = box || Array.from(this.querySelectorAll(pvSel)).find(shown);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const img = box ? box.querySelector('.dv-card img') : null;
      return {
        kind: box ? 'box' : 'preview',
        name: text(el.querySelector(box ? '.dv-name' : '.pv-head')),
        text: text(el),
        box: { x: r.x, y: r.y, w: r.width, h: r.height },
        pictureLoaded: box ? !!img && img.complete && img.naturalWidth > 0 : true,
      };
    }`,
    [HOVER_BOX, QUICK_PREVIEW],
  );
}

/**
 * Waits for what a resting pointer (or the focus) shows of `name`: the unpinned card box with its picture loaded
 * ('box'), or the quick preview ('preview').
 */
async function waitForHover(cdp: CDPSession, name: string, kind: HoverView['kind'], timeoutMs = 10000): Promise<HoverView> {
  const start = Date.now();
  let last: HoverView | null = null;
  for (;;) {
    last = await readHover(cdp);
    if (last && last.kind === kind && last.name?.includes(name) && last.pictureLoaded) return last;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `no ${kind === 'box' ? 'unpinned card box' : 'quick preview'} naming "${name}" within ${timeoutMs / 1000} s (last: ${JSON.stringify(last)}); HOVER_BOX is "${HOVER_BOX}", QUICK_PREVIEW "${QUICK_PREVIEW}", and Duel Lens's shadow root has the classes: ${await shadowClasses(cdp)}`,
      );
    }
    await sleep(80);
  }
}

/** Waits until nothing shows for a resting pointer (the pointer left the outline). */
async function waitForNoHover(cdp: CDPSession, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const p = await readHover(cdp);
    if (!p) return;
    if (Date.now() - start > timeoutMs) throw new Error(`the hover box or preview stayed after the pointer left: ${JSON.stringify(p)}`);
    await sleep(80);
  }
}

interface BarView {
  text: string;
  box: Box;
  /** The centre of its ✕ (EXIT_BUTTON). */
  exit: [number, number];
}

/** Scan mode's bar at the top: the ✕ that leaves (EXIT_BUTTON) and the element around it that holds its text. */
async function readBar(cdp: CDPSession): Promise<BarView | null> {
  return inShadowRoot<BarView | null>(
    cdp,
    `function (sel) {
      const x = this.querySelector(sel);
      if (!x) return null;
      const xr = x.getBoundingClientRect();
      let bar = x;
      while (bar.parentElement && bar.getBoundingClientRect().width < 3 * xr.width) bar = bar.parentElement;
      const r = bar.getBoundingClientRect();
      return { text: bar.textContent.replace(/\\s+/g, ' ').trim(), box: { x: r.x, y: r.y, w: r.width, h: r.height }, exit: [xr.x + xr.width / 2, xr.y + xr.height / 2] };
    }`,
    [EXIT_BUTTON],
  );
}

/** Scan mode's bar, which must be there, and say how many cards are outlined and that Esc leaves. */
async function expectBar(cdp: CDPSession, n: number, what: string): Promise<BarView> {
  const bar = await readBar(cdp);
  if (!bar) throw new Error(`check failed: ${what}: no scan-mode bar (no ${EXIT_BUTTON}); Duel Lens's shadow root has the classes: ${await shadowClasses(cdp)}`);
  expect(bar.text.includes(`${n} card`) && /Esc/.test(bar.text), `${what}: the bar says "${bar.text}" (${n} outlines)`);
  return bar;
}

/** A box a little bigger than the card, as a user drags it. */
function boxAround(c: Placed): [[number, number], [number, number]] {
  const b = c.bounds;
  return [
    [b.x - 12, b.y - 10],
    [b.x + b.w + 12, b.y + b.h + 10],
  ];
}

/** Where picking `c` touches the page: around its click point, or the box dragged around it. */
function reachOf(c: Placed, how: 'click' | 'box', at?: [number, number]): Box {
  if (how === 'box') {
    const [p0, p1] = boxAround(c);
    return { x: p0[0], y: p0[1], w: p1[0] - p0[0], h: p1[1] - p0[1] };
  }
  const [x, y] = at ?? [c.x + 4, c.y + 6];
  return { x: x - 8, y: y - 8, w: 16, h: 16 };
}

/** Picks `c` as the viewer sees it: the pointer moves to it and clicks, or drags a box around it. */
async function pick(actor: Actor, c: Placed, how: 'click' | 'box', at?: [number, number]): Promise<void> {
  if (how === 'click') {
    const [x, y] = at ?? [c.x + 4, c.y + 6];
    await actor.move(x, y, 600);
    await sleep(300);
    await actor.click();
    return;
  }
  const [p0, p1] = boxAround(c);
  await actor.move(p0[0], p0[1], 600);
  await sleep(250);
  await actor.down();
  await actor.move(p1[0], p1[1], 1000);
  await sleep(200);
  await actor.up();
}

/** A crop `width` px wide (or wider, to hold every box) around `boxes`, inside a page `pageW` x `pageH`. */
function fitCrop(boxes: { x: number; y: number; w: number; h: number }[], width: number, pageW: number, pageH: number): [number, number, number, number] {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const w = Math.min(pageW, Math.max(width, Math.ceil(x1 - x0 + 48)));
  const left = Math.max(0, Math.min(pageW - w, Math.round((x0 + x1) / 2 - w / 2)));
  return [left, 0, w, pageH];
}

// ---------- sprites: the key badges and the pointer ----------

/** The Archivo font the extension bundles (extension/fonts, SIL OFL 1.1), as a @font-face with a data URL. */
async function archivo(): Promise<string> {
  const data = (await readFile(path.join(ROOT, 'extension/fonts/archivo-latin-var.woff2'))).toString('base64');
  return `@font-face { font-family: "RM Archivo"; src: url(data:font/woff2;base64,${data}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }`;
}

const CURSORS: Record<Exclude<Cursor, 'none'>, { svg: string; hot: [number, number] }> = {
  // The usual arrow, black with a white rim; its tip is the hot spot.
  arrow: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="-1 -1 26 36"><path d="M2 2 L2 26.5 L8.1 20.9 L12.3 30.3 L16.3 28.5 L12.1 19.3 L20.3 19.3 Z" fill="#111" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    hot: [3, 3],
  },
  // The pointing hand (over an outlined card or a button): white with a black rim; the fingertip is the hot spot.
  hand: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="34" viewBox="-1 -1 30 34"><path d="M9.2 2.2c1.35 0 2.45 1.1 2.45 2.45v8.1l.9-.05v-1.5c0-1.3 1.05-2.35 2.35-2.35s2.35 1.05 2.35 2.35v1.9h.6c.05-1.2 1.05-2.15 2.25-2.15 1.25 0 2.25 1 2.25 2.25v1.55c.4-.3.9-.45 1.45-.45 1.25 0 2.25 1 2.25 2.25v6.1c0 4.7-3.8 8.5-8.5 8.5h-2.1c-2.7 0-5.2-1.35-6.7-3.6l-4.9-7.35c-.7-1.05-.45-2.45.6-3.15 1.05-.7 2.4-.55 3.2.35l1 1.1V4.65c0-1.35 1.1-2.45 2.45-2.45z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/><path d="M12.9 17.5v5.4M16.9 17.5v5.4M20.9 17.9v5" stroke="#111" stroke-width="1.2" stroke-linecap="round"/></svg>',
    hot: [10, 3],
  },
  // The crosshair Duel Lens shows on the frozen frame (styles.ts: .layer { cursor: crosshair }).
  cross: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="27" height="27" viewBox="0 0 27 27"><path d="M13.5 2v23M2 13.5h23" stroke="#fff" stroke-width="3.4" stroke-linecap="square"/><path d="M13.5 2v23M2 13.5h23" stroke="#111" stroke-width="1.4" stroke-linecap="square"/></svg>',
    hot: [13.5, 13.5],
  },
};

interface Sprites {
  cursors: Record<string, { file: string; hot: [number, number] }>;
  keys: Record<string, string>;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Renders the key badges ("Alt + Shift + Y", "K"…) and the pointers as transparent PNGs, with the extension's own font. */
async function renderSprites(browser: Browser): Promise<Sprites> {
  const dir = path.join(RAW, 'sprites');
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage();
  const font = await archivo();
  const sprites: Sprites = { cursors: {}, keys: {} };
  try {
    await page.setViewport({ width: 700, height: 200, deviceScaleFactor: 1 });
    for (const [i, label] of KEY_LABELS.entries()) {
      const keys = label.split(' + ').map((k) => `<kbd>${escapeHtml(k)}</kbd>`);
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${font}
        html, body { margin: 0; background: transparent; }
        .wrap { display: inline-block; padding: 10px 14px 18px; }
        .badge { display: inline-flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 14px;
          background: rgba(23,21,30,.95); box-shadow: 0 6px 16px rgba(0,0,0,.55), inset 0 0 0 1.5px rgba(231,185,85,.7); }
        kbd { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 38px; height: 38px;
          padding: 0 11px; border-radius: 8px; font: 650 19px/1 "RM Archivo", Arial, sans-serif; color: #F4F1F9;
          background: linear-gradient(#3a3546, #28242f); box-shadow: inset 0 -3px 0 rgba(0,0,0,.5), inset 0 0 0 1px rgba(255,255,255,.18); }
        i { font: 600 18px/1 "RM Archivo", Arial, sans-serif; font-style: normal; color: #CFC8DC; }
      </style></head><body><div class="wrap"><div class="badge">${keys.join('<i>+</i>')}</div></div></body></html>`);
      await page.evaluate('document.fonts.ready');
      const file = path.join(dir, `key-${i}.png`);
      await (await page.$('.wrap'))!.screenshot({ path: file, omitBackground: true });
      sprites.keys[label] = file;
    }
    for (const [name, c] of Object.entries(CURSORS)) {
      await page.setContent(
        `<!doctype html><html><head><style>html, body { margin: 0; background: transparent; } .c { display: inline-block; line-height: 0; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.45)); padding: 0 3px 3px 0; }</style></head><body><span class="c">${c.svg}</span></body></html>`,
      );
      const file = path.join(dir, `cursor-${name}.png`);
      await (await page.$('.c'))!.screenshot({ path: file, omitBackground: true });
      sprites.cursors[name] = { file, hot: c.hot };
    }
  } finally {
    await page.close();
  }
  return sprites;
}

// ---------- GIFs: the plan make_gif.py encodes ----------

interface GifLayer {
  frames: Frame[];
  /** The part of the page shown: x, y, width, height (CSS px). */
  crop: [number, number, number, number];
  /** Where it goes on the canvas. */
  at: [number, number];
  /** Shown only from / until these times (seconds since the epoch). */
  from?: number;
  until?: number;
  /** Only the frames painted from / before these times (a page that changed size, or a moment to hold). */
  frames_from?: number;
  frames_before?: number;
}

type RGB = [number, number, number];

interface GifPlan {
  name: GifName;
  canvas: [number, number];
  layers: GifLayer[];
  events: TimelineEvent[];
  t0: number;
  t1: number;
  fps?: number;
  /** Where the key badges go (a negative value counts from the right or bottom edge). */
  keyAt?: [number, number];
  /** x, y, width, height, colour, and optionally the time it appears from. */
  dividers?: ([number, number, number, number, RGB] | [number, number, number, number, RGB, number])[];
}

async function savePlan(plan: GifPlan): Promise<void> {
  const dir = path.join(RAW, plan.name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 1));
}

interface Encoded {
  out: string;
  bytes: number;
  frames: number;
  seconds: number;
  size: number[];
  review?: string[];
}

async function encode(name: GifName, sprites: Sprites): Promise<Encoded> {
  const plan = JSON.parse(await readFile(path.join(RAW, name, 'plan.json'), 'utf8')) as GifPlan;
  const spec = {
    out: path.join(OUT, `${name}.gif`),
    fps: plan.fps ?? 10,
    t0: plan.t0,
    t1: plan.t1,
    canvas: plan.canvas,
    layers: plan.layers,
    events: plan.events,
    dividers: plan.dividers ?? [],
    key_at: plan.keyAt ?? [14, 14],
    colors: 256,
    sprites,
    review: { dir: path.join(RAW, 'review'), name, at: [0.1, 0.4, 0.7, 0.98] },
  };
  const specFile = path.join(RAW, name, 'spec.json');
  await writeFile(specFile, JSON.stringify(spec));
  const r = spawnSync(PYTHON, [path.join(TOOL, 'make_gif.py'), specFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`make_gif.py failed for ${name}:\n${r.stderr}`);
  const report = JSON.parse(r.stdout.trim().split('\n').pop()!) as Encoded;
  expect(report.bytes <= GIF_MAX, `${name}.gif is ${(report.bytes / 1e6).toFixed(2)} MB (over 4 MB)`);
  return report;
}

/** Records `pages` (screencasts) while `script` runs; the frames and the recording's start and end times. */
async function record(name: GifName, pages: Page[], script: () => Promise<void>): Promise<{ frames: Frame[][]; t0: number; t1: number }> {
  const dir = path.join(RAW, name);
  await rm(dir, { recursive: true, force: true });
  const casts = pages.map((p, i) => new Screencast(p, path.join(dir, `layer${i}`)));
  for (const c of casts) await c.start();
  const t0 = now();
  await script();
  const t1 = now();
  const frames: Frame[][] = [];
  for (const c of casts) frames.push(await c.stop());
  return { frames, t0, t1 };
}

/** The shortcut as the viewer sees it: its badge, then what it does (the E2E hook), then the outlines. */
async function shortcut(s: Scene, actor: Actor): Promise<number> {
  await actor.key('Alt + Shift + Y', 1.3);
  await sleep(120);
  const n = await s.begin();
  await actor.refresh();
  return n;
}

// ---------- the GIFs ----------

/** A spot on the card box's text, where a reader rests the pointer (off every outline, so nothing else opens). */
const onPopover = (p: H.PopoverView): [number, number] => {
  expect(p.box, 'the card box has no box');
  return [p.box.x + p.box.w * 0.55, p.box.y + p.box.h * 0.72];
};

/** A Genesys chip ("Genesys 18 pts"): whatever the points, which the card data changes. */
const hasGenesys = (p: H.PopoverView | undefined) => !!p?.facts.some((f) => /^Genesys \d+ pts?$/.test(f ?? ''));

/**
 * 1. Scan mode: the shortcut, every card outlined and scan mode's bar. The pointer rests on Ash Blossom and its
 * card box opens beside it, unpinned ("Full details on hover": the picture, the facts with its Genesys points,
 * the text); a click pins it (the numbers line, the links and the actions come). Scan mode stays open: the
 * pointer rests on Accesscode Talker, whose quick preview shows beside it while Ash Blossom's box stays pinned,
 * and a click replaces the box with Accesscode Talker's.
 */
async function clickToScan(s: Scene): Promise<GifPlan> {
  await s.open();
  const ash = s.card('ash-gy');
  const talker = s.card('link');
  for (const c of [ash, talker]) {
    const warm = await s.trial(c.x, c.y); // the pictures get cached, as for a user who saw these cards before
    expect(warm.state.card === c.name, `click-to-scan warm-up read ${warm.state.card} for ${c.name}`);
  }
  const actor = s.actor([900, 620]);
  await actor.place();
  let n = 0;
  let bar: BarView | undefined;
  let hoverA: HoverView | undefined;
  let stateA: H.HostState | undefined;
  let popA: H.PopoverView | undefined;
  let pinnedA: string | null = null;
  let hoverB: HoverView | undefined;
  let pinnedDuringB: H.PopoverView | null | undefined;
  let stateB: H.HostState | undefined;
  let popB: H.PopoverView | undefined;
  const rec = await record('click-to-scan', [s.page], async () => {
    await sleep(600);
    n = await shortcut(s, actor);
    bar = await expectBar(s.cdp, n, 'click-to-scan');
    await sleep(700);
    await actor.move(ash.x - 6, ash.y + 10, 800);
    hoverA = await waitForHover(s.cdp, ash.name, 'box');
    await actor.refresh();
    await sleep(1500);
    await actor.click();
    stateA = await s.result();
    popA = await s.popover();
    pinnedA = await boxProblems(s.cdp);
    await actor.refresh();
    await actor.move(...onPopover(popA), 450);
    await sleep(1500);
    await actor.move(talker.x + 4, talker.y + 10, 950);
    hoverB = await waitForHover(s.cdp, talker.name, 'preview');
    pinnedDuringB = await H.readPopover(s.cdp);
    await actor.refresh();
    await sleep(1000);
    await actor.click();
    stateB = await s.nextResult(stateA!);
    popB = await s.popover();
    await actor.refresh();
    await actor.move(...onPopover(popB), 450);
    await sleep(2800);
  });
  expect(n === s.geo.faceUp.length, `click-to-scan: ${n} outlines for ${s.geo.faceUp.length} cards`);
  expect(stateA?.card === ash.name && stateA.confident === 'true', `click-to-scan read ${JSON.stringify(stateA)}`);
  expect(hasGenesys(popA), `click-to-scan: no Genesys chip (${popA?.facts})`);
  expect(!popA?.toast, `click-to-scan: a toast (${popA?.toast})`);
  expect(pinnedA === null, `click-to-scan: Ash Blossom's pinned box: ${pinnedA}`);
  expect(pinnedDuringB?.name === ash.name, `click-to-scan: Accesscode Talker's preview replaced the pinned box (${JSON.stringify(pinnedDuringB?.name)})`);
  expect(stateB?.card === talker.name && stateB.confident === 'true' && popB?.name === talker.name, `click-to-scan: the second click read ${JSON.stringify(stateB)}`);
  checks['click-to-scan'] = { outlines: n, bar, hoverA, stateA, popoverA: popA, hoverB, stateB, popoverB: popB };
  await s.close();
  const boxes = [ash.bounds, talker.bounds, hoverA!.box, hoverB!.box, popA!.box, popB!.box, bar!.box].filter((b): b is Box => !!b);
  const crop = fitCrop(boxes, 894, 1280, 720);
  return {
    name: 'click-to-scan',
    canvas: [crop[2], crop[3]],
    layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [-14, 14],
  };
}

/**
 * 2. Details on hover. With scan mode open and nothing pinned, the pointer rests on Infinite Impermanence and its
 * card box opens beside it, unpinned ("Full details on hover", the default since 0.9.4; before, a small quick
 * preview); then on Accesscode Talker, and the box follows. Then the keyboard, the pointer parked off the cards:
 * Tab focuses the first outline in reading order (Accesscode Talker) and opens its box, Tab again Dark Magician's,
 * and Enter pins Dark Magician's.
 */
async function hoverPreview(s: Scene): Promise<GifPlan> {
  await s.open();
  const imp = s.card('imp-tilt');
  const talker = s.card('link');
  const dm = s.card('dm');
  for (const c of [imp, talker, dm]) {
    const warm = await s.trial(c.x, c.y); // the pictures, cached
    expect(warm.state.card === c.name, `hover-preview warm-up read ${warm.state.card} for ${c.name}`);
  }
  // Off every outline: the mat left of Accesscode Talker, above Dark Magician.
  const park: [number, number] = [150, 240];
  const actor = s.actor([560, 640]);
  await actor.place();
  let n = 0;
  let bar: BarView | undefined;
  const hovers: Record<string, HoverView> = {};
  let state: H.HostState | undefined;
  let pop: H.PopoverView | undefined;
  const rec = await record('hover-preview', [s.page], async () => {
    await sleep(500);
    n = await shortcut(s, actor);
    bar = await expectBar(s.cdp, n, 'hover-preview');
    await sleep(600);
    await actor.move(imp.x + 6, imp.y + 8, 800);
    hovers.imp = await waitForHover(s.cdp, imp.name, 'box');
    await actor.refresh();
    await sleep(1600);
    await actor.move(talker.x + 4, talker.y + 10, 950);
    hovers.talker = await waitForHover(s.cdp, talker.name, 'box');
    await actor.refresh();
    await sleep(1600);
    await actor.move(park[0], park[1], 750);
    await waitForNoHover(s.cdp);
    await actor.refresh();
    await sleep(500);
    await actor.key('Tab', 0.8, 'Tab');
    hovers.tabTalker = await waitForHover(s.cdp, talker.name, 'box');
    await sleep(1300);
    await actor.key('Tab', 0.8, 'Tab');
    hovers.tabDm = await waitForHover(s.cdp, dm.name, 'box');
    await sleep(1400);
    await actor.key('Enter', 0.8, 'Enter');
    state = await s.result();
    pop = await s.popover();
    await sleep(2800);
  });
  expect(n === s.geo.faceUp.length, `hover-preview: ${n} outlines for ${s.geo.faceUp.length} cards`);
  expect(state?.card === dm.name && state.confident === 'true' && pop?.name === dm.name, `hover-preview: Enter read ${JSON.stringify(state)}`);
  checks['hover-preview'] = { outlines: n, bar, hovers, state, popover: pop };
  await s.close();
  const parked: Box = { x: park[0] - 10, y: park[1] - 10, w: 40, h: 50 };
  const boxes = [imp.bounds, talker.bounds, dm.bounds, ...Object.values(hovers).map((p) => p.box), pop!.box, bar!.box, parked].filter((b): b is Box => !!b);
  const crop = fitCrop(boxes, 894, 1280, 720);
  return {
    name: 'hover-preview',
    canvas: [crop[2], crop[3]],
    layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [14, 14],
  };
}

/**
 * 3. Leaving. The scene's video plays, its clock running (scene.html ?clock=). The shortcut freezes it (the
 * clock stops) and outlines the cards; a click on Dark Magician pins its card box; Esc closes the box and the
 * outlines stay; Esc again leaves, and the clock runs on. Then the shortcut again, and a click on
 * the bar's ✕ leaves too. Each step is checked: the video pauses in scan mode and plays after each exit.
 */
async function leaveScanMode(s: Scene): Promise<GifPlan> {
  await s.open(`?${CLOCK_QUERY}`);
  const dm = s.card('dm');
  const warm = await s.trial(dm.x, dm.y);
  expect(warm.state.card === dm.name, `leave-scan-mode warm-up read ${warm.state.card}`);
  const playing = async () => (await s.page.evaluate("!document.getElementById('duel').paused")) as boolean;
  const clock = (await s.page.evaluate(`(() => {
    const el = document.getElementById('time');
    const r = el && !el.hidden ? el.getBoundingClientRect() : null;
    return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  })()`)) as Box | null;
  expect(clock, `leave-scan-mode: the scene shows no clock (?${CLOCK_QUERY})`);
  // Off every outline: the mat between the two Extra Monster Zones, above Odd-Eyes.
  const rest: [number, number] = [640, 200];
  const actor = s.actor(rest);
  await actor.place();
  const seen: Record<string, unknown> = {};
  let bar: BarView | undefined;
  let pop: H.PopoverView | undefined;
  const rec = await record('leave-scan-mode', [s.page], async () => {
    await sleep(1400);
    seen.playingBefore = await playing();
    const n = await shortcut(s, actor);
    seen.outlines = n;
    seen.pausedInScanMode = !(await playing());
    bar = await expectBar(s.cdp, n, 'leave-scan-mode');
    await sleep(500);
    await actor.move(dm.x + 4, dm.y + 8, 700);
    await sleep(120);
    await actor.click();
    seen.state = await s.result();
    pop = await s.popover();
    await actor.refresh();
    await actor.move(rest[0], rest[1], 450);
    await sleep(1300);
    await actor.key('Esc', 0.8, 'Escape');
    await sleep(450);
    seen.afterFirstEsc = { host: await H.hostState(s.page), popover: await popoverOpen(s.cdp), hover: await readHover(s.cdp) };
    await actor.refresh();
    await sleep(800);
    await actor.key('Esc', 0.8, 'Escape');
    await sleep(450);
    seen.afterSecondEsc = { host: await H.hostState(s.page), playing: await playing() };
    await actor.refresh();
    await sleep(1700);
    await shortcut(s, actor);
    const again = await readBar(s.cdp);
    expect(again, 'leave-scan-mode: no bar after the second shortcut');
    await sleep(500);
    await actor.move(again.exit[0], again.exit[1], 800);
    await sleep(300);
    await actor.click();
    await s.page.waitForFunction("!document.getElementById('duel-lens-host')", { timeout: 3000 }).catch(() => undefined);
    seen.afterExitButton = { host: await H.hostState(s.page), playing: await playing() };
    await actor.refresh();
    await actor.move(again.exit[0] + 40, again.exit[1] + 150, 500);
    await sleep(1800);
  });
  const st = seen.state as H.HostState | undefined;
  const esc1 = seen.afterFirstEsc as { host: H.HostState | null; popover: boolean; hover: HoverView | null };
  const esc2 = seen.afterSecondEsc as { host: H.HostState | null; playing: boolean };
  const byX = seen.afterExitButton as { host: H.HostState | null; playing: boolean };
  expect(seen.playingBefore === true, 'leave-scan-mode: the scene video was not playing before the shortcut');
  expect(seen.pausedInScanMode === true, 'leave-scan-mode: the video kept playing in scan mode');
  expect(st?.card === dm.name && st.confident === 'true', `leave-scan-mode read ${JSON.stringify(st)}`);
  expect(esc1.host && !esc1.popover && !esc1.hover, `leave-scan-mode: the first Esc should close the card box and keep scan mode (${JSON.stringify(esc1)})`);
  expect(!esc2.host && esc2.playing, `leave-scan-mode: the second Esc should leave and play the video (${JSON.stringify(esc2)})`);
  expect(!byX.host && byX.playing, `leave-scan-mode: the bar's ✕ should leave and play the video (${JSON.stringify(byX)})`);
  checks['leave-scan-mode'] = { ...seen, bar, popover: pop, clock };
  const crop = fitCrop([clock, dm.bounds, pop!.box, bar!.box].filter((b): b is Box => !!b), 960, 1280, 720);
  return {
    name: 'leave-scan-mode',
    canvas: [crop[2], crop[3]],
    layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [14, 14],
  };
}

/** 2. Drag a box around a card (Infinite Impermanence, lying tilted): the answer comes beside the box. */
async function dragABox(s: Scene): Promise<GifPlan> {
  await s.open();
  const c = s.card('imp-tilt');
  const warm = await s.trial(c.x, c.y);
  expect(warm.state.card === c.name, `drag-a-box warm-up read ${warm.state.card}`);
  const b = c.bounds;
  const from: [number, number] = [b.x - 13, b.y - 11];
  const to: [number, number] = [b.x + b.w + 13, b.y + b.h + 9];
  const actor = s.actor([560, 250]);
  await actor.place();
  let state: H.HostState | undefined;
  let pop: H.PopoverView | undefined;
  const rec = await record('drag-a-box', [s.page], async () => {
    await sleep(500);
    await shortcut(s, actor);
    await sleep(600);
    await actor.move(from[0], from[1], 700);
    await sleep(250);
    await actor.down();
    await actor.move(to[0], to[1], 1100);
    await sleep(200);
    await actor.up();
    state = await s.result();
    pop = await s.popover();
    await actor.refresh();
    await actor.move(to[0] - 30, to[1] + 22, 400);
    await sleep(2800);
  });
  expect(state?.card === c.name && state.confident === 'true', `drag-a-box read ${JSON.stringify(state)}`);
  checks['drag-a-box'] = { state, popover: pop, box: [from, to] };
  await s.close();
  return {
    name: 'drag-a-box',
    canvas: [960, 720],
    layers: [{ frames: rec.frames[0], crop: [0, 0, 960, 720], at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [14, 14],
  };
}

/** 3. A box with two clicks: a click beside the cards sets a corner, the box follows the pointer, a second click ends it. */
async function twoClicks(s: Scene): Promise<GifPlan> {
  await s.open();
  const c = s.card('bewd');
  const warm = await s.trial(c.x, c.y);
  expect(warm.state.card === c.name, `two-clicks warm-up read ${warm.state.card}`);
  const b = c.bounds;
  const first: [number, number] = [b.x - 15, b.y - 13];
  const second: [number, number] = [b.x + b.w + 15, b.y + b.h + 12];
  const actor = s.actor([b.x - 30, 140]);
  await actor.place();
  let state: H.HostState | undefined;
  let pop: H.PopoverView | undefined;
  let armedHint: string | null = null;
  let armedBar: BarView | null = null;
  const rec = await record('two-clicks', [s.page], async () => {
    await sleep(500);
    await shortcut(s, actor);
    await sleep(600);
    await actor.move(first[0], first[1], 700);
    await sleep(300);
    await actor.click();
    await sleep(200);
    // Scan mode's bar says what to do: "Click the opposite corner".
    armedBar = await readBar(s.cdp);
    armedHint = armedBar?.text ?? null;
    await sleep(400);
    await actor.move(second[0], second[1], 1100);
    await sleep(300);
    await actor.click();
    state = await s.result();
    pop = await s.popover();
    await actor.refresh();
    await actor.move(second[0] - 40, second[1] + 110, 400);
    await sleep(2800);
  });
  expect(armedHint && /Click the opposite corner/.test(armedHint), `two-clicks: the first click set no corner (hint "${armedHint}")`);
  expect(state?.card === c.name && state.confident === 'true', `two-clicks read ${JSON.stringify(state)}`);
  checks['two-clicks'] = { state, popover: pop, armedHint, corners: [first, second] };
  await s.close();
  // The card, both corners, the bar's hint and the card box, wherever it opened (left or right of the card).
  const corner = (p: [number, number]): Box => ({ x: p[0] - 12, y: p[1] - 12, w: 24, h: 24 });
  const crop = fitCrop([b, corner(first), corner(second), (armedBar as BarView | null)?.box, pop?.box].filter((x): x is Box => !!x), 892, 1280, 720);
  return {
    name: 'two-clicks',
    canvas: [crop[2], crop[3]],
    layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [-14, 14],
  };
}

/**
 * 4. "Not sure", then "Low match". A card caught mid-motion: the popover says "Not sure" and offers the
 * closest matches; → shows the next one ("You picked this"), and a click on the first chip goes back.
 * Then a card blurred more, picked in the same scan (scan mode stays open): the engine can't call it, but
 * a card was picked, so it offers its closest guess under "Low match". Each answer is checked honest
 * first (NOT_SURE_SCENES); none is staged.
 */
async function notSure(s: Scene): Promise<GifPlan> {
  const tried: unknown[] = [];
  try {
    for (const cand of NOT_SURE_SCENES) {
      await s.page.setViewport({ width: 1280, height: cand.height, deviceScaleFactor: 1 });
      await s.open(cand.query);
      // Trial runs, which also cache the pictures.
      const a = s.card(cand.notSure.card);
      const ta = await s.attempt(a, cand.notSure.how);
      const b = cand.low ? s.card(cand.low.card) : null;
      const tb = b && isNotSure(ta, a.name) ? await s.attempt(b, cand.low!.how) : null;
      const ok = isNotSure(ta, a.name) && (!b || isLowMatch(tb, b.name));
      tried.push({ scene: cand, notSure: ta, low: tb, accepted: ok });
      if (!ok) continue;
      const actor = s.actor([a.x + 330, a.y + 250]);
      await actor.place();
      let first: H.PopoverView | undefined;
      let stepped: H.PopoverView | undefined;
      let back: H.PopoverView | undefined;
      let low: { popover: H.PopoverView; note: string | null } | undefined;
      let escFirst = false;
      const rec = await record('not-sure', [s.page], async () => {
        await sleep(400);
        await shortcut(s, actor);
        await sleep(400);
        await pick(actor, a, cand.notSure.how);
        await s.result();
        first = await s.popover();
        await actor.refresh();
        await actor.move(...onPopover(first), 450);
        await sleep(1200);
        await actor.key('→', 1.0, 'ArrowRight');
        await sleep(250);
        stepped = await s.popover();
        await sleep(950);
        // The top match is the first chip now: a click on it goes back.
        const chip = await chipCenter(s.cdp, first!.name!);
        expect(chip, 'not-sure: no chip for the top match');
        await actor.move(chip![0], chip![1], 550);
        await sleep(250);
        await actor.click();
        await sleep(250);
        back = await s.popover();
        if (b) {
          await sleep(900);
          // Scan mode is still open: the next card is a click away. When its outline, or the box dragged
          // around it, lies under this popover, Esc closes the popover first (the outlines stay).
          escFirst = !!back?.box && overlap(back.box, reachOf(b, cand.low!.how));
          if (escFirst) {
            await actor.key('Esc', 0.8, 'Escape');
            await sleep(500);
          }
          const before = await H.hostState(s.page);
          await pick(actor, b, cand.low!.how);
          await s.nextResult(before);
          low = { popover: await s.popover(), note: await lowNote(s.cdp) };
          await actor.refresh();
          await actor.move(...onPopover(low.popover), 400);
          await sleep(2400);
        } else {
          await actor.move(...onPopover(back!), 400);
          await sleep(2300);
        }
      });
      expect(first?.unsure && first.name === a.name, `not-sure: ${JSON.stringify(first)}`);
      expect(stepped?.name && stepped.name !== a.name && /You picked this/.test(stepped.match ?? ''), `not-sure: → showed ${JSON.stringify(stepped)}`);
      expect(back?.name === a.name && /Not sure/.test(back.match ?? ''), `not-sure: the chip went to ${JSON.stringify(back)}`);
      if (b) expect(low?.note && low.popover.name === b.name, `not-sure: the second card read ${JSON.stringify(low)}`);
      const fits = await inShadowRoot<boolean>(s.cdp, 'function () { const p = this.querySelector(".pop-scroll"); return !!p && p.scrollHeight <= p.clientHeight + 1; }');
      checks['not-sure'] = { tried, scene: cand, first, stepped, back, low, escBeforeSecondCard: escFirst, popoverFits: fits };
      await s.close();
      const boxes = [first!.box, stepped!.box, back!.box, low?.popover.box, a.bounds, b?.bounds].filter((x): x is NonNullable<typeof x> => !!x);
      const crop = fitCrop(boxes, 892, 1280, cand.height);
      return {
        name: 'not-sure',
        canvas: [crop[2], crop[3]],
        layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
        events: actor.events,
        t0: rec.t0,
        t1: rec.t1,
        keyAt: [14, -82],
      };
    }
  } finally {
    await s.page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  }
  checks['not-sure'] = { tried };
  throw new Error('not-sure: no scene gave an honest "Not sure" (one is never staged); widen NOT_SURE_SCENES');
}

/** The centre of the chip naming `name` in the popover (CSS px), or null. */
async function chipCenter(cdp: CDPSession, name: string): Promise<[number, number] | null> {
  return inShadowRoot<[number, number] | null>(
    cdp,
    `function (name) {
      const chip = Array.from(this.querySelectorAll('.pop .dv-alts .alt')).find((b) => b.querySelector('em') && b.querySelector('em').textContent.trim() === name);
      if (!chip) return null;
      const r = chip.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    }`,
    [name],
  );
}

/**
 * A fresh history, as the side panel's "Clear history" leaves it (background/history.ts clearHistory): the list in the
 * private IndexedDB store (secure-store.ts: duel-lens-private, its one store kv, key history) emptied, the pictures
 * (thumb:…) gone, no current card, and the panel told (historyChanged).
 */
async function freshHistory(worker: WebWorker): Promise<void> {
  await worker.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('duel-lens-private');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      store.put([], 'history');
      store.delete(IDBKeyRange.bound('thumb:', 'thumb:\uffff'));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }).then(() => chrome.storage.session.remove('currentEntryId')).then(() => chrome.storage.session.set({ historyChanged: crypto.randomUUID() }))`);
}

interface PanelView {
  current: string | null;
  facts: string[];
  entries: { name: string; time: string; active: boolean }[];
  pictureLoaded: boolean;
  /** The ban frame around the card's picture (card-view.tsx BanFrame: 'forbidden', 'limited', 'semi'), or null. */
  banFrame: string | null;
  text: string;
}

async function readPanel(panel: Page): Promise<PanelView> {
  return (await panel.evaluate(`(() => {
    const img = document.querySelector('.current img');
    return {
      current: document.querySelector('.current .dv-name')?.textContent ?? null,
      facts: [...document.querySelectorAll('.current .dv-facts .fact')].map((f) => f.textContent),
      entries: [...document.querySelectorAll('.history li')].map((li) => ({ name: li.querySelector('.name').textContent, time: li.querySelector('.time').textContent, active: li.classList.contains('active') })),
      pictureLoaded: !!img && img.complete && img.naturalWidth > 0,
      banFrame: (() => { const f = document.querySelector('.current .ban-frame'); return f ? ['forbidden', 'limited', 'semi'].find((k) => f.classList.contains(k)) ?? 'other' : null; })(),
      text: document.body.innerText,
    };
  })()`)) as PanelView;
}

async function waitForPanel(panel: Page, test: (v: PanelView) => boolean, what: string, timeoutMs = 30000): Promise<PanelView> {
  const start = Date.now();
  for (;;) {
    const v = await readPanel(panel);
    if (test(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`the side panel never showed ${what}: ${JSON.stringify({ ...v, text: undefined })}`);
    await sleep(150);
  }
}

interface BoardPanelView {
  /** Which of the views ("Live check", "Board", "Scans": the .views buttons) is pressed; null when none is. */
  tab: 'live' | 'board' | 'card' | null;
  /** The board section says "Reading the board…" (no list yet). */
  reading: boolean;
  /** The board's list: each card read, and what the read said (Sure, Not sure, Low match). */
  rows: { name: string; state: string }[];
  /** How many of the rows' small pictures have loaded. */
  thumbs: number;
  /** The board section's placeholder line ("Reading the board…", "No card was read…"), or null once it has a list. */
  emptyText: string | null;
}

/** The side panel's Board view: its list of the cards read (sidepanel/app.tsx: .board-list's .board-item). */
async function readBoardPanel(panel: Page): Promise<BoardPanelView> {
  return (await panel.evaluate(`(() => {
    const tabBtn = [...document.querySelectorAll('.views button')].find((b) => b.getAttribute('aria-pressed') === 'true');
    const label = tabBtn ? tabBtn.textContent.trim() : null;
    const empty = document.querySelector('.board .empty');
    return {
      tab: label === null ? null : label === 'Board' ? 'board' : label === 'Live check' ? 'live' : 'card',
      reading: !!empty && /Reading the board/.test(empty.textContent),
      rows: [...document.querySelectorAll('.board .board-list .board-item')].map((b) => ({ name: b.querySelector('.name').textContent.trim(), state: b.querySelector('.state').textContent.trim() })),
      thumbs: [...document.querySelectorAll('.board .board-list .board-item img')].filter((i) => i.complete && i.naturalWidth > 0).length,
      emptyText: empty ? empty.textContent.trim() : null,
    };
  })()`)) as BoardPanelView;
}

async function waitForBoardPanel(panel: Page, test: (v: BoardPanelView) => boolean, what: string, timeoutMs = 30000): Promise<BoardPanelView> {
  const start = Date.now();
  for (;;) {
    const v = await readBoardPanel(panel);
    if (test(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`the side panel never showed ${what}: ${JSON.stringify(v)}`);
    await sleep(150);
  }
}

/** The pointer the side panel shows at (x, y): the hand over its buttons and links. */
function pageCursor(page: Page) {
  return async (x: number, y: number): Promise<Cursor> =>
    (await page.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el && el.closest('button, a') ? 'hand' : 'arrow'; })()`)) as Cursor;
}

/**
 * 5. Keep (S) and the side panel. Every scan becomes the side panel's card (router.ts), and S opens the
 * panel on it (show-in-panel). Recorded as Chrome shows it: the page at full width with Pot of Greed's
 * popover; S; the page narrows and the side panel (sidepanel.html in a window of its own, placed beside
 * the page) shows the card in full; then the mouse wheel scrolls it down to the scans. Keeping no longer
 * ends scan mode, so the proof that S opened the panel is show-in-panel's own sidePanel.open() call
 * (counted in the service worker) with no failure toast. Scan mode stays open through the resize the
 * panel's opening causes (src/content/app.tsx); checks.json records the host's state after it.
 */
async function keepAndSidePanel(ctx: Ctx): Promise<GifPlan> {
  const scenePage = await ctx.browser.newPage({ type: 'window' });
  await scenePage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const s = await Scene.create(ctx, scenePage);
  await s.open();
  // A fresh history, as after "Clear history".
  await freshHistory(ctx.worker);
  // Earlier scans, a few seconds of video apart.
  for (const id of ['link', 'dm', 'imp-tilt']) {
    await sleep(4000);
    const c = s.card(id);
    const t = await s.trial(c.x, c.y);
    expect(t.state.card === c.name && t.state.confident === 'true', `keep: the earlier scan of ${c.name} read ${JSON.stringify(t.state)}`);
  }
  await sleep(4000);
  const pog = s.card('pog');
  await s.begin();
  await scenePage.mouse.click(pog.x, pog.y);
  const r = await s.result();
  expect(r.card === pog.name && r.confident === 'true', `keep: Pot of Greed read ${JSON.stringify(r)}`);
  const pop = await s.popover();
  expect(pop.facts.includes('Forbidden · TCG') && hasGenesys(pop), `keep: Pot of Greed's facts ${pop.facts}`);
  const problems = await boxProblems(s.cdp);
  expect(problems === null, `keep: Pot of Greed's card box: ${problems}`);
  // The side panel, as it will show once opened (out of the picture until S).
  const panel = await ctx.browser.newPage({ type: 'window' });
  await panel.setViewport({ width: 379, height: 720, deviceScaleFactor: 1 });
  await panel.emulateMediaFeatures(DARK_REDUCED);
  await panel.goto(`chrome-extension://${ctx.extId}/sidepanel.html`);
  await panel.evaluate('document.fonts.ready');
  const shown = await waitForPanel(panel, (v) => v.current === pog.name && v.entries.length === 4 && v.pictureLoaded, 'Pot of Greed and 4 scans');
  await H.settle(panel, 200);
  await H.refocus(scenePage);
  const actor = s.actor([pog.x - 170, pog.y - 70]);
  await actor.place();
  const wheel = new Actor(panel, pageCursor(panel), [262, 430], 2);
  // Counts show-in-panel's chrome.sidePanel.open() calls (router.ts calls it through chrome.sidePanel at
  // call time, so a wrapper sees it; it calls the real one at once, inside the same user gesture).
  const patched = (await ctx.worker.evaluate(`(() => {
    const api = chrome.sidePanel;
    if (!globalThis.__readmeMediaPanel) {
      const open = api.open.bind(api);
      const counter = { calls: 0 };
      try {
        api.open = (opts) => { counter.calls++; return open(opts); };
      } catch {
        return false;
      }
      if (api.open === open) return false;
      globalThis.__readmeMediaPanel = counter;
    }
    globalThis.__readmeMediaPanel.calls = 0;
    return true;
  })()`)) as boolean;
  const panelCalls = async () => (patched ? ((await ctx.worker.evaluate('globalThis.__readmeMediaPanel.calls')) as number) : -1);
  let tPress = 0;
  let tResize = 0;
  let tSwitch = 0;
  // Where the narrowed page is shown from: scan mode stays open after S, so its popover (placed again
  // for the narrower page) is kept in view; x 320 when no popover is left.
  let narrowX = 320;
  let afterS: { calls: number; toast: string | null; host: H.HostState | null } | undefined;
  expect((await panel.evaluate('scrollY')) === 0, 'keep: the side panel is not at its top');
  const rec = await record('keep-and-side-panel', [scenePage, panel], async () => {
    await sleep(1100);
    tPress = now() + 0.15;
    await actor.key('S', 1.0, 's');
    // show-in-panel called sidePanel.open(); a failure would show a toast ("Press Alt+Shift+U…").
    const start = Date.now();
    while (patched && Date.now() - start < 5000 && (await panelCalls()) < 1) await sleep(50);
    await sleep(350);
    afterS = { calls: await panelCalls(), toast: (await H.readPopover(s.cdp))?.toast ?? null, host: await H.hostState(scenePage) };
    // The side panel takes its width from the page. The picture switches once the page has settled.
    await scenePage.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
    tResize = now();
    await H.settle(scenePage, 300);
    tSwitch = now();
    const narrowPop = (await H.readPopover(s.cdp))?.box;
    if (narrowPop) narrowX = Math.max(0, Math.min(900 - 580, Math.round(narrowPop.x - 12)));
    actor.hide();
    await wheel.place();
    await sleep(1400);
    // Down to the list of scans, with the mouse wheel over the panel.
    const bottom = (await panel.evaluate('document.documentElement.scrollHeight - innerHeight')) as number;
    for (let i = 0; i < 80 && ((await panel.evaluate('scrollY')) as number) < bottom - 1; i++) {
      await panel.mouse.wheel({ deltaY: 20 });
      await sleep(50);
    }
    await wheel.refresh();
    await sleep(2700);
  });
  const scrolled = await readPanel(panel);
  const hostAfterResize = await H.hostState(scenePage);
  expect(!afterS?.toast, `keep: S showed a toast (${JSON.stringify(afterS)}); the side panel did not open`);
  expect(!patched || afterS?.calls === 1, `keep: S called sidePanel.open() ${afterS?.calls} times (${JSON.stringify(afterS)})`);
  expect(shown.facts.includes('Forbidden · TCG') && shown.facts.some((f) => /^Genesys \d+ pts?$/.test(f)), `keep: the panel's facts ${shown.facts}`);
  expect(shown.banFrame === 'forbidden', `keep: the panel's picture has no Forbidden frame (${shown.banFrame})`);
  expect(scrolled.entries[0].active && scrolled.entries[0].name === pog.name, `keep: the active entry ${JSON.stringify(scrolled.entries)}`);
  expect(!/E2E/.test(scrolled.text), 'keep: the side panel shows "E2E"');
  checks['keep-and-side-panel'] = { popover: pop, panel: { ...shown, text: undefined }, entries: scrolled.entries, afterS, sidePanelCounted: patched, hostAfterResize };
  await leave(scenePage);
  await panel.close();
  await scenePage.close();
  // A 960 px view of the window's right side: before S, the page (x 320-1280); after, the narrowed
  // page (580 px of it, around the popover when one is open), a divider, and the side panel.
  return {
    name: 'keep-and-side-panel',
    canvas: [960, 720],
    layers: [
      // The full-width page stays in the picture until the panel is: Chrome opens the panel, then the page narrows.
      { frames: rec.frames[0], crop: [320, 0, 960, 720], at: [0, 0], until: tSwitch, frames_before: tPress },
      // The narrowed page repaints once, as it resizes (a still page paints nothing more).
      { frames: rec.frames[0], crop: [narrowX, 0, 580, 720], at: [0, 0], from: tSwitch, frames_from: tResize },
      { frames: rec.frames[1], crop: [0, 0, 379, 720], at: [581, 0], from: tSwitch },
    ],
    dividers: [[580, 0, 1, 720, [42, 39, 51], tSwitch]],
    events: [...actor.events, ...wheel.events],
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [14, 14],
  };
}

/**
 * 6. Cut-off cards, on the picture's top edge: a quarter cut gives "Not sure" with the right card first
 * (the engine's second try completes the card), a third cut, clicked next in the same scan, says part of
 * the card is outside the picture.
 */
async function cutCard(s: Scene): Promise<GifPlan> {
  const tried: unknown[] = [];
  for (const pair of CUT_PAIRS) {
    await s.open(`?add=${pair.rescued.add};${pair.tooCut.add}`);
    const [rescued, tooCut] = s.geo.extra;
    // The part of each card inside the picture: click its middle.
    const visible = (c: Placed): [number, number] => [c.x, Math.max(8, (c.bounds.y + c.bounds.h) / 2)];
    const a = await s.attempt(rescued, 'click', visible(rescued));
    const b = await s.attempt(tooCut, 'click', visible(tooCut));
    const okA = isNotSure(a, pair.rescued.name);
    const okB = !!b && !b.popover.name && b.popover.message === TRUNCATED_MESSAGE;
    tried.push({ pair, rescued: a, tooCut: b, accepted: okA && okB });
    if (!(okA && okB)) continue;
    const actor = s.actor([800, 560]);
    await actor.place();
    let first: H.PopoverView | undefined;
    let second: H.PopoverView | undefined;
    let escFirst = false;
    const rec = await record('cut-card', [s.page], async () => {
      await sleep(400);
      await shortcut(s, actor);
      await sleep(400);
      const [ax, ay] = visible(rescued);
      await actor.move(ax, ay, 600);
      await sleep(300);
      await actor.click();
      await s.result();
      first = await s.popover();
      await actor.refresh();
      await actor.move(...onPopover(first), 450);
      await sleep(1700);
      // Scan mode is still open: the other card is a click away (Esc first, if this popover covers it).
      const at = visible(tooCut);
      escFirst = !!first.box && overlap(first.box, reachOf(tooCut, 'click', at));
      if (escFirst) {
        await actor.key('Esc', 0.8, 'Escape');
        await sleep(500);
      }
      const before = await H.hostState(s.page);
      await actor.move(at[0], at[1], 600);
      await sleep(300);
      await actor.click();
      await s.nextResult(before);
      second = await s.popover();
      await actor.refresh();
      await actor.move(...onPopover(second), 400);
      await sleep(2300);
    });
    expect(first?.unsure && first.name === pair.rescued.name, `cut-card: the first read ${JSON.stringify(first)}`);
    expect(second?.message === TRUNCATED_MESSAGE, `cut-card: the second read ${JSON.stringify(second)}`);
    checks['cut-card'] = { tried, first, second, escBeforeSecondCard: escFirst };
    await s.close();
    const crop = fitCrop([rescued.bounds, tooCut.bounds, first!.box, second!.box].filter((x): x is Box => !!x), 892, 1280, 720);
    return {
      name: 'cut-card',
      canvas: [crop[2], crop[3]],
      layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
      events: actor.events,
      t0: rec.t0,
      t1: rec.t1,
      keyAt: [14, -82],
    };
  }
  checks['cut-card'] = { tried };
  throw new Error('cut-card: no pair gave both answers; make a still instead (see README.md in this folder)');
}

/**
 * Alt+Shift+Y on a specific tab (duelLensDebug.startScan(tabId)): with two windows open (the scene and
 * the side panel), `chrome.tabs.query({active:true, currentWindow:true})` has no "current window" from
 * the service worker, so the plain shortcut() helper (no tab id) can pick the wrong one.
 */
async function beginOnTab(s: Scene, tabId: number): Promise<number> {
  await s.ctx.worker.evaluate(`globalThis.duelLensDebug.startScan(${tabId})`);
  await H.waitForState(s.page, ['selecting'], 15000);
  const n = await H.waitForOutlines(s.page, 20000);
  await H.settle(s.page, 250);
  return n;
}

/** The shortcut, as the viewer sees it, pinned to `tabId` (see beginOnTab). */
async function shortcutOnTab(s: Scene, actor: Actor, tabId: number): Promise<number> {
  await actor.key('Alt + Shift + Y', 1.3);
  await sleep(120);
  const n = await beginOnTab(s, tabId);
  await actor.refresh();
  return n;
}

/**
 * 7. "Read the whole board" (board.ts): with every card outlined, B reads them one at a time (the bar
 * counts up, "Reading N of M…"); scan mode stays open, and the side panel opens on the Board view's list
 * (the same live gesture as Keep: sidePanel.open() at the press, the final board once it is read).
 */
async function readTheBoard(ctx: Ctx): Promise<GifPlan> {
  const scenePage = await ctx.browser.newPage({ type: 'window' });
  await scenePage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const s = await Scene.create(ctx, scenePage);
  await s.open();
  const tabId = (await ctx.worker.evaluate(`(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => t.url === ${JSON.stringify(scenePage.url())});
    return t ? t.id : null;
  })()`)) as number | null;
  expect(tabId !== null, 'read-the-board: could not find the scene tab to scan (two windows are open)');
  // A fresh install's state: no history, no earlier board.
  await freshHistory(ctx.worker);
  await ctx.worker.evaluate("chrome.storage.session.remove('board')");
  // The side panel, already open and watching storage (out of the picture until B).
  const panel = await ctx.browser.newPage({ type: 'window' });
  await panel.setViewport({ width: 379, height: 720, deviceScaleFactor: 1 });
  await panel.emulateMediaFeatures(DARK_REDUCED);
  await panel.goto(`chrome-extension://${ctx.extId}/sidepanel.html`);
  await panel.evaluate('document.fonts.ready');
  await H.settle(panel, 200);
  await H.refocus(scenePage);
  const actor = s.actor([150, 240]); // off every outline, as hover-preview rests
  await actor.place();
  // Counts show-board's chrome.sidePanel.open() call at the B press (the same wrapper as Keep's S).
  const patched = (await ctx.worker.evaluate(`(() => {
    const api = chrome.sidePanel;
    if (!globalThis.__readmeMediaPanel) {
      const open = api.open.bind(api);
      const counter = { calls: 0 };
      try {
        api.open = (opts) => { counter.calls++; return open(opts); };
      } catch {
        return false;
      }
      if (api.open === open) return false;
      globalThis.__readmeMediaPanel = counter;
    }
    globalThis.__readmeMediaPanel.calls = 0;
    return true;
  })()`)) as boolean;
  const panelCalls = async () => (patched ? ((await ctx.worker.evaluate('globalThis.__readmeMediaPanel.calls')) as number) : -1);
  let n = 0;
  let bar: BarView | undefined;
  let tSwitch = 0;
  let tResize = 0;
  let afterPress: { calls: number; toast: string | null } | undefined;
  const progress: string[] = [];
  let board: BoardPanelView | undefined;
  const rec = await record('read-the-board', [scenePage, panel], async () => {
    await sleep(900);
    n = await shortcutOnTab(s, actor, tabId!);
    bar = await expectBar(s.cdp, n, 'read-the-board');
    await sleep(700);
    await actor.key('B', 1.0, 'b');
    const start = Date.now();
    while (patched && Date.now() - start < 5000 && (await panelCalls()) < 1) await sleep(50);
    await sleep(250);
    afterPress = { calls: await panelCalls(), toast: (await H.readPopover(s.cdp))?.toast ?? null };
    tResize = now();
    await scenePage.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
    await H.settle(scenePage, 250);
    tSwitch = now();
    actor.hide();
    // The bar counts up while the board is read (sampled here for the checks; the GIF has it live).
    for (let i = 0; i < 100; i++) {
      const b = await readBar(s.cdp);
      if (b) progress.push(b.text);
      const sawReading = progress.some((t) => /Reading \d+ of \d+/.test(t));
      if (b && sawReading && !/Reading \d+ of \d+/.test(b.text)) break;
      if (i > 25 && !sawReading) break; // too fast (or too slow) to catch mid-read: move on
      await sleep(80);
    }
    // The finished board, with its cards' names and small pictures in (they come from the card data a moment after).
    board = await waitForBoardPanel(
      panel,
      (v) => v.tab === 'board' && !v.reading && v.rows.length > 0 && v.rows.every((r) => r.name !== 'Loading…') && v.thumbs === v.rows.length,
      'the finished board, its names and pictures',
    );
    await H.settle(panel, 200);
    await sleep(2600);
  });
  expect(afterPress && !afterPress.toast, `read-the-board: B showed a toast (${JSON.stringify(afterPress)}); the side panel did not open`);
  expect(!patched || afterPress?.calls === 1, `read-the-board: B called sidePanel.open() ${afterPress?.calls} times (${JSON.stringify(afterPress)})`);
  const total = board?.rows.length ?? 0;
  expect(board && total > 0 && total <= n, `read-the-board: the board's list ${JSON.stringify(board)} for ${n} outlines`);
  expect(board.rows.every((r) => s.geo.faceUp.some((c) => c.name === r.name)), `read-the-board: a card on the board's list is not on the scene (${JSON.stringify(board.rows)})`);
  const hostAfter = await H.hostState(scenePage);
  expect(hostAfter, 'read-the-board: scan mode did not stay open after the read');
  checks['read-the-board'] = { outlines: n, bar, afterPress, progress, board, sidePanelCounted: patched, hostAfter };
  await leave(scenePage);
  await panel.close();
  await scenePage.close();
  const fullCrop = fitCrop([bar!.box, ...s.geo.faceUp.map((c) => c.bounds)], 960, 1280, 720);
  const canvasW = fullCrop[2];
  const narrowW = canvasW - 1 - 379;
  const narrowX = Math.max(0, Math.min(900 - narrowW, 160));
  return {
    name: 'read-the-board',
    canvas: [canvasW, 720],
    layers: [
      // The full board, outlined, until the panel opens (the B press is the same live gesture as Keep's S): its frames
      // from before the page narrowed (a narrowed frame is too small for this crop).
      { frames: rec.frames[0], crop: fullCrop, at: [0, 0], until: tSwitch, frames_before: tResize },
      // The narrowed page repaints once, as it resizes, then the bar counts up over it.
      { frames: rec.frames[0], crop: [narrowX, 0, narrowW, 720], at: [0, 0], from: tSwitch, frames_from: tResize },
      { frames: rec.frames[1], crop: [0, 0, 379, 720], at: [narrowW + 1, 0], from: tSwitch },
    ],
    dividers: [[narrowW, 0, 1, 720, [42, 39, 51], tSwitch]],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [14, 14],
  };
}

// ---------- Live check ----------

/**
 * Live check's hero (live-check.gif), on the scene with its clock running: Dark Magician (no banlist status), then
 * Solemn Judgment (TCG Limited: its orange frame), put on the Spell & Trap Zone's face-down card (?add=, over it), then
 * Pot of Greed (Forbidden: its red frame). The pointer's way from one to the next keeps to the gaps between the
 * cards, so no other card's box shows on the way (a box follows the pointer at once onto any card Live has listed).
 * `at` is where the pointer rests, from the card's middle.
 */
const LIVE_ADD = 'bench/41420027@478,566,1.5';
const LIVE_CARDS: { id: string; name: string; ban: string | null; at: [number, number] }[] = [
  { id: 'dm', name: 'Dark Magician', ban: null, at: [4, 10] },
  { id: 'add-0', name: 'Solemn Judgment', ban: 'limited', at: [2, 8] },
  { id: 'pog', name: 'Pot of Greed', ban: 'forbidden', at: [4, 8] },
];
/**
 * Live check on a picture (live-check-picture.gif): two cards of the deck list's second row (deck-picture.html), whose
 * boxes open above them, over the first row: Number 39: Utopia (a Rank: the outlined star), then Accesscode Talker (a
 * Link: its arrows' grid).
 */
const PICTURE_CARDS: { name: string; ban: string | null }[] = [
  { name: 'Number 39: Utopia', ban: null },
  { name: 'Accesscode Talker', ban: null },
];

/**
 * Turns Live check on or off as the toolbar popup's switch ends up doing: the setting live.check, which the browser
 * follows (background/live-check.ts: the script on every page, the open tabs armed). The E2E build holds every site
 * already, and consent was given.
 */
async function setLiveCheck(worker: WebWorker, on: boolean): Promise<void> {
  await worker.evaluate(
    `chrome.storage.local.get('settings').then((s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), live: { ...((s.settings || {}).live || {}), check: ${on} } } }))`,
  );
  await sleep(1500);
}

interface LiveView {
  /** The pill at the video's corner: its word ("Live check"), its count, and whether it is ready (not "getting ready"). */
  pill: { word: string | null; count: string | null; ready: boolean; box: Box } | null;
  /** The outline on the card under the pointer: gold once listed, dashed grey while it is read. */
  outline: { state: 'promoted' | 'reading'; box: Box } | null;
  /** The card box: its card, or its loading state ("reading"), its ban frame and its picture. */
  card: { name: string | null; reading: boolean; banFrame: string | null; pictureLoaded: boolean; facts: (string | null)[]; box: Box } | null;
}

/** What Live check shows on the page, read through its host's closed shadow root (LIVE_HOST). */
async function readLive(cdp: CDPSession): Promise<LiveView | null> {
  return inShadowRoot<LiveView>(
    cdp,
    `function () {
      const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      const text = (e) => (e ? e.textContent.replace(/\\s+/g, ' ').trim() : null);
      const shown = (e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && !e.classList.contains('measuring'); };
      const pill = this.querySelector('.live-pill');
      const outline = this.querySelector('.live-outline');
      const pop = Array.from(this.querySelectorAll('.pop')).find(shown);
      const img = pop ? pop.querySelector('.dv-card img') : null;
      const frame = pop ? pop.querySelector('.ban-frame') : null;
      return {
        pill: pill ? { word: text(pill.querySelector('.live-word')), count: text(pill.querySelector('.live-count')), ready: !pill.querySelector('.live-ready'), box: rect(pill) } : null,
        outline: outline ? { state: outline.classList.contains('promoted') ? 'promoted' : 'reading', box: rect(outline) } : null,
        card: pop
          ? {
              name: text(pop.querySelector('.dv-name')),
              reading: !!pop.querySelector('.skel'),
              banFrame: frame ? ['forbidden', 'limited', 'semi'].find((k) => frame.classList.contains(k)) || 'other' : null,
              pictureLoaded: !!img && img.complete && img.naturalWidth > 0,
              facts: Array.from(pop.querySelectorAll('.dv-facts .fact')).map(text),
              box: rect(pop),
            }
          : null,
      };
    }`,
    [],
    LIVE_HOST,
  );
}

/** Waits until Live check's card box shows `name` (read, not loading) with its picture. */
async function waitForLiveCard(cdp: CDPSession, name: string, timeoutMs = 30000): Promise<LiveView & { t: number }> {
  const start = Date.now();
  let last: LiveView | null = null;
  for (;;) {
    last = await readLive(cdp).catch(() => null);
    if (last?.card && last.card.name === name && !last.card.reading && last.card.pictureLoaded) return { ...last, t: now() };
    if (Date.now() - start > timeoutMs) throw new Error(`Live check's box never showed ${name} within ${timeoutMs / 1000} s (last: ${JSON.stringify(last)})`);
    await sleep(60);
  }
}

/** Reads what Live check shows every ~70 ms while a clip records: the checks see each state the GIF shows. */
class LiveSampler {
  readonly samples: (LiveView & { t: number })[] = [];
  private on = true;
  private readonly loop: Promise<void>;
  constructor(cdp: CDPSession) {
    this.loop = (async () => {
      while (this.on) {
        const v = await readLive(cdp).catch(() => null);
        if (v) this.samples.push({ ...v, t: now() });
        await sleep(70);
      }
    })();
  }
  async stop(): Promise<void> {
    this.on = false;
    await this.loop;
  }
}

/** Whether (x, y) lies in `b`. */
const inside = (b: Box | undefined | null, x: number, y: number) => !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/** One card of a Live clip: where the pointer rested, when it came, when its box was complete, when it moved on. */
interface LiveHit {
  name: string;
  at: [number, number];
  arrived: number;
  left: number;
  view: LiveView & { t: number };
}

/**
 * Rests the pointer on each of `cards` in turn (`hold` seconds), as a viewer does: a slow move there, the box (its
 * loading state first when the card isn't read yet, then the card), the next card. Returns what showed when each
 * card's box was complete, with the pointer's spot and times.
 */
async function restOnEach(cdp: CDPSession, actor: Actor, cards: { name: string; at: [number, number]; moveMs: number; hold: number }[]): Promise<LiveHit[]> {
  const out: LiveHit[] = [];
  for (const c of cards) {
    await actor.move(c.at[0], c.at[1], c.moveMs);
    const arrived = now();
    const view = await waitForLiveCard(cdp, c.name);
    await actor.refresh();
    await sleep(c.hold * 1000);
    out.push({ name: c.name, at: c.at, arrived, left: now(), view });
  }
  return out;
}

/**
 * The samples where `h`'s box was not its card, complete, while the pointer still rested on the card. Seen on Dark
 * Magician when Live check started with the pointer on it (9 takes of 11): about 1.5 s after its box opened, the box
 * went back to its loading state for 0.1 to 0.5 s, then showed the card again. Should it happen, the clip is taken
 * again (LIVE_TAKES), checks.json keeps what each take saw, and live-check-trail-take<N>.json what Live did.
 */
const unsteady = (samples: (LiveView & { t: number })[], h: LiveHit) =>
  samples.filter((v) => v.t > h.view.t + 0.05 && v.t < h.left - 0.05 && !(v.card?.name === h.name && !v.card.reading));

/** Takes of a Live clip before its run stops on a box that did not stay (unsteady). */
const LIVE_TAKES = 4;

/**
 * The hero: Live check on a playing video. The scene's video plays, its clock running; the pointer comes onto the video
 * and stops on the mat: Live check starts there (the LIVE CHECK pill at the video's corner). Then it rests on Dark
 * Magician: the card's gold outline and its box beside it. Then Solemn Judgment, and its box follows ("reading" for a
 * moment when Live has not read it yet, then the card, with its Limited frame), then Pot of Greed (the Forbidden frame).
 * The pointer stops on the mat first because the box of a card Live's very first look found under the pointer went
 * back to its loading state about 1.5 s after it opened, in 9 takes of 11 (see unsteady). Every box is the engine's
 * own read, checked; the video never stops. Before it, a warm-up in a tab of its own loads the engine and caches the
 * three pictures, as for a viewer who has had Live check on for a while: then the tab is closed, and the clip's tab
 * starts Live check afresh.
 */
async function liveCheck(ctx: Ctx): Promise<GifPlan> {
  const query = `?${CLOCK_QUERY}&add=${LIVE_ADD}`;
  const warmPage = await ctx.browser.newPage();
  await warmPage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const warm = await Scene.create(ctx, warmPage);
  await warm.open(query);
  const warmed: string[] = [];
  for (const c of LIVE_CARDS) {
    const card = warm.card(c.id);
    await warmPage.mouse.move(card.x + c.at[0], card.y + c.at[1], { steps: 6 });
    warmed.push((await waitForLiveCard(warm.cdp, c.name, 60000)).card!.name!);
    await sleep(400);
  }
  await warmPage.close();
  await sleep(800);

  const retakes: unknown[] = [];
  for (let take = 1; ; take++) {
    const page = await ctx.browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    const s = await Scene.create(ctx, page);
    await s.open(query);
    await sleep(2500); // the engine is asked to load when a page has a video this big (arm.ts warm)
    const before = await readLive(s.cdp);
    expect(!before?.pill && !before?.card, `live-check: Live check showed something before the pointer came (${JSON.stringify(before)})`);
    const clockText = async () => (await page.evaluate("document.getElementById('time').textContent")) as string;
    const playing = async () => (await page.evaluate("!document.getElementById('duel').paused")) as boolean;
    const clock0 = await clockText();
    const spots = LIVE_CARDS.map((c) => {
      const card = s.card(c.id);
      return { ...c, spot: [card.x + c.at[0], card.y + c.at[1]] as [number, number], bounds: card.bounds };
    });
    // The pointer comes in from the right, outside the picture: it never rested on the video before the clip.
    const actor = new Actor(page, duelLensCursor(s.cdp, LIVE_HOST), [990, 430]);
    await actor.place(false);
    // Where the pointer first rests: the empty Main Monster Zone left of Dark Magician (no card there).
    const dm = s.card('dm');
    const mat: [number, number] = [dm.x - 162, dm.y + 14];
    const sampler = new LiveSampler(s.cdp);
    let hits: LiveHit[] = [];
    let stillPlaying = false;
    let onMat: LiveView | null = null;
    const rec = await record('live-check', [page], async () => {
      await sleep(1100); // the video plays
      // The pointer comes onto the video and stops on the mat: Live check starts there (the pill), no card under it.
      await actor.move(mat[0], mat[1], 1400);
      await sleep(1900);
      onMat = await readLive(s.cdp);
      hits = await restOnEach(s.cdp, actor, [
        { name: spots[0].name, at: spots[0].spot, moveMs: 650, hold: 2.6 },
        { name: spots[1].name, at: spots[1].spot, moveMs: 900, hold: 2.8 },
        { name: spots[2].name, at: spots[2].spot, moveMs: 750, hold: 3.2 },
      ]);
      stillPlaying = await playing();
    });
    await sampler.stop();
    const clock1 = await clockText();
    const samples = sampler.samples;
    const wobble = hits.flatMap((h) => unsteady(samples, h).map((v) => ({ card: h.name, atS: Math.round((v.t - rec.t0) * 100) / 100, shows: v.card ? (v.card.reading ? 'reading' : v.card.name) : 'nothing' })));
    if (wobble.length) {
      // What Live did then (its reads, their tracks), for whoever looks into it.
      const trail = await ctx.worker.evaluate('globalThis.duelLensDebug.liveTrail()').catch(() => null);
      await writeFile(path.join(RAW, `live-check-trail-take${take}.json`), JSON.stringify({ t0: rec.t0, wobble, hits, trail }, null, 1));
    }
    // Each card's loading state, before its box was complete: the box's "reading", or the grey dashed outline of a card
    // found but not read yet; how long it showed (s). From the last card's box on (the pointer then moves through the
    // gaps between the cards, so a loading state then is this card's).
    const loadingOf = (h: LiveHit) => {
      const from = hits[hits.indexOf(h) - 1]?.view.t ?? 0;
      const seen = samples.filter((v) => v.t > from && v.t < h.view.t && (v.card?.reading || v.outline?.state === 'reading'));
      return { samples: seen.length, seconds: seen.length ? Math.round((seen[seen.length - 1].t - seen[0].t + 0.07) * 100) / 100 : 0 };
    };
    // The loading state is brief here (0.1 to 0.3 s: the engine is warm and fast, and the sampler sees it once or twice;
    // the GIF, from every painted frame, shows it a frame or two), and whether a card shows it at all depends on whether
    // Live had read it before the pointer came.
    if (wobble.length && take < LIVE_TAKES) {
      retakes.push({ take, wobble, loading: hits.map((h) => ({ name: h.name, ...loadingOf(h) })) });
      await page.close();
      await sleep(800);
      continue;
    }
    expect(!wobble.length, `live-check: in ${take} takes, a box never stayed while the pointer rested on its card (${JSON.stringify([...retakes, { take, wobble }])})`);
    for (const [i, h] of hits.entries()) {
      const want = spots[i];
      expect(h.view.card?.name === want.name && h.view.card.banFrame === want.ban, `live-check: ${want.name}'s box showed ${JSON.stringify(h.view.card)}`);
      expect(h.view.outline?.state === 'promoted' && inside(h.view.outline.box, ...h.at), `live-check: no gold outline under the pointer on ${want.name} (${JSON.stringify(h.view.outline)})`);
      expect(h.view.pill && /^live check$/i.test(h.view.pill.word ?? '') && h.view.pill.ready && Number(h.view.pill.count) >= 1, `live-check: the pill on ${want.name}: ${JSON.stringify(h.view.pill)}`);
      expect(h.view.card!.box.x >= 0 && h.view.card!.box.y >= 0 && h.view.card!.box.x + h.view.card!.box.w <= 960, `live-check: ${want.name}'s box is outside the picture (${JSON.stringify(h.view.card!.box)})`);
    }
    // Only the card under the pointer has a box: none of another card while the pointer went from one to the next.
    const names = new Set(samples.map((v) => v.card?.name).filter((n): n is string => !!n));
    expect([...names].every((n) => LIVE_CARDS.some((c) => c.name === n)), `live-check: a box of another card showed on the way (${[...names].join(', ')})`);
    expect(stillPlaying && clock1 !== clock0, `live-check: the video did not keep playing (${clock0} → ${clock1}, playing ${stillPlaying})`);
    const mats = onMat as LiveView | null;
    expect(mats?.pill && !mats.card, `live-check: resting on the mat, Live check should have started (its pill) with no box (${JSON.stringify(mats)})`);
    checks['live-check'] = {
      onMat: mats,
      warmed,
      take,
      retakes,
      hits: hits.map((h) => ({ name: h.name, at: h.at, view: h.view })),
      loading: hits.map((h) => ({ name: h.name, ...loadingOf(h), waitedS: Math.round((h.view.t - h.arrived) * 100) / 100 })),
      pillCounts: [...new Set(samples.map((v) => v.pill?.count).filter(Boolean))],
      clock: [clock0, clock1],
      samples: samples.length,
    };
    expect(hits.some((h) => loadingOf(h).samples > 0), `live-check: no card's box showed its loading state ("reading") before the card (${JSON.stringify(retakes)})`);
    await page.close();
    return {
      name: 'live-check',
      canvas: [960, 720],
      layers: [{ frames: rec.frames[0], crop: [0, 0, 960, 720], at: [0, 0] }],
      events: actor.events,
      t0: rec.t0,
      t1: rec.t1,
    };
  }
}

interface DeckCard {
  name: string;
  x: number;
  y: number;
  bounds: Box;
}

/**
 * Live check on a picture: a deck list (an <img>, deck-picture.html). The pointer rests on Number 39: Utopia: its
 * box ("reading", then the card); then on Accesscode Talker, and the box follows. No pill: that is the video's.
 */
async function liveCheckPicture(ctx: Ctx): Promise<GifPlan> {
  const open = async (page: Page) => {
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures(DARK_REDUCED);
    await page.goto(ctx.sceneUrl('picture'), { waitUntil: 'load' });
    await page.evaluate('window.deck.ready');
    await H.refocus(page);
    await H.settle(page, 300);
    return (await page.evaluate('window.deck.cards()')) as DeckCard[];
  };
  // The warm-up: the cards' reads and pictures, as for the hero.
  const warmPage = await ctx.browser.newPage();
  const warmCards = await open(warmPage);
  const warmCdp = await warmPage.createCDPSession();
  await sleep(1500);
  for (const c of PICTURE_CARDS) {
    const d = warmCards.find((x) => x.name === c.name)!;
    await warmPage.mouse.move(d.x - 4, d.y, { steps: 4 });
    await warmPage.mouse.move(d.x, d.y + 6, { steps: 3 });
    await waitForLiveCard(warmCdp, c.name, 60000);
    await sleep(300);
  }
  await warmPage.close();
  await sleep(600);

  const retakes: unknown[] = [];
  for (let take = 1; ; take++) {
    const page = await ctx.browser.newPage();
    const cards = await open(page);
    const cdp = await page.createCDPSession();
    await sleep(1500);
    const img = (await page.evaluate("(() => { const r = document.getElementById('deck').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()")) as Box;
    const spots = PICTURE_CARDS.map((c) => {
      const d = cards.find((x) => x.name === c.name);
      expect(d, `live-check-picture: no ${c.name} on the deck list`);
      return { ...c, spot: [d.x + 3, d.y + 6] as [number, number], bounds: d.bounds };
    });
    // Below the picture, on the page: nothing to read there.
    const actor = new Actor(page, duelLensCursor(cdp, LIVE_HOST), [img.x + img.w * 0.62, img.y + img.h + 70]);
    await actor.place();
    const sampler = new LiveSampler(cdp);
    let hits: LiveHit[] = [];
    const rec = await record('live-check-picture', [page], async () => {
      await sleep(900);
      hits = await restOnEach(cdp, actor, [
        { name: spots[0].name, at: spots[0].spot, moveMs: 1100, hold: 2.8 },
        { name: spots[1].name, at: spots[1].spot, moveMs: 900, hold: 3.0 },
      ]);
    });
    await sampler.stop();
    const samples = sampler.samples;
    const wobble = hits.flatMap((h) => unsteady(samples, h).map((v) => ({ card: h.name, atS: Math.round((v.t - rec.t0) * 100) / 100, shows: v.card ? (v.card.reading ? 'reading' : v.card.name) : 'nothing' })));
    if (wobble.length && take < LIVE_TAKES) {
      retakes.push({ take, wobble });
      await page.close();
      await sleep(800);
      continue;
    }
    expect(!wobble.length, `live-check-picture: in ${take} takes, a box never stayed while the pointer rested on its card (${JSON.stringify([...retakes, { take, wobble }])})`);
    const loading = hits.map((h, i) => samples.filter((v) => v.t > (hits[i - 1]?.view.t ?? 0) && v.t < h.view.t && v.card?.reading).length);
    for (const [i, h] of hits.entries()) {
      const want = spots[i];
      expect(h.view.card?.name === want.name && h.view.card.banFrame === want.ban, `live-check-picture: ${want.name}'s box showed ${JSON.stringify(h.view.card)}`);
      expect(!h.view.pill, `live-check-picture: a pill on a picture (${JSON.stringify(h.view.pill)})`);
    }
    const names = new Set(samples.map((v) => v.card?.name).filter((n): n is string => !!n));
    expect([...names].every((n) => PICTURE_CARDS.some((c) => c.name === n)), `live-check-picture: a box of another card showed (${[...names].join(', ')})`);
    checks['live-check-picture'] = { take, retakes, hits: hits.map((h) => ({ name: h.name, at: h.at, view: h.view })), loadingSamples: loading, image: img, samples: samples.length };
    expect(loading.some((n) => n > 0), `live-check-picture: no card's box showed its loading state ("reading") before the card`);
    await page.close();
    const boxes = [img, ...hits.map((h) => h.view.card!.box)];
    const crop = fitCrop(boxes, 960, 1280, 720);
    return {
      name: 'live-check-picture',
      canvas: [crop[2], crop[3]],
      layers: [{ frames: rec.frames[0], crop, at: [0, 0] }],
      events: actor.events,
      t0: rec.t0,
      t1: rec.t1,
    };
  }
}

// ---------- stills ----------

/**
 * Screenshot of the area `r` (viewport CSS px, as getBoundingClientRect gives it) grown by `pad`, at the
 * page's device scale. Puppeteer's clip is in document coordinates, and it must stay inside the viewport:
 * a capture beyond it lays the page out again and moves its fixed parts (the welcome page's foil line).
 */
async function shoot(page: Page, file: string, r: { x: number; y: number; w: number; h: number }, pad = 0): Promise<void> {
  const { sx, sy, vw, vh } = (await page.evaluate('({ sx: scrollX, sy: scrollY, vw: innerWidth, vh: innerHeight })')) as { sx: number; sy: number; vw: number; vh: number };
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  const width = Math.min(vw - x, r.w + 2 * pad);
  const height = Math.min(vh - y, r.h + 2 * pad);
  expect(r.y - pad >= 0 && r.y + r.h + pad <= vh && r.x - pad >= 0 && r.x + r.w + pad <= vw, `${path.basename(file)}: the area is not all in view (${JSON.stringify(r)} in ${vw}x${vh})`);
  await page.screenshot({ path: file, clip: { x: x + sx, y: y + sy, width, height }, captureBeyondViewport: false });
}

/** The welcome page's consent step, as the install shows it (dark theme, before agreeing); then a real "Agree and start". */
async function welcomeConsent(browser: Browser, worker: WebWorker): Promise<void> {
  const welcome = await H.installWelcomePage(browser);
  await welcome.setViewport({ width: 1000, height: 900, deviceScaleFactor: 2 });
  await welcome.emulateMediaFeatures(DARK_REDUCED);
  await welcome.reload({ waitUntil: 'load' });
  await welcome.bringToFront();
  await welcome.waitForFunction("document.body.innerText.includes('Before your first scan')", { timeout: 30000 });
  await welcome.evaluate('document.fonts.ready');
  await H.settle(welcome, 400);
  const before = (await worker.evaluate("chrome.storage.local.get('consentedAt')")) as { consentedAt?: number };
  expect(before.consentedAt === undefined, 'welcome-consent: consent was already given');
  const box = (await welcome.evaluate(`(() => {
    const el = document.getElementById('consent');
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.innerText };
  })()`)) as { x: number; y: number; w: number; h: number; text: string };
  await H.settle(welcome, 200);
  const r = (await welcome.evaluate(`(() => { const r = document.getElementById('consent').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)) as {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  for (const lead of ['Screenshots.', 'History.', 'Card data and pictures.', 'AI check (off).', 'Agree and start', 'Not now']) {
    expect(box.text.includes(lead), `welcome-consent: "${lead}" is missing`);
  }
  expect(!/E2E/.test(box.text), 'welcome-consent: the step shows "E2E"');
  await shoot(welcome, path.join(OUT, 'welcome-consent.png'), r, 16);
  checks['welcome-consent'] = { box: r, text: box.text };
  const [agree] = await welcome.$$('xpath/.//button[normalize-space()="Agree and start"]');
  await agree.click();
  await welcome.waitForFunction("document.body.innerText.includes(\"You're all set\")", { timeout: 15000 });
  const after = (await worker.evaluate("chrome.storage.local.get('consentedAt')")) as { consentedAt?: number };
  expect(typeof after.consentedAt === 'number', 'welcome-consent: "Agree and start" stored no consent');
  await welcome.close();
}

/** The Options page's AI check section, as a new install has it (off, no key). */
async function optionsStill(ctx: Ctx): Promise<void> {
  const page = await ctx.browser.newPage();
  try {
    await page.setViewport({ width: 1000, height: 1100, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures(DARK_REDUCED);
    await page.goto(`chrome-extension://${ctx.extId}/options.html`, { waitUntil: 'load' });
    await page.waitForFunction("document.getElementById('ai-check') && document.getElementById('ai-key')", { timeout: 30000 });
    await page.evaluate('document.fonts.ready');
    await H.settle(page, 400);
    const view = (await page.evaluate(`(() => {
      const el = document.getElementById('ai-check');
      el.scrollIntoView({ block: 'start' });
      window.scrollBy(0, -24);
      const r = el.getBoundingClientRect();
      const box = document.querySelector('#ai-check input[type=checkbox]');
      return { x: r.x, y: r.y, w: r.width, h: r.height, text: el.innerText, checked: box ? box.checked : null, key: document.getElementById('ai-key').value };
    })()`)) as { x: number; y: number; w: number; h: number; text: string; checked: boolean | null; key: string };
    await H.settle(page, 200);
    const r = (await page.evaluate(`(() => { const r = document.getElementById('ai-check').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)) as {
      x: number;
      y: number;
      w: number;
      h: number;
    };
    expect(view.checked === false && view.key === '', `options: the AI check is not off and empty (${JSON.stringify({ checked: view.checked, key: view.key })})`);
    expect(/Off by default/.test(view.text), 'options: the disclosure is missing');
    expect(!/E2E/.test(view.text), 'options: the section shows "E2E"');
    await shoot(page, path.join(OUT, 'options.png'), r, 16);
    checks.options = { box: r, text: view.text };
  } finally {
    await page.close();
  }
}

interface Part {
  label: string;
  side: 'left' | 'right';
  box: { x: number; y: number; w: number; h: number };
  /** Where its dot goes (page px): the middle of its edge on the label's side by default. */
  dot?: [number, number];
  /**
   * The line's lane: from the dot it goes up or down to this y first (a gap between the box's rows), then out to the
   * box's edge, so it never crosses the parts beside it on its row (the Attribute left of the Level, Wrong card?
   * left of the flag).
   */
  lane?: number;
}

/** What the anatomy's card box must show: every part the callouts name. Null when it does, else what is missing. */
const ANATOMY_NEEDS = `function () {
  const pop = this.querySelector('.pop:not(.hovering)');
  if (!pop) return 'no pinned card box';
  const q = (sel) => pop.querySelector(sel);
  const missing = [];
  const need = (ok, what) => { if (!ok) missing.push(what); };
  need(q('.dv-zoom img'), 'the picture (a button that shows it bigger)');
  need(q('.ban-frame.limited .ban-band'), "the Limited frame around the picture");
  need(q('.fact.attr .attr-icon') && q('.fact.attr .attr-icon').dataset.k, 'the Attribute icon with its kanji');
  need(q('.fact.level svg.star'), 'the Level star');
  need(q('.fact.mono') && /ATK/.test(q('.fact.mono').textContent), 'ATK / DEF');
  need(q('.fact.ban svg.mark') && / · TCG$/.test(q('.fact.ban').textContent.trim()), 'the TCG banlist status with its mark');
  need(q('.fact.genesys svg.mark') && /^Genesys \\d+ pts?$/.test(q('.fact.genesys').textContent.trim()), 'the Genesys points with the hexagon');
  const ids = q('.dv-meta .dv-ids');
  need(ids && /Passcode/i.test(ids.textContent) && /Archetype/i.test(ids.textContent) && q('.dv-prices') && /[$€]/.test(q('.dv-prices').textContent), 'the Passcode / Archetype / Price line');
  const links = Array.from(pop.querySelectorAll('.dv-links a')).map((a) => a.textContent);
  need(links.some((t) => /Konami/.test(t)) && links.some((t) => /YGOPRODeck/.test(t)), 'the Konami database and YGOPRODeck links');
  const btns = Array.from(pop.querySelectorAll('.dv-foot .dv-actions .btn'));
  need(btns.some((b) => /Keep in side panel/.test(b.textContent) && b.querySelector('kbd')), 'Keep in side panel [S]');
  need(btns.some((b) => /Wrong card/.test(b.textContent)), 'Wrong card?');
  need(q('.dv-foot .btn.report'), 'the Report flag');
  need(!btns.some((b) => /copy/i.test(b.textContent)), 'no Copy button');
  const sc = q('.pop-scroll');
  need(sc && sc.scrollHeight <= sc.clientHeight + 1, 'the whole box in view (no scroll)');
  return missing.length ? missing.join('; ') : null;
}`;

/**
 * The card box's parts, named: the card is read for real (a click on its outline), then each part's box is read
 * from the card box, and the callouts are drawn around a screenshot of it on a page of their own (like the store
 * images' captions).
 */
async function popoverAnatomy(ctx: Ctx): Promise<void> {
  const page = await ctx.browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
    const s = await Scene.create(ctx, page);
    let chosen: (typeof ANATOMY_CARDS)[number] | null = null;
    const tried: unknown[] = [];
    for (const cand of ANATOMY_CARDS) {
      await s.open(`?add=${cand.add}`);
      const c = s.geo.extra[0];
      await s.begin();
      await page.mouse.click(c.x, c.y);
      const state = await s.result().catch(() => null);
      const pop = state?.state === 'result' ? await s.popover() : null;
      const missing = pop ? await inShadowRoot<string | null>(s.cdp, ANATOMY_NEEDS) : 'no answer';
      await s.close(); // the pictures are cached now
      const ok = state?.card === cand.name && state.confident === 'true' && missing === null;
      tried.push({ cand, state, facts: pop?.facts, missing, accepted: ok });
      if (ok) {
        chosen = cand;
        break;
      }
    }
    expect(chosen, `popover-anatomy: no candidate read confidently with every part the callouts name: ${JSON.stringify(tried)}`);
    const c = s.geo.extra[0];
    await s.begin();
    await page.mouse.click(c.x, c.y);
    const state = await s.result();
    const pop = await s.popover();
    await page.mouse.move(40, 700); // the pointer off the card box (no hover styles)
    await H.settle(page, 500);
    expect(state.card === chosen!.name && state.confident === 'true', `popover-anatomy read ${JSON.stringify(state)}`);
    const missing = await inShadowRoot<string | null>(s.cdp, ANATOMY_NEEDS);
    expect(missing === null, `popover-anatomy: the card box lacks ${missing}`);
    const parts = await inShadowRoot<{ pop: Part['box']; parts: Part[] }>(
      s.cdp,
      `function () {
        const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
        const box = (el) => rect(el.getBoundingClientRect());
        // A text's own extent, not its block's (a heading spans the whole column).
        const textBox = (el) => { const range = document.createRange(); range.selectNodeContents(el); return rect(range.getBoundingClientRect()); };
        const union = (els) => { const bs = els.map(box); const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y)); return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }; };
        const pop = this.querySelector('.pop:not(.hovering)');
        const q = (sel) => pop.querySelector(sel);
        const r = (el) => el.getBoundingClientRect();
        // The gap between two rows (a lane for the lines of the parts that have others to their right).
        const between = (above, below) => (r(above).bottom + r(below).top) / 2;
        const rows = Array.from(pop.querySelectorAll('.dv-facts .facts-row'));
        const row1 = rows.find((x) => !x.classList.contains('legal'));
        const legal = q('.dv-facts .facts-row.legal');
        const type = q('.dv-type');
        const text = q('.dv-text');
        const icon = q('.fact.attr .attr-icon');
        const star = q('.fact.level svg.star');
        const banMark = q('.fact.ban svg.mark');
        const btns = Array.from(pop.querySelectorAll('.dv-foot .dv-actions .btn'));
        const keep = btns.find((b) => /Keep in side panel/.test(b.textContent));
        const wrong = btns.find((b) => /Wrong card/.test(b.textContent));
        const foot = q('.dv-foot');
        const top = (el) => [r(el).x + r(el).width / 2, r(el).y];
        const bottom = (el) => [r(el).x + r(el).width / 2, r(el).bottom];
        const parts = [
          { label: 'Official card picture: click it to see it bigger', side: 'left', box: box(q('.dv-zoom')) },
          { label: 'A frame by banlist status: orange with one card for Limited, yellow with two for Semi-Limited, red with a prohibition sign for Forbidden', side: 'left', box: box(q('.ban-band')) },
          { label: 'Card text, in full', side: 'left', box: box(text) },
          { label: 'Passcode, archetype and market price ($ TCGplayer, € Cardmarket)', side: 'left', box: box(q('.dv-ids')) },
          { label: 'Keep it in the side panel (S)', side: 'left', box: box(keep) },
          { label: 'Card name', side: 'right', box: textBox(q('.dv-name')) },
          { label: 'Type', side: 'right', box: textBox(type) },
          { label: 'Attribute, with its kanji', side: 'right', box: box(icon), dot: top(icon), lane: between(type, row1) },
          { label: 'Level: a star (outlined for a Rank)', side: 'right', box: box(star), dot: bottom(star), lane: legal ? between(row1, legal) : between(row1, text) },
          { label: 'ATK / DEF', side: 'right', box: box(q('.fact.mono')) },
          { label: 'TCG banlist status, with its mark', side: 'right', box: box(banMark), dot: bottom(banMark), lane: between(legal, text) },
          { label: 'Genesys points', side: 'right', box: box(q('.fact.genesys')) },
          { label: "The card on Konami's database and on YGOPRODeck", side: 'right', box: union(Array.from(pop.querySelectorAll('.dv-links a'))) },
          { label: 'Wrong card? Pick the right one', side: 'right', box: box(wrong), dot: bottom(wrong), lane: (r(foot).bottom + r(pop).bottom) / 2 + 1 },
          { label: 'Report a wrong read', side: 'right', box: box(q('.dv-foot .btn.report')) },
        ];
        return { pop: box(pop), parts };
      }`,
    );
    expect(parts && parts.parts.every((p) => p.box.w > 0 && p.box.h > 0), `popover-anatomy: a part is missing (${JSON.stringify(parts)})`);
    const shot = path.join(RAW, 'anatomy-popover.png');
    await mkdir(RAW, { recursive: true });
    await shoot(page, shot, parts!.pop);
    checks['popover-anatomy'] = { tried, card: chosen, state, popover: pop, parts };
    await s.close();
    await composeAnatomy(ctx.browser, shot, parts!.pop, parts!.parts);
  } finally {
    await page.close();
  }
}

/** Draws the callouts: the card box in the middle, the names of its parts left and right, a gold line to each. */
async function composeAnatomy(browser: Browser, shot: string, pop: Part['box'], parts: Part[]): Promise<void> {
  const font = await archivo();
  const COL = 250; // label column width
  const GAP = 64; // label column to the card box
  const PAD = 26;
  const W = PAD + COL + GAP + Math.round(pop.w) + GAP + COL + PAD;
  const top = PAD;
  const px = PAD + COL + GAP; // the card box's x on the page
  const H0 = Math.round(pop.h) + 2 * PAD;
  const rel = (b: Part['box']) => ({ x: b.x - pop.x + px, y: b.y - pop.y + top, w: b.w, h: b.h });
  const relPt = (p: [number, number]): [number, number] => [p[0] - pop.x + px, p[1] - pop.y + top];
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: W, height: H0, deviceScaleFactor: 2 });
    const img = `data:image/png;base64,${(await readFile(shot)).toString('base64')}`;
    const data = parts.map((p) => ({ ...p, box: rel(p.box), dot: p.dot ? relPt(p.dot) : undefined, lane: p.lane === undefined ? undefined : p.lane - pop.y + top }));
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${font}
      html, body { margin: 0; width: ${W}px; height: ${H0}px; background: #111016; overflow: hidden; }
      .pop { position: absolute; left: ${px}px; top: ${top}px; width: ${pop.w}px; height: ${pop.h}px; border-radius: 14px; box-shadow: 0 18px 50px rgba(0,0,0,.55); }
      .label { position: absolute; width: ${COL}px; font: 600 14.5px/1.3 "RM Archivo", Arial, sans-serif; color: #F4F1F9; }
      .label.left { text-align: right; }
      svg { position: absolute; left: 0; top: 0; }
    </style></head><body>
      <img class="pop" src="${img}">
      <svg id="lines" width="${W}" height="${H0}"></svg>
      <div id="labels"></div>
      <script>
        const parts = ${JSON.stringify(data)};
        const W = ${W}, COL = ${COL}, PAD = ${PAD}, PX = ${px}, POPW = ${pop.w};
        const labels = document.getElementById('labels');
        const svg = document.getElementById('lines');
        const ns = 'http://www.w3.org/2000/svg';
        // Each part's dot, and the y its line leaves the card box at (its lane, else the dot's).
        for (const p of parts) {
          const b = p.box;
          p.at = p.dot || [p.side === 'left' ? b.x - 7 : b.x + b.w + 7, b.y + b.h / 2];
          p.out = p.lane === undefined ? p.at[1] : p.lane;
        }
        for (const side of ['left', 'right']) {
          const list = parts.filter((p) => p.side === side).sort((a, b) => a.out - b.out);
          let floor = PAD - 4;
          const placed = [];
          for (const p of list) {
            const el = document.createElement('div');
            el.className = 'label ' + side;
            el.textContent = p.label;
            el.style.left = (side === 'left' ? PAD : W - PAD - COL) + 'px';
            labels.append(el);
            const h = el.getBoundingClientRect().height;
            const want = p.out - Math.min(h, 19) / 2 - 1;
            const y = Math.max(want, floor);
            el.style.top = y + 'px';
            floor = y + h + 12;
            placed.push({ p, el, y, h });
          }
          // Too low at the bottom: push the column back up.
          let ceil = ${H0} - PAD + 4;
          for (let i = placed.length - 1; i >= 0; i--) {
            const q = placed[i];
            if (q.y + q.h > ceil) { q.y = ceil - q.h; q.el.style.top = q.y + 'px'; }
            ceil = q.y - 12;
          }
          for (const { p, y, h } of placed) {
            const [ax, ay] = p.at;
            const edge = side === 'left' ? PX - 14 : PX + POPW + 14;
            const lx = side === 'left' ? PAD + COL + 10 : W - PAD - COL - 10;
            const ly = y + Math.min(h, 19) / 2 + 1;
            const pts = p.lane === undefined ? [ax, ay, edge, ay, lx, ly] : [ax, ay, ax, p.lane, edge, p.lane, lx, ly];
            const line = document.createElementNS(ns, 'polyline');
            line.setAttribute('points', pts.join(' '));
            line.setAttribute('fill', 'none');
            line.setAttribute('stroke', '#E7B955');
            line.setAttribute('stroke-width', '1.6');
            line.setAttribute('stroke-linejoin', 'round');
            svg.append(line);
            const dot = document.createElementNS(ns, 'circle');
            dot.setAttribute('cx', ax); dot.setAttribute('cy', ay); dot.setAttribute('r', '3.6');
            dot.setAttribute('fill', '#E7B955'); dot.setAttribute('stroke', '#111016'); dot.setAttribute('stroke-width', '1.4');
            svg.append(dot);
          }
        }
      </script>
    </body></html>`);
    await page.evaluate('document.fonts.ready');
    await H.settle(page, 200);
    const overlap = (await page.evaluate(`(() => {
      const ls = [...document.querySelectorAll('.label')].map((l) => l.getBoundingClientRect());
      for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) {
        const a = ls[i], b = ls[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) return true;
      }
      return ls.some((l) => l.top < 0 || l.bottom > innerHeight);
    })()`)) as boolean;
    expect(!overlap, 'popover-anatomy: two callouts overlap, or one is cut');
    await page.screenshot({ path: path.join(OUT, 'popover-anatomy.png') });
  } finally {
    await page.close();
  }
}

// ---------- main ----------

/** The local card images the wanted pictures need (both folders are gitignored, like all of data/). */
function checkCardImages(): void {
  const missing: string[] = [];
  if (!existsSync(path.join(ROOT, 'test/fixtures/cards'))) missing.push('test/fixtures/cards/ (the E2E fixture cards)');
  const adds = [
    ...(wanted('popover-anatomy') ? ANATOMY_CARDS.map((c) => c.add) : []),
    ...(wanted('cut-card') ? CUT_PAIRS.flatMap((p) => [p.rescued.add, p.tooCut.add]) : []),
    ...(wanted('live-check') ? [LIVE_ADD] : []),
    // deck-picture.html's cards that the fixtures lack.
    ...(wanted('live-check-picture') ? ['bench/41420027@0,0,0', 'bench/90953320@0,0,0'] : []),
  ];
  for (const add of adds) {
    const id = /^bench\/(\d+)@/.exec(add)?.[1];
    const file = id && path.join(ROOT, 'data/bench/cards-small', `${id}.jpg`);
    if (file && !existsSync(file)) missing.push(path.relative(ROOT, file));
  }
  expect(missing.length === 0, `missing card images: ${[...new Set(missing)].join(', ')} (see README.md in this folder, "It needs")`);
}

async function main() {
  await mkdir(RAW, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const gifsWanted = GIFS.filter(wanted);
  if (!encodeOnly) {
    checkCardImages();
    if (!noBuild || !existsSync(path.join(BUILD, 'manifest.json'))) await build();
    await storeName();
    const server = await serve();
    const port = (server.address() as AddressInfo).port;
    const browser = await launch();
    try {
      const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 30000 });
      const worker = (await sw.worker())!;
      const extId = new URL(sw.url()).host;
      const manifest = (await worker.evaluate('chrome.runtime.getManifest()')) as { name: string; version: string };
      expect(manifest.name === 'Duel Lens – Card Reader', `the build's name is "${manifest.name}"`);
      checks.build = { dir: path.relative(ROOT, BUILD), version: manifest.version };
      const ctx: Ctx = { browser, worker, extId, sceneUrl: (q = '') => `http://127.0.0.1:${port}/${q}` };
      // The install opened the welcome page: its consent step is captured before agreeing, as a user does.
      if (wanted('welcome-consent')) await welcomeConsent(browser, worker);
      else {
        await (await H.installWelcomePage(browser)).close();
        await H.grantConsent(worker);
      }
      if (wanted('options')) await optionsStill(ctx);
      if (gifsWanted.length) {
        const sprites = await renderSprites(browser);
        await writeFile(path.join(RAW, 'sprites.json'), JSON.stringify(sprites, null, 1));
      }
      const page = (await browser.pages()).find((p) => p.url() === 'about:blank') ?? (await browser.newPage());
      await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
      const scene = await Scene.create(ctx, page);
      if (wanted('click-to-scan')) await savePlan(await clickToScan(scene));
      if (wanted('hover-preview')) await savePlan(await hoverPreview(scene));
      if (wanted('leave-scan-mode')) await savePlan(await leaveScanMode(scene));
      if (wanted('drag-a-box')) await savePlan(await dragABox(scene));
      if (wanted('two-clicks')) await savePlan(await twoClicks(scene));
      if (wanted('not-sure')) await savePlan(await notSure(scene));
      if (wanted('cut-card')) await savePlan(await cutCard(scene));
      if (wanted('keep-and-side-panel')) await savePlan(await keepAndSidePanel(ctx));
      if (wanted('read-the-board')) await savePlan(await readTheBoard(ctx));
      if (wanted('popover-anatomy')) await popoverAnatomy(ctx);
      // Live check last, on its own pages: on, a pointer resting on the scene's playing video would start it there
      // in the scan clips above. Off again after, as a new install has it.
      if (wanted('live-check') || wanted('live-check-picture')) {
        await setLiveCheck(worker, true);
        try {
          if (wanted('live-check')) await savePlan(await liveCheck(ctx));
          if (wanted('live-check-picture')) await savePlan(await liveCheckPicture(ctx));
        } finally {
          await setLiveCheck(worker, false);
        }
      }
    } finally {
      await browser.close();
      server.close();
    }
  }
  const outputs: Record<string, unknown> = {};
  if (gifsWanted.length) {
    const sprites = JSON.parse(await readFile(path.join(RAW, 'sprites.json'), 'utf8')) as Sprites;
    for (const name of gifsWanted) {
      if (!existsSync(path.join(RAW, name, 'plan.json'))) continue;
      const e = await encode(name, sprites);
      outputs[name] = e;
      console.log(`${name}.gif: ${(e.bytes / 1e6).toFixed(2)} MB, ${e.size.join('x')}, ${e.frames} frames, ${e.seconds} s`);
    }
  }
  // Every picture in docs/media, and the budget.
  let total = 0;
  for (const f of (await readdir(OUT)).sort()) {
    const bytes = (await stat(path.join(OUT, f))).size;
    total += bytes;
    console.log(`  docs/media/${f}: ${(bytes / 1e6).toFixed(2)} MB`);
  }
  console.log(`  total: ${(total / 1e6).toFixed(2)} MB`);
  expect(total <= TOTAL_MAX, `docs/media is ${(total / 1e6).toFixed(2)} MB (over 25 MB)`);
  checks.outputs = outputs;
  checks.totalBytes = total;
  checks.finishedAt = new Date().toISOString();
  const file = path.join(RAW, 'checks.json');
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // The first run.
  }
  await writeFile(file, JSON.stringify({ ...saved, ...checks }, null, 2));
}

main().catch(async (e) => {
  console.error(e);
  checks.error = String(e?.stack ?? e);
  await mkdir(RAW, { recursive: true }).catch(() => {});
  await writeFile(path.join(RAW, 'checks-failed.json'), JSON.stringify(checks, null, 2)).catch(() => {});
  process.exit(1);
});
