// End-to-end check: loads the E2E build into Chrome for Testing, opens a local board of
// real cards, triggers a scan through the service worker's debug hook, drags a box around
// each card with the mouse, and asserts the popover's card name.
// Run: npx tsx test/e2e/run.ts   (screenshots land in test/e2e/out/)
// Click to scan: npx tsx test/e2e/run.ts --click [--fake-detect]
//   After the shortcut, waits for the detector's outlines and clicks each card's centre instead of
//   dragging; reports shortcut → outlines and click → popover times. When the build has no card
//   detector (the first card's detection says exactly "no card detector in this build") it stops
//   there with SKIPPED (exit 0); any other detection failure, or none, fails that card (harness.ts
//   checkDetection). --fake-detect sends the outlines from the harness instead (the board's own
//   geometry, the build's own detection held back), to test the UI alone.
// --dpr=N (the board only): the browser at devicePixelRatio N, so the screenshot is N times the viewport
//   (checked on the first card): the capture → outline → crop chain at Retina scale, end to end.
// Real footage: npx tsx test/e2e/run.ts --real [--click [--fake-detect]] [--limit N] [--only cards|negatives] (see real.ts)
// The first-run consent: every run starts on a fresh profile, so it first checks that the install
//   opened the welcome page and that a scan before the consent opens its consent step (and leaves the
//   page alone), then agrees through the E2E hook (duelLensDebug.grantConsent) and scans.
// --store-images (the board, dragging): the crop build's image mode (build.mjs --no-remote-images; the
//   flag's name dates from before decision D2, when the store build was the crop build).
//   Each popover must show the user's own crop, the service worker must request nothing from
//   images.ygoprodeck.com, and every scan must keep its small picture for the side panel.
//   Screenshots: store-consent-step.png, store-<card>.png, store-sidepanel.png.
// Every board scan also checks (each mode):
// - security review H1: page.html is a hostile page that tries to reach the overlay's closed shadow
//   root through ElementInternals; it must get none.
// - a11y review B2 and B1: the popover takes focus when the answer comes (no focus ring after a
//   mouse scan), and closing gives focus back to the page's control, which gets its keys again.
// - a11y review M1: after the cards, one more scan with two clicks instead of a drag (a click beside
//   the outlines arms a corner, the second click scans the box): the same card as the drag.
// Then, each mode (the outlines are the detector's, or the harness's with --fake-detect):
// - UX-1, scan mode stays open: click a card, then another (its popover replaces the first), Esc closes
//   the popover (scan mode stays), Esc leaves; the video Duel Lens paused plays again.
// - UX-2, hover previews ("Show card details: Hover or click", the default): a preview on a card, the
//   pointer onto the preview (it stays), Esc hides it, hover again, a click pins it; the history gets
//   exactly one entry. "Click" mode: no preview. And the time from the pointer resting to the preview,
//   first read and cached, over the board's cards.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type Browser, type CDPSession, type Page, type WebWorker } from 'puppeteer';
import {
  NoDetector,
  checkConsentGate,
  checkDetection,
  checkFakeDetection,
  checkPageFocusBack,
  checkPopoverFocus,
  clickStartsScan,
  closeOverlay,
  focusPageControl,
  grantConsent,
  historyCount,
  hostState,
  installTabTap,
  readArmedCorner,
  readH1Probe,
  readOverlay,
  readPopoverPicture,
  readShadowFocus,
  readTabTap,
  sendFakeDetection,
  setReveal,
  settleInstall,
  skipMessage,
  waitForOutlines,
  waitForPreview,
  waitForState,
  type Corners,
} from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, 'dist-e2e');
const outDir = path.join(root, 'test/e2e/out');

