// Renders the Chrome Web Store images (store/screenshots-plan.md): five 1280x800 screenshots and the
// 440x280 small promo tile. Every box, hint, outline, pill and panel is the real UI of an E2E-flavoured
// copy of the store build (node build.mjs --e2e: official card pictures from images.ygoprodeck.com, so
// the run needs the network), driven with Puppeteer on a synthetic scene (scene.html: the E2E fixture
// cards on a plain playmat, played as a video). Nothing is retouched; every result shown is checked
// first (the card, sure or not, its picture loaded), and the run stops if a check fails.
//
// Run from the repository root:  npx tsx tools/store-shots/render.ts [options]
//   --no-build      reuse release/shots-build/ext instead of building it again
//   --compose-only  only redo the captions and the promo tile, from the captures in release/shots-build/raw
//   --only=live     01 and 04 alone (one Live check run); --only=scan: 02 and 03; --only=05-privacy: 05
//                   (the other images and their captures are left as they are)
// Screenshot 5 is always rendered as on Windows (WINDOWS_COMMANDS below), so its keys read "Alt+Shift+Y".
// Writes store/screenshots/0{1..5}-*.png, store/promo/small-440x280.png, and the raw captures and every
// check's result in release/shots-build/raw/ (checks.json). README.md in this folder has the details.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import puppeteer from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import type { Browser, CDPSession, Page, WebWorker } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import * as H from './harness';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TOOL = path.join(ROOT, 'tools/store-shots');
const BUILD = path.join(ROOT, 'release/shots-build/ext');
const RAW = path.join(ROOT, 'release/shots-build/raw');
const SHOTS = path.join(ROOT, 'store/screenshots');
const PROMO = path.join(ROOT, 'store/promo');

const args = process.argv.slice(2);
const composeOnly = args.includes('--compose-only');
const noBuild = args.includes('--no-build') || composeOnly;
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;

/** The captions: store/screenshots-plan.md, "Captions at a glance" (as changed for 0.10.3: Live check leads). */
const CAPTIONS = {
  '01-hero': ['Read the card without leaving the stream', 'Turn on Live check and rest the pointer on a card in a video: its name and text appear beside it.'],
  '02-click': ['Freeze the frame. Click a card.', 'Press Alt+Shift+Y: every card Duel Lens finds is outlined. Dragging a box still works.'],
  '03-not-sure': ['Not sure? It says so.', 'The closest matches are a click (or ← →) away. Optional: ask AI with your own key.'],
  '04-side-panel': ['Every card it found, in the side panel', 'Live check lists the cards it is sure of as the video plays. Click one to see it in full, or its time to jump back.'],
  '05-privacy': ['Runs on your computer', 'No account, no analytics. It asks before its first scan.'],
} as const;
type ShotName = keyof typeof CAPTIONS;
/**
 * --only=<group>: capture and compose those screenshots alone; the other images and their captures stay as
 * they are. Their checks replace the earlier ones in checks.json. 01 and 04 come from one Live check run.
 */
const ONLY_GROUPS: Record<string, { shots: ShotName[]; checks: string[] }> = {
  live: { shots: ['01-hero', '04-side-panel'], checks: ['01-hero', '04-side-panel', 'liveRun', 'scene'] },
  scan: { shots: ['02-click', '03-not-sure'], checks: ['02-click', '03-not-sure', 'scene'] },
  '05-privacy': { shots: ['05-privacy'], checks: ['05-privacy', 'welcomePlatform', 'welcomeFrame'] },
};
if (ONLY !== null && !ONLY_GROUPS[ONLY]) throw new Error(`--only=${ONLY}: use --only=live, --only=scan or --only=05-privacy`);
const wanted = (group: string) => ONLY === null || ONLY === group;
/**
 * Screenshot 2 shows the frame just after the shortcut: 'spotlight' (every outlined card bright, the
 * mat dimmed; the pointer on no card) or 'lit' (the pointer on Number 39: Utopia, which lights it and
 * dims the rest). Both are captured (the other goes to raw/02-click-other.png); this picks the one used.
 */
const SHOT_02: 'spotlight' | 'lit' = 'spotlight';
/** Only if no honest "Not sure" turns up: screenshot 3 shows a card in Defense Position instead (the caller's fallback). */
const FALLBACK_03 = ['Sideways, upside down or tilted', 'Cards in Defense Position, upside down or slightly tilted are read too.'] as const;
/**
 * Screenshot 1's card: Pot of Greed, Forbidden in the TCG (the default list) and 20 Genesys points, so its box shows
 * 0.10's ban frame (red, with the prohibition sign) and both legality marks. Its text is short, so the box covers
 * little of the board above it.
 */
const HERO_CARD = 'pog';
/**
 * The pointer in screenshot 1: Live check answers a pointer at rest, which headless Chrome's screenshots don't show,
 * so the compose step draws the usual arrow with its tip exactly where the mouse rested (checks['01-hero'].pointer).
 * Nothing of Duel Lens is drawn: the arrow is the system's pointer, as tools/readme-media draws it in its clips.
 */
const DRAW_POINTER_01 = true;
const ARROW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="-1 -1 26 36"><path d="M2 2 L2 26.5 L8.1 20.9 L12.3 30.3 L16.3 28.5 L12.1 19.3 L20.3 19.3 Z" fill="#111" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
/** The arrow's tip in its own pixels (the SVG's 2,2 plus its 1 px margin). */
const ARROW_HOT: [number, number] = [3, 3];

/** Colours and the foil of the popover (src/content/styles.ts), for the caption band and the promo tile. */
const INK = '#F4F1F9';
const INK_2 = '#B8B2C7';
const BAND_BG = '#17151E';
const DIVIDER = '#2A2733';
const FOIL = 'linear-gradient(100deg,#ffd1f4,#c3e4ff 22%,#c8ffe0 42%,#fff0b8 62%,#ffc9c9 80%,#ffd1f4)';

/**
 * Screenshot 3's hard case, tried in order until one gives a real "Not sure" with the right card on
 * screen and at least two chips. Shrinking a card, covering half of it, boxing part of the art, glare and
 * 360p video gave a confident answer or "Couldn't match" on 0.9; a card caught mid-motion (motion blur, one
 * of the causes the listing names) gives "Not sure". On 0.10.3 (2026-11-11) a click on Odd-Eyes blurred
 * 12-16 px reads it sure, 17-18 px "Not sure" with one chip; boxed at 14 px it is "Not sure" (76%) with
 * three chips, at 15-16 px with none.
 */
const NOT_SURE_CANDIDATES = [
  { label: 'Odd-Eyes caught mid-motion (blur 14 px), boxed', query: '?fx=pend:blur:14:15', card: 'pend', how: 'box' },
  { label: 'Odd-Eyes caught mid-motion (blur 17 px), clicked', query: '?fx=pend:blur:17:15', card: 'pend', how: 'click' },
  { label: 'Odd-Eyes caught mid-motion (blur 16 px), boxed', query: '?fx=pend:blur:16:15', card: 'pend', how: 'box' },
] as const;

