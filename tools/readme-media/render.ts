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
// Pictures: click-to-scan, drag-a-box, two-clicks, not-sure, keep-and-side-panel, cut-card (GIFs),
// popover-anatomy, welcome-consent, options (PNG). README.md in this folder has the details.
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import type { Browser, CDPSession, Page, WebWorker } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import * as H from '../store-shots/harness';
import { Actor, duelLensCursor, inShadowRoot, now, Screencast, type Cursor, type Frame, type TimelineEvent } from './recorder';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TOOL = path.join(ROOT, 'tools/readme-media');
const SCENE = path.join(ROOT, 'tools/store-shots/scene.html');
const BUILD = path.join(ROOT, 'release/readme-build');
const RAW = path.join(ROOT, 'release/readme-raw');
const OUT = path.join(ROOT, 'docs/media');
const PYTHON = process.env.PYTHON ?? path.join(ROOT, 'data/venv-train/bin/python');

const GIFS = ['click-to-scan', 'drag-a-box', 'two-clicks', 'not-sure', 'keep-and-side-panel', 'cut-card'] as const;
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
const KEY_LABELS = ['Alt + Shift + Y', 'K', '→', '←', 'Esc'];

/** The cards the fixtures lack come from the benchmark's card images (data/bench/cards-small, YGOPRODeck's small images). */
const ANATOMY_CARDS = [
  // A monster with a TCG banlist status and Genesys points: every fact the popover can show.
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
  manifest.name = 'Duel Lens – Card Reader for Duel Videos';
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

// ---------- the scene's server ----------

/** The scene, the fixture cards (cards/) and, for the cards the fixtures lack, the benchmark's card images (bench/). */
function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = '';
    if (url === '/') file = SCENE;
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

  /** The popover once its pictures are in (a message has none to wait for). */
  async popover(): Promise<H.PopoverView> {
    const view = await H.readPopover(this.cdp);
    if (view?.name) return H.waitForPictures(this.cdp);
    expect(view, 'no popover to read');
    return view;
  }

  async close(): Promise<void> {
    expect(await H.closeOverlay(this.page), 'Escape did not close Duel Lens');
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
  return inShadowRoot<string | null>(cdp, 'function () { const l = this.querySelector(".note.low"); return l ? l.textContent.trim() : null; }');
}

/** A box a little bigger than the card, as a user drags it. */
function boxAround(c: Placed): [[number, number], [number, number]] {
  const b = c.bounds;
  return [
    [b.x - 12, b.y - 10],
    [b.x + b.w + 12, b.y + b.h + 10],
  ];
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

/**
 * 1. Click to scan (the hero): the shortcut, every card outlined, the pointer lights Ash Blossom up, a
 * click, and its popover: the official picture, the facts with its Genesys points, the full text.
 */
async function clickToScan(s: Scene): Promise<GifPlan> {
  await s.open();
  const ash = s.card('ash-gy');
  const warm = await s.trial(ash.x, ash.y);
  expect(warm.state.card === ash.name, `click-to-scan warm-up read ${warm.state.card}`);
  const actor = s.actor([900, 620]);
  await actor.place();
  let state: H.HostState | undefined;
  let pop: H.PopoverView | undefined;
  const rec = await record('click-to-scan', [s.page], async () => {
    await sleep(600);
    const n = await shortcut(s, actor);
    expect(n === s.geo.faceUp.length, `click-to-scan: ${n} outlines for ${s.geo.faceUp.length} cards`);
    await sleep(800);
    await actor.move(ash.x - 6, ash.y + 10, 800);
    await sleep(550);
    await actor.click();
    state = await s.result();
    pop = await s.popover();
    await actor.refresh();
    await actor.move(ash.x + 50, ash.y + 190, 500);
    await sleep(3000);
  });
  expect(state?.card === ash.name && state.confident === 'true', `click-to-scan read ${JSON.stringify(state)}`);
  expect(pop?.facts.includes('Genesys 20 pts'), `click-to-scan: no Genesys chip (${pop?.facts})`);
  expect(!pop?.toast, `click-to-scan: a toast (${pop?.toast})`);
  checks['click-to-scan'] = { state, popover: pop };
  await s.close();
  return {
    name: 'click-to-scan',
    canvas: [894, 720],
    layers: [{ frames: rec.frames[0], crop: [386, 0, 894, 720], at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [-14, 14],
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
  const rec = await record('two-clicks', [s.page], async () => {
    await sleep(500);
    await shortcut(s, actor);
    await sleep(600);
    await actor.move(first[0], first[1], 700);
    await sleep(300);
    await actor.click();
    await sleep(200);
    armedHint = (await H.readOutlines(s.cdp))?.hint ?? null;
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
  return {
    name: 'two-clicks',
    canvas: [892, 720],
    layers: [{ frames: rec.frames[0], crop: [388, 0, 892, 720], at: [0, 0] }],
    events: actor.events,
    t0: rec.t0,
    t1: rec.t1,
    keyAt: [-14, 14],
  };
}

/**
 * 4. "Not sure", then "Low match". A card caught mid-motion: the popover says "Not sure" and offers the
 * closest matches; → shows the next one ("You picked this"), and a click on the first chip goes back.
 * Then a card blurred more: the engine can't call it, but a card was picked, so it offers its closest
 * guess under "Low match". Each answer is checked honest first (NOT_SURE_SCENES); none is staged.
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
      const rec = await record('not-sure', [s.page], async () => {
        await sleep(400);
        await shortcut(s, actor);
        await sleep(400);
        await pick(actor, a, cand.notSure.how);
        await s.result();
        first = await s.popover();
        await actor.refresh();
        await sleep(1600);
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
          await actor.key('Esc', 0.8, 'Escape');
          await sleep(500);
          await shortcut(s, actor);
          await sleep(300);
          await pick(actor, b, cand.low!.how);
          await s.result();
          low = { popover: await s.popover(), note: await lowNote(s.cdp) };
          await actor.refresh();
          await actor.move(b.x - 10, b.y + b.h / 2 + 60, 400);
          await sleep(2400);
        } else {
          await actor.move(a.x - 20, a.y + 200, 400);
          await sleep(2300);
        }
      });
      expect(first?.unsure && first.name === a.name, `not-sure: ${JSON.stringify(first)}`);
      expect(stepped?.name && stepped.name !== a.name && /You picked this/.test(stepped.match ?? ''), `not-sure: → showed ${JSON.stringify(stepped)}`);
      expect(back?.name === a.name && /Not sure/.test(back.match ?? ''), `not-sure: the chip went to ${JSON.stringify(back)}`);
      if (b) expect(low?.note && low.popover.name === b.name, `not-sure: the second card read ${JSON.stringify(low)}`);
      const fits = await inShadowRoot<boolean>(s.cdp, 'function () { const p = this.querySelector(".pop-scroll"); return !!p && p.scrollHeight <= p.clientHeight + 1; }');
      checks['not-sure'] = { tried, scene: cand, first, stepped, back, low, popoverFits: fits };
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
      const chip = Array.from(this.querySelectorAll('.dv-alts .alt')).find((b) => b.querySelector('em') && b.querySelector('em').textContent.trim() === name);
      if (!chip) return null;
      const r = chip.getBoundingClientRect();
      return [r.x + r.width / 2, r.y + r.height / 2];
    }`,
    [name],
  );
}

interface PanelView {
  current: string | null;
  facts: string[];
  entries: { name: string; time: string; active: boolean }[];
  pictureLoaded: boolean;
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

/** The pointer the side panel shows at (x, y): the hand over its buttons and links. */
function pageCursor(page: Page) {
  return async (x: number, y: number): Promise<Cursor> =>
    (await page.evaluate(`(() => { const el = document.elementFromPoint(${x}, ${y}); return el && el.closest('button, a') ? 'hand' : 'arrow'; })()`)) as Cursor;
}

/**
 * 5. Keep (K) and the side panel. Every scan becomes the side panel's card (router.ts), and K opens the
 * panel on it (show-in-panel). Recorded as Chrome shows it: the page at full width with Pot of Greed's
 * popover; K; the popover closes, the page narrows and the side panel (sidepanel.html in a window of its
 * own, placed beside the page) shows the card in full; then the mouse wheel scrolls it down to the scans.
 */
async function keepAndSidePanel(ctx: Ctx): Promise<GifPlan> {
  const scenePage = await ctx.browser.newPage({ type: 'window' });
  await scenePage.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const s = await Scene.create(ctx, scenePage);
  await s.open();
  // A fresh history, as after "Clear history".
  await ctx.worker.evaluate("chrome.storage.local.set({ history: [] }).then(() => chrome.storage.session.remove('currentEntryId'))");
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
  expect(pop.facts.includes('Forbidden · TCG') && pop.facts.includes('Genesys 30 pts'), `keep: Pot of Greed's facts ${pop.facts}`);
  // The side panel, as it will show once opened (out of the picture until K).
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
  let tPress = 0;
  let tSwitch = 0;
  let hostAfterK: H.HostState | null | undefined;
  expect((await panel.evaluate('scrollY')) === 0, 'keep: the side panel is not at its top');
  const rec = await record('keep-and-side-panel', [scenePage, panel], async () => {
    await sleep(1100);
    tPress = now() + 0.15;
    await actor.key('K', 1.0, 'k');
    // sidePanel.open() succeeded: the popover closes (app.tsx, keep).
    await scenePage.waitForFunction("!document.getElementById('duel-lens-host')", { timeout: 5000 });
    hostAfterK = await H.hostState(scenePage);
    // The side panel takes its width from the page. The picture switches once the page has settled.
    await scenePage.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
    await H.settle(scenePage, 300);
    tSwitch = now();
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
  expect(hostAfterK === null, `keep: the popover stayed open after K (${JSON.stringify(hostAfterK)}); the side panel did not open`);
  expect(shown.facts.includes('Forbidden · TCG') && shown.facts.includes('Genesys 30 pts'), `keep: the panel's facts ${shown.facts}`);
  expect(scrolled.entries[0].active && scrolled.entries[0].name === pog.name, `keep: the active entry ${JSON.stringify(scrolled.entries)}`);
  expect(!/E2E/.test(scrolled.text), 'keep: the side panel shows "E2E"');
  checks['keep-and-side-panel'] = { popover: pop, panel: { ...shown, text: undefined }, entries: scrolled.entries };
  await panel.close();
  await scenePage.close();
  // A 960 px view of the window's right side: before K, the page (x 320-1280); after, the narrowed
  // page (x 320-900), a divider, and the side panel.
  return {
    name: 'keep-and-side-panel',
    canvas: [960, 720],
    layers: [
      // The popover stays in the picture until the panel is: Chrome opens the panel, then the popover closes.
      { frames: rec.frames[0], crop: [320, 0, 960, 720], at: [0, 0], until: tSwitch, frames_before: tPress },
      { frames: rec.frames[0], crop: [320, 0, 580, 720], at: [0, 0], from: tSwitch, frames_from: tSwitch },
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
 * (the engine's second try completes the card), a third cut says part of the card is outside the picture.
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
      await sleep(2100);
      await actor.key('Esc', 0.8, 'Escape');
      await sleep(500);
      await shortcut(s, actor);
      await sleep(250);
      const [bx, by] = visible(tooCut);
      await actor.move(bx, by, 600);
      await sleep(300);
      await actor.click();
      await s.result();
      second = await s.popover();
      await actor.refresh();
      await sleep(2500);
    });
    expect(first?.unsure && first.name === pair.rescued.name, `cut-card: the first read ${JSON.stringify(first)}`);
    expect(second?.message === TRUNCATED_MESSAGE, `cut-card: the second read ${JSON.stringify(second)}`);
    checks['cut-card'] = { tried, first, second };
    await s.close();
    return {
      name: 'cut-card',
      canvas: [892, 720],
      layers: [{ frames: rec.frames[0], crop: [388, 0, 892, 720], at: [0, 0] }],
      events: actor.events,
      t0: rec.t0,
      t1: rec.t1,
      keyAt: [14, -82],
    };
  }
  checks['cut-card'] = { tried };
  throw new Error('cut-card: no pair gave both answers; make a still instead (see README.md in this folder)');
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
}

/**
 * The popover's parts, named: the card is read for real (a click on its outline), then each part's
 * box is read from the popover, and the callouts are drawn around a screenshot of it on a page of
 * their own (like the store images' captions).
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
      const t = await s.trial(c.x, c.y); // the pictures get cached
      const ok = t.state.card === cand.name && t.state.confident === 'true' && t.popover.facts.some((f) => / · TCG$/.test(f)) && t.popover.facts.some((f) => /^Genesys /.test(f));
      tried.push({ cand, state: t.state, facts: t.popover.facts, accepted: ok });
      if (ok) {
        chosen = cand;
        break;
      }
    }
    expect(chosen, `popover-anatomy: no candidate read confidently with a banlist and a Genesys chip: ${JSON.stringify(tried)}`);
    const c = s.geo.extra[0];
    await s.begin();
    await page.mouse.click(c.x, c.y);
    const state = await s.result();
    const pop = await s.popover();
    await page.mouse.move(40, 700); // the pointer off the popover (no hover styles)
    await H.settle(page, 500);
    expect(state.card === chosen!.name && state.confident === 'true', `popover-anatomy read ${JSON.stringify(state)}`);
    const parts = await inShadowRoot<{ pop: Part['box']; parts: Part[] }>(
      s.cdp,
      `function () {
        const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
        const box = (el) => rect(el.getBoundingClientRect());
        // A text's own extent, not its block's (a heading spans the whole column).
        const textBox = (el) => { const range = document.createRange(); range.selectNodeContents(el); return rect(range.getBoundingClientRect()); };
        const union = (els) => { const bs = els.map(box); const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y)); return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }; };
        const q = (sel) => this.querySelector(sel);
        // By their text, which card-view.tsx fixes ("Limited · TCG", "Genesys 20 pts"), not their styling.
        const facts = Array.from(this.querySelectorAll('.dv-facts .fact'));
        const ban = facts.find((f) => / · TCG$/.test(f.textContent.trim()));
        const genesys = facts.find((f) => /^Genesys /.test(f.textContent.trim()));
        const plain = facts.filter((f) => f !== ban && f !== genesys);
        // The Attribute, Level and ATK/DEF chips may wrap: point at the end of their first row.
        const firstRow = plain.filter((f) => Math.abs(f.getBoundingClientRect().top - plain[0].getBoundingClientRect().top) < 4);
        const parts = [
          { label: 'Official card picture', side: 'left', box: box(q('.dv-card img')) },
          { label: 'Card text, in full', side: 'left', box: box(q('.dv-text')) },
          { label: 'Passcode and archetype', side: 'left', box: textBox(q('.dv-meta')) },
          { label: 'How close the match is', side: 'left', box: box(q('.dv-match')) },
          { label: 'Keyboard shortcuts', side: 'left', box: textBox(q('.note.keys')) },
          { label: 'Card name', side: 'right', box: textBox(q('.dv-name')) },
          { label: 'Type', side: 'right', box: textBox(q('.dv-type')) },
          { label: 'Attribute, Level, ATK / DEF', side: 'right', box: union(firstRow) },
          { label: 'TCG banlist status', side: 'right', box: box(ban) },
          { label: 'Genesys points: what the card costs in the Genesys format', side: 'right', box: box(genesys) },
          { label: 'Keep it in the side panel, copy its text, or open it on YGOPRODeck', side: 'right', box: union(Array.from(this.querySelectorAll('.dv-foot .dv-actions > *'))) },
        ];
        return { pop: box(q('.pop')), parts };
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

/** Draws the callouts: the popover in the middle, the names of its parts left and right, a gold line to each. */
async function composeAnatomy(browser: Browser, shot: string, pop: Part['box'], parts: Part[]): Promise<void> {
  const font = await archivo();
  const COL = 250; // label column width
  const GAP = 64; // label column to popover
  const PAD = 26;
  const W = PAD + COL + GAP + Math.round(pop.w) + GAP + COL + PAD;
  const top = PAD;
  const px = PAD + COL + GAP; // the popover's x on the page
  const H0 = Math.round(pop.h) + 2 * PAD;
  const rel = (b: Part['box']) => ({ x: b.x - pop.x + px, y: b.y - pop.y + top, w: b.w, h: b.h });
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: W, height: H0, deviceScaleFactor: 2 });
    const img = `data:image/png;base64,${(await readFile(shot)).toString('base64')}`;
    const data = parts.map((p) => ({ ...p, box: rel(p.box) }));
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
        for (const side of ['left', 'right']) {
          const list = parts.filter((p) => p.side === side).sort((a, b) => (a.box.y + a.box.h / 2) - (b.box.y + b.box.h / 2));
          let floor = PAD - 4;
          const placed = [];
          for (const p of list) {
            const el = document.createElement('div');
            el.className = 'label ' + side;
            el.textContent = p.label;
            el.style.left = (side === 'left' ? PAD : W - PAD - COL) + 'px';
            labels.append(el);
            const h = el.getBoundingClientRect().height;
            const want = p.box.y + p.box.h / 2 - h / 2;
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
            const b = p.box;
            const ay = b.y + b.h / 2;
            const ax = side === 'left' ? b.x - 7 : b.x + b.w + 7;
            const edge = side === 'left' ? PX - 14 : PX + POPW + 14;
            const lx = side === 'left' ? PAD + COL + 10 : W - PAD - COL - 10;
            const ly = y + Math.min(h, 19) / 2 + 1;
            const line = document.createElementNS(ns, 'polyline');
            line.setAttribute('points', [ax, ay, edge, ay, lx, ly].join(' '));
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
      expect(manifest.name === 'Duel Lens – Card Reader for Duel Videos', `the build's name is "${manifest.name}"`);
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
      if (wanted('drag-a-box')) await savePlan(await dragABox(scene));
      if (wanted('two-clicks')) await savePlan(await twoClicks(scene));
      if (wanted('not-sure')) await savePlan(await notSure(scene));
      if (wanted('cut-card')) await savePlan(await cutCard(scene));
      if (wanted('keep-and-side-panel')) await savePlan(await keepAndSidePanel(ctx));
      if (wanted('popover-anatomy')) await popoverAnatomy(ctx);
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
