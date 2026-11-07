// Manual check of Live check on pictures (spec D-L15) on a real page the user named: the deck lists of
// https://roadoftheking.com/ocg-2026-10-metagame-report-2-3-4/ are <img>s. Turns Live check on through the settings
// (the E2E build holds <all_urls>), rests the pointer on points of the first deck list and saves a screenshot after each.
// Run: npx tsx test/e2e/live-check-pictures.ts
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { grantConsent, langArgs, settleInstall } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, 'dist-e2e');
const outDir = path.join(root, 'test/e2e/out/live-check-pictures');
const URL = 'https://roadoftheking.com/ocg-2026-10-metagame-report-2-3-4/';

execFileSync('node', ['build.mjs', '--e2e', '--out', dist], { cwd: root, stdio: 'inherit' });
await mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [dist], defaultViewport: { width: 1400, height: 1000 }, args: ['--no-first-run', ...langArgs()] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.text().includes('Duel Lens')) console.log('[page]', m.text());
  });
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const worker = (await sw.worker())!;
  await settleInstall(browser, page);
  await grantConsent(worker);
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });
  await worker.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const s = (settings ?? {}) as { live?: object };
    await chrome.storage.local.set({ settings: { ...s, live: { effort: 'balanced', showLabel: true, ...s.live, check: true } } });
  });
  await new Promise((r) => setTimeout(r, 3000)); // registered and injected
  const deck = () => [...document.images].find((i) => i.naturalWidth > 900 && i.naturalHeight > 1000);
  await page.evaluate(`(${deck})()?.scrollIntoView({ block: 'start', behavior: 'instant' })`);
  await new Promise((r) => setTimeout(r, 1500));
  const box = (await page.evaluate(`(() => { const r = (${deck})()?.getBoundingClientRect(); return r && { x: r.left, y: r.top, w: r.width, h: Math.min(r.height, innerHeight - r.top) }; })()`)) as { x: number; y: number; w: number; h: number } | null;
  console.log('deck list image', box);
  if (!box || box.h < 100) throw new Error('no deck list image in view');
  for (const [i, [fx, fy]] of [[0.12, 0.3], [0.3, 0.3], [0.5, 0.55]].entries()) {
    await page.mouse.move(box.x + box.w * fx - 3, box.y + box.h * fy - 3);
    await page.mouse.move(box.x + box.w * fx, box.y + box.h * fy, { steps: 3 });
    await new Promise((r) => setTimeout(r, 6000));
    await page.screenshot({ path: path.join(outDir, `rest-${i}.png`) as `${string}.png` });
  }
  console.log('screenshots in', outDir);
} finally {
  await browser.close();
}