const DARK_REDUCED = [
  { name: 'prefers-color-scheme', value: 'dark' },
  { name: 'prefers-reduced-motion', value: 'reduce' },
];

/**
 * Screenshot 5 shows the welcome page as on Windows, where most Chrome users are, so its keys match
 * caption 1 ("Alt+Shift+Y"). The page doesn't read the user agent or navigator.platform: it shows
 * the shortcut chrome.commands.getAll() gives it, which Chrome formats for its own OS ("⌥⇧Y" on a Mac,
 * "Alt+Shift+Y" on Windows; src/welcome/shortcuts.tsx). So besides the Windows user agent and
 * platform, this script (run in the welcome page before its own) converts that answer to Windows'
 * format. The page's code, and the shortcut Chrome actually assigned, are untouched.
 */
const WINDOWS_COMMANDS = `(() => {
  if (!(globalThis.chrome && chrome.commands && chrome.commands.getAll)) return;
  const names = { '⌃': 'Ctrl', '⌘': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
  const order = ['Ctrl', 'Alt', 'Shift'];
  const toWindows = (s) => {
    if (!s || s.includes('+')) return s;
    const mods = [];
    let i = 0;
    while (i < s.length && s[i] in names) mods.push(names[s[i++]]);
    return [...order.filter((m) => mods.includes(m)), s.slice(i)].join('+');
  };
  const commands = chrome.commands;
  const getAll = commands.getAll.bind(commands);
  const wrapped = (callback) => {
    const answer = getAll().then((list) => list.map((c) => ({ ...c, shortcut: toWindows(c.shortcut) })));
    if (typeof callback === 'function') return void answer.then(callback);
    return answer;
  };
  try { commands.getAll = wrapped; } catch (e) {}
  if (commands.getAll !== wrapped) Object.defineProperty(commands, 'getAll', { value: wrapped, configurable: true, writable: true });
  globalThis.__storeShotsWindows = commands.getAll === wrapped;
})()`;

/** A Windows user agent for this browser's own version (Emulation.setUserAgentOverride). */
async function windowsUserAgent(browser: Browser) {
  const full = (await browser.version()).split('/')[1] ?? '154.0.0.0';
  const major = full.split('.')[0];
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    platform: 'Win32',
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not.A/Brand', version: '99' },
      ],
      fullVersion: full,
      platform: 'Windows',
      platformVersion: '15.0.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
    },
  };
}

const checks: Record<string, unknown> = { startedAt: new Date().toISOString() };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function expect(ok: unknown, message: string): void {
  if (!ok) throw new Error(`check failed: ${message}`);
}

// ---------- build ----------

async function build(): Promise<void> {
  // The store build's UI (official card pictures, D2), plus the E2E-only hooks the script drives it with.
  execFileSync('node', ['build.mjs', '--e2e', '--out', BUILD], { cwd: ROOT, stdio: 'inherit' });
}

/** The E2E build is named "Duel Lens (E2E)" (build.mjs); the screenshots' build gets the store's name back. */
async function storeName(): Promise<void> {
  const file = path.join(BUILD, 'manifest.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.name = 'Duel Lens – Card Reader';
  await writeFile(file, JSON.stringify(manifest, null, 2));
}

// ---------- the scene's server ----------

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = '';
    if (url === '/') file = path.join(TOOL, 'scene.html');
    else if (/^\/cards\/\d+\.jpg$/.test(url)) file = path.join(ROOT, 'test/fixtures', url);
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(withExtension: boolean): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    pipe: true,
    ...(withExtension ? { enableExtensions: [BUILD] } : {}),
    defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
    args: ['--window-size=1280,900', '--no-first-run', '--lang=en-US', '--hide-scrollbars', '--force-color-profile=srgb'],
  });
}

// ---------- the captures ----------

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
  faceDown: Placed[];
}

async function capture(): Promise<void> {
  if (!noBuild || !existsSync(path.join(BUILD, 'manifest.json'))) await build();
  await storeName();
  if (!ONLY) await rm(RAW, { recursive: true, force: true }); // --only keeps the other captures
  await mkdir(RAW, { recursive: true });
  const server = await serve();
  const port = (server.address() as AddressInfo).port;
  const sceneUrl = (query = '') => `http://127.0.0.1:${port}/${query}`;
  const browser = await launch(true);
  try {
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 30000 });
    const worker = (await sw.worker())!;
    const extId = new URL(sw.url()).host;
    const manifest = (await worker.evaluate('chrome.runtime.getManifest()')) as { name: string; version: string; host_permissions?: string[] };
    checks.build = { dir: path.relative(ROOT, BUILD), name: manifest.name, version: manifest.version, hosts: manifest.host_permissions ?? [] };
    expect(manifest.name === 'Duel Lens – Card Reader', `the build's name is "${manifest.name}", not the store title`);

    if (ONLY !== null && ONLY !== '05-privacy') {
      // Without screenshot 5: agree as the E2E harness does (the welcome page isn't captured).
      await (await H.installWelcomePage(browser)).close();
      await H.grantConsent(worker);
    } else {
      await welcomeShot(browser, worker);
    }
    if (ONLY === '05-privacy') return;

    const page = (await browser.pages()).find((p) => p.url() === 'about:blank') ?? (await browser.newPage());
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures(DARK_REDUCED);
    const cdp = await page.createCDPSession();
    const open = async (query = '') => {
      await page.goto(sceneUrl(query), { waitUntil: 'load' });
      const video = await page.evaluate('window.scene.ready');
      await H.refocus(page);
      await H.settle(page, 300);
      return { video, geo: (await page.evaluate('window.scene.geometry()')) as Geometry };
    };
    const scene = await open();
    checks.scene = { video: scene.video, faceUp: scene.geo.faceUp.map((c) => c.name), faceDown: scene.geo.faceDown.map((c) => c.id) };
    const card = (geo: Geometry, id: string) => {
      const c = geo.faceUp.find((x) => x.id === id);
      if (!c) throw new Error(`no card "${id}" in the scene`);
      return c;
    };

    if (wanted('scan')) await scanShots(page, cdp, worker, scene.geo, open, card);
    if (wanted('live')) await liveShots(browser, page, cdp, worker, extId, open, card);
  } finally {
    await browser.close();
    server.close();
  }
}

type Open = (query?: string) => Promise<{ video: unknown; geo: Geometry }>;
type CardOf = (geo: Geometry, id: string) => Placed;

