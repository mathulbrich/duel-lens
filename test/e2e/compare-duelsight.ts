// Duel Lens's Live check against DuelSight on the same synthetic clip (live.html), the pointer resting on each card in
// turn, as a viewer would: how long from the rest until the right name shows, and any wrong name. Both warm up first
// (the pointer rests on the playing video, so each loads its models), then the clip plays (?scale stretches it).
//   npx tsx test/e2e/compare-duelsight.ts --ext ours|duelsight [--scale 2] [--warm 30]
// DuelSight is the user's installed copy, copied to test/e2e/out/duelsight-ext with 127.0.0.1 added to its matches.
// In the low-end Docker profile: test/e2e/low-end/run.sh low compare-ours compare-duelsight
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type Page } from 'puppeteer';
import { lowEnd, lowEndLaunch } from './low-end';
import { grantConsent, langArgs, settleInstall } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const ext = (opt('--ext') ?? 'ours') as 'ours' | 'duelsight';
const scale = Number(opt('--scale') ?? 2);
const warmS = Number(opt('--warm') ?? 30);
/** Seconds the pointer rests on each card of the YouTube hand. */
const restS = Number(opt('--rest') ?? 4);
const dist = ext === 'ours' ? path.join(root, process.env.DUEL_LENS_E2E_DIST ?? 'dist-e2e') : path.join(root, 'test/e2e/out/duelsight-ext');
const youtube = argv.includes('--youtube');
const outFile = path.join(root, `test/e2e/out/compare-${ext}${youtube ? '-youtube' : ''}.json`);
/** The user's video (Amj2Z7EuMaA, from 0:08: five cards in a hand at the bottom, cut by the picture's edge) and where
 *  those cards lie (fractions of the picture, from an earlier Live run's boxes). */
const YT_URL = 'https://www.youtube.com/watch?v=Amj2Z7EuMaA&t=8';
const YT_CARDS = [
  { name: 'Abyss Shark', fx: 0.302 },
  { name: 'Deep Sea Diva', fx: 0.388 },
  { name: 'Superancient Deepsea King Coelacanth', fx: 0.477 },
  { name: 'Deep Sea Minstrel', fx: 0.564 },
  { name: 'Poseidra, the Storming Atlantean', fx: 0.653 },
].map((c) => ({ ...c, fy: 0.91 }));

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const file = url === '/' ? path.join(root, 'test/e2e/live.html') : url.startsWith('/cards/') ? path.join(root, 'test/fixtures', path.normalize(url)) : '';
  if (!file || !file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
const port = (server.address() as AddressInfo).port;

if (ext === 'ours') execFileSync('node', ['build.mjs', '--e2e', '--out', path.relative(root, dist)], { cwd: root, stdio: 'inherit' });
const launch = lowEndLaunch(lowEnd());
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [dist],
  defaultViewport: { width: 1500, height: 1000 },
  ...(launch.executablePath ? { executablePath: launch.executablePath } : {}),
  args: ['--window-size=1500,1000', '--no-first-run', '--autoplay-policy=no-user-gesture-required', ...langArgs(), ...launch.args],
});

/** The clip's cards (live.html), where they lie (video px of 1280 x 720) and when the pointer rests on each (clip s). */
const CARDS = [
  { name: 'Dark Magician', x: 330, y: 380, from: 5.5, to: 13.75 },
  { name: 'Accesscode Talker', x: 880, y: 380, from: 13.25, to: 17.75 }, // the hand hovers over it until 13 s
  { name: 'Odd-Eyes Pendulum Dragon', x: 1100, y: 380, from: 18, to: 21.75 },
];

/** The name a viewer sees now over the video: our card box or preview, or DuelSight's tooltip. */
async function shownName(page: Page, call: (fn: string) => Promise<unknown>): Promise<string | null> {
  if (ext === 'ours') {
    const outlines = ((await call('liveOutlines')) as { state: string; name?: string }[] | null) ?? [];
    return outlines.find((o) => o.state === 'promoted')?.name ?? null;
  }
  for (const f of page.frames()) {
    if (!f.url().includes('tooltip.html')) continue;
    const el = await f.frameElement();
    const visible = el ? await el.evaluate((n) => getComputedStyle(n).visibility !== 'hidden' && getComputedStyle(n).display !== 'none') : false;
    if (!visible) continue;
    const text = await f.evaluate(() => document.body.innerText).catch(() => '');
    const hit = [...CARDS, ...YT_CARDS].find((c) => text.includes(c.name));
    return hit ? hit.name : text.trim().split('\n')[0] || null;
  }
  return null;
}