function serve(): Promise<http.Server> {
  const files: Record<string, string> = { '/': path.join(root, 'test/e2e/page.html') };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const file = files[url] ?? (url.startsWith('/cards/') ? path.join(root, 'test/fixtures', url) : '');
    if (!file || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** --store-images: what each popover showed as the card's picture (harness.ts readPopoverPicture). */
type Picture = Awaited<ReturnType<typeof readPopoverPicture>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What each scan checks besides its card: null when it holds, else what went wrong (see the header). */
interface ScanChecks {
  leak: string | null;
  popoverFocus: string | null;
  focusBack: string | null;
}

/** At the answer: the hostile page reached no shadow root (H1), and the popover has focus (B2). */
async function checkAtAnswer(page: Page, cdp: CDPSession): Promise<Omit<ScanChecks, 'focusBack'>> {
  const probe = await readH1Probe(page);
  return {
    leak: probe.leaked === 0 ? null : `the page reached ${probe.leaked} Duel Lens shadow root(s) through ElementInternals`,
    popoverFocus: checkPopoverFocus(await readShadowFocus(cdp)),
  };
}

/** Closes Duel Lens with Escape, then checks focus and keys are the page's again (B1). */
async function closeAndCheckFocus(page: Page): Promise<string | null> {
  const closed = await closeOverlay(page);
  await sleep(300);
  return closed ? checkPageFocusBack(page) : 'Escape did not close Duel Lens';
}

async function scanTarget(page: Page, worker: WebWorker, id: string, cdp: CDPSession, store: boolean) {
  const box = await page.evaluate((elId) => {
    const el = document.getElementById(elId)!;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, expect: el.dataset.expect ?? '' };
  }, id);
  // For the video, box only the card in the middle of the frame (half the displayed size).
  const target =
    id === 'vid'
      ? { x: box.x + box.w / 2 - 62, y: box.y + box.h / 2 - 86, w: 124, h: 172 }
      : { x: box.x - 6, y: box.y - 6, w: box.w + 12, h: box.h + 12 };

  await focusPageControl(page);
  await worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
  await waitForState(page, ['selecting'], 15000);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + target.w / 2, target.y + target.h / 2, { steps: 5 });
  await page.mouse.move(target.x + target.w, target.y + target.h, { steps: 5 });
  await page.mouse.up();
  const t0 = Date.now();
  const s = await waitForState(page, ['result', 'error'], 60000);
  const ms = Date.now() - t0;
  const atAnswer = await checkAtAnswer(page, cdp);
  // Card images arrive after the result (fetched once, then cached); give them a moment.
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, `${store ? 'store-' : ''}${id}.png`) });
  // The crop build (--no-remote-images) shows the user's own crop (a PNG data URL), never a card image (JPEG).
  const picture: Picture = store ? await readPopoverPicture(cdp) : null;
  const pictureOk = !store || (picture?.ownCrop === true && picture.src === 'data:image/png;base64,' && picture.altThumbs === 0);
  const checks: ScanChecks = { ...atAnswer, focusBack: await closeAndCheckFocus(page) };
  return {
    id,
    expect: box.expect,
    got: s.card ?? `(${s.state})`,
    confident: s.confident,
    ms,
    ...(store ? { picture } : {}),
    checks,
    ok: s.card === box.expect && pictureOk,
  };
}

/**
 * Two clicks instead of a drag (a11y review M1, WCAG 2.5.7): once the outlines are in, a click beside
 * them arms a corner (the hint asks for the opposite corner and nothing is scanned), and a click at
 * the opposite corner scans the box between the two: the same card as dragging around it.
 */
