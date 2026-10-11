// Card text language end to end, with a REAL download from db.ygoprodeck.com (so it isn't part of run.ts,
// which needs no network for card text): builds the E2E extension, agrees on the welcome page, then for each
// language given (default: fr ja):
// - picks it in Options' real "Card text language" select, and times it until the page says the pack is stored;
// - reads the download's size on the wire from the Options page's network log;
// - boxes Dark Magician on the test page and checks the popover: the translated name (with its lang) and the
//   English name under it; screenshot test/e2e/out/card-language-<lang>.png.
// Then English again: the popover shows "Dark Magician" with no subtitle, and the pack is gone.
//
//   npx tsx test/e2e/card-language.ts [fr ja …]      (DUEL_LENS_E2E_DIST=<dir> builds there, as run.ts does)
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type Browser, type CDPSession, type Page, type WebWorker } from 'puppeteer';
import { closeOverlay, focusPageControl, grantConsent, langArgs, readPopoverName, settleInstall, waitForState } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.DUEL_LENS_E2E_DIST ? path.resolve(root, process.env.DUEL_LENS_E2E_DIST) : path.join(root, 'dist-e2e');
const outDir = path.join(root, 'test/e2e/out');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const file = url === '/' ? path.join(root, 'test/e2e/page.html') : url.startsWith('/cards/') ? path.join(root, 'test/fixtures', url) : '';
    if (!file || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Picks `lang` in Options and waits for the stored-pack line: the time, the bytes on the wire, and that line. */
async function pickLanguage(browser: Browser, extId: string, lang: string) {
  const options = await browser.newPage();
  const cdp = await options.createCDPSession();
  await cdp.send('Network.enable');
  const ids = new Map<string, string>();
  let wire = 0;
  cdp.on('Network.requestWillBeSent', (e) => ids.set(e.requestId, e.request.url));
  cdp.on('Network.loadingFinished', (e) => {
    if (ids.get(e.requestId)?.includes('language=')) wire += e.encodedDataLength;
  });
  await options.goto(`chrome-extension://${extId}/options.html#card-language`, { waitUntil: 'load' });
  await options.waitForSelector('#card-language-select');
  const t0 = Date.now();
  await options.select('#card-language-select', lang);
  const done = lang === 'en' ? 'nothing to download' : 'cards translated';
  await options.waitForFunction(
    `(() => { const s = document.getElementById('card-language-state'); return !!s && (s.textContent.includes(${JSON.stringify(done)}) || !!s.querySelector('[role=alert]')); })()`,
    { timeout: 120000, polling: 200 },
  );
  const ms = Date.now() - t0;
  const line = (await options.evaluate(`document.getElementById('card-language-state').textContent.replace(/\\s+/g, ' ').trim()`)) as string;
  await (await options.$('#card-language'))?.screenshot({ path: path.join(outDir, `card-language-options-${lang}.png`) });
  await options.close();
  return { ms, wire, line };
}

/** Boxes Dark Magician (#dm) and reads the popover's name; screenshot card-language-<lang>.png. */
async function scanDarkMagician(page: Page, worker: WebWorker, cdp: CDPSession, lang: string) {
  const box = await page.evaluate(`(() => { const r = document.getElementById('dm').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`) as {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  await page.bringToFront();
  await focusPageControl(page);
  await worker.evaluate('globalThis.duelLensDebug.startScan()');
  await waitForState(page, ['selecting'], 15000);
  await page.mouse.move(box.x - 6, box.y - 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w / 2, box.y + box.h / 2, { steps: 5 });
  await page.mouse.move(box.x + box.w + 6, box.y + box.h + 6, { steps: 5 });
  await page.mouse.up();
  const state = await waitForState(page, ['result', 'error'], 60000);
  await sleep(1500); // the card image arrives after the answer
  const read = await readPopoverName(cdp);
  await page.screenshot({ path: path.join(outDir, `card-language-${lang}.png`) });
  await closeOverlay(page);
  return { state: state.state, ...read };
}

async function main() {
  const langs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const picks = langs.length ? langs : ['fr', 'ja'];
  execFileSync('node', ['build.mjs', '--e2e', ...(process.env.DUEL_LENS_E2E_DIST ? ['--out', dist] : [])], { cwd: root, stdio: 'inherit' });
  await mkdir(outDir, { recursive: true });
  const server = await serve();
  const port = (server.address() as AddressInfo).port;
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: [dist],
    defaultViewport: { width: 1500, height: 1000 },
    args: ['--window-size=1500,1000', '--no-first-run', ...langArgs()],
  });
  let failed = false;
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
    const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
    const worker = (await sw.worker())!;
    const extId = new URL(sw.url()).host;
    await settleInstall(browser, page);
    await grantConsent(worker);
    const cdp = await page.createCDPSession();
    for (const lang of [...picks, 'en']) {
      const pick = await pickLanguage(browser, extId, lang);
      const read = await scanDarkMagician(page, worker, cdp, lang);
      const ok =
        lang === 'en'
          ? read.name === 'Dark Magician' && read.english === null && !pick.line.includes("Couldn't")
          : !!read.name && read.name !== 'Dark Magician' && read.lang === lang && read.english === 'English name: Dark Magician';
      if (!ok) failed = true;
      console.log(
        JSON.stringify({
          lang,
          downloadMs: pick.ms,
          wireMB: +(pick.wire / 1e6).toFixed(2),
          options: pick.line,
          popover: read,
          ok,
        }),
      );
    }
    const left = (await worker.evaluate(
      `new Promise((resolve) => { const r = indexedDB.open('duel-lens-card-text'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readonly'); const g = tx.objectStore('meta').get('pack'); g.onsuccess = () => resolve(g.result ?? null); }; r.onerror = () => resolve('error'); })`,
    )) as unknown;
    console.log(`after English: stored pack ${JSON.stringify(left)}`);
    if (left !== null) failed = true;
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? '\ncard text language: FAIL' : '\ncard text language: pass');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