/** Scan mode's shortcut (the E2E hook does exactly what Alt+Shift+Y does) and the detector's outlines; Escape. */
function scanMode(page: Page, worker: WebWorker) {
  return {
    begin: async () => {
      await H.startScan(worker);
      await H.waitForState(page, ['selecting'], 15000);
      return H.waitForOutlines(page, 20000);
    },
    close: async () => {
      expect(await H.closeOverlay(page), 'Escape did not close Duel Lens');
      await sleep(700); // captureVisibleTab allows 2 calls a second
    },
  };
}

/**
 * 0.10's card box: the brand row (lens and "Duel Lens"), no Copy; a match line only when unsure ("Not sure", the
 * percentage in its tooltip, "Could also be" chips); the labelled numbers and the links only once pinned.
 */
function expectBox(shot: string, pop: H.PopoverView | null, want: { sure: boolean; pinned: boolean }): void {
  expect(pop?.brand === 'Duel Lens', `${shot}: the box's top row reads "${pop?.brand}"`);
  expect(!pop!.buttons.some((b) => /copy/i.test(b)), `${shot}: the box offers Copy (${pop!.buttons.join(', ')})`);
  if (want.sure) expect(pop!.match === null && !pop!.unsure, `${shot}: a sure match shows a match line ("${pop!.match}")`);
  else
    expect(
      pop!.unsure && pop!.match === 'Not sure' && /^\d+% artwork match/.test(pop!.matchTitle ?? '') && pop!.chipsLabel === 'Could also be',
      `${shot}: the unsure box reads "${pop!.match}" (tooltip "${pop!.matchTitle}", chips "${pop!.chipsLabel}")`,
    );
  if (want.pinned)
    expect(
      !pop!.hovering && pop!.meta[0] === 'Passcode' && pop!.links.includes('YGOPRODeck ↗'),
      `${shot}: the pinned box's bottom line is ${JSON.stringify({ hovering: pop!.hovering, meta: pop!.meta, links: pop!.links })}`,
    );
  else expect(pop!.meta.length === 0 && pop!.links.length === 0, `${shot}: the unpinned box shows ${JSON.stringify({ meta: pop!.meta, links: pop!.links })}`);
}

/** 02 (the outlines after the shortcut) and 03 (an honest "Not sure"). */
async function scanShots(page: Page, cdp: CDPSession, worker: WebWorker, geo: Geometry, open: Open, card: CardOf): Promise<void> {
  const { begin, close } = scanMode(page, worker);
  const box = (c: Placed, pad = 6): [[number, number], [number, number]] => [
    [c.bounds.x - pad, c.bounds.y - pad],
    [c.bounds.x + c.bounds.w + pad, c.bounds.y + c.bounds.h + pad],
  ];

  // --- 02: the outlines after the shortcut and the bar, first with the pointer on no card (the spotlight:
  // every outlined card bright), then on Number 39: Utopia (lit). SHOT_02 picks one.
  const utopia = card(geo, 'xyz-def');
  const emptyZone = { x: (card(geo, 'bewd').x + card(geo, 'ash-gy').x) / 2, y: card(geo, 'bewd').y };
  await page.mouse.move(emptyZone.x, emptyZone.y);
  const outlinesCount = await begin();
  await H.settle(page, 400); // the outlines fade in (0.2 s; none with reduced motion)
  const view = await H.readOutlines(cdp);
  expect(view, '02: no outlines to read');
  const outlines = view!.outlines;
  const unoutlined = geo.faceUp.filter((c) => !outlines.some((o) => H.insideBox(o, c.x, c.y)));
  const stray = outlines.filter((o) => !geo.faceUp.some((c) => H.insideBox(o, c.x, c.y)));
  const faceDownOutlined = geo.faceDown.filter((d) => outlines.some((o) => H.insideBox(o, d.x, d.y)));
  expect(outlinesCount === geo.faceUp.length && outlines.length === outlinesCount && unoutlined.length === 0, `02: cards without an outline: ${unoutlined.map((c) => c.name).join(', ')}`);
  expect(stray.length === 0, `02: ${stray.length} outline(s) on no card`);
  expect(faceDownOutlined.length === 0, `02: face-down cards outlined: ${faceDownOutlined.map((d) => d.id).join(', ')}`);
  // The bar names how many cards it outlined, offers to read them all, and says how to leave.
  expect(view!.hint === `${geo.faceUp.length} cards` && !view!.hintLow, `02: the bar's hint reads "${view!.hint}"${view!.hintLow ? ' (at the bottom)' : ''}`);
  expect(/Read all cards/.test(view!.bar ?? '') && /Esc to exit/.test(view!.bar ?? ''), `02: the bar reads "${view!.bar}"`);
  expect(view!.spotlight && !view!.lit, `02: no spotlight with the pointer on no card (${JSON.stringify({ spotlight: view!.spotlight, lit: view!.lit })})`);
  await page.screenshot({ path: path.join(RAW, SHOT_02 === 'spotlight' ? '02-click.png' : '02-click-other.png') });
  await page.mouse.move(utopia.x, utopia.y);
  await H.settle(page, 300);
  const lit = await H.readOutlines(cdp);
  expect(lit?.lit, '02: no card is lit under the pointer');
  await page.screenshot({ path: path.join(RAW, SHOT_02 === 'lit' ? '02-click.png' : '02-click-other.png') });
  const shot02: Record<string, unknown> = { shown: SHOT_02, outlines: outlinesCount, bar: view!.bar, hint: view!.hint, hintLow: view!.hintLow, spotlight: view!.spotlight, lit: lit?.lit, unoutlined: unoutlined.map((c) => c.name), stray, faceDownOutlined: faceDownOutlined.map((d) => d.id) };
  checks['02-click'] = shot02;
  // Honesty: that click really reads the card, and pins 0.10's box.
  await page.mouse.down();
  await page.mouse.up();
  const clicked = await H.waitForState(page, ['result', 'error'], 60000);
  shot02.clickReads = clicked;
  expect(clicked.card === utopia.name && clicked.confident === 'true', `02: the click read ${clicked.card} (confident ${clicked.confident})`);
  const clickedPop = await H.waitForPictures(cdp);
  shot02.clickBox = clickedPop;
  expect(clickedPop.name === utopia.name, `02: the box shows ${clickedPop.name}`);
  expectOfficialPicture('02', clickedPop);
  expectBox('02', clickedPop, { sure: true, pinned: true });
  await close();

  // --- 03: an honest "Not sure", with the AI check on and a placeholder key so "Ask AI" is offered.
  // The key is never used: nothing here presses Ask AI. The settings are removed afterwards.
  await worker.evaluate(
    "chrome.storage.local.set({ settings: { ai: { enabled: true, apiKey: 'sk-ant-placeholder', model: 'claude-opus-5' }, debug: { saveCrops: false } } })",
  );
  const attempts: unknown[] = [];
  let notSure = false;
  try {
    for (const cand of NOT_SURE_CANDIDATES) {
      const { geo: g } = await open(cand.query);
      const c = card(g, cand.card);
      await begin();
      if (cand.how === 'click') await page.mouse.click(c.x, c.y);
      else await H.drag(page, ...box(c, 12));
      // A click on no outline sets a first corner and leaves the frame frozen: that candidate failed.
      const s = await H.waitForState(page, ['result', 'error'], 30000).catch(() => null);
      let pop = await H.readPopover(cdp);
      if (s?.state === 'result' && pop?.name) pop = await H.waitForPictures(cdp).catch(() => pop);
      await H.settle(page, 400);
      const onScreen = pop?.name === c.name || !!pop?.chips.some((x) => x.name === c.name);
      const ok = s?.state === 'result' && s.confident === 'false' && onScreen && (pop?.chips.length ?? 0) >= 2 && !!pop?.askAi;
      attempts.push({ candidate: cand.label, state: s, popover: pop, accepted: ok });
      if (ok) {
        expectOfficialPicture('03', pop);
        expectBox('03', pop, { sure: false, pinned: true });
        await page.screenshot({ path: path.join(RAW, '03-not-sure.png') });
        notSure = true;
      }
      await close();
      if (notSure) break;
    }
  } finally {
    await worker.evaluate("chrome.storage.local.remove('settings')");
  }
  checks['03-not-sure'] = { attempts, notSure };
  if (!notSure) {
    // No honest doubt: a card in Defense Position instead (never a staged "Not sure").
    console.warn('03: no candidate gave an honest "Not sure"; using the Defense Position card instead');
    const { geo: g } = await open();
    const c = card(g, 'xyz-def');
    await begin();
    await page.mouse.click(c.x, c.y);
    const s = await H.waitForState(page, ['result', 'error'], 60000);
    const pop = await H.waitForPictures(cdp);
    await H.settle(page, 400);
    (checks['03-not-sure'] as Record<string, unknown>).fallback = { state: s, popover: pop };
    expect(s.card === c.name && s.confident === 'true', `03 fallback: the click read ${s.card}`);
    expectOfficialPicture('03', pop);
    expectBox('03', pop, { sure: true, pinned: true });
    await page.screenshot({ path: path.join(RAW, '03-not-sure.png') });
    await close();
  }
  const settingsLeft = await worker.evaluate("chrome.storage.local.get('settings')");
  expect(!(settingsLeft as { settings?: unknown }).settings, 'the placeholder AI settings were not removed');
}

