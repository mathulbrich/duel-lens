// Duel Lens "Live" on real YouTube footage (docs/superpowers/plans/2026-10-30-live-real-test.md): loads the E2E build
// into Chrome, the Opera build (in Chromium) or Firefox, opens one test URL, starts Live on that tab through the
// debug hook and records what it does: the log, a crop of the page at each new listing, the outlines every 2 s, a
// screenshot every 30 s, the step costs, long tasks and statuses. Ends with a contact sheet (crop | official picture
// | name | first video time | appearances) rendered to sheet.png by the same browser.
//
// Run: npm run e2e:live-real -- --url 'https://www.youtube.com/watch?v=gYmgyzpjitM&t=4748' --minutes 6 --name r1
//   --browser chrome|opera|firefox   (default chrome; opera = Opera's build loaded in Chromium)
//   --url <watch url with t=>        (required; only the two test pages of the plan)
//   --minutes N                      recording time after Live starts (default 6)
//   --effort balanced|light          Live's effort (default balanced)
//   --script                         scripted events at +2:00 pause 10 s, +3:00 seek back 30 s, +4:00 switch effort
//   --name <id>                      the run's folder name (default: browser-effort-<time>)
//   --headful (default) | --headless a visible window (headless YouTube playback is less reliable; the container
//                                    has no display, so low-end/run.sh passes --headless)
//   --no-build                       load the existing build
//   --out <dir>                      write there instead of test/e2e/out/live-real/<name>/
// Environment: DUEL_LENS_E2E_DIST (build folder), FIREFOX_BIN, DUEL_LENS_E2E_CHROME / _NO_GPU (low-end.ts).
// YouTube rules for this tool: a consent page gets "Reject all" and nothing else; a bot check, sign-in wall or captcha
// STOPS the run (status 'bot-check', a screenshot, exit code 3); it is never worked around. Nothing is clicked while an
// ad plays; the ad periods are marked in the report.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type Browser, type Page, type WebWorker } from 'puppeteer';
import { grantConsent, langArgs, quantile, settleInstall } from './harness';
import { lowEnd, lowEndLaunch } from './low-end';

const root = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(name);

