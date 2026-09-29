// Renders the Chrome Web Store images (store/screenshots-plan.md): five 1280x800 screenshots and the
// 440x280 small promo tile. Every popover, hint, outline and panel is the real UI of an E2E-flavoured
// copy of the store build (node build.mjs --e2e: official card pictures from images.ygoprodeck.com, so
// the run needs the network), driven with Puppeteer on a synthetic scene (scene.html: the E2E fixture
// cards on a plain playmat, played as a video). Nothing is retouched; every result shown is checked
// first (the card, confident or not, its picture loaded), and the run stops if a check fails.
//
// Run from the repository root:  npx tsx tools/store-shots/render.ts [options]
//   --no-build      reuse release/shots-build/ext instead of building it again
//   --compose-only  only redo the captions and the promo tile, from the captures in release/shots-build/raw
//   --gap=<s>       seconds between the side panel's scans (default 20), so the list's times differ
//   --only=05-privacy, --only=01-hero  capture and compose that screenshot alone (the others are left as they are)
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
import type { Browser, Page, WebWorker } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
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
const gapArg = args.find((a) => a.startsWith('--gap='));
const GAP_MS = (gapArg ? Number(gapArg.slice('--gap='.length)) : 20) * 1000;
/**
 * --only=05-privacy or --only=01-hero: capture and compose that screenshot alone; the other images and
 * their captures stay as they are. Its checks replace the earlier ones in checks.json (ONLY_CHECKS).
 */
const onlyArg = args.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null;
const ONLY_CHECKS: Record<string, string[]> = { '05-privacy': ['05-privacy', 'welcomePlatform'], '01-hero': ['01-hero'] };
if (ONLY !== null && !ONLY_CHECKS[ONLY]) throw new Error(`--only=${ONLY}: only --only=05-privacy and --only=01-hero are supported`);

/** The captions: store/screenshots-plan.md, "Captions at a glance" (2: the click variant, as the zip ships the detector). */
const CAPTIONS = {
  // The plan's subline said "drag a box"; clicking a card is the main path now (the lead, 2026-09-29).
  '01-hero': ['Read the card without leaving the stream', 'Press Alt+Shift+Y and click a card: its name and full text appear beside it.'],
  '02-click': ['Every card outlined. Click one.', 'Duel Lens finds the cards on the frozen frame. Dragging a box still works.'],
  '03-not-sure': ['Not sure? It says so.', 'The closest matches are a click (or ← →) away. Optional: ask AI with your own key.'],
  // The plan's subline named "Open at", which F3 removed: a YouTube scan's time is itself the link now.
  '04-side-panel': ['Keep what you looked up', 'The side panel keeps your scans. On YouTube, click a scan’s time to jump back to that moment.'],
  '05-privacy': ['Runs on your computer', 'No account, no analytics. It asks before its first scan.'],
} as const;
type ShotName = keyof typeof CAPTIONS;
/**
 * Screenshot 2 shows the frame just after the shortcut: 'spotlight' (every outlined card bright, the
 * mat dimmed; the pointer on no card) or 'lit' (the pointer on Number 39: Utopia, which lights it and
 * dims the rest). Both are captured (the other goes to raw/02-click-other.png); this picks the one used.
 */
const SHOT_02: 'spotlight' | 'lit' = 'spotlight';
/** Only if no honest "Not sure" turns up: screenshot 3 shows a card in Defense Position instead (the caller's fallback). */
const FALLBACK_03 = ['Sideways, upside down or tilted', 'Cards in Defense Position, upside down or slightly tilted are read too.'] as const;

/** Colours and the foil of the popover (src/content/styles.ts), for the caption band and the promo tile. */
const INK = '#F4F1F9';
const INK_2 = '#B8B2C7';
const BAND_BG = '#17151E';
const DIVIDER = '#2A2733';
const FOIL = 'linear-gradient(100deg,#ffd1f4,#c3e4ff 22%,#c8ffe0 42%,#fff0b8 62%,#ffc9c9 80%,#ffd1f4)';