/** Where the scene's mat point (x, y) (display px of its 1280x720 layout) is in the page now (scene.html geometry()). */
async function matPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return (await page.evaluate(`(() => {
    const s = Math.max(innerWidth / 1280, innerHeight / 720);
    return { x: (innerWidth - 1280 * s) / 2 + ${x} * s, y: (innerHeight - 720 * s) / 2 + ${y} * s };
  })()`)) as { x: number; y: number };
}

interface LiveLogView {
  status: string;
  entries: { cardId: number; imageId: number; firstVideoTime: number; appearances: number }[];
}

/**
 * 01 and 04, from one Live check run. Live check is turned on as its switch does (settings.live.check; every other
 * setting is the default: Speed Light, Full details on hover), the scene plays with the player's clock, and the
 * pointer comes to rest on Pot of Greed: Live starts there, outlines the card and opens its box, "reading" first,
 * then the card (01). Then the pointer goes to the empty mat, Live reads on, and the side panel's "Live check" list
 * is captured beside the scene (04), in a window of its own so the scene's tab stays in front and Live keeps watching.
 */
async function liveShots(browser: Browser, page: Page, cdp: CDPSession, worker: WebWorker, extId: string, open: Open, card: CardOf): Promise<void> {
  const call = async <T>(fn: string, ...a: unknown[]) => (await worker.evaluate(`globalThis.duelLensDebug[${JSON.stringify(fn)}](...${JSON.stringify(a)})`)) as T;
  const logNow = async () => {
    const log = await call<LiveLogView | null>('liveLog');
    const names = log?.entries.length ? await call<Record<number, string>>('cardNames', log.entries.map((e) => e.cardId)) : {};
    return { status: log?.status ?? null, entries: (log?.entries ?? []).map((e) => ({ ...e, name: names[e.cardId] ?? null })) };
  };
  await worker.evaluate(
    "chrome.storage.local.get('settings').then((s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), live: { ...((s.settings || {}).live || {}), check: true } } }))",
  );
  // No player clock (scene.html ?clock=): its made-up time would disagree with the times Live lists, the video's own.
  const { geo } = await open();
  const names = new Set(geo.faceUp.map((c) => c.name));
  await sleep(2000); // the switch reaches the tab (background/live-check.ts applyLiveCheck)
  expect((await logNow()).status === null, '01: Live ran before the pointer rested on the video');

  // --- 01: from the empty zone beside it, the pointer comes to rest on the card's art.
  const hero = card(geo, HERO_CARD);
  const at = { x: Math.round(hero.x), y: Math.round(hero.y + 4) };
  await page.mouse.move(hero.x + 162, hero.y);
  await page.mouse.move(at.x, at.y, { steps: 12 });
  const t0 = Date.now();
  const seen: string[] = [];
  type HoverBox = { shows: string; rect: { x: number; y: number; w: number; h: number } } | null;
  let hover: HoverBox = null;
  for (;;) {
    hover = await call<HoverBox>('liveHoverBox').catch(() => null);
    if (hover && seen.at(-1) !== hover.shows) seen.push(hover.shows);
    if (hover?.shows === 'sure') break;
    expect(Date.now() - t0 < 120000, `01: no sure box on ${hero.name} within 2 minutes (seen: ${seen.join(' → ') || 'none'})`);
    await sleep(150);
  }
  const shownAfterMs = Date.now() - t0;
  // The pointer stays: Live reads on until it has listed every face-up card (or 90 s), so the pill counts the whole
  // board, as the side panel will list it (04).
  for (;;) {
    const listed = new Set((await logNow()).entries.map((e) => e.name));
    if ([...names].every((n) => listed.has(n)) || Date.now() - t0 > 90000) break;
    await sleep(1000);
  }
  hover = await call<HoverBox>('liveHoverBox').catch(() => null);
  expect(hover?.shows === 'sure', `01: the box went while Live read the board (${JSON.stringify(hover)})`);
  const pop = await H.waitForPictures(cdp, 30000, H.LIVE_HOST);
  await H.settle(page, 600);
  // The pill's count is the log's: read them until they agree (Live may list another card in between).
  let live: H.LiveView | null = null;
  let log = await logNow();
  for (let i = 0; i < 20; i++) {
    live = await H.readLive(cdp);
    log = await logNow();
    if (live?.pill?.count === String(log.entries.length)) break;
    await sleep(200);
  }
  const playing = (await page.evaluate("(() => { const v = document.getElementById('duel'); return !v.paused && !v.ended; })()")) as boolean;
  checks['01-hero'] = { card: hero.name, pointer: at, readingFirst: seen[0] === 'reading', states: seen, shownAfterMs, hoverBox: hover, box: pop, live, log, playing };
  expect(pop.name === hero.name, `01: the box shows ${pop.name}, not ${hero.name}`);
  expectOfficialPicture('01', pop);
  expectBox('01', pop, { sure: true, pinned: false });
  expect(pop.banFrame === 'forbidden', `01: the picture's ban frame is ${pop.banFrame}`);
  expect(pop.facts.includes('Forbidden · TCG') && pop.facts.includes('Genesys 20 pts'), `01: the legality row reads ${JSON.stringify(pop.facts)}`);
  expect(live?.pill?.word === 'Live check' && live.pill.ready && live.pill.count === String(log.entries.length), `01: the pill is ${JSON.stringify(live?.pill)} with ${log.entries.length} cards listed`);
  expect(Math.abs(live!.pill!.x - 12) <= 1 && Math.abs(live!.pill!.y - 12) <= 1, `01: the pill is not at the video's top-left corner (${live!.pill!.x}, ${live!.pill!.y})`);
  expect(live!.outlines.length === 1 && live!.outlines[0].state === 'promoted', `01: the outlines are ${JSON.stringify(live!.outlines)}`);
  const o = live!.outlines[0];
  expect(at.x > o.x && at.x < o.x + o.w && at.y > o.y && at.y < o.y + o.h, '01: the outline is not around the pointer');
  const b = pop.box!;
  expect(!(at.x >= b.x && at.x <= b.x + b.w && at.y >= b.y && at.y <= b.y + b.h), '01: the box covers the pointer');
  expect(log.entries.every((e) => e.name !== null && names.has(e.name)), `01: Live listed a card not on the mat: ${JSON.stringify(log.entries.map((e) => e.name))}`);
  expect(log.entries.some((e) => e.name === hero.name), `01: ${hero.name} is not in Live's list`);
  expect(playing, '01: the video is not playing');
  expect((await H.hostState(page)) === null, '01: scan mode is open');
  await page.screenshot({ path: path.join(RAW, '01-hero.png') });

  // --- 04: the pointer off the cards, on the empty mat left of the Extra Monster Zones; Live reads on.
  const empty = await matPoint(page, 316, 166);
  await page.mouse.move(empty.x, empty.y, { steps: 8 });
  await sleep(1500);
  log = await logNow();
  const missing = [...names].filter((n) => !log.entries.some((e) => e.name === n));
  expect(log.entries.every((e) => e.name !== null && names.has(e.name)), `04: Live listed a card not on the mat: ${JSON.stringify(log.entries.map((e) => e.name))}`);
  expect(log.entries.length >= names.size - 1, `04: Live listed only ${log.entries.length} cards (missing: ${missing.join(', ')})`);
  expect(log.status === 'watching', `04: Live is ${log.status}`);

  // The side panel as a page, in a window of its own (379x720): its "Live check" view, as a click on it shows it.
  const session = await browser.target().createCDPSession();
  await session.send('Target.createTarget', { url: `chrome-extension://${extId}/sidepanel.html`, newWindow: true });
  const panelTarget = await browser.waitForTarget((t) => t.url().endsWith('/sidepanel.html'), { timeout: 15000 });
  const panel = (await panelTarget.page())!;
  await panel.setViewport({ width: 379, height: 720, deviceScaleFactor: 1 });
  await panel.emulateMediaFeatures(DARK_REDUCED);
  await panel.waitForFunction("document.querySelector('.views button')", { timeout: 15000 });
  const [liveTab] = await panel.$$('xpath/.//div[contains(@class,"views")]/button[normalize-space()="Live check"]');
  expect(liveTab, '04: the side panel has no "Live check" view');
  await liveTab.click();
  const rows = log.entries.length;
  await panel.waitForFunction(
    `document.querySelectorAll('.live-list li').length === ${rows} && !document.body.innerText.includes('Loading…') && [...document.querySelectorAll('.live-list li img')].length === ${rows} && [...document.querySelectorAll('.live-list li img')].every((i) => i.complete && i.naturalWidth > 0)`,
    { timeout: 30000 },
  );
  await panel.evaluate('document.fonts.ready');
  await H.settle(panel, 400);
  const panelView = (await panel.evaluate(`(() => {
    const at = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
    return {
      pressed: [...document.querySelectorAll('.views button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent.trim()),
      heading: document.getElementById('live-heading')?.textContent,
      status: document.querySelector('.live-status')?.textContent,
      rows: [...document.querySelectorAll('.live-list li')].map((li) => ({ name: li.querySelector('.name').textContent, time: li.querySelector('.live-time').textContent, seen: li.querySelector('.seen')?.textContent ?? null, onScreen: at(li) })),
      foot: document.querySelector('.live-foot')?.textContent,
      scrollHeight: document.documentElement.scrollHeight,
      text: document.body.innerText,
    };
  })()`)) as { pressed: string[]; heading: string; status: string; rows: { name: string; time: string; onScreen: [number, number] }[]; foot: string; scrollHeight: number; text: string };
  const sceneVisible = (await page.evaluate('document.visibilityState')) as string;
  const logAtPanel = await logNow();
  checks['04-side-panel'] = { ...panelView, text: undefined, sceneVisible, missing };
  checks.liveRun = { log: logAtPanel };
  expect(JSON.stringify(panelView.pressed) === JSON.stringify(['Live check']), `04: the panel's pressed view is ${panelView.pressed}`);
  expect(JSON.stringify(panelView.rows.map((r) => r.name)) === JSON.stringify(logAtPanel.entries.map((e) => e.name)), `04: the panel lists ${panelView.rows.map((r) => r.name).join(', ')}`);
  expect(/^Watching/.test(panelView.status ?? ''), `04: the panel's status reads "${panelView.status}"`);
  expect(sceneVisible === 'visible' && logAtPanel.status === 'watching', `04: the scene is ${sceneVisible}, Live ${logAtPanel.status}`);
  expect(panelView.rows.every((r) => r.onScreen[0] >= 0 && r.onScreen[1] <= 720), '04: a row is out of view');
  expect(!/E2E|Unknown card/.test(panelView.text), '04: the side panel shows "E2E" or "Unknown card"');
  await panel.screenshot({ path: path.join(RAW, '04-panel.png') });
  await panel.close();

  // The scene beside it at 900x720: the pill counts what the panel lists; the pointer on the empty mat, no box.
  await page.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
  await H.refocus(page);
  const empty900 = await matPoint(page, 316, 166);
  await page.mouse.move(empty900.x, empty900.y, { steps: 4 });
  await H.settle(page, 800);
  const live900 = await H.readLive(cdp);
  const box900 = await call<unknown>('liveHoverBox').catch(() => null);
  (checks['04-side-panel'] as Record<string, unknown>).scene = { pill: live900?.pill, outlines: live900?.outlines, hoverBox: box900 };
  expect(live900?.pill?.count === String(panelView.rows.length) && live900.pill.ready, `04: the pill (${JSON.stringify(live900?.pill)}) doesn't count the panel's ${panelView.rows.length} cards`);
  expect(!box900 && (live900?.outlines.length ?? 0) === 0, '04: a box or an outline shows on the scene');
  expect((await H.hostState(page)) === null, '04: scan mode is open');
  await page.screenshot({ path: path.join(RAW, '04-scene.png') });
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await worker.evaluate(
    "chrome.storage.local.get('settings').then((s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), live: { ...((s.settings || {}).live || {}), check: false } } }))",
  );
}