async function twoClickTarget(page: Page, worker: WebWorker, cdp: CDPSession, id: string, outlineWaitMs: number) {
  const box = await page.evaluate((elId) => {
    const el = document.getElementById(elId)!;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, expect: el.dataset.expect ?? '' };
  }, id);
  const [a, b] = [
    { x: box.x - 12, y: box.y - 12 },
    { x: box.x + box.w + 12, y: box.y + box.h + 12 },
  ];
  await focusPageControl(page);
  await worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
  await waitForState(page, ['selecting'], 15000);
  await waitForOutlines(page, outlineWaitMs).catch(() => null); // the first click is judged against them
  await page.mouse.click(a.x, a.y);
  await sleep(300);
  const armed = await readArmedCorner(cdp);
  const stillSelecting = (await hostState(page))?.state === 'selecting';
  await page.mouse.move(b.x, b.y, { steps: 8 }); // the rubber band follows the pointer
  await page.screenshot({ path: path.join(outDir, `two-click-${id}-armed.png`) });
  await page.mouse.click(b.x, b.y);
  const started = await waitForState(page, ['scanning', 'result', 'error'], 5000).catch(() => null);
  const s = started ? await waitForState(page, ['result', 'error'], 60000) : null;
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, `two-click-${id}.png`) });
  const focusBack = await closeAndCheckFocus(page);
  const problems = [
    stillSelecting && armed?.corner ? null : `the first click did not arm a corner (state ${stillSelecting ? 'selecting' : 'scanning'}, marker ${armed?.corner ? 'shown' : 'missing'})`,
    armed?.hint?.includes('Click the opposite corner') ? null : `the hint said "${armed?.hint ?? 'nothing'}"`,
    s ? null : 'the second click scanned nothing',
    s && s.card !== box.expect ? `got ${s.card ?? `(${s.state})`}` : null,
    focusBack,
  ].filter(Boolean);
  return { id, expect: box.expect, got: s?.card ?? `(${s?.state ?? 'no scan'})`, problems, ok: problems.length === 0 };
}

/**
 * --store-images, after the scans: nothing was requested from images.ygoprodeck.com, and each scan's
 * history entry has its small picture (a JPEG data URL). Also screenshots the side panel page.
 */