/** YouTube rules (live-real.ts): only the user's URL; a consent page gets "Reject all" and nothing else; an ad is waited
 *  out, never skipped by a script; a bot check or sign-in wall ends the run. */
async function youtubeRun(page: Page, call: (fn: string) => Promise<unknown>) {
  await page.goto(YT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 4000));
  if (await page.evaluate(`location.hostname.startsWith('consent.') || /Before you continue/i.test(document.body.innerText)`)) {
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => /^\s*Reject all\s*$/i.test(b.innerText))?.click()`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const state = () => page.evaluate(`(() => { const v = document.querySelector('video.html5-main-video'); const p = document.getElementById('movie_player'); if (!v || !p) return null; const r = v.getBoundingClientRect(); return { t: v.currentTime, paused: v.paused, ad: p.classList.contains('ad-showing'), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }; })()`) as Promise<{ t: number; paused: boolean; ad: boolean; rect: { x: number; y: number; w: number; h: number } } | null>;
  for (let i = 0; i < 120; i++) {
    const st = await state();
    if (st && !st.ad && !st.paused && st.t > 0) break;
    if (/not a bot|Sign in to confirm/i.test(String(await page.evaluate('document.body.innerText')))) throw new Error('YouTube asked for a bot check: the run ends here');
    await page.evaluate(`document.querySelector('video.html5-main-video')?.play()`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const st = await state();
  if (!st || st.ad) throw new Error('the video never played without an ad');
  const at = (fx: number, fy: number) => ({ x: st.rect.x + fx * st.rect.w, y: st.rect.y + fy * st.rect.h });
  let w = 0;
  async function rest(fx: number, fy: number, ms: number, each?: () => Promise<void>) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      w = (w + 1) % 4;
      const p = at(fx, fy);
      await page.mouse.move(p.x + (w % 2) * 2, p.y + (w >> 1) * 2, { steps: 2 });
      const tick = Date.now() + 1000;
      while (Date.now() < Math.min(tick, end)) {
        await each?.();
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  await rest(0.5, 0.3, warmS * 1000); // warm-up: the top of the picture, no card there
  if (process.env.DEBUG_COMPARE) console.log('after warm-up:', JSON.stringify(await call('liveLog')).slice(0, 300), JSON.stringify(await call('liveFlags')).slice(0, 300));
  await page.evaluate(`document.getElementById('movie_player').seekTo(8, true)`);
  await new Promise((r) => setTimeout(r, 1500));
  const out: Record<string, unknown>[] = [];
  for (const c of YT_CARDS) {
    const restAt = Date.now();
    let shownAfterS: number | null = null;
    const wrong = new Set<string>();
    await rest(c.fx, c.fy, restS * 1000, async () => {
      const name = await shownName(page, call);
      if (!name) return;
      if (name === c.name) shownAfterS ??= Math.round((Date.now() - restAt) / 100) / 10;
      else wrong.add(name);
    });
    out.push({ name: c.name, restS, shownAfterS, wrong: [...wrong], videoT: Math.round(((await state())?.t ?? 0) * 10) / 10 });
    console.log(ext, c.name, 'shown after', shownAfterS, 's', wrong.size ? `wrong: ${[...wrong].join(', ')}` : '');
  }
  return out;
}

const report: Record<string, unknown> = { ext, scale, warmS };
try {
  const page = await browser.newPage();
  if (process.env.DEBUG_COMPARE) page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 200)));
  if (process.env.DEBUG_COMPARE) page.on('response', (r) => r.status() >= 400 && console.log('[http]', r.status(), r.url().slice(0, 160)));
  if (process.env.DEBUG_COMPARE) page.on('requestfailed', (r) => console.log('[failed]', r.url().slice(0, 160), r.failure()?.errorText));
  let call: (fn: string) => Promise<unknown> = async () => null;
  if (ext === 'ours') {
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
    const worker = (await sw.worker())!;
    await settleInstall(browser, page);
    await grantConsent(worker);
    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      const s = (settings ?? {}) as { live?: object };
      await chrome.storage.local.set({ settings: { ...s, live: { effort: 'balanced', showLabel: true, ...s.live, check: true } } });
    });
    await new Promise((r) => setTimeout(r, 2000)); // the script registered on every page
    call = (fn) => worker.evaluate((f) => (globalThis as any).duelLensDebug[f](), fn);
  }
  if (youtube) report.cards = await youtubeRun(page, call);
  else {
  await page.goto(`http://127.0.0.1:${port}/?scale=${scale}`, { waitUntil: 'networkidle0' });
  await page.bringToFront();
  await page.evaluate(`window.longTasks = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true })`);
  const vid = (await page.evaluate(`(() => { const r = document.getElementById('vid').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)) as { x: number; y: number; w: number; h: number };
  const at = (x: number, y: number) => ({ x: vid.x + (x / 1280) * vid.w, y: vid.y + (y / 720) * vid.h });
  let wiggle = 0;
  /** Rests the pointer near (x, y) of the video for `ms`, moving it a pixel or two every second, as a hand does. */
  async function restOn(x: number, y: number, ms: number, each?: () => Promise<void>) {
    const end = Date.now() + ms;
    const p = at(x, y);
    while (Date.now() < end) {
      wiggle = (wiggle + 1) % 4;
      await page.mouse.move(p.x + (wiggle % 2) * 2, p.y + (wiggle >> 1) * 2, { steps: 2 });
      const tick = Date.now() + 1000;
      while (Date.now() < Math.min(tick, end)) {
        await each?.();
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }
  // Warm-up: the pointer rests on the playing video (the mat, no card yet), so each extension loads its models.
  await restOn(640, 200, warmS * 1000);
  if (process.env.DEBUG_COMPARE) console.log('frames after warm-up:', page.frames().map((f) => f.url()));
  if (process.env.DEBUG_COMPARE) {
    for (const t of browser.targets().filter((t) => /compute\.html|tooltip\.html|background|offscreen/.test(t.url()))) {
      const cdp = await t.createCDPSession().catch(() => null);
      if (!cdp) continue;
      cdp.on('Runtime.consoleAPICalled', (e) => console.log('[target]', t.url().slice(-30), e.type, e.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)));
      cdp.on('Runtime.exceptionThrown', (e) => console.log('[target-exc]', t.url().slice(-30), e.exceptionDetails.exception?.description?.slice(0, 200)));
      await cdp.send('Runtime.enable').catch(() => undefined);
    }
    console.log('targets', browser.targets().map((t) => `${t.type()} ${t.url().slice(0, 80)}`));
  }
  await page.evaluate('window.startClip()');
  const t0 = Date.now();
  const cards: Record<string, unknown>[] = [];
  for (const c of CARDS) {
    const wait = c.from * scale * 1000 - (Date.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const restAt = Date.now();
    let shownAfterS: number | null = null;
    const wrong = new Set<string>();
    await restOn(c.x, c.y, (c.to - c.from) * scale * 1000, async () => {
      const name = await shownName(page, call);
      if (!name) return;
      if (name === c.name) shownAfterS ??= Math.round((Date.now() - restAt) / 100) / 10;
      else wrong.add(name);
    });
    if (process.env.DEBUG_COMPARE) await page.screenshot({ path: path.join(root, `test/e2e/out/compare-${ext}-${cards.length}.png`) as `${string}.png` });
    cards.push({ name: c.name, restS: (c.to - c.from) * scale, shownAfterS, wrong: [...wrong] });
    console.log(ext, c.name, 'shown after', shownAfterS, 's', wrong.size ? `wrong: ${[...wrong].join(', ')}` : '');
  }
  const lt = (await page.evaluate('window.longTasks')) as number[];
  report.cards = cards;
  report.longTasks = { count: lt.length, longestMs: Math.round(Math.max(0, ...lt)) };
  }
} catch (e) {
  report.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  console.error(e);
} finally {
  writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  await browser.close();
  server.close();
}