/**
 * The popover's picture is the card's official image (every build shows YGOPRODeck's, D2), loaded,
 * and so is every chip's small one.
 */
function expectOfficialPicture(shot: string, pop: H.PopoverView | null): void {
  expect(
    pop?.picture?.loaded && !pop.picture.ownCrop && pop.picture.src === 'data:image/jpeg;base64,',
    `${shot}: the popover's picture is not the card's official image (${JSON.stringify(pop?.picture)})`,
  );
  expect(pop?.chipPicturesLoaded === pop?.chipPictures, `${shot}: ${pop?.chipPicturesLoaded} of ${pop?.chipPictures} chip pictures loaded`);
}

/**
 * 05: the welcome page the install opened, before agreeing, in the dark theme: the whole "Before your
 * first scan" step, with what is above and below it as fits (see the framing below). Then a real click on
 * "Agree and start".
 */
async function welcomeShot(browser: Browser, worker: WebWorker): Promise<void> {
  const welcome = await H.installWelcomePage(browser);
  await welcome.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  await welcome.emulateMediaFeatures(DARK_REDUCED);
  // As on Windows (WINDOWS_COMMANDS): set before the page loads again, then reload it. The session
  // stays open until the capture, so the override holds.
  const windows = await windowsUserAgent(browser);
  const cdp = await welcome.createCDPSession();
  await cdp.send('Emulation.setUserAgentOverride', windows);
  await welcome.evaluateOnNewDocument(WINDOWS_COMMANDS);
  await welcome.reload({ waitUntil: 'load' });
  await welcome.bringToFront();
  await welcome.waitForFunction("document.body.innerText.includes('Before your first scan')", { timeout: 30000 });
  await welcome.waitForFunction("document.querySelector('.steps .step h3') && /\\bY$/.test(document.querySelector('.steps .step h3').textContent)", { timeout: 15000 });
  const platform = (await welcome.evaluate(`({
    windowsCommands: globalThis.__storeShotsWindows === true,
    navigatorPlatform: navigator.platform,
    uaPlatform: navigator.userAgentData && navigator.userAgentData.platform,
    userAgent: navigator.userAgent,
    macKeys: /[⌃⌥⇧⌘]/.test(document.body.innerText),
    scanTitle: document.querySelector('.steps .step h3').textContent,
  })`)) as { windowsCommands: boolean; navigatorPlatform: string; uaPlatform: string; userAgent: string; macKeys: boolean; scanTitle: string };
  checks.welcomePlatform = platform;
  expect(platform.windowsCommands && platform.navigatorPlatform === 'Win32' && platform.uaPlatform === 'Windows', `05: not emulating Windows (${JSON.stringify(platform)})`);
  expect(!platform.macKeys && platform.scanTitle === 'Press Alt+Shift+Y', `05: the page shows "${platform.scanTitle}" (Mac keys: ${platform.macKeys})`);
  await welcome.waitForFunction("document.body.innerText.includes('Ready:')", { timeout: 120000 });
  await welcome.evaluate('document.fonts.ready');
  const before = (await worker.evaluate("chrome.storage.local.get('consentedAt')")) as { consentedAt?: number };
  expect(before.consentedAt === undefined, '05: consent was already given');
  const frame = (await welcome.evaluate(`(() => {
    const abs = (el) => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; };
    const titles = [...document.querySelectorAll('.steps .step h3')].map(abs);
    return { consent: abs(document.getElementById('consent')), status: abs(document.querySelector('.hero .status')), how: abs(document.getElementById('wl-how')), titlesBottom: Math.max(...titles.map((t) => t.bottom)) };
  })()`)) as { consent: { top: number; bottom: number }; status: { top: number; bottom: number }; how: { top: number; bottom: number }; titlesBottom: number };
  // End the view just below the step titles (above their first line of text) when they fit under the
  // whole consent step. Since 0.10 the step is taller (it names Live check), so they don't: the view
  // then runs from the card data's "Ready" line to the "How to use it" heading (the steps' cards below
  // it are left out rather than cut), or, if those don't fit either, starts just above the consent step.
  const fits = frame.titlesBottom + 9 - 720 <= frame.consent.top - 12;
  // (The heading's box is taller than its letters: up to 8 px of it may fall below the view.)
  const fromStatus = frame.how.bottom - (frame.status.top - 8) <= 720 + 8;
  const y = Math.round(fits ? frame.titlesBottom + 9 - 720 : fromStatus ? frame.status.top - 8 : frame.consent.top - 12);
  checks.welcomeFrame = { ...frame, fits, fromStatus, y };
  await welcome.evaluate(`window.scrollTo(0, ${y})`);
  await H.settle(welcome, 300);
  const shown = (await welcome.evaluate(`(() => {
    const c = document.getElementById('consent').getBoundingClientRect();
    return {
      scrollY,
      consent: [Math.round(c.top), Math.round(c.bottom)],
      consentText: document.getElementById('consent').innerText,
      agreeVisible: (() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Agree and start'); const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })(),
      stepTitles: [...document.querySelectorAll('.steps .step h3')].map((h) => { const r = h.getBoundingClientRect(); return { text: h.textContent, visible: r.top >= 0 && r.bottom <= innerHeight }; }),
      e2e: document.body.innerText.includes('E2E'),
    };
  })()`)) as { consent: [number, number]; consentText: string; agreeVisible: boolean; stepTitles: { text: string; visible: boolean }[]; e2e: boolean };
  checks['05-privacy'] = shown;
  expect(shown.consent[0] >= 0 && shown.consent[1] <= 720, `05: the consent step is cut (${shown.consent})`);
  for (const lead of ['Screenshots.', 'History.', 'Card data and pictures.', 'AI check (off).']) expect(shown.consentText.includes(lead), `05: "${lead}" is missing`);
  expect(shown.consentText.includes('which card pictures your browser asks for'), '05: the "Card data and pictures" point is not the official-pictures one');
  expect(shown.consentText.includes('While Live check is on'), '05: the "Screenshots" point does not name Live check');
  const titles = shown.stepTitles.map((t) => t.text);
  // The steps' titles (0.10.3), shown when they fit under the consent step (`fits`), else left below the view.
  expect(JSON.stringify(titles) === JSON.stringify(['Press Alt+Shift+Y', 'Point at a card', 'Click to read it']), `05: the steps read ${JSON.stringify(shown.stepTitles)}`);
  expect(!fits || shown.stepTitles.every((t) => t.visible), `05: the step titles are cut (${JSON.stringify(shown.stepTitles)})`);
  expect(shown.agreeVisible, '05: "Agree and start" is not in view');
  expect(!shown.e2e, '05: the page shows "E2E"');
  await welcome.screenshot({ path: path.join(RAW, '05-welcome.png') });
  // Agree, as a user would.
  const [agree] = await welcome.$$('xpath/.//button[normalize-space()="Agree and start"]');
  await agree.click();
  await welcome.waitForFunction("document.body.innerText.includes(\"You're all set\")", { timeout: 15000 });
  const after = (await worker.evaluate("chrome.storage.local.get('consentedAt')")) as { consentedAt?: number };
  expect(typeof after.consentedAt === 'number', '05: "Agree and start" stored no consent');
  await welcome.close();
}