async function checkStoreMode(browser: Browser, worker: WebWorker, requested: string[], extId: string) {
  // The monitor itself: a request the worker makes now must show up in `requested`.
  await worker.evaluate("fetch(chrome.runtime.getURL('manifest.json')).then((r) => r.status)");
  await new Promise((r) => setTimeout(r, 500));
  const monitored = requested.some((u) => u.endsWith('/manifest.json'));
  const imageRequests = requested.filter((u) => u.includes('images.ygoprodeck.com'));
  const kept = (await worker.evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    const history = Array.isArray(all.history) ? all.history : [];
    return history.map((e) => ({ id: e.id, thumb: typeof all['thumb:' + e.id] === 'string' ? all['thumb:' + e.id].slice(0, 23) + '… (' + all['thumb:' + e.id].length + ' chars)' : null }));
  })()`)) as { id: string; thumb: string | null }[];
  const panel = await browser.newPage();
  await panel.setViewport({ width: 380, height: 820 });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('.current img.own', { timeout: 15000 }).catch(() => {});
  const panelPicture = await panel.evaluate("(document.querySelector('.current img.own') || {}).src ? document.querySelector('.current img.own').src.slice(0, 23) : null");
  await panel.screenshot({ path: path.join(outDir, 'store-sidepanel.png') });
  await panel.close();
  const thumbsOk = kept.length > 0 && kept.every((k) => k.thumb?.startsWith('data:image/jpeg;base64,'));
  console.log(
    `store mode: ${requested.length} service-worker requests (the monitor ${monitored ? 'saw' : 'MISSED'} its own probe), ` +
      `${imageRequests.length} to images.ygoprodeck.com${imageRequests.length ? `: ${imageRequests.slice(0, 3).join(', ')}` : ''}`,
  );
  console.log(`store mode: ${kept.filter((k) => k.thumb).length}/${kept.length} history entries keep a picture (${kept[0]?.thumb ?? 'none'}); side panel shows ${panelPicture ?? 'no picture'}`);
  return monitored && imageRequests.length === 0 && thumbsOk && panelPicture === 'data:image/jpeg;base64,';
}

/**
 * --fake-detect: every card on the board, as a perfect detector would report it (corners in
 * screenshot pixels): the images' own boxes turned like their CSS transform, and the card drawn in
 * the middle of the video stream (220x320 at 0.04 rad in 960x540, shown at half size; page.html).
 */
const BOARD_CARDS = `(() => {
  const dpr = devicePixelRatio;
  const boxes = [];
  for (const el of document.querySelectorAll('.board img, .board video')) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let w = el.offsetWidth;
    let h = el.offsetHeight;
    let angle = 0;
    if (el.tagName === 'VIDEO') {
      w = 110;
      h = 160;
      angle = 0.04;
    } else {
      const t = getComputedStyle(el).transform;
      if (t && t !== 'none') {
        const m = new DOMMatrix(t);
        angle = Math.atan2(m.b, m.a);
      }
    }
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const at = (dx, dy) => [(cx + dx * c - dy * s) * dpr, (cy + dx * s + dy * c) * dpr];
    boxes.push([at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)]);
  }
  return { boxes, width: Math.round(innerWidth * dpr), height: Math.round(innerHeight * dpr) };
})()`;

const OUTLINE_WAIT_MS = 20000;

/**
 * Click to scan: the shortcut, the detector's outlines, then one click on the card's centre.
 * Throws NoDetector on the first card when the build says it has no card detector (without
 * --fake-detect), and an Error, failing that card, when its detection failed any other way.
 */
async function clickTarget(page: Page, worker: WebWorker, cdp: CDPSession, id: string, fake: boolean, first: boolean) {
  const card = await page.evaluate((elId) => {
    const el = document.getElementById(elId)!;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, expect: el.dataset.expect ?? '' };
  }, id);
  if (!(await installTabTap(worker, fake))) {
    // Without it, a detection's error (the only reason to skip) can't be read.
    throw new Error(`--click needs chrome.tabs.sendMessage wrapped in the service worker (${fake ? 'to send the fake detection' : 'to read the detection'}), and it could not be`);
  }
  await focusPageControl(page);
  const t0 = Date.now();
  await worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
  await waitForState(page, ['selecting'], 15000);
  if (fake) {
    const board = (await page.evaluate(BOARD_CARDS)) as { boxes: Corners[]; width: number; height: number };
    await sendFakeDetection(worker, board.boxes, board);
  }
  let outlines: number | null = null;
  try {
    outlines = await waitForOutlines(page, OUTLINE_WAIT_MS);
  } catch {
    // No detection came: the click below can only land on nothing.
  }
  const outlineMs = outlines === null ? null : Date.now() - t0;
  const tap = await readTabTap(worker);
  const detection = tap?.detected.find((d) => d.capturedAt === tap.begin?.capturedAt) ?? null;
  // Skipped only when the build says it has no card detector, on the first card; any other failure
  // to outline fails the card (click-review I2).
  const verdict = fake ? checkFakeDetection(outlines, OUTLINE_WAIT_MS) : checkDetection(outlines, detection, OUTLINE_WAIT_MS);
  if (verdict) {
    await closeOverlay(page);
    if ('skip' in verdict && first) throw new NoDetector(verdict.skip);
    throw new Error(`click to scan: ${'skip' in verdict ? `a later scan says ${verdict.skip}` : verdict.fail}`);
  }
  await page.screenshot({ path: path.join(outDir, `click-${id}-outlines.png`) });
  await page.evaluate(() => {
    (window as any).scanClock = { up: 0, done: 0 };
  });
  const scanned = await clickStartsScan(page, card.x, card.y);
  const s = scanned ? await waitForState(page, ['result', 'error'], 60000) : await hostState(page);
  const atAnswer = scanned ? await checkAtAnswer(page, cdp) : { leak: null, popoverFocus: null };
  const clock = await page.evaluate(() => (window as any).scanClock as { up: number; done: number });
  const ms = scanned && clock.up && clock.done ? Math.round(clock.done - clock.up) : null;
  // Card images arrive after the result (fetched once, then cached); give them a moment.
  await sleep(1500);
  await page.screenshot({ path: path.join(outDir, `click-${id}.png`) });
  const checks: ScanChecks = { ...atAnswer, focusBack: await closeAndCheckFocus(page) };
  return {
    id,
    expect: card.expect,
    got: scanned ? (s?.card ?? `(${s?.state})`) : '(no outline under the click)',
    confident: s?.confident ?? null,
    outlines,
    outlineMs,
    detectorMs: fake ? null : (detection?.ms ?? null), // with --fake-detect, the build's own (held-back) detection
    ms,
    checks,
    ok: scanned && s?.card === card.expect,
  };
}


// ---------- UX-1 and UX-2 flows ----------

/** Where no card is on the board (its bottom-left corner): the pointer rests there between cards. */
const EMPTY = { x: 8, y: 990 };

async function centreOf(page: Page, id: string) {
  return page.evaluate((elId) => {
    const r = document.getElementById(elId)!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, expect: document.getElementById(elId)!.dataset.expect ?? '' };
  }, id);
}

/** The shortcut, then the outlines (sent by the harness with --fake-detect); the pointer waits off the cards. */
async function openScan(page: Page, worker: WebWorker, fake: boolean): Promise<number> {
  await page.mouse.move(EMPTY.x, EMPTY.y);
  if (fake && !(await installTabTap(worker, true))) throw new Error('--fake-detect needs chrome.tabs.sendMessage wrapped in the service worker');
  await focusPageControl(page);
  await worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
  await waitForState(page, ['selecting'], 15000);
  if (fake) {
    const board = (await page.evaluate(BOARD_CARDS)) as { boxes: Corners[]; width: number; height: number };
    await sendFakeDetection(worker, board.boxes, board);
  }
  return waitForOutlines(page, fake ? 5000 : OUTLINE_WAIT_MS);
}

const videoPaused = (page: Page) => page.evaluate("document.getElementById('vid').paused") as Promise<boolean>;

/** UX-1: scan → card 1 → its popover → card 2 → its popover replaces the first → Esc closes it → Esc leaves; the video plays again. */
async function stayOpenFlow(page: Page, worker: WebWorker, cdp: CDPSession, fake: boolean) {
  const problems: string[] = [];
  const note = (ok: boolean, what: string) => ok || problems.push(what);
  await openScan(page, worker, fake);
  note(await videoPaused(page), 'the video kept playing under the frozen frame');
  const [one, two] = [await centreOf(page, 'dm'), await centreOf(page, 'link')];
  await page.mouse.click(one.x, one.y);
  const first = await waitForState(page, ['result', 'error'], 60000);
  note(first.card === one.expect, `card 1 read ${first.card ?? first.state}`);
  await page.mouse.click(two.x, two.y);
  const t0 = Date.now();
  let second = await hostState(page);
  while (second?.card !== two.expect && Date.now() - t0 < 60000) {
    await sleep(100);
    second = await hostState(page);
  }
  note(second?.state === 'result' && second.card === two.expect, `card 2 read ${JSON.stringify(second)}`);
  const open = await readOverlay(cdp);
  note(open?.popovers === 1 && !!open.frame, `after card 2: ${JSON.stringify(open)} (one popover over the frozen frame)`);
  note((await checkAtAnswer(page, cdp)).popoverFocus === null, 'the second popover did not take focus');
  await page.screenshot({ path: path.join(outDir, 'stay-open.png') });
  await page.keyboard.press('Escape');
  await sleep(300);
  const closed = await readOverlay(cdp);
  note((await hostState(page))?.state === 'selecting' && closed?.popovers === 0, `Esc #1: ${JSON.stringify(closed)} (the popover closed, scan mode stays)`);
  await page.keyboard.press('Escape');
  await sleep(500);
  note((await hostState(page)) === null, 'Esc #2 did not leave scan mode');
  note(!(await videoPaused(page)), 'the video did not play again');
  const focus = await checkPageFocusBack(page);
  if (focus) problems.push(focus);
  return { cards: [first.card, second?.card], problems, ok: problems.length === 0 };
}

