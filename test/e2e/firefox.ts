// End-to-end check of the Firefox build (build.mjs --target firefox --e2e): loads it into Firefox over
// WebDriver BiDi (Puppeteer, webExtension.install), opens the local board of real cards, and scans each
// card through the event page's debug hook, by drag and by click, asserting the popover's card.
// Run: npm run e2e:firefox   (or: npx tsx test/e2e/firefox.ts [options])
//   --headful        a visible window: Firefox offers a WebGPU adapter only there, so the embedder runs on
//                    WebGPU and the detector on WASM (decision D-FF1, "mixed"); headless is WASM only.
//   --idle-ms N      Firefox's event-page idle timeout for this run (extensions.background.idle.timeout;
//                    default 30000, Firefox's own). The keep-alive check needs it over 20 s (KEEP_ALIVE_MS).
//   --skip-idle      leave out the idle checks (about 80 s at the default timeout).
//   --soak N         also a self-updating-index run of N artworks (the board's images, the real rate and
//                    chunks), started and left alone, as an alarm starts one: is it cut off when Firefox
//                    suspends the event page? Run it with a short --idle-ms (5000) to know in a minute.
//   --private-probe  report what the side panel in a private window sees of the IndexedDB database
//                    duel-lens-private (the API key and the history), against the event page.
//   --no-build       load the existing build instead of building it first.
// DUEL_LENS_E2E_DIST=<dir>: build into (and load) that folder instead of dist-firefox-e2e/.
// FIREFOX_BIN=<path>: the Firefox to run (default: /Applications/Firefox.app on macOS, else firefox on PATH).
//
// What it checks (exit 1 when any fails):
// - the board: 8 cards (the video's included) by drag, then by click on the detector's outline: each
//   popover names the card (confident or not is reported);
// - security review H1: the hostile board page reaches nothing in the overlay's closed shadow root;
// - S on a popover ("Keep in side panel"): Firefox's sidebar refuses a content script's message (no user
//   input), so the panel opens as a popup window on sidepanel.html (src/background/panel.ts);
// - idle and reload: after the idle timeout with scan mode closed, the event page was suspended (a new
//   bootedAt), and the next scan still reads its card (a cold engine reload);
// - the keep-alive (decision D-FF3): with scan mode open and no input for longer than the timeout, the
//   event page is NOT suspended (the same bootedAt), and the click then reads its card;
// - latency: shortcut → outlines and pointer up → answer (medians without the first scan), and the
//   engine's own times, in test/e2e/out/firefox-report.json.
// What BiDi can't reach (the shortcut, the toolbar button, moz-extension:// pages, the keyboard focus
// inside the closed shadow root) is the manual list in docs/DEVELOPMENT.md, "Firefox".
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer';