// ---------- composing ----------

/** The Archivo font the extension bundles (extension/fonts, SIL OFL 1.1), as a data URL. */
async function fontFaces(): Promise<string> {
  const data = async (file: string) => `data:font/woff2;base64,${(await readFile(path.join(ROOT, 'extension/fonts', file))).toString('base64')}`;
  return `
    @font-face { font-family: "Shot Archivo"; src: url(${await data('archivo-latin-var.woff2')}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The 80 px caption band (plan §3.4): headline 27 px Archivo 650 at x 40, baseline 38; subline 15 px, baseline 63; a 3 px foil line at the bottom. */
async function renderBand(page: Page, fonts: string, headline: string, subline: string): Promise<Buffer> {
  await page.setViewport({ width: 1280, height: 80, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
    html, body { margin: 0; width: 1280px; height: 80px; overflow: hidden; background: ${BAND_BG}; }
    svg { position: absolute; left: 0; top: 0; }
    text { font-family: "Shot Archivo", "Helvetica Neue", Arial, sans-serif; }
    .h { font-size: 27px; font-weight: 650; fill: ${INK}; letter-spacing: -0.005em; }
    .s { font-size: 15px; font-weight: 400; fill: ${INK_2}; }
    .foil { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: ${FOIL}; }
  </style></head><body>
    <svg width="1280" height="80"><text class="h" x="40" y="38">${escapeHtml(headline)}</text><text class="s" x="40" y="63">${escapeHtml(subline)}</text></svg>
    <div class="foil"></div>
  </body></html>`);
  await page.evaluate('document.fonts.ready');
  const fit = (await page.evaluate(`(() => {
    const [h, s] = document.querySelectorAll('text');
    return { loaded: document.fonts.check('650 27px "Shot Archivo"'), headlineRight: 40 + h.getComputedTextLength(), sublineRight: 40 + s.getComputedTextLength() };
  })()`)) as { loaded: boolean; headlineRight: number; sublineRight: number };
  expect(fit.loaded, 'the caption font did not load');
  expect(fit.headlineRight <= 1240 && fit.sublineRight <= 1240, `a caption runs past the right margin: ${JSON.stringify(fit)}`);
  return Buffer.from(await page.screenshot({ type: 'png' }));
}