/**
 * Screenshot 3's hard case, tried in order until one gives a real "Not sure" with the right card on
 * screen. Shrinking a card, covering half of it, boxing part of the art, glare and 360p video all gave
 * a confident answer or "Couldn't match" on this build; a card caught mid-motion (motion blur, one of
 * the causes the listing names) gives "Not sure".
 */
const NOT_SURE_CANDIDATES = [
  { label: 'Odd-Eyes caught mid-motion (blur 16 px), clicked', query: '?fx=pend:blur:16:15', card: 'pend', how: 'click' },
  { label: 'Odd-Eyes caught mid-motion (blur 16 px), boxed', query: '?fx=pend:blur:16:15', card: 'pend', how: 'box' },
  { label: 'Odd-Eyes caught mid-motion (blur 18 px), boxed', query: '?fx=pend:blur:18:15', card: 'pend', how: 'box' },
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
  manifest.name = 'Duel Lens';
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
    expect(manifest.name === 'Duel Lens', `the build's name is "${manifest.name}", not "Duel Lens"`);

    if (ONLY === '01-hero') {
      // Screenshot 1 alone: agree as the E2E harness does (the welcome page isn't captured).
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

    /** The shortcut (the E2E hook does exactly what Alt+Shift+Y does), then the detector's outlines. */
    const begin = async () => {
      await H.startScan(worker);
      await H.waitForState(page, ['selecting'], 15000);
      return H.waitForOutlines(page, 20000);
    };
    const close = async () => {
      expect(await H.closeOverlay(page), 'Escape did not close Duel Lens');
      await sleep(700); // captureVisibleTab allows 2 calls a second
    };
    const box = (c: Placed, pad = 6): [[number, number], [number, number]] => [
      [c.bounds.x - pad, c.bounds.y - pad],
      [c.bounds.x + c.bounds.w + pad, c.bounds.y + c.bounds.h + pad],
    ];

    // --- 01 (the hero) and 04 (the history). Accesscode Talker, Odd-Eyes Pendulum Dragon and Infinite
    // Impermanence are clicked. Ash Blossom (upside down in the GY, and with Genesys points) is clicked
    // too, as caption 1 says: that popover is the hero. Dark Magician is clicked last, so the side panel
    // shows it (its short text leaves room for the list under the panel's full-width picture).
    const history: unknown[] = [];
    const heroShot = async () => {
      const ash = card(scene.geo, 'ash-gy');
      await begin();
      await page.mouse.click(ash.x, ash.y);
      const hero = await H.waitForState(page, ['result', 'error'], 60000);
      history.push({ card: ash.name, by: 'click', got: hero.card, confident: hero.confident });
      expect(hero.card === ash.name && hero.confident === 'true', `01: the click read ${hero.card} (confident ${hero.confident})`);
      const heroPop = await H.waitForPictures(cdp);
      await H.settle(page, 400);
      checks['01-hero'] = { by: 'click', state: hero, popover: heroPop };
      expectOfficialPicture('01', heroPop);
      expect(!heroPop.toast, `01: a toast is showing (${heroPop.toast})`);
      expect(heroPop.facts.includes('Genesys 20 pts'), `01: no Genesys chip (facts: ${heroPop.facts.join(', ')})`);
      await page.screenshot({ path: path.join(RAW, '01-hero.png') });
      await close();
    };
    if (ONLY === '01-hero') {
      await heroShot(); // awaited here, before the `finally` below closes the browser
      return;
    }
    const clickScan = async (id: string) => {
      const c = card(scene.geo, id);
      await begin();
      await page.mouse.click(c.x, c.y);
      const s = await H.waitForState(page, ['result', 'error'], 60000);
      history.push({ card: c.name, by: 'click', got: s.card, confident: s.confident });
      expect(s.card === c.name && s.confident === 'true', `${c.name}: the click read ${s.card} (confident ${s.confident})`);
    };
    for (const id of ['link', 'pend', 'imp-tilt']) {
      await sleep(GAP_MS); // the video plays on between scans, so each entry has its own time
      await clickScan(id);
      await close();
    }
    await sleep(GAP_MS);
    await heroShot();
    await sleep(GAP_MS);
    await clickScan('dm');
    await close();
    checks.historyScans = history;

    // --- 04: the side panel as a page (379x720), then the scene beside it at 900x720, no popover open.
    const panel = await browser.newPage();
    await panel.setViewport({ width: 379, height: 720, deviceScaleFactor: 1 });
    await panel.emulateMediaFeatures(DARK_REDUCED);
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.waitForFunction(
      `document.querySelectorAll('.history li').length === 5 && !document.body.innerText.includes('Loading…') && ![...document.querySelectorAll('.history .name')].some((n) => n.textContent === 'Unknown card') && (() => { const img = document.querySelector('.current img'); return !!img && img.complete && img.naturalWidth > 0; })()`,
      { timeout: 30000 },
    );
    await panel.evaluate('document.fonts.ready');
    // The official picture fills the panel's width, so the card and the list don't fit in 720 px below
    // it: the view ends a little under the fifth entry, with the picture's lower part above the card.
    const lastBottom = (await panel.evaluate(
      "(() => { const li = [...document.querySelectorAll('.history li')].pop(); return li.getBoundingClientRect().bottom + scrollY; })()",
    )) as number;
    await panel.evaluate(`window.scrollTo(0, ${Math.max(0, Math.round(lastBottom + 18 - 720))})`);
    await H.settle(panel, 300);
    const panelView = (await panel.evaluate(`(() => {
      const img = document.querySelector('.current img');
      const at = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.top), Math.round(b.bottom)]; };
      return {
        scrollY,
        current: document.querySelector('.current .dv-name')?.textContent,
        type: document.querySelector('.current .dv-type')?.textContent,
        facts: [...document.querySelectorAll('.current .dv-facts .fact')].map((f) => f.textContent),
        picture: { alt: img.alt, src: img.src.slice(0, 23), width: img.naturalWidth, height: img.naturalHeight, onScreen: at(img) },
        name: at(document.querySelector('.current .dv-name')),
        entries: [...document.querySelectorAll('.history li')].map((li) => ({ name: li.querySelector('.name').textContent, time: li.querySelector('.time').textContent, link: !!li.querySelector('a.time'), active: li.classList.contains('active'), onScreen: at(li) })),
        text: document.body.innerText,
      };
    })()`)) as {
      current: string;
      picture: { alt: string; src: string; onScreen: [number, number] };
      name: [number, number];
      entries: { name: string; time: string; link: boolean; active: boolean; onScreen: [number, number] }[];
      text: string;
    };
    checks['04-side-panel'] = { ...panelView, text: undefined };
    const order = ['Dark Magician', 'Ash Blossom & Joyous Spring', 'Infinite Impermanence', 'Odd-Eyes Pendulum Dragon', 'Accesscode Talker'];
    expect(JSON.stringify(panelView.entries.map((e) => e.name)) === JSON.stringify(order), `04: the history lists ${panelView.entries.map((e) => e.name).join(', ')}`);
    expect(panelView.entries[0].active && panelView.entries.filter((e) => e.active).length === 1, '04: Dark Magician is not the one active entry');
    expect(panelView.current === 'Dark Magician', `04: the panel shows ${panelView.current}`);
    expect(panelView.picture.alt === 'Dark Magician' && panelView.picture.src === 'data:image/jpeg;base64,', `04: the picture is ${JSON.stringify(panelView.picture)}`);
    expect(panelView.picture.onScreen[1] >= 120, `04: only ${panelView.picture.onScreen[1]} px of the picture are in view`);
    expect(panelView.name[0] >= 0 && panelView.entries.every((e) => e.onScreen[0] >= 0 && e.onScreen[1] <= 720), '04: the name or an entry is out of view');
    expect(!/E2E/.test(panelView.text), '04: the side panel shows "E2E"');
    await panel.screenshot({ path: path.join(RAW, '04-panel.png') });
    await panel.close();
    await page.setViewport({ width: 900, height: 720, deviceScaleFactor: 1 });
    await H.refocus(page);
    await H.settle(page, 400);
    expect((await H.hostState(page)) === null, '04: a Duel Lens element is still on the page');
    await page.screenshot({ path: path.join(RAW, '04-scene.png') });
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await H.refocus(page);
    await H.settle(page, 300);

    // --- 02: the outlines after the shortcut and the hint, first with the pointer on no card (the
    // spotlight: every outlined card bright), then on Number 39: Utopia (lit). SHOT_02 picks one.
    const utopia = card(scene.geo, 'xyz-def');
    const emptyZone = { x: (card(scene.geo, 'bewd').x + card(scene.geo, 'ash-gy').x) / 2, y: card(scene.geo, 'bewd').y };
    await page.mouse.move(emptyZone.x, emptyZone.y);
    const outlinesCount = await begin();
    await H.settle(page, 400); // the outlines fade in (0.2 s; none with reduced motion)
    const view = await H.readOutlines(cdp);
    expect(view, '02: no outlines to read');
    const outlines = view!.outlines;
    const unoutlined = scene.geo.faceUp.filter((c) => !outlines.some((o) => H.insideBox(o, c.x, c.y)));
    const stray = outlines.filter((o) => !scene.geo.faceUp.some((c) => H.insideBox(o, c.x, c.y)));
    const faceDownOutlined = scene.geo.faceDown.filter((d) => outlines.some((o) => H.insideBox(o, d.x, d.y)));
    expect(outlinesCount === scene.geo.faceUp.length && outlines.length === outlinesCount && unoutlined.length === 0, `02: cards without an outline: ${unoutlined.map((c) => c.name).join(', ')}`);
    expect(stray.length === 0, `02: ${stray.length} outline(s) on no card`);
    expect(faceDownOutlined.length === 0, `02: face-down cards outlined: ${faceDownOutlined.map((d) => d.id).join(', ')}`);
    expect(view!.hint === 'Click a card, or drag a box · Esc cancels' && !view!.hintLow, `02: the hint reads "${view!.hint}"${view!.hintLow ? ' (at the bottom)' : ''}`);
    expect(view!.spotlight && !view!.lit, `02: no spotlight with the pointer on no card (${JSON.stringify({ spotlight: view!.spotlight, lit: view!.lit })})`);
    await page.screenshot({ path: path.join(RAW, SHOT_02 === 'spotlight' ? '02-click.png' : '02-click-other.png') });
    await page.mouse.move(utopia.x, utopia.y);
    await H.settle(page, 300);
    const lit = await H.readOutlines(cdp);
    expect(lit?.lit, '02: no card is lit under the pointer');
    await page.screenshot({ path: path.join(RAW, SHOT_02 === 'lit' ? '02-click.png' : '02-click-other.png') });
    checks['02-click'] = { shown: SHOT_02, outlines: outlinesCount, hint: view!.hint, hintLow: view!.hintLow, spotlight: view!.spotlight, lit: lit?.lit, unoutlined: unoutlined.map((c) => c.name), stray, faceDownOutlined: faceDownOutlined.map((d) => d.id) };
    // Honesty: that click really reads the card.
    await page.mouse.down();
    await page.mouse.up();
    const clicked = await H.waitForState(page, ['result', 'error'], 60000);
    (checks['02-click'] as Record<string, unknown>).clickReads = clicked;
    expect(clicked.card === utopia.name && clicked.confident === 'true', `02: the click read ${clicked.card} (confident ${clicked.confident})`);
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
        const { geo } = await open(cand.query);
        const c = card(geo, cand.card);
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
      const { geo } = await open();
      const c = card(geo, 'xyz-def');
      await begin();
      await page.mouse.click(c.x, c.y);
      const s = await H.waitForState(page, ['result', 'error'], 60000);
      const pop = await H.waitForPictures(cdp);
      await H.settle(page, 400);
      (checks['03-not-sure'] as Record<string, unknown>).fallback = { state: s, popover: pop };
      expect(s.card === c.name && s.confident === 'true', `03 fallback: the click read ${s.card}`);
      expectOfficialPicture('03', pop);
      await page.screenshot({ path: path.join(RAW, '03-not-sure.png') });
      await close();
    }
    const settingsLeft = await worker.evaluate("chrome.storage.local.get('settings')");
    expect(!(settingsLeft as { settings?: unknown }).settings, 'the placeholder AI settings were not removed');
  } finally {
    await browser.close();
    server.close();
  }
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
 * first scan" step and, below it, the titles of "How to use it". Then a real click on "Agree and start".
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
    return { consent: abs(document.getElementById('consent')), titlesBottom: Math.max(...titles.map((t) => t.bottom)) };
  })()`)) as { consent: { top: number; bottom: number }; titlesBottom: number };
  // End the view just below the step titles (above their first line of text), unless that would cut
  // the top of the consent step.
  const y = Math.round(Math.min(frame.titlesBottom + 9 - 720, frame.consent.top - 12));
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
  const titles = shown.stepTitles.map((t) => t.text);
  expect(JSON.stringify(titles) === JSON.stringify(['Press Alt+Shift+Y', 'Pick the card', 'Read it']) && shown.stepTitles.every((t) => t.visible), `05: the steps read ${JSON.stringify(shown.stepTitles)}`);
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

/** The Archivo and Spectral SC fonts the extension bundles (extension/fonts, SIL OFL 1.1), as data URLs. */
async function fontFaces(): Promise<string> {
  const data = async (file: string) => `data:font/woff2;base64,${(await readFile(path.join(ROOT, 'extension/fonts', file))).toString('base64')}`;
  return `
    @font-face { font-family: "Shot Archivo"; src: url(${await data('archivo-latin-var.woff2')}) format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
    @font-face { font-family: "Shot Spectral SC"; src: url(${await data('spectral-sc-latin-700.woff2')}) format("woff2"); font-weight: 700; }`;
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
    let fallback03 = false;
    if (existsSync(path.join(RAW, 'checks.json'))) {
      const saved = JSON.parse(await readFile(path.join(RAW, 'checks.json'), 'utf8'));
      fallback03 = saved['03-not-sure']?.notSure === false;
    } else fallback03 = (checks['03-not-sure'] as { notSure?: boolean } | undefined)?.notSure === false;
    for (const name of Object.keys(CAPTIONS) as ShotName[]) {
      if (ONLY && name !== ONLY) continue;
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
 * icon: gold card, foil lens) on #17151E with a soft gold glow, the name in Spectral SC, a foil line on
 * top. No card art, no logos. Drawn at 2x and scaled down; a 220x140 preview goes to the raw folder.
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
    .word { position: absolute; left: 238px; top: 140px; transform: translateY(-50%); margin: 0; font-family: "Shot Spectral SC", Georgia, serif;
      font-weight: 700; font-size: 46px; line-height: .98; color: ${INK}; letter-spacing: .005em; white-space: nowrap; }
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
    // The plan's one line at 46 px would need this much room from x 238 (440 px is the edge): hence two lines.
    const oneLine = document.getElementById('one-line').getBoundingClientRect().width;
    return { loaded: document.fonts.check('700 46px "Shot Spectral SC"'), left: r.left, right: r.right, top: r.top, bottom: r.bottom, oneLineWidth: oneLine };
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
    for (const key of ONLY_CHECKS[ONLY]) saved[key] = checks[key];
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
