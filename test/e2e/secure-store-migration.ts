// The D-FF2 move in a real Chrome (src/background/secure-store.ts): an extension with 0.9.2's data in
// chrome.storage.local (the API key in the settings, the history, a picture), at its service worker's next
// start (as after an update, or an idle stop), moves it into its own IndexedDB, leaves no copy in chrome.storage.local, and shows
// the same key (Options) and history (side panel); a second start changes nothing.
// Run: DUEL_LENS_E2E_DIST=<a built E2E folder> npx tsx test/e2e/secure-store-migration.ts
// (it doesn't build: build it first with node build.mjs --e2e [--no-remote-images] --out <dir>, or point it at
// run.ts's.) With the crop build (--no-remote-images) it also checks that the side panel shows the moved picture.
import path from 'node:path';
import puppeteer, { type Browser } from 'puppeteer';
import { langArgs, READ_PRIVATE_STORE } from './harness';

const root = path.resolve(import.meta.dirname, '../..');
const dist = path.resolve(root, process.env.DUEL_LENS_E2E_DIST ?? 'dist-e2e');

const KEY = 'sk-ant-api03-e2e-from-0.9.2';
const entry = (id: string, cardId: number, at: number) => ({
  id,
  cardId,
  imageId: cardId,
  score: 0.9,
  confident: true,
  at,
  pageUrl: 'https://www.youtube.com/watch?v=e2e',
  pageTitle: 'A duel',
  videoTime: at / 1000,
  source: 'video',
});
const STORED_092 = {
  settings: { ai: { enabled: false, apiKey: KEY, model: 'claude-opus-5' }, debug: { saveCrops: false }, display: { reveal: 'click', banlist: 'ocg', cardLanguage: 'en' } },
  history: [entry('e2', 14558127, 2_000_000), entry('e1', 46986414, 1_000_000)],
  'thumb:e2': 'data:image/jpeg;base64,/9j/E2',
};

/** JSON with sorted keys: chrome.storage.local hands objects back with their keys sorted. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const same = (a: unknown, b: unknown) => canon(a) === canon(b);

const problems: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'pass' : 'FAIL'}: ${what}`);
  if (!ok) problems.push(what);
};

/**
 * Evaluates `expression` in the extension's service worker, through a fresh CDP session each time: after a
 * stop, Puppeteer's WebWorker handle stays bound to the dead worker.
 */
async function inWorker(browser: Browser, expression: string): Promise<unknown> {
  const target = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const session = await target.createCDPSession();
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the worker did not answer')), 3000));
    const res = await Promise.race([session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), timeout]);
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/**
 * Stops the service worker (CDP Target.closeTarget) and wakes a new one with an extension page, whose
 * get-status message starts it: a worker start, as after an update or an idle stop. (chrome.runtime.reload
 * does nothing to an extension Puppeteer loaded.) chrome.storage.local and IndexedDB stay. A mark set in the
 * old worker's global scope tells the new one apart.
 */
async function restart(browser: Browser, extId: string): Promise<void> {
  await inWorker(browser, 'self.__oldWorker = true');
  const cdp = await browser.target().createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
  if (!sw) throw new Error('no service worker to stop');
  await cdp.send('Target.closeTarget', { targetId: sw.targetId });
  await new Promise((r) => setTimeout(r, 500));
  const waker = await browser.newPage();
  await waker.goto(`chrome-extension://${extId}/options.html`);
  for (const t0 = Date.now(); Date.now() - t0 < 15000; await new Promise((r) => setTimeout(r, 250))) {
    if ((await inWorker(browser, 'self.__oldWorker === undefined').catch(() => false)) === true) {
      await waker.close();
      await new Promise((r) => setTimeout(r, 1500)); // the move runs at the worker's start
      return;
    }
  }
  throw new Error('the service worker did not start again');
}

const readLocal = (b: Browser) => inWorker(b, 'chrome.storage.local.get(null)') as Promise<Record<string, unknown>>;
const readPrivate = (b: Browser, keys: string[]) => inWorker(b, `${READ_PRIVATE_STORE}(${JSON.stringify(keys)})`) as Promise<unknown[]>;

const browser = await puppeteer.launch({ headless: true, pipe: true, enableExtensions: [dist], args: ['--no-first-run', ...langArgs()] });
try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const extId = new URL(swTarget.url()).host;
  await new Promise((r) => setTimeout(r, 1500)); // the install's own start-up (welcome tab, seeding)
  await inWorker(browser, `chrome.storage.local.set(${JSON.stringify(STORED_092)})`);
  const before = await readLocal(browser);
  check(JSON.stringify(before).includes(KEY), 'set up: chrome.storage.local holds the 0.9.2 key, history and picture');

  await restart(browser, extId);
  const after = await readLocal(browser);
  const [key, history, thumb] = await readPrivate(browser, ['apiKey', 'history', 'thumb:e2']);
  check(key === KEY, `the key is in the private store (${String(key)})`);
  check(same(history, STORED_092.history), 'the history is in the private store, unchanged');
  check(thumb === STORED_092['thumb:e2'], 'the picture is in the private store');
  check(!JSON.stringify(after).includes(KEY) && !('history' in after) && !Object.keys(after).some((k) => k.startsWith('thumb:')), `chrome.storage.local keeps no key, history or picture (keys: ${Object.keys(after).sort().join(', ')})`);
  const settings = after.settings as { ai?: object; display?: object } | undefined;
  check(same(settings?.ai, { enabled: false, model: 'claude-opus-5' }) && same(settings?.display, STORED_092.settings.display), 'the other settings stay as they were');

  const options = await browser.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  await options.waitForSelector('input[placeholder="sk-ant-..."]', { timeout: 10000 });
  await new Promise((r) => setTimeout(r, 500));
  const shown = await options.$eval('input[placeholder="sk-ant-..."]', (el) => (el as HTMLInputElement).value);
  check(shown === KEY, `Options shows the moved key (${shown})`);
  await options.close();

  const panel = await browser.newPage();
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.waitForSelector('ul.history li', { timeout: 10000 }).catch(() => undefined);
  const rows = await panel.$$eval('ul.history li', (els) => els.length);
  check(rows === 2, `the side panel lists the moved history (${rows} rows)`);
  const crop = await panel.waitForSelector('.current img.own', { timeout: 5000 }).then((el) => el?.evaluate((img) => img.getAttribute('src')), () => undefined);
  if (crop === undefined) console.log('(no own picture in the side panel: a build with remote images shows the card image)');
  else check(crop === STORED_092['thumb:e2'], 'the side panel shows the moved picture (the crop build)');
  await panel.close();

  const settled = await readLocal(browser);
  await restart(browser, extId);
  const again = await readLocal(browser);
  const [key2, history2] = await readPrivate(browser, ['apiKey', 'history']);
  check(same(again, settled) && key2 === KEY && same(history2, STORED_092.history), 'a second start changes nothing');
} finally {
  await browser.close();
}
console.log(problems.length ? `secure-store migration: ${problems.length} FAILED` : 'secure-store migration: all pass');
process.exit(problems.length ? 1 : 0);