const browserName = (opt('--browser') ?? 'chrome') as 'chrome' | 'opera' | 'firefox';
if (!['chrome', 'opera', 'firefox'].includes(browserName)) throw new Error(`--browser: chrome, opera or firefox, not ${browserName}`);
const url = opt('--url');
if (!url) throw new Error('--url <youtube url with t=> is required');
const ALLOWED = new Set(['gYmgyzpjitM']);
{
  const u = new URL(url);
  if (!/(^|\.)youtube\.com$/.test(u.hostname) || u.pathname !== '/watch' || !ALLOWED.has(u.searchParams.get('v') ?? '')) {
    throw new Error('--url: only the test pages of docs/superpowers/plans/2026-10-30-live-real-test.md (youtube.com/watch?v=gYmgyzpjitM)');
  }
}
const minutes = Number(opt('--minutes') ?? 6);
const effort0 = (opt('--effort') ?? 'balanced') as 'balanced' | 'light';
if (effort0 !== 'balanced' && effort0 !== 'light') throw new Error('--effort: balanced or light');
if (!(minutes > 0)) throw new Error('--minutes must be positive');
const scripted = flag('--script');
const headful = !flag('--headless');
const name = opt('--name') ?? `${browserName}-${effort0}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const outDir = path.resolve(root, opt('--out') ?? path.join('test/e2e/out/live-real', name));
const target = browserName === 'firefox' ? ['--target', 'firefox'] : browserName === 'opera' ? ['--target', 'opera'] : [];
const dist = process.env.DUEL_LENS_E2E_DIST
  ? path.resolve(root, process.env.DUEL_LENS_E2E_DIST)
  : path.join(root, browserName === 'firefox' ? 'dist-firefox-e2e' : browserName === 'opera' ? 'dist-opera-e2e' : 'dist-e2e');
const FIREFOX_ID = 'duel-lens@mathulbrich.github.io';
const FIREFOX_UUID = '0d1e2f30-1111-4222-8333-444455556666';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const mkdir = (p: string) => mkdirSync(p, { recursive: true });
const cropsDir = path.join(outDir, 'crops');
const shotsDir = path.join(outDir, 'shots');

type Rect = { x: number; y: number; w: number; h: number };
type Outline = { state: 'reading' | 'promoted'; rect: Rect; name?: string };
interface LogEntry {
  cardId: number;
  imageId: number;
  firstVideoTime: number;
  lastVideoTime: number;
  appearances: number;
}
interface Log {
  status: string;
  stopReason?: string;
  intervalMs?: number;
  voting?: number;
  entries: LogEntry[];
}
interface PageState {
  t: number;
  w: number;
  h: number;
  paused: boolean;
  ad: boolean;
  ready: number;
  src: string;
  sx: number;
  sy: number;
  rect: Rect | null;
  quality: string | null;
  /** YouTube's player error screen ("Something went wrong") is showing. */
  err: boolean;
}

/** A tiny server on 127.0.0.1: a blank page (Firefox's bridge content script runs on 127.0.0.1) and the run's folder (the sheet). */
function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (u === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Duel Lens live-real bridge</title><body>bridge</body>');
    const file = path.join(outDir, path.normalize(u));
    if (!file.startsWith(outDir) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

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

const report: Record<string, any> = {
  name,
  browser: browserName,
  url,
  effortStart: effort0,
  minutes,
  scripted,
  headful,
  status: 'error',
  consent: { seen: false, clicked: false },
  ads: [] as { fromS: number; toS: number | null }[],
  quality: [] as { s: number; w: number; h: number; ad: boolean }[],
  srcChanges: 0,
  entries: [] as any[],
  events: [] as any[],
  outlines: [] as { s: number; outlines: Outline[] }[],
  shots: [] as { s: number; file: string }[],
  trace: [] as any[],
  statusesSeen: [] as string[],
  errors: [] as string[],
};

mkdir(outDir);
mkdir(cropsDir);
mkdir(shotsDir);
const writeReport = () => writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

if (!flag('--no-build')) {
  execFileSync('node', ['build.mjs', '--e2e', ...target, '--out', dist], { cwd: root, stdio: 'inherit' });
}
const server = await serve();
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let browser: Browser | undefined;
let exit = 0;
try {
  // ---------- launch with the extension, a fresh profile ----------
  let call: (fn: string, ...args: unknown[]) => Promise<unknown>;
  let page: Page;
  const viewport = { width: 1600, height: 1000 };
  if (browserName === 'firefox') {
    const executablePath = firefoxBin();
    if (!executablePath) throw new Error('No Firefox found: install it, or set FIREFOX_BIN to its executable.');
    browser = await puppeteer.launch({
      browser: 'firefox',
      executablePath,
      headless: !headful,
      defaultViewport: viewport,
      extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ [FIREFOX_ID]: FIREFOX_UUID }) },
    });
    await browser.installExtension(dist);
    await sleep(1500);
    // The bridge tab (a local page the E2E build's content script listens on) stays open; YouTube gets its own tab.
    const bridge = await browser.newPage();
    await bridge.goto(origin, { waitUntil: 'load' });
    await sleep(500);
    call = async (fn, ...args) => {
      const r = (await bridge.evaluate(
        `new Promise((res, rej) => { const id = Math.random(); const on = (e) => { if (e.data && e.data.duelLensE2e === 'reply' && e.data.id === id) { removeEventListener('message', on); e.data.error ? rej(new Error(e.data.error)) : res(e.data.value); } }; addEventListener('message', on); postMessage({ duelLensE2e: 'call', id, fn: ${JSON.stringify(fn)}, args: ${JSON.stringify(args)} }, '*'); setTimeout(() => rej(new Error('no answer from the bridge to ${fn}')), 120000); })`,
      )) as { ok: boolean; value?: unknown; error?: string } | undefined;
      if (!r?.ok) throw new Error(`${fn}: ${r?.error ?? 'no answer'}`);
      return r.value;
    };
    await call('grantConsent');
    page = await browser.newPage();
  } else {
    const launch = lowEndLaunch(lowEnd());
    browser = await puppeteer.launch({
      headless: !headful,
      pipe: true,
      enableExtensions: [dist],
      defaultViewport: viewport,
      ...(launch.executablePath ? { executablePath: launch.executablePath } : {}),
      args: ['--window-size=1600,1100', '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--mute-audio', ...langArgs(), ...launch.args],
    });
    page = await browser.newPage();
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 30000 });
    const worker = (await sw.worker()) as WebWorker;
    await settleInstall(browser, page);
    await grantConsent(worker);
    call = (fn, ...args) => worker.evaluate((f, a) => (globalThis as any).duelLensDebug[f](...a), fn, args);
  }
  report.browserVersion = await browser.version();
  console.log(`${browserName} ${report.browserVersion}, ${headful ? 'headful' : 'headless'}, effort ${effort0}, ${minutes} min -> ${outDir}`);

  // ---------- the page ----------
  // Long tasks of the page (YouTube's own scripts included), from the document's first moment.
  await page.evaluateOnNewDocument(`window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}`);
  const ev = async <T>(expr: string, fallback: T): Promise<T> => {
    try {
      return (await page.evaluate(expr)) as T;
    } catch {
      return fallback; // a navigation destroyed the context
    }
  };
  const shot = async (file: string, clip?: Rect): Promise<boolean> => {
    try {
      await page.screenshot({ path: file as `${string}.png`, ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } } : {}) });
      return true;
    } catch (e) {
      report.errors.push(`screenshot ${path.basename(file)}: ${e instanceof Error ? e.message : e}`);
      return false;
    }
  };
  const BOT = `(() => { const t = document.body ? document.body.innerText : ''; return /confirm you.{0,3}re not a bot|unusual traffic from your computer|verify you are not a robot/i.test(t) || location.pathname.startsWith('/sorry') || !!document.querySelector('iframe[src*="recaptcha"], #captcha-form'); })()`;
  const botCheck = async (): Promise<boolean> => ev<boolean>(BOT, false);
  const stopForBot = async (where: string): Promise<never> => {
    await shot(path.join(outDir, 'bot-check.png'));
    report.status = 'bot-check';
    report.botCheckAt = where;
    report.botCheckUrl = page.url();
    console.error(`BOT CHECK (${where}): stopped, screenshot in bot-check.png. Not worked around.`);
    exit = 3;
    throw new Error('bot-check');
  };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.bringToFront();
  await sleep(2500);
  // The consent page ("Before you continue"): its most private choice, nothing else.
  for (let i = 0; i < 3; i++) {
    const onConsent = await ev<boolean>(`location.hostname.startsWith('consent.') || /Before you continue/i.test(document.body ? document.body.innerText : '')`, false);
    if (!onConsent) break;
    report.consent.seen = true;
    await shot(path.join(outDir, 'consent.png'));
    const clicked = await ev<boolean>(
      `(() => { const els = [...document.querySelectorAll('button, [role=button], ytd-button-renderer, form button')]; const b = els.find((e) => /^\\s*reject all\\s*$/i.test(e.innerText || e.textContent || '') || /reject all/i.test(e.getAttribute('aria-label') || '')); if (!b) return false; (b.querySelector('button') || b).click(); return true; })()`,
      false,
    );
    report.consent.clicked ||= clicked;
    if (!clicked) {
      report.errors.push('consent page without a "Reject all" button');
      break;
    }
    await sleep(4000);
  }
  if (await botCheck()) await stopForBot('after load');

  // Wait until the video plays (muted); mark ads, never click on them.
  const state = (): Promise<PageState | null> =>
    ev<PageState | null>(
      `(() => { const v = document.querySelector('video.html5-main-video') || document.querySelector('video'); if (!v) return null; const p = document.getElementById('movie_player'); const r = v.getBoundingClientRect(); let q = null; try { q = p && p.getPlaybackQuality ? p.getPlaybackQuality() : null; } catch (e) {} return { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, paused: v.paused, ad: !!(p && p.classList.contains('ad-showing')), ready: v.readyState, src: (v.currentSrc || '').slice(-40), sx: window.scrollX, sy: window.scrollY, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, quality: q, err: !!(p && p.querySelector('.ytp-error:not([style*="display: none"])')) }; })()`,
      null,
    );
  const prep = `(() => { const v = document.querySelector('video.html5-main-video') || document.querySelector('video'); if (v) { v.muted = true; if (v.paused) v.play().catch(() => {}); } })()`;
  const wantQuality = `(() => { const p = document.getElementById('movie_player'); try { if (p && p.setPlaybackQualityRange) p.setPlaybackQualityRange('hd1080'); if (p && p.setPlaybackQuality) p.setPlaybackQuality('hd1080'); } catch (e) {} })()`;
  let playing = false;
  for (let i = 0; i < 90 && !playing; i++) {
    await ev(prep, null);
    const s = await state();
    playing = !!s && !s.paused && s.ready >= 3 && s.t > 0;
    if (!playing) {
      if (i % 5 === 4 && (await botCheck())) await stopForBot('waiting for playback');
      await sleep(1000);
    }
  }
  if (!playing) {
    await shot(path.join(outDir, 'not-playing.png'));
    if (await botCheck()) await stopForBot('video would not play');
    throw new Error('the video never played (not-playing.png)');
  }
  await ev(wantQuality, null);
  // Give the quality a few seconds to come up (not during an ad: nothing is touched then).
  for (let i = 0; i < 15; i++) {
    const s = await state();
    if (s && !s.ad && s.h >= 1080) break;
    await sleep(1000);
    if (s && !s.ad && i % 4 === 3) await ev(wantQuality, null);
  }

  // ---------- start Live ----------
  const tabId = (await call('tabIdByUrl', 'youtube.com/watch')) as number | null;
  if (tabId === null) throw new Error('the debug hook found no YouTube tab');
  await call('setLiveEffort', effort0);
  await page.bringToFront();
  await ev(prep, null);
  const t0 = Date.now();
  report.startedAt = new Date(t0).toISOString();
  await call('toggleLive', tabId);
  const T = () => (Date.now() - t0) / 1000;
  const readLog = async (): Promise<Log | null> => {
    try {
      return (await call('liveLog')) as Log | null;
    } catch (e) {
      report.errors.push(`liveLog: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };
  const readOutlines = async (): Promise<Outline[]> => {
    try {
      return ((await call('liveOutlines')) as Outline[] | null) ?? [];
    } catch {
      return [];
    }
  };
  const nameOf = async (ids: number[]): Promise<Record<number, string>> => {
    try {
      return (await call('cardNames', ids)) as Record<number, string>;
    } catch {
      return {};
    }
  };

  // ---------- the recording loop ----------
  const known = new Set<number>();
  const intervals: number[] = [];
  const statuses = new Set<string>();
  const cropOf: Record<number, string> = {};
  let adStart: number | null = null;
  let lastSrc = '';
  let nextOutlines = 0;
  let nextShot = 0;
  let nextQuality = 10;
  let effort = effort0;
  let firstWatchingS: number | null = null;
  let lastBotCheck = 0;
  const pendingAfter: { ev: any; due: number }[] = [];
  const events = [
    { at: 120, name: 'pause', fn: () => ev('document.querySelector("video.html5-main-video").pause()', null) },
    { at: 130, name: 'play', fn: () => ev('document.querySelector("video.html5-main-video").play()', null) },
    {
      at: 180,
      name: 'seek-back-30',
      fn: () => ev('(() => { const v = document.querySelector("video.html5-main-video"); v.currentTime = Math.max(0, v.currentTime - 30); })()', null),
    },
    {
      at: 240,
      name: 'switch-effort',
      fn: async () => {
        effort = effort === 'balanced' ? 'light' : 'balanced';
        await call('setLiveEffort', effort);
      },
    },
  ].map((e) => ({ ...e, done: false }));
  let last: Log | null = null;
  const end = minutes * 60;

  while (T() < end) {
    const s = T();
    const ps = await state();
    last = (await readLog()) ?? last;
    if (last) {
      statuses.add(last.status);
      if (last.intervalMs !== undefined) intervals.push(last.intervalMs);
      if (firstWatchingS === null && ['watching', 'slow'].includes(last.status)) firstWatchingS = round(s);
    }
    // ads and quality
    if (ps) {
      if (ps.ad && adStart === null) {
        adStart = s;
        report.ads.push({ fromS: round(s), toS: null });
      } else if (!ps.ad && adStart !== null) {
        report.ads[report.ads.length - 1].toS = round(s);
        adStart = null;
      }
      if (lastSrc && ps.src && ps.src !== lastSrc) report.srcChanges++;
      if (ps.src) lastSrc = ps.src;
      if (s >= nextQuality) {
        nextQuality = s + 10;
        report.quality.push({ s: round(s), w: ps.w, h: ps.h, ad: ps.ad });
        if (!ps.ad && ps.h < 1080) await ev(wantQuality, null);
      }
    }
    report.trace.push({ s: round(s), status: last?.status ?? null, intervalMs: last?.intervalMs ?? null, voting: last?.voting ?? 0, listed: last?.entries.length ?? 0, videoTime: ps ? round(ps.t) : null, paused: ps?.paused ?? null, ad: ps?.ad ?? null, size: ps ? `${ps.w}x${ps.h}` : null, playerError: ps?.err ?? null });
    if (ps?.err && report.playerErrorFromS === undefined) {
      report.playerErrorFromS = round(s);
      console.error(`[+${round(s)}s] YouTube's player shows an error screen (see shots/); recording goes on`);
    }

    // outlines every 2 s (and at a new listing)
    const fresh = (last?.entries ?? []).filter((e) => !known.has(e.cardId));
    let outlines: Outline[] | null = null;
    if (s >= nextOutlines || fresh.length) {
      outlines = await readOutlines();
      if (s >= nextOutlines) {
        nextOutlines = s + 2;
        report.outlines.push({ s: round(s), outlines });
      }
    }
    // each new entry: a crop of the page at the card's outline
    if (fresh.length) {
      const names = await nameOf(fresh.map((e) => e.cardId));
      for (const e of fresh) {
        known.add(e.cardId);
        const n = report.entries.length + 1;
        const nm = names[e.cardId] ?? null;
        const o = outlines?.find((x) => x.state === 'promoted' && x.name && x.name === nm) ?? null;
        const r = o?.rect ?? ps?.rect ?? null;
        const file = `crops/${n}-${e.cardId}.png`;
        let saved = false;
        if (r && r.w > 1 && r.h > 1) {
          const pad = o ? 3 : 0;
          const clip = { x: Math.max(0, r.x - pad + (ps?.sx ?? 0)), y: Math.max(0, r.y - pad + (ps?.sy ?? 0)), w: r.w + 2 * pad, h: r.h + 2 * pad };
          saved = await shot(path.join(outDir, file), clip);
          if (saved) cropOf[e.cardId] = file;
        }
        report.entries.push({ n, cardId: e.cardId, imageId: e.imageId, name: nm, listedAtS: round(s), firstVideoTime: e.firstVideoTime, videoTimeNow: ps ? round(ps.t) : null, adShowing: ps?.ad ?? null, cropSource: saved ? (o ? 'outline' : 'video') : 'none', cropFile: saved ? file : null, outlineRect: o?.rect ?? null });
        console.log(`[+${round(s)}s] listed #${n} ${nm ?? e.cardId} (video ${round(e.firstVideoTime)} s)${ps?.ad ? ' DURING AN AD' : ''}`);
      }
    }
    // a full screenshot every 30 s
    if (s >= nextShot) {
      nextShot = s + 30;
      const f = `shots/${String(Math.round(s)).padStart(4, '0')}.png`;
      if (await shot(path.join(outDir, f))) report.shots.push({ s: round(s), file: f });
    }
    // scripted events
    if (scripted) {
      for (const e of events) {
        if (e.done || s < e.at) continue;
        e.done = true;
        const rec: any = { name: e.name, atS: round(s), videoTime: ps ? round(ps.t) : null, ad: ps?.ad ?? null, before: { status: last?.status ?? null, intervalMs: last?.intervalMs ?? null, listed: last?.entries.length ?? 0 } };
        if (ps?.ad && e.name !== 'play') rec.note = 'an ad was showing; the event was still run';
        try {
          await e.fn();
        } catch (err) {
          rec.error = String(err);
        }
        if (e.name === 'switch-effort') rec.effortNow = effort;
        report.events.push(rec);
        pendingAfter.push({ ev: rec, due: s + 2.5 });
      }
      for (const p of [...pendingAfter]) {
        if (s < p.due) continue;
        pendingAfter.splice(pendingAfter.indexOf(p), 1);
        const cur = last;
        p.ev.after = { status: cur?.status ?? null, intervalMs: cur?.intervalMs ?? null, listed: cur?.entries.length ?? 0, videoTime: (await state())?.t ?? null };
      }
    }
    if (s - lastBotCheck >= 10) {
      lastBotCheck = s;
      if (await botCheck()) await stopForBot(`at +${round(s)} s`);
    }
    const spent = T() - s;
    await sleep(Math.max(50, 1000 - spent * 1000));
  }

  // ---------- the end ----------
  last = (await readLog()) ?? last;
  const stats = (await call('liveStats').catch(() => null)) as { thumbMs: number[]; encodeMs: number[]; cropMs: number[] } | null;
  const lt = await ev<number[]>('window.__lt || []', []);
  const stepStats = (v: number[] | undefined) => (v?.length ? { n: v.length, p50: round(quantile(v, 0.5)), p95: round(quantile(v, 0.95)), max: round(Math.max(...v)) } : null);
  report.liveStartToWatchingS = firstWatchingS;
  report.statusesSeen = [...statuses];
  report.intervalMs = { samples: intervals.length, median: intervals.length ? quantile(intervals, 0.5) : null, p95: intervals.length ? quantile(intervals, 0.95) : null, max: intervals.length ? Math.max(...intervals) : null };
  report.steps = stats && { thumbMs: stepStats(stats.thumbMs), encodeMs: stepStats(stats.encodeMs), cropMs: stepStats(stats.cropMs) };
  report.longTasks = { count: lt.length, over50ms: lt.filter((d) => d > 50).length, longestMs: lt.length ? round(Math.max(...lt)) : 0, note: 'the whole page, YouTube included' };
  report.finalStatus = last?.status ?? null;
  const ids = (last?.entries ?? []).map((e) => e.cardId);
  report.duplicateCardIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  const finalNames = await nameOf(ids);
  report.finalLog = (last?.entries ?? []).map((e) => ({ ...e, name: finalNames[e.cardId] ?? null }));
  report.entriesDuringAds = report.entries.filter((e: any) => e.adShowing).map((e: any) => e.name);
  const sizes = report.quality as { w: number; h: number }[];
  report.maxVideoSize = sizes.length ? `${Math.max(...sizes.map((q) => q.w))}x${Math.max(...sizes.map((q) => q.h))}` : null;
  await call('toggleLive', tabId).catch((e: unknown) => report.errors.push(`stop: ${e}`));
  await sleep(500);
  report.statusAfterStop = (await readLog())?.status ?? null;

  // ---------- the contact sheet ----------
  const rows = [...(last?.entries ?? [])].sort((a, b) => a.firstVideoTime - b.firstVideoTime);
  const clock = (sec: number) => {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const PER = 40;
  report.sheets = [] as string[];
  const sheetPage = await browser.newPage();
  await sheetPage.setViewport({ width: 900, height: 800 });
  for (let k = 0, sheet = 1; k < Math.max(rows.length, 1); k += PER, sheet++) {
    const chunk = rows.slice(k, k + PER);
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(name)} sheet ${sheet}</title><style>
body{font:14px system-ui,sans-serif;margin:12px;background:#fff;color:#111}h1{font-size:16px;margin:0 0 8px}
table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:4px 8px;vertical-align:middle;text-align:left}
img{display:block;height:140px;width:auto}.c img{max-width:220px;object-fit:contain}.none{color:#a00;width:100px}</style>
<h1>${esc(name)} (${browserName}, ${effort0}), sheet ${sheet}: ${chunk.length} of ${rows.length} listed</h1>
<table><tr><th>#</th><th>Crop (what Live saw)</th><th>Official picture</th><th>Name</th><th>First video time</th><th>Appearances</th></tr>
${chunk
  .map((e, i) => {
    const nm = finalNames[e.cardId] ?? `card ${e.cardId}`;
    const crop = cropOf[e.cardId];
    return `<tr><td>${k + i + 1}</td><td class="c">${crop ? `<img src="/${crop}">` : '<span class="none">no crop</span>'}</td><td><img src="https://images.ygoprodeck.com/images/cards_small/${e.imageId}.jpg"></td><td>${esc(nm)}</td><td>${clock(e.firstVideoTime)}</td><td>${e.appearances}</td></tr>`;
  })
  .join('\n')}</table>`;
    const htmlName = sheet === 1 ? 'sheet.html' : `sheet-${sheet}.html`;
    const pngName = sheet === 1 ? 'sheet.png' : `sheet-${sheet}.png`;
    writeFileSync(path.join(outDir, htmlName), html);
    await sheetPage.goto(`${origin}/${htmlName}`, { waitUntil: 'load' });
    await sheetPage.evaluate(`Promise.all([...document.images].map((i) => i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; setTimeout(r, 15000); })))`);
    await sheetPage.screenshot({ path: path.join(outDir, pngName) as `${string}.png`, fullPage: true });
    report.sheets.push(pngName);
  }
  report.status = 'ok';
} catch (e) {
  if (!(e instanceof Error && e.message === 'bot-check')) {
    report.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
    report.status = report.status === 'bot-check' ? 'bot-check' : 'error';
    console.error(e);
    exit ||= 1;
  }
} finally {
  writeReport();
  await browser?.close().catch(() => {});
  server.close();
}
console.log(`status: ${report.status}; ${report.entries.length} entries; report: ${path.join(outDir, 'report.json')}`);
process.exitCode = exit;