const root = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const headful = argv.includes('--headful');
const idleMs = Number(opt('--idle-ms') ?? 30_000);
const skipIdle = argv.includes('--skip-idle');
const soak = Number(opt('--soak') ?? 0);
const dist = process.env.DUEL_LENS_E2E_DIST ? path.resolve(root, process.env.DUEL_LENS_E2E_DIST) : path.join(root, 'dist-firefox-e2e');
const outDir = path.join(root, 'test/e2e/out');
mkdirSync(outDir, { recursive: true });
/** The add-on's id (build.mjs FIREFOX_ID) and a fixed moz-extension UUID for it in this profile. */
const ID = 'duel-lens@mathulbrich.github.io';
const UUID = '0d1e2f30-1111-4222-8333-444455556666';
/** The keep-alive's interval (src/shared/keep-alive.ts KEEP_ALIVE_MS). */
const KEEP_ALIVE_MS = 20_000;
const CARDS = ['dm', 'link', 'pend', 'imp-tilt', 'ash-upside', 'pog-small', 'xyz-def', 'vid'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (v: number[]) => (v.length ? [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] : NaN);

function firefoxBin(): string | undefined {
  if (process.env.FIREFOX_BIN) return process.env.FIREFOX_BIN;
  const mac = '/Applications/Firefox.app/Contents/MacOS/firefox';
  if (process.platform === 'darwin' && existsSync(mac)) return mac;
  try {
    return execFileSync('which', ['firefox'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The board (page.html), its card images, and /art/<k>: one of them, for the --soak index run. */
function serve(): Promise<http.Server> {
  const art = ['46986414', '14558127', '55144522', '86066372', '16178681', '10045474', '84013237', '89631139'];
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const file =
      url === '/'
        ? path.join(root, 'test/e2e/page.html')
        : url.startsWith('/cards/')
          ? path.join(root, 'test/fixtures', path.normalize(url))
          : url.startsWith('/art/')
            ? path.join(root, 'test/fixtures/cards', `${art[Number(url.slice(5)) % art.length]}.jpg`)
            : '';
    if (!file || !file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

type HostState = { state: string | null; card: string | null; confident: string | null; cards: string | null } | null;

/** The popover's state, from the host's E2E attributes (src/content/host.ts mirrorState; E2E builds only). */
async function state(page: Page): Promise<HostState> {
  return (await page.evaluate(
    `(() => { const h = document.getElementById('duel-lens-host'); return h ? { state: h.getAttribute('data-duel-lens-state'), card: h.getAttribute('data-duel-lens-card'), confident: h.getAttribute('data-duel-lens-confident'), cards: h.getAttribute('data-duel-lens-cards') } : null; })()`,
  )) as HostState;
}

async function waitFor(page: Page, pred: (s: HostState) => boolean, ms: number, what: string): Promise<HostState> {
  const t0 = Date.now();
  for (;;) {
    const s = await state(page);
    if (pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what} (last ${JSON.stringify(s)})`);
    await sleep(50);
  }
}

async function closeAll(page: Page) {
  for (let i = 0; i < 3 && (await state(page)); i++) {
    await page.keyboard.press('Escape');
    await sleep(250);
  }
}

const report: Record<string, unknown> = { headful, idleMs };
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

if (!argv.includes('--no-build')) {
  execFileSync('node', ['build.mjs', '--target', 'firefox', '--e2e', '--out', dist], { cwd: root, stdio: 'inherit' });
}
const executablePath = firefoxBin();
if (!executablePath) {
  console.error('No Firefox found: install it, or set FIREFOX_BIN to its executable.');
  process.exit(1);
}
const server = await serve();
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath,
  headless: !headful,
  defaultViewport: { width: 1500, height: 1000 },
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [ID]: UUID }),
    'extensions.background.idle.timeout': idleMs,
  },
});
report.firefox = await browser.version();
console.log(`${report.firefox}, ${headful ? 'headful' : 'headless'}, idle timeout ${idleMs} ms`);
try {
  await browser.installExtension(dist);
  await sleep(1500);
  const page = await browser.newPage();
  await page.goto(`${origin}/`, { waitUntil: 'load' });
  await sleep(500);

  /** duelLensDebug[fn](...args) in the event page, through the board's bridge (src/background/e2e-bridge.ts). */
  const call = async (fn: string, ...args: unknown[]): Promise<unknown> => {
    const r = (await page.evaluate(
      `new Promise((res, rej) => { const id = Math.random(); const on = (e) => { if (e.data && e.data.duelLensE2e === 'reply' && e.data.id === id) { removeEventListener('message', on); e.data.error ? rej(new Error(e.data.error)) : res(e.data.value); } }; addEventListener('message', on); postMessage({ duelLensE2e: 'call', id, fn: ${JSON.stringify(fn)}, args: ${JSON.stringify(args)} }, '*'); setTimeout(() => rej(new Error('no answer from the bridge to ${fn}')), 120000); })`,
    )) as { ok: boolean; value?: unknown; error?: string } | undefined;
    if (!r?.ok) throw new Error(`${fn}: ${r?.error ?? 'no answer'}`);
    return r.value;
  };
  const box = async (id: string) => {
    const b = (await page.evaluate(
      `(() => { const el = document.getElementById(${JSON.stringify(id)}); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, expect: el.dataset.expect }; })()`,
    )) as { x: number; y: number; w: number; h: number; expect: string };
    // The video: only the card in the middle of its frame (as run.ts boxes it).
    return id === 'vid' ? { ...b, x: b.x + b.w / 2 - 62, y: b.y + b.h / 2 - 86, w: 124, h: 172 } : b;
  };

  report.environment = await call('environment');
  console.log('event page:', JSON.stringify(report.environment));
  const tw = Date.now();
  await call('warmup');
  report.warmupMs = Date.now() - tw;
  await call('grantConsent');

  /** One scan of `id`: the shortcut (the hook), the outlines, then a drag around it or a click on it. */
  const scan = async (id: string, mode: 'drag' | 'click', opts: { idleInScanModeMs?: number } = {}) => {
    const b = await box(id);
    await page.bringToFront();
    await page.evaluate(`document.getElementById('page-focus').focus()`);
    const t0 = Date.now();
    await call('startScan');
    await waitFor(page, (s) => s?.state === 'selecting', 30_000, 'scan mode');
    const outlines = await waitFor(page, (s) => s?.cards != null, 30_000, 'the outlines').then(
      (s) => ({ n: Number(s!.cards), ms: Date.now() - t0 }),
      (e: Error) => ({ n: -1, ms: Date.now() - t0, error: e.message }),
    );
    if (opts.idleInScanModeMs) await sleep(opts.idleInScanModeMs);
    if (mode === 'drag') {
      await page.mouse.move(b.x - 6, b.y - 6);
      await page.mouse.down();
      await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, { steps: 5 });
      await page.mouse.move(b.x + b.w + 6, b.y + b.h + 6, { steps: 5 });
      await page.mouse.up();
    } else {
      await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
    }
    const tUp = Date.now();
    const s = await waitFor(page, (x) => x?.state === 'result' || x?.state === 'error', 60_000, 'the answer').catch((e: Error) => ({
      state: `timeout: ${e.message}`,
      card: null,
      confident: null,
      cards: null,
    }));
    const upToAnswerMs = Date.now() - tUp;
    const pageClockMs = (await page.evaluate('window.scanClock && window.scanClock.done && window.scanClock.up ? Math.round(window.scanClock.done - window.scanClock.up) : null')) as number | null;
    const r = { id, mode, expect: b.expect, got: s?.card ?? s?.state, ok: s?.card === b.expect, confident: s?.confident === 'true', outlines, upToAnswerMs, pageClockMs };
    console.log(JSON.stringify(r));
    return r;
  };

  // 1. The board, by drag and by click.
  const scans: Awaited<ReturnType<typeof scan>>[] = [];
  for (const mode of ['drag', 'click'] as const) {
    for (const id of CARDS) {
      scans.push(await scan(id, mode));
      if (mode === 'drag' && id === 'dm') await page.screenshot({ path: path.join(outDir, 'firefox-popover.png') });
      await closeAll(page);
    }
    const mine = scans.filter((r) => r.mode === mode);
    check(mine.every((r) => r.ok), `board by ${mode}: ${mine.filter((r) => r.ok).length}/${mine.length} right (${mine.filter((r) => r.confident).length} confident)`);
  }
  report.scans = scans;
  const later = scans.slice(1);
  report.latency = {
    shortcutToOutlinesMs: median(later.map((r) => r.outlines.ms)),
    clickUpToAnswerMs: median(later.filter((r) => r.mode === 'click').map((r) => r.upToAnswerMs)),
    clickPageClockMs: median(later.filter((r) => r.mode === 'click' && r.pageClockMs != null).map((r) => r.pageClockMs!)),
    dragUpToAnswerMs: median(later.filter((r) => r.mode === 'drag').map((r) => r.upToAnswerMs)),
  };
  const engineLog = (await call('engineLog')) as { type: string; wallMs: number; timings?: Record<string, number>; detectMs?: number }[];
  const rec = engineLog.filter((e) => e.type === 'recognize' && e.timings).slice(1);
  report.engine = {
    recognizeWallMs: median(rec.map((e) => e.wallMs)),
    timings: rec.length ? Object.fromEntries(Object.keys(rec[0].timings!).map((k) => [k, median(rec.map((e) => e.timings![k]).filter((v) => typeof v === 'number'))])) : null,
    screenshotDetectMs: median(engineLog.filter((e) => e.type === 'detect-cards' && typeof e.detectMs === 'number').slice(1).map((e) => e.detectMs!)),
  };
  console.log('latency:', JSON.stringify(report.latency), 'engine:', JSON.stringify(report.engine));

  // 2. Security review H1: the hostile page reaches nothing in the closed shadow root.
  const h1 = (await page.evaluate(
    'JSON.stringify(window.h1Probe ? { internals: window.h1Probe.internals.length, leaked: window.h1Probe.internals.filter((i) => { try { return !!i.shadowRoot; } catch { return false; } }).length } : null)',
  )) as string;
  report.h1 = JSON.parse(h1);
  check((report.h1 as { leaked: number } | null)?.leaked === 0, `H1: the page reached ${(report.h1 as { leaked: number } | null)?.leaked ?? '?'} closed shadow roots`);

  // 3. S on a popover: no user input reaches the event page, so the popup window opens instead of the sidebar.
  {
    await scan('dm', 'click');
    await sleep(300);
    await page.keyboard.press('s');
    let contexts: string[] = [];
    for (let i = 0; i < 30 && !contexts.some((c) => c.includes('sidepanel.html')); i++) {
      await sleep(200);
      contexts = (await call('panelContexts')) as string[];
    }
    report.sKey = { sidebarOpen: await call('sidebarIsOpen'), contexts };
    check(contexts.some((c) => /^TAB .*sidepanel\.html\?tabId=\d+/.test(c)), 'S opens the side panel page in a popup window (Firefox refuses the sidebar without user input)');
    await page.bringToFront();
    await closeAll(page);
  }

  // 4. Idle: scan mode closed, the event page is suspended, and the next scan reloads the engine.
  if (!skipIdle) {
    const before = await call('bootedAt');
    console.log(`idle ${Math.round((idleMs + 8000) / 1000)} s with scan mode closed…`);
    await sleep(idleMs + 8000);
    const r = await scan('dm', 'click');
    const after = await call('bootedAt');
    report.idleReload = { suspended: after !== before, ...r };
    check(after !== before, 'idle: Firefox suspended the event page once scan mode was closed');
    check(r.ok, `idle: the next scan reloaded the engine and read ${r.got} (${r.upToAnswerMs} ms from the click)`);
    await closeAll(page);

    // 5. The keep-alive: scan mode open and left alone for longer than the timeout.
    if (idleMs > KEEP_ALIVE_MS) {
      const booted = await call('bootedAt');
      console.log(`idle ${Math.round((idleMs + 15000) / 1000)} s with scan mode open…`);
      const k = await scan('pend', 'click', { idleInScanModeMs: idleMs + 15_000 });
      const still = await call('bootedAt');
      report.keepAlive = { suspended: still !== booted, ...k };
      check(still === booted, 'keep-alive: the event page stayed up while scan mode was open');
      check(k.ok, `keep-alive: the click read ${k.got} (${k.upToAnswerMs} ms)`);
      await closeAll(page);
    } else {
      console.log(`keep-alive check skipped: --idle-ms ${idleMs} is not over the keep-alive's ${KEEP_ALIVE_MS} ms`);
    }
  }

  // --private-probe (SECURE-STORE's question): what an extension page in a private window sees of duel-lens-private.
  if (argv.includes('--private-probe')) {
    report.privateWindow = await call('privateWindowProbe');
    console.log('private window:', JSON.stringify(report.privateWindow));
  }

  // 6. --soak N: a long self-updating-index run, left alone (last: it adds the board's images to the local index).
  if (soak > 0) {
    const booted = await call('bootedAt');
    await call('soakIndexUpdate', soak, `${origin}/art/`);
    const t0 = Date.now();
    const limit = Math.max(120_000, soak * 2_000);
    type Progress = { state?: string; bootedAt?: number; fetched?: number; at?: number } | null;
    let progress = null as Progress;
    // Poll sparsely: each poll is an event that restarts Firefox's idle timer, so wait three timeouts between them.
    while (Date.now() - t0 < limit) {
      await sleep(Math.max(idleMs * 3, idleMs + 5000));
      progress = (await call('soakProgress')) as Progress;
      console.log('soak:', JSON.stringify(progress), `(${Math.round((Date.now() - t0) / 1000)} s)`);
      if (progress?.state === 'done' || progress?.state === 'failed') break;
      if (progress && progress.bootedAt !== booted) break; // the page that ran it is gone
      if (progress?.at && Date.now() - progress.at > idleMs * 3 + 15_000) break; // no progress for long: cut off
    }
    const now = await call('bootedAt');
    report.soak = { artworks: soak, progress, restarted: now !== booted, seconds: Math.round((Date.now() - t0) / 1000) };
    check(progress?.state === 'done' && progress.bootedAt === booted, `index run of ${soak} artworks finished in the same event page (${JSON.stringify(progress)})`);
  }
} catch (e) {
  failures.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
  console.error(e);
} finally {
  report.failures = failures;
  writeFileSync(path.join(outDir, 'firefox-report.json'), JSON.stringify(report, null, 2));
  await browser.close();
  server.close();
}
console.log(failures.length ? `\nFirefox E2E FAILED (${failures.length}):\n- ${failures.join('\n- ')}` : '\nFirefox E2E passed');
process.exitCode = failures.length ? 1 : 0;