/** UX-2: a preview on a card → the pointer onto it (it stays) → Esc hides it → hover again → a click pins it: one history entry. */
async function hoverFlow(page: Page, worker: WebWorker, cdp: CDPSession, fake: boolean) {
  const problems: string[] = [];
  const note = (ok: boolean, what: string) => ok || problems.push(what);
  await openScan(page, worker, fake);
  const before = await historyCount(worker);
  const dm = await centreOf(page, 'dm');
  await page.mouse.move(dm.x, dm.y);
  const shown = await waitForPreview(page, true, 15000).catch(() => null);
  note(shown === dm.expect, `the preview said ${JSON.stringify(shown)}`);
  const pv = (await readOverlay(cdp))?.preview;
  await page.screenshot({ path: path.join(outDir, 'hover-preview.png') });
  if (pv) {
    await page.mouse.move(pv.box.x + pv.box.w / 2, pv.box.y + pv.box.h / 2, { steps: 6 });
    await sleep(600);
    note((await readOverlay(cdp))?.preview !== null, 'the preview went when the pointer moved onto it');
  } else problems.push('no preview to move onto');
  note((await historyCount(worker)) === before, 'a hover recorded a history entry');
  await page.keyboard.press('Escape');
  await sleep(300);
  note((await readOverlay(cdp))?.preview === null && (await hostState(page)) !== null, 'Esc did not hide the preview (or it left scan mode)');
  await page.mouse.move(EMPTY.x, EMPTY.y);
  await page.mouse.move(dm.x, dm.y);
  note((await waitForPreview(page, true, 5000).catch(() => null)) === dm.expect, 'no preview on the second hover');
  await page.mouse.click(dm.x, dm.y);
  const pinned = await waitForState(page, ['result', 'error'], 5000).catch(() => null);
  note(pinned?.card === dm.expect, `the click pinned ${JSON.stringify(pinned)}`);
  const t0 = Date.now();
  while ((await historyCount(worker)) === before && Date.now() - t0 < 10000) await sleep(100);
  await sleep(1500);
  const added = (await historyCount(worker)) - before;
  note(added === 1, `the history got ${added} entries (one expected)`);
  await closeOverlay(page);
  return { added, problems, ok: problems.length === 0 };
}