async function compose(): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  await mkdir(PROMO, { recursive: true });
  const fonts = await fontFaces();
  const browser = await launch(false);
  const written: Record<string, unknown> = {};
  try {
    const page = await browser.newPage();
    // This run's checks, else the last full run's (--compose-only, or a screenshot --only left as it was).
    const saved = existsSync(path.join(RAW, 'checks.json')) ? JSON.parse(await readFile(path.join(RAW, 'checks.json'), 'utf8')) : {};
    const checked = (key: string) => (checks[key] ?? saved[key]) as Record<string, unknown> | undefined;
    const fallback03 = checked('03-not-sure')?.notSure === false;
    for (const name of Object.keys(CAPTIONS) as ShotName[]) {
      if (ONLY && !ONLY_GROUPS[ONLY].shots.includes(name)) continue;
      const [headline, subline] = name === '03-not-sure' && fallback03 ? FALLBACK_03 : CAPTIONS[name];
      const band = await renderBand(page, fonts, headline, subline);
      let shot: Buffer;
      if (name === '04-side-panel') {
        const scene = path.join(RAW, '04-scene.png');
        const panel = path.join(RAW, '04-panel.png');
        await expectSize(scene, 900, 720);
        await expectSize(panel, 379, 720);
        // The page beside the side panel: 900 + a 1 px divider + 379 = 1280.
        shot = await sharp({ create: { width: 1280, height: 720, channels: 3, background: DIVIDER } })
          .composite([
            { input: scene, left: 0, top: 0 },
            { input: panel, left: 901, top: 0 },
          ])
          .png()
          .toBuffer();
      } else {
        const raw = path.join(RAW, `${name === '05-privacy' ? '05-welcome' : name}.png`);
        await expectSize(raw, 1280, 720);
        shot = await readFile(raw);
        const pointer = checked('01-hero')?.pointer as { x: number; y: number } | undefined;
        if (name === '01-hero' && DRAW_POINTER_01) {
          // The pointer where the mouse rested (DRAW_POINTER_01): its tip on that pixel.
          expect(pointer, '01: no pointer position in the checks');
          shot = await sharp(shot)
            .composite([{ input: Buffer.from(ARROW_SVG), left: Math.round(pointer!.x - ARROW_HOT[0]), top: Math.round(pointer!.y - ARROW_HOT[1]) }])
            .png()
            .toBuffer();
        }
      }
      const out = path.join(SHOTS, `${name}.png`);
      await sharp({ create: { width: 1280, height: 800, channels: 3, background: BAND_BG } })
        .composite([
          { input: band, left: 0, top: 0 },
          { input: shot, left: 0, top: 80 },
        ])
        .removeAlpha()
        .toColourspace('srgb')
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toFile(out);
      written[name] = await describe(out, 1280, 800);
    }
    if (!ONLY) written.promo = await promoTile(page, fonts);
  } finally {
    await browser.close();
  }
  checks.outputs = written;
}

async function expectSize(file: string, width: number, height: number): Promise<void> {
  const m = await sharp(file).metadata();
  expect(m.width === width && m.height === height, `${path.relative(ROOT, file)} is ${m.width}x${m.height}, not ${width}x${height}`);
}

