// Diagnostic for the crop build (--no-remote-images: no host permission; no --e2e): npx tsx test/e2e/diag-store.ts <build dir> <out dir>
// Build one with: node build.mjs --no-remote-images --out <build dir> (never into dist/, the installed build).
// (The default build, the store build since decision D2, has host access to images.ygoprodeck.com, so
// the images control below doesn't hold for it.)
// - The install opens the welcome page; its consent step is agreed to with a real click.
// - The card data API (db.ygoprodeck.com) answers the service worker without any host permission
//   (CORS "*"), for the version check and the card list, and "Check for updates now" works; as a
//   control, images.ygoprodeck.com (no CORS headers) can't be read without host access.
// - Screenshots of the welcome page, Options, the privacy policy and the licences, as shipped.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const [buildDir, outDir] = process.argv.slice(2).map((p) => path.resolve(p));
if (!buildDir || !outDir) throw new Error('usage: npx tsx test/e2e/diag-store.ts <build dir> <out dir>');
await mkdir(outDir, { recursive: true });

const report: Record<string, unknown> = {};
const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [buildDir], args: ['--no-first-run'] });
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 30000 });
  const worker = (await sw.worker())!;
  const id = new URL(sw.url()).host;
  report.manifestHosts = await worker.evaluate('chrome.runtime.getManifest().host_permissions || []');

  // The welcome page the install opened, and a real "Agree and start".
  const welcomeTarget = await browser.waitForTarget((t) => t.url() === `chrome-extension://${id}/welcome.html`, { timeout: 30000 });
  const welcome = (await welcomeTarget.page())!;
  await welcome.setViewport({ width: 1280, height: 900 });
  await welcome.waitForFunction("document.body.innerText.includes('Before your first scan')", { timeout: 30000 });
  await welcome.waitForFunction("document.body.innerText.includes('Ready:')", { timeout: 60000 }).catch(() => {});
  await welcome.screenshot({ path: path.join(outDir, 'welcome-store-top.png') });
  await welcome.screenshot({ path: path.join(outDir, 'welcome-store-full.png'), fullPage: true });
  report.consentBefore = await worker.evaluate("chrome.storage.local.get('consentedAt')");
  const [agree] = await welcome.$$('xpath/.//button[normalize-space()="Agree and start"]');
  await agree.click();
  await welcome.waitForFunction("document.body.innerText.includes(\"You're all set: press\")", { timeout: 15000 });
  const done = await welcome.$('#consent');
  await done?.screenshot({ path: path.join(outDir, 'welcome-store-agreed.png') });
  report.consentAfter = await worker.evaluate("chrome.storage.local.get('consentedAt')");

  // The card data API without host permission, from the service worker (where refreshIfChanged runs).
  report.cors = await worker.evaluate(`(async () => {
    const out = {};
    const tryFetch = async (url, read) => {
      try {
        const r = await fetch(url);
        return { status: r.status, ...(await read(r)) };
      } catch (e) {
        return { error: String(e) };
      }
    };
    out.checkDBVer = await tryFetch('https://db.ygoprodeck.com/api/v7/checkDBVer.php', async (r) => ({ body: JSON.stringify(await r.json()).slice(0, 120) }));
    out.cardinfo = await tryFetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?name=Pot%20of%20Greed&misc=yes', async (r) => {
      const j = await r.json();
      return { card: j.data && j.data[0] && j.data[0].name, konamiId: j.data && j.data[0] && j.data[0].misc_info && j.data[0].misc_info[0] && j.data[0].misc_info[0].konami_id };
    });
    out.imagesControl = await tryFetch('https://images.ygoprodeck.com/images/cards_small/55144522.jpg', async (r) => ({ bytes: (await r.arrayBuffer()).byteLength }));
    return out;
  })()`);

  // Options: "Check for updates now" (the real refresh-cards path), and the page as shipped.
  const options = await browser.newPage();
  await options.setViewport({ width: 1100, height: 900 });
  await options.goto(`chrome-extension://${id}/options.html`);
  await options.waitForFunction("document.body.innerText.includes('Ready:')", { timeout: 60000 }).catch(() => {});
  report.refreshCards = await options.evaluate("chrome.runtime.sendMessage({ type: 'refresh-cards' })");
  report.status = await options.evaluate(`chrome.runtime.sendMessage({ type: 'get-status' }).then((s) => ({ dbVersion: s.dbVersion, cardCount: s.cardCount, consentedAt: s.consentedAt, indexUpdate: s.indexUpdate }))`);
  await options.reload();
  await options.waitForFunction("document.body.innerText.includes('You agreed on')", { timeout: 60000 }).catch(() => {});
  await options.screenshot({ path: path.join(outDir, 'options-store-full.png'), fullPage: true });

  // The bundled privacy policy and licences.
  for (const page of ['privacy', 'licenses']) {
    const p = await browser.newPage();
    await p.setViewport({ width: 1100, height: 900 });
    await p.goto(`chrome-extension://${id}/${page}.html`);
    await p.waitForSelector('h2', { timeout: 15000 });
    await p.screenshot({ path: path.join(outDir, `${page}-store.png`) });
    report[page] = await p.evaluate(`({
      headings: document.querySelectorAll('h2').length,
      mentionsImageHost: document.body.innerText.includes('images.ygoprodeck.com'),
      text: document.body.innerText.slice(0, 160),
    })`);
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify(report, null, 2));
await writeFile(path.join(outDir, 'diag-store.json'), JSON.stringify(report, null, 2));