/** UX-2 "Click" mode: resting on a card shows no preview and reads nothing; a click reads it as before. */
async function clickModeFlow(page: Page, worker: WebWorker, fake: boolean) {
  const problems: string[] = [];
  await setReveal(worker, 'click');
  try {
    await openScan(page, worker, fake);
    const before = await historyCount(worker);
    const dm = await centreOf(page, 'dm');
    await page.mouse.move(dm.x, dm.y);
    await sleep(1500);
    const s = await page.evaluate("document.getElementById('duel-lens-host').getAttribute('data-duel-lens-preview')");
    if (s !== null) problems.push(`a preview showed in "Click" mode: ${s}`);
    await page.mouse.click(dm.x, dm.y);
    const read = await waitForState(page, ['result', 'error'], 60000);
    if (read.card !== dm.expect) problems.push(`the click read ${read.card ?? read.state}`);
    const t0 = Date.now();
    while ((await historyCount(worker)) === before && Date.now() - t0 < 5000) await sleep(100);
    if ((await historyCount(worker)) !== before + 1) problems.push('the click was not recorded once');
    await closeOverlay(page);
  } finally {
    await setReveal(worker, 'hover');
  }
  return { problems, ok: problems.length === 0 };
}

/** UX-2 point 8: from the pointer resting on a card to its preview, first read and cached, over the board's cards. */
async function hoverLatency(page: Page, worker: WebWorker, fake: boolean, ids: string[]) {
  await openScan(page, worker, fake);
  const pass = async () => {
    const ms: number[] = [];
    for (const id of ids) {
      const c = await centreOf(page, id);
      const t0 = Date.now();
      await page.mouse.move(c.x, c.y);
      const ok = await waitForPreview(page, true, 10000).then(
        () => true,
        () => false,
      );
      if (ok) ms.push(Date.now() - t0);
      await page.mouse.move(EMPTY.x, EMPTY.y);
      await waitForPreview(page, false, 3000).catch(() => null);
    }
    return ms;
  };
  const first = await pass();
  const cached = await pass();
  await closeOverlay(page);
  const pct = (xs: number[], q: number) => {
    const v = [...xs].sort((a, b) => a - b);
    return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null;
  };
  return {
    first: { n: first.length, p50: pct(first, 0.5), p90: pct(first, 0.9), ms: first },
    cached: { n: cached.length, p50: pct(cached, 0.5), p90: pct(cached, 0.9), ms: cached },
  };
}

const median = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null;
};

