// Diagnostic: can the service worker fetch a card image, and does get-image answer?
import path from 'node:path';
import puppeteer from 'puppeteer';
const root = path.resolve(import.meta.dirname, '../..');
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [path.join(root, 'dist-e2e')] });
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const worker = (await sw.worker())!;
  const direct = await worker.evaluate(async () => {
    try {
      const r = await fetch('https://images.ygoprodeck.com/images/cards_small/14558127.jpg');
      return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.arrayBuffer()).byteLength };
    } catch (e) { return { error: String(e) }; }
  });
  console.log('SW direct fetch:', JSON.stringify(direct));
  const page = await browser.newPage();
  const extId = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${extId}/options.html`);
  const viaMsg = await page.evaluate(async () => {
    const res: any = await chrome.runtime.sendMessage({ type: 'get-image', imageId: 14558127, size: 'small' });
    return res?.dataUrl ? res.dataUrl.slice(0, 40) + '… (' + res.dataUrl.length + ' chars)' : JSON.stringify(res);
  });
  console.log('get-image via message:', viaMsg);
} finally { await browser.close(); }
