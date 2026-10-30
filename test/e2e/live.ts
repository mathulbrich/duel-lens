// End-to-end check of Live, the measurement gate (spec D-L12): plays a 30 s synthetic clip (live.html: cards
// slide onto a playmat, a hand crosses the picture) through canvas.captureStream in real Chrome with the E2E
// build, starts Live through the debug hook, and watches the log.
// Run: npm run e2e:live   (report: test/e2e/out/live-report.json; exit 1 when an assertion fails)
// On a slow computer: test/e2e/low-end/run.sh low live (the environment variables of test/e2e/low-end.ts).
// Asserts: every card named in data-expect is listed and no other; each within 15 s of its placement; the first
// while the hand still moves (before 10 s of clip time); median intervalMs <= 800 (balanced); each step's
// (thumbMs, encodeMs, cropMs) 95th percentile <= 50 ms.
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { lowEnd, lowEndLaunch } from './low-end';
import { checkLiveReport, grantConsent, langArgs, runLiveClip, settleInstall } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = process.env.DUEL_LENS_E2E_DIST ? path.resolve(root, process.env.DUEL_LENS_E2E_DIST) : path.join(root, 'dist-e2e');
const outDir = path.join(root, 'test/e2e/out');

function serve(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const file = url === '/' ? path.join(root, 'test/e2e/live.html') : url.startsWith('/cards/') ? path.join(root, 'test/fixtures', path.normalize(url)) : '';
    if (!file || !file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'image/jpeg' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

execFileSync('node', ['build.mjs', '--e2e', '--out', dist], { cwd: root, stdio: 'inherit' });
await mkdir(outDir, { recursive: true });
const server = await serve();
const port = (server.address() as AddressInfo).port;
const launch = lowEndLaunch(lowEnd());
const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  enableExtensions: [dist],
  defaultViewport: { width: 1500, height: 1000 },
  ...(launch.executablePath ? { executablePath: launch.executablePath } : {}),
  args: ['--window-size=1500,1000', '--no-first-run', ...langArgs(), ...launch.args],
});
let failures: string[] = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.text().includes('Duel Lens')) console.log('[page]', m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
  await page.bringToFront();
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const worker = (await sw.worker())!;
  await settleInstall(browser, page);
  await grantConsent(worker);
  const call = (fn: string, ...args: unknown[]) => worker.evaluate((f, a) => (globalThis as any).duelLensDebug[f](...a), fn, args);
  const report = await runLiveClip({ call, page });
  failures = checkLiveReport(report, { interval: true });
  writeFileSync(path.join(outDir, 'live-report.json'), JSON.stringify({ ...report, failures }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  failures.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\nLive E2E FAILED (${failures.length}):\n- ${failures.join('\n- ')}` : '\nLive E2E passed');
process.exitCode = failures.length ? 1 : 0;
