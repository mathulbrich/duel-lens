// End-to-end check of "Report" (src/content/report-panel.tsx) in Chrome for Testing: scans a card on the local board by
// drag, opens Report, types a comment and presses Send; the service worker's request to the report relay is caught
// (CDP Fetch on the worker) and answered with a made-up issue, so no real issue is opened. Checks the request (the
// relay's URL, the extension's Origin, a JPEG under the relay's limit, the card, the comment, the version) and that
// the popover then links the issue. The relay itself has its own tests (relay/src/*.test.ts).
// Run: npx tsx test/e2e/report.ts   (DUEL_LENS_E2E_DIST=<dir> to build elsewhere than test/e2e/out/report-dist)
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer, { type CDPSession, type Page } from 'puppeteer';
import { REPORT_RELAY_URL } from '../../src/shared/report';
import { focusPageControl, grantConsent, inShadowRoot, langArgs, settleInstall, waitForState } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = path.resolve(root, process.env.DUEL_LENS_E2E_DIST ?? 'test/e2e/out/report-dist');
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

/** Clicks the popover's control whose text is `label` (a real, trusted click at its place). */
async function clickInPopover(page: Page, cdp: CDPSession, selector: string, label: string) {
  const r = await inShadowRoot<{ x: number; y: number } | null>(
    cdp,
    `function () {
      const el = [...this.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.textContent || e.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = el.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }`,
  );
  if (!r) throw new Error(`no "${label}" in the popover`);
  await page.mouse.click(r.x, r.y);
}

const popoverText = (cdp: CDPSession) => inShadowRoot<string>(cdp, `function () { return this.textContent || ''; }`);

execFileSync('node', ['build.mjs', '--e2e', '--out', dist], { cwd: root, stdio: 'inherit' });
const server = await serve();
const port = (server.address() as AddressInfo).port;
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [dist], defaultViewport: { width: 1500, height: 1000 }, args: ['--window-size=1500,1000', '--no-first-run', ...langArgs()] });
const problems: string[] = [];
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
  await page.bringToFront();
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const worker = (await swTarget.worker())!;
  await settleInstall(browser, page);
  await grantConsent(worker);

  // The relay, as the worker reaches it: caught and answered here.
  const sent: { headers: Record<string, string>; body: Record<string, any> }[] = [];
  const swCdp = await swTarget.createCDPSession();
  await swCdp.send('Fetch.enable', { patterns: [{ urlPattern: `${REPORT_RELAY_URL}*` }] });
  swCdp.on('Fetch.requestPaused', (e) => {
    const origin = e.request.headers.Origin ?? e.request.headers.origin ?? '';
    if (e.request.method === 'POST') sent.push({ headers: e.request.headers, body: JSON.parse(e.request.postData ?? '{}') });
    const cors = [
      { name: 'Access-Control-Allow-Origin', value: origin },
      { name: 'Access-Control-Allow-Methods', value: 'POST' },
      { name: 'Access-Control-Allow-Headers', value: 'Content-Type' },
      { name: 'Content-Type', value: 'application/json' },
    ];
    const body = e.request.method === 'POST' ? JSON.stringify({ ok: true, issue: { number: 77, url: 'https://github.com/mathulbrich/duel-lens/issues/77' } }) : '';
    void swCdp.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: e.request.method === 'POST' ? 201 : 204, responseHeaders: cors, body: Buffer.from(body).toString('base64') });
  });

  // Scan Dark Magician by drag.
  const box = await page.evaluate(() => {
    const r = document.getElementById('dm')!.getBoundingClientRect();
    return { x: r.x - 6, y: r.y - 6, w: r.width + 12, h: r.height + 12 };
  });
  await focusPageControl(page);
  await worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
  await waitForState(page, ['selecting'], 15000);
  await sleep(1500);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.w, box.y + box.h, { steps: 8 });
  await page.mouse.up();
  const state = await waitForState(page, ['result', 'error'], 60000);
  console.log(`scanned: ${state.card ?? state.state}`);

  const cdp = await page.createCDPSession();
  await clickInPopover(page, cdp, 'button', 'Report issue');
  await sleep(300);
  const listed = await popoverText(cdp);
  if (!listed?.includes('the card shown: Dark Magician')) problems.push('the panel does not list the card shown');
  await clickInPopover(page, cdp, 'textarea', "What's wrong? (optional)");
  await page.keyboard.type('E2E: it is right, testing the report');
  await page.screenshot({ path: path.join(root, 'test/e2e/out/report-panel.png') });
  await clickInPopover(page, cdp, 'button', 'Send report');
  for (let i = 0; i < 50 && !(await popoverText(cdp))?.includes('#77'); i++) await sleep(200);
  await page.screenshot({ path: path.join(root, 'test/e2e/out/report-sent.png') });

  const req = sent[0];
  if (!req) problems.push('no request reached the relay');
  else {
    const b = req.body;
    const origin = req.headers.Origin ?? req.headers.origin ?? '';
    const imageBytes = ((b.image as string).length - 'data:image/jpeg;base64,'.length) * 0.75;
    console.log(`relay request: origin ${origin}, kind ${b.kind}, shown ${b.shown?.name}, image ${Math.round(imageBytes / 1024)} KB, comment "${b.comment}", app ${JSON.stringify(b.app)}, video ${JSON.stringify(b.video)}`);
    if (!origin.startsWith('chrome-extension://')) problems.push(`the Origin was "${origin}"`);
    if (!/^data:image\/jpeg;base64,/.test(b.image) || imageBytes > 200 * 1024) problems.push('the image is not a JPEG under 200 KB');
    if (b.shown?.name !== 'Dark Magician') problems.push(`shown: ${b.shown?.name}`);
    if (b.comment !== 'E2E: it is right, testing the report') problems.push(`comment: "${b.comment}"`);
    if (!/^\d+\.\d+\.\d+$/.test(b.app?.version ?? '')) problems.push('no version');
    if (b.video?.url !== `http://127.0.0.1:${port}/`) problems.push(`video: ${JSON.stringify(b.video)}`);
  }
  if (!(await popoverText(cdp))?.includes('Reported as issue #77')) problems.push('the popover does not show the issue');
} finally {
  await browser.close();
  server.close();
}
console.log(problems.length ? `FAIL\n- ${problems.join('\n- ')}` : 'Report E2E passed');
process.exit(problems.length ? 1 : 0);