/** Checks a written image (exact size, PNG, sRGB, no transparency, under 2 MB) and describes it. */
async function describe(file: string, width: number, height: number) {
  const m = await sharp(file).metadata();
  const bytes = (await stat(file)).size;
  expect(m.format === 'png' && m.width === width && m.height === height, `${file}: ${m.format} ${m.width}x${m.height}`);
  expect(!m.hasAlpha && m.channels === 3 && m.space === 'srgb', `${file}: ${m.channels} channels, alpha ${m.hasAlpha}, ${m.space}`);
  expect(bytes < 2 * 1024 * 1024, `${file}: ${bytes} bytes (over 2 MB)`);
  return { file: path.relative(ROOT, file), width: m.width, height: m.height, bytes };
}

// ---------- the promo tile ----------

/**
 * The small promo tile (plan §5): the Duel Lens mark (src/content/icons.tsx, drawn like the toolbar
 * icon: gold card, foil lens) on #17151E with a soft gold glow, the name lettered as 0.10's card box and scan
 * bar letter it in their top row ("DUEL LENS": Archivo 700, condensed, capitals, spaced), a foil line on top.
 * No card art, no logos. Drawn at 2x and scaled down; a 220x140 preview goes to the raw folder.
 */
async function promoTile(page: Page, fonts: string) {
  await page.setViewport({ width: 440, height: 280, deviceScaleFactor: 2 });
  const stops = [
    ['0', '#ffd1f4'],
    ['.22', '#c3e4ff'],
    ['.42', '#c8ffe0'],
    ['.62', '#fff0b8'],
    ['.80', '#ffc9c9'],
    ['1', '#ffd1f4'],
  ]
    .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`)
    .join('');
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${fonts}
    html, body { margin: 0; width: 440px; height: 280px; overflow: hidden; background: ${BAND_BG}; }
    .glow { position: absolute; left: 125px; top: 140px; width: 360px; height: 360px; margin: -180px 0 0 -180px; border-radius: 50%;
      background: radial-gradient(closest-side, rgba(231,185,85,.13), rgba(231,185,85,.05) 55%, rgba(231,185,85,0)); }
    .foil { position: absolute; left: 0; right: 0; top: 0; height: 4px; background: ${FOIL}; }
    svg { position: absolute; left: 50px; top: 65px; width: 150px; height: 150px; overflow: visible; }
    .word { position: absolute; left: 238px; top: 140px; transform: translateY(-50%); margin: 0; font-family: "Shot Archivo", "Helvetica Neue", Arial, sans-serif;
      font-weight: 700; font-stretch: 75%; text-transform: uppercase; font-size: 58px; line-height: 1; color: ${INK}; letter-spacing: .1em; white-space: nowrap; }
  </style></head><body>
    <div class="glow"></div>
    <div class="foil"></div>
    <svg viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">
      <defs>
        <linearGradient id="foil" x1="0" y1="0" x2="1" y2=".18">${stops}</linearGradient>
        <linearGradient id="handle" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient>
      </defs>
      <g transform="translate(-0.35 0.55)">
        <rect x="3.2" y="2.8" width="10.5" height="15" rx="1.6" transform="rotate(-8 8.4 10.3)" stroke="#E7B955" stroke-width="1.45" />
        <circle cx="15.2" cy="14.2" r="4.6" fill="${BAND_BG}" />
        <circle cx="15.2" cy="14.2" r="4.6" fill="url(#foil)" fill-opacity=".1" stroke="url(#foil)" stroke-width="1.55" />
        <path d="M18.6 17.6 21.4 20.4" stroke="url(#handle)" stroke-width="1.75" />
      </g>
    </svg>
    <p class="word" id="word">Duel<br>Lens</p>
    <span class="word" id="one-line" style="visibility: hidden; top: 0; transform: none">Duel Lens</span>
  </body></html>`);
  await page.evaluate('document.fonts.ready');
  const word = (await page.evaluate(`(() => {
    const r = document.getElementById('word').getBoundingClientRect();
    // One line would need this much room from x 238 (440 px is the edge): hence two lines.
    const oneLine = document.getElementById('one-line').getBoundingClientRect().width;
    return { loaded: document.fonts.check('700 58px "Shot Archivo"'), left: r.left, right: r.right, top: r.top, bottom: r.bottom, oneLineWidth: oneLine };
  })()`)) as { loaded: boolean; left: number; right: number; top: number; bottom: number; oneLineWidth: number };
  expect(word.loaded, 'the promo font did not load');
  expect(word.right <= 440 - 24, `the name runs to x ${word.right}`);
  const big = Buffer.from(await page.screenshot({ type: 'png' }));
  const out = path.join(PROMO, 'small-440x280.png');
  await sharp(big).resize(440, 280, { kernel: 'lanczos3' }).removeAlpha().toColourspace('srgb').png({ compressionLevel: 9 }).toFile(out);
  await sharp(out).resize(220, 140, { kernel: 'lanczos3' }).png().toFile(path.join(RAW, 'promo-220x140-preview.png'));
  return { ...(await describe(out, 440, 280)), word };
}

// ---------- main ----------

async function main() {
  if (!composeOnly) await capture();
  else expect(existsSync(path.join(RAW, '05-welcome.png')), `--compose-only needs the captures in ${path.relative(ROOT, RAW)} (run without it first)`);
  await compose();
  checks.finishedAt = new Date().toISOString();
  const file = path.join(RAW, composeOnly ? 'checks-compose.json' : 'checks.json');
  let saved: Record<string, unknown> = checks;
  if (ONLY && existsSync(file)) {
    // One screenshot alone: its checks replace the earlier ones; everything else keeps the full run's.
    saved = JSON.parse(await readFile(file, 'utf8'));
    for (const key of ONLY_GROUPS[ONLY].checks) saved[key] = checks[key];
    saved.outputs = { ...(saved.outputs as object), ...(checks.outputs as object) };
    saved.rerendered = [...((saved.rerendered as unknown[]) ?? []), { only: ONLY, build: checks.build, at: checks.finishedAt }];
  }
  await writeFile(file, JSON.stringify(saved, null, 2));
  console.log(`\nstore images written; checks in ${path.relative(ROOT, file)}`);
  for (const [name, o] of Object.entries(checks.outputs as Record<string, { file: string; bytes: number }>)) {
    console.log(`  ${name}: ${o.file} (${Math.round(o.bytes / 1024)} kB)`);
  }
}

main().catch(async (e) => {
  console.error(e);
  checks.error = String(e?.stack ?? e);
  await mkdir(RAW, { recursive: true }).catch(() => {});
  await writeFile(path.join(RAW, 'checks-failed.json'), JSON.stringify(checks, null, 2)).catch(() => {});
  process.exit(1);
});