/** "first 900 ms, then median 450 ms (min 420, max 510)" over the values in order. */
function timing(values: (number | null)[]): string {
  const v = values.filter((x): x is number => x !== null);
  if (!v.length) return 'n/a';
  const rest = v.slice(1);
  return rest.length
    ? `first ${v[0]} ms, then median ${median(rest)} ms (min ${Math.min(...rest)}, max ${Math.max(...rest)})`
    : `${v[0]} ms`;
}

async function main() {
  const storeImages = process.argv.includes('--store-images');
  if (storeImages && (process.argv.includes('--real') || process.argv.includes('--click'))) {
    throw new Error('--store-images applies to the board, dragging (not --real or --click)');
  }
  execFileSync(
    'node',
    ['build.mjs', '--e2e', ...(storeImages ? ['--no-remote-images'] : [])],
    { cwd: root, stdio: 'inherit' },
  );
  await mkdir(outDir, { recursive: true });
  const click = process.argv.includes('--click');
  const fake = process.argv.includes('--fake-detect');
  if (fake && !click) throw new Error('--fake-detect only applies with --click');
  const dprArg = process.argv.find((a) => a.startsWith('--dpr='));
  const dpr = dprArg ? Number(dprArg.slice('--dpr='.length)) : 1;
  if (!(dpr > 0)) throw new Error(`${dprArg}: --dpr= needs a positive number`);
  if (dprArg && process.argv.includes('--real')) throw new Error('--dpr applies to the board only (--real shows its frames 1:1)');
  if (process.argv.includes('--real')) {
    const { runReal } = await import('./real');
    process.exitCode = await runReal({ root, dist, outDir, click, fake });
    return;
  }
  const server = await serve();
  const port = (server.address() as AddressInfo).port;
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [dist],
    defaultViewport: { width: 1500, height: 1000, deviceScaleFactor: dpr },
    args: ['--window-size=1500,1000', '--no-first-run', ...(dprArg ? [`--force-device-scale-factor=${dpr}`] : [])],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.text().includes('DuelLens')) console.log('[page]', m.text());
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    await page.bringToFront();
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
    const worker = (await sw.worker())!;
    if (dprArg && !(await installTabTap(worker, fake))) throw new Error('--dpr needs chrome.tabs.sendMessage wrapped in the service worker (to read the screenshot size), and it could not be');
    // The first-run consent (a fresh profile has none): the install's welcome page, the gate, then agree.
    await settleInstall(browser, page);
    console.log('install: opened welcome.html');
    console.log(`consent gate: ${await checkConsentGate(browser, worker, page, path.join(outDir, `${storeImages ? 'store-' : ''}consent-step.png`))}`);
    await grantConsent(worker);
    // --store-images: every request the service worker makes, to check none goes to images.ygoprodeck.com.
    const requested: string[] = [];
    // Reads the overlay's closed shadow root (focus, the crop build's picture), as the page can't.
    const cdp = await page.createCDPSession();
    if (storeImages) {
      const swCdp = await sw.createCDPSession();
      swCdp.on('Network.requestWillBeSent', (e) => requested.push(e.request.url));
      await swCdp.send('Network.enable');
    }

    const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    const ids = args.length ? args : ['dm', 'ash-upside', 'pog-small', 'link', 'pend', 'imp-tilt', 'xyz-def', 'vid'];
    const results: { id: string; ok: boolean; outlineMs?: number | null; ms: number | null; checks?: ScanChecks }[] = [];
    for (const id of ids) {
      try {
        results.push(click ? await clickTarget(page, worker, cdp, id, fake, results.length === 0) : await scanTarget(page, worker, id, cdp, storeImages));
      } catch (e) {
        if (e instanceof NoDetector) {
          console.log(`\n${skipMessage(e.message)}`);
          process.exitCode = 0;
          return;
        }
        results.push({ id, expect: '?', got: `ERROR ${(e as Error).message}`, confident: null, ms: null, ok: false } as (typeof results)[number]);
        await closeOverlay(page);
      }
      console.log(JSON.stringify(results.at(-1)));
      if (dprArg && results.length === 1) {
        // The run means something only if the tab was captured at that scale.
        const shot = (await readTabTap(worker))?.begin?.shot;
        const want = { width: Math.round(1500 * dpr), height: Math.round(1000 * dpr) };
        console.log(`screenshot ${shot ? `${shot.width}x${shot.height}` : 'of unknown size'} for the 1500x1000 viewport at devicePixelRatio ${dpr}`);
        if (shot?.width !== want.width || shot?.height !== want.height) throw new Error(`--dpr=${dpr}: the screenshot should be ${want.width}x${want.height}`);
      }
    }
    const two = await twoClickTarget(page, worker, cdp, 'dm', fake ? 2000 : OUTLINE_WAIT_MS).catch((e: Error) => ({
      id: 'dm',
      expect: 'Dark Magician',
      got: `ERROR ${e.message}`,
      problems: [e.message],
      ok: false,
    }));
    console.log(JSON.stringify({ twoClick: two }));
    const failed = (e: Error) => ({ problems: [`ERROR ${e.message}`], ok: false });
    const stay = await stayOpenFlow(page, worker, cdp, fake).catch(failed);
    console.log(JSON.stringify({ stayOpen: stay }));
    const hover = await hoverFlow(page, worker, cdp, fake).catch(failed);
    console.log(JSON.stringify({ hover }));
    const clickMode = await clickModeFlow(page, worker, fake).catch(failed);
    console.log(JSON.stringify({ clickMode }));
    const latency = await hoverLatency(page, worker, fake, ids).catch((e: Error) => ({ error: e.message }));
    console.log(JSON.stringify({ hoverLatency: latency }));
    const passed = results.filter((r) => r.ok).length;
    const storeOk = storeImages ? await checkStoreMode(browser, worker, requested, new URL(sw.url()).host) : true;
    const mode =
      (click ? (fake ? ' (click, fake detector)' : ' (click)') : '') + (dprArg ? ` (devicePixelRatio ${dpr})` : '') + (storeImages ? ' (store images: own crop)' : '');
    console.log(`\nE2E${mode}: ${passed}/${results.length} cards identified correctly${storeImages ? `; store-mode checks ${storeOk ? 'pass' : 'FAIL'}` : ''}`);
    if (click) {
      console.log(`shortcut → outlines: ${timing(results.map((r) => r.outlineMs ?? null))}`);
      console.log(`click → popover answer: ${timing(results.map((r) => r.ms))}`);
    }
    // The hostile page must have done its part (defined our tags and got their internals), or the leak check proves nothing.
    const probe = await readH1Probe(page);
    const probeRan = probe.grabbed > 0 && probe.tags.some((t) => t.startsWith('duel-lens-'));
    console.log(
      `H1 probe: the page defined ${probe.tags.length} Duel Lens tag(s) as they appeared and got ${probe.grabbed} ElementInternals; ` +
        `${probe.leaked} reached a shadow root${probeRan ? '' : ' (FAIL: the probe never got hold of a Duel Lens element)'}`,
    );
    const failedChecks = results.flatMap((r) => Object.entries(r.checks ?? {}).flatMap(([name, v]) => (v ? [`${r.id} ${name}: ${v}`] : [])));
    console.log(
      `checks (no shadow root leaked, popover focused, focus back to the page): ${failedChecks.length ? `FAIL\n  ${failedChecks.join('\n  ')}` : `pass on all ${results.length} scans`}`,
    );
    console.log(`two clicks instead of a drag: ${two.id} → ${two.got}: ${two.ok ? 'pass' : `FAIL (${two.problems.join('; ')})`}`);
    const verdict = (f: { ok: boolean; problems: string[] }) => (f.ok ? 'pass' : `FAIL (${f.problems.join('; ')})`);
    console.log(`scan mode stays open (two cards, Esc, Esc, the video plays again): ${verdict(stay)}`);
    console.log(`hover preview (onto it, Esc, again, click pins: one history entry): ${verdict(hover)}`);
    console.log(`"Click" mode (no preview): ${verdict(clickMode)}`);
    const flowsOk = stay.ok && hover.ok && clickMode.ok;
    process.exitCode = passed === results.length && storeOk && probeRan && failedChecks.length === 0 && two.ok && flowsOk ? 0 : 1;
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
