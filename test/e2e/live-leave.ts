// End-to-end check of Live's box when the pointer leaves it into a frame (an ad, a chat): the frame keeps the
// pointer's moves from the page, so the page sees the box's leave and nothing after it. Plays the synthetic clip
// (live.html) in real Chrome with the E2E build, rests the pointer on the first card until its box shows it sure,
// lays an iframe under the box (across the box's rows, clear of the card), and moves the pointer in single steps
// from the card onto the box (straight, then across the gap between them), then off the box into the iframe. The iframe is same-origin: for a cross-origin one,
// the browser's synthetic input (CDP) sends the page no leave at all, which a real mouse does.
// Run: npm run e2e:live-leave   (exit 1 when an assertion fails)
// Asserts: the box shows the card sure while the pointer rests on it; 600 ms after the pointer went into the iframe,
// no box shows; back on the card, its box shows again. Then Live check on a picture (a canvas with a card): from the
// card onto its box and straight back onto the card, the box never goes.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { grantConsent, langArgs, settleInstall } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.DUEL_LENS_E2E_DIST ? path.resolve(root, process.env.DUEL_LENS_E2E_DIST) : path.join(root, 'dist-e2e');
type Rect = { x: number; y: number; w: number; h: number };
type HoverBox = { shows: string; rect: Rect; picture?: true } | null;

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/frame') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<body style="margin:0;background:#dde">another site</body>');
    // A picture for Live check on pictures: Dark Magician drawn on a playmat-dark canvas, the card at (320..580, 150..529).
    if (url === '/picture')
      return void res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<body style="margin:0;background:#fff"><canvas id="pic" width="900" height="700" style="display:block;margin:60px 0 0 300px"></canvas><script>const c = document.getElementById('pic'), g = c.getContext('2d'); g.fillStyle = '#2a3a2a'; g.fillRect(0, 0, 900, 700); const i = new Image(); i.onload = () => { g.drawImage(i, 320, 150, 260, 379); document.title = 'ready'; }; i.src = '/cards/46986414.jpg';</script></body>`,
        );
    const file = url === '/' ? path.join(root, 'test/e2e/live.html') : url.startsWith('/cards/') ? path.join(root, 'test/fixtures', path.normalize(url)) : '';
    if (!file || !file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (!process.argv.includes('--no-build')) execFileSync('node', ['build.mjs', '--e2e', '--out', dist], { cwd: root, stdio: 'inherit' });
const server = await serve();
const port = (server.address() as AddressInfo).port;
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [dist],
  defaultViewport: { width: 1500, height: 1000 },
  args: ['--window-size=1500,1000', '--no-first-run', ...langArgs()],
});
const failures: string[] = [];
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
  await page.bringToFront();
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const worker = (await sw.worker())!;
  await settleInstall(browser, page);
  await grantConsent(worker);
  await worker.evaluate(`chrome.storage.local.get('settings').then((s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), live: { ...((s.settings || {}).live || {}), effort: 'balanced' } } }))`);
  const call = (fn: string, ...args: unknown[]) => worker.evaluate((f, a) => (globalThis as any).duelLensDebug[f](...a), fn, args);
  const hoverBox = async () => ((await call('liveHoverBox').catch(() => null)) as HoverBox) ?? null;

  await page.evaluate(`document.getElementById('page-focus').focus()`);
  await call('toggleLive');
  for (let i = 0; i < 240; i++) {
    const s = ((await call('liveLog')) as { status?: string } | null)?.status;
    if (s === 'watching' || s === 'slow' || s === 'blocked') break;
    await sleep(250);
  }
  await page.evaluate('window.startClip()');
  // The first card: centred on (330, 380) of the 1280x720 clip, 200 px tall, still until its stillUntil (harness.ts).
  const vid = (await page.evaluate(`(() => { const r = document.getElementById('vid').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)) as Rect;
  const card = { x: vid.x + (330 / 1280) * vid.w, y: vid.y + (380 / 720) * vid.h };
  await page.mouse.move(card.x, card.y, { steps: 3 });
  let box: HoverBox = null;
  for (let i = 0; i < 60 && box?.shows !== 'sure'; i++) {
    await sleep(250);
    box = await hoverBox();
  }
  if (box?.shows !== 'sure') throw new Error(`the box never showed the first card sure (last: ${JSON.stringify(box)})`);
  const b = box.rect;
  console.log(`box ${JSON.stringify(b)} over the card at (${Math.round(card.x)}, ${Math.round(card.y)})`);

  // The frame: the box's rows, across the page (the box lies over it), clear of the card.
  await page.evaluate(
    (top: number, h: number, src: string) => {
      const f = document.createElement('iframe');
      f.src = src;
      f.style.cssText = `position:fixed;left:0;top:${top}px;width:100vw;height:${h}px;border:0;z-index:1`;
      document.body.appendChild(f);
      return new Promise((done) => f.addEventListener('load', done, { once: true }));
    },
    b.y,
    b.h,
    `http://127.0.0.1:${port}/frame`,
  );
  const outX = b.x + b.w + 80 < 1500 ? b.x + b.w + 80 : b.x - 80;
  // The card's outline (Live's box on the video), for the gap between it and the box.
  const outline = (((await call('liveOutlines')) as { rect: Rect }[] | null) ?? [])[0]?.rect;
  if (!outline) throw new Error('no outline under the pointer on the first card');
  const gapY = b.y >= outline.y + outline.h ? (outline.y + outline.h + b.y) / 2 : (b.y + b.h + outline.y) / 2;
  const gapX = outline.x + outline.w * 0.15; // beside the box's arrow, which points at the card's centre across the gap
  // Straight from the card onto the box (the card is the last point the page saw), and the way a hand moves: across
  // the gap between the card and the box (the page saw the pointer off the card), then onto the box.
  for (const way of ['straight', 'across the gap'] as const) {
    if (way === 'across the gap') {
      await page.mouse.move(gapX, gapY); // one step: into the gap
      await sleep(50); // within GRACE_MS
    }
    await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2); // one step: onto the box
    await sleep(200);
    await page.mouse.move(outX, b.y + b.h / 2); // one step: off the box into the frame
    await sleep(600);
    const after = await hoverBox();
    console.log(`${way}: 600 ms in the frame: ${JSON.stringify(after)}`);
    if (after) failures.push(`${way}: the box still shows (${after.shows}) 600 ms after the pointer left it into a frame`);

    await page.mouse.move(card.x, card.y, { steps: 3 });
    let back: HoverBox = null;
    for (let i = 0; i < 12 && back?.shows !== 'sure'; i++) {
      await sleep(250);
      back = await hoverBox();
    }
    console.log(`${way}: back on the card: ${JSON.stringify(back)}`);
    if (back?.shows !== 'sure') throw new Error(`${way}: back on the card, its box did not show it sure again within 3 s`);
  }

  // Live check on a picture: the pointer goes from the card onto its box and straight back onto the card (as a box
  // that grows under a still pointer and moves off it again): the box stays, with no gap.
  await page.goto(`http://127.0.0.1:${port}/picture`, { waitUntil: 'networkidle0' });
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const s = (settings ?? {}) as { live?: object };
    await chrome.storage.local.set({ settings: { ...s, live: { ...s.live, check: true } } });
  });
  await page.waitForFunction(() => document.title === 'ready');
  await sleep(2000); // Live check on in the tab
  const pic = { x: 300 + 450, y: 60 + 339 };
  await page.mouse.move(pic.x - 6, pic.y - 6);
  await page.mouse.move(pic.x, pic.y, { steps: 2 });
  let pbox: HoverBox = null;
  for (let i = 0; i < 60 && !(pbox?.picture && pbox.shows === 'sure'); i++) {
    await sleep(250);
    pbox = await hoverBox();
  }
  if (!(pbox?.picture && pbox.shows === 'sure')) throw new Error(`picture: the box never showed the card sure (last: ${JSON.stringify(pbox)})`);
  const pb = pbox.rect;
  console.log(`picture: box ${JSON.stringify(pb)}`);
  await page.mouse.move(pb.x + pb.w / 2, pb.y + pb.h / 2); // one step onto the box
  await sleep(200);
  await page.mouse.move(pic.x, pic.y); // one step back onto the card
  const gaps: number[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 900) {
    if (!(await hoverBox())) gaps.push(Date.now() - t0);
    await sleep(30);
  }
  console.log(`picture: back on the card, no box at ${gaps.length ? gaps.join(', ') + ' ms' : 'no point'}`);
  if (gaps.length) failures.push(`picture: the box went while the pointer was on its card (${gaps[0]}..${gaps.at(-1)} ms after it came back)`);

  // Across the gap onto the box, back onto the card, and off the card before the picture's rest (PICTURE.dwellMs)
  // would read it again: the box goes.
  const card2 = { x: 300 + 320, y: 60 + 150, w: 260, h: 379 }; // the card on the page
  const pGapY = pb.y >= card2.y + card2.h ? (card2.y + card2.h + pb.y) / 2 : (pb.y + pb.h + card2.y) / 2;
  await page.mouse.move(card2.x + card2.w * 0.15, pGapY); // one step: into the gap, beside the arrow
  await sleep(50);
  await page.mouse.move(pb.x + pb.w / 2, pb.y + pb.h / 2); // onto the box
  await sleep(200);
  await page.mouse.move(pic.x, pic.y); // back onto the card
  await sleep(100);
  await page.mouse.move(300 + 100, 60 + 90); // off the card, on the picture's empty playmat
  await sleep(600);
  const off = await hoverBox();
  console.log(`picture: off the card soon after: ${JSON.stringify(off)}`);
  if (off) failures.push(`picture: the box still shows (${off.shows}) 600 ms after the pointer left its card (across the gap, onto the box, back, off)`);
} catch (e) {
  failures.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\nLive leave E2E FAILED (${failures.length}):\n- ${failures.join('\n- ')}` : '\nLive leave E2E passed');
process.exitCode = failures.length ? 1 : 0;
