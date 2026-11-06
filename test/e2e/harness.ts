// Helpers shared by both modes of the end-to-end test (run.ts): the content script mirrors its UI
// state onto the host element's data attributes (src/content/host.ts), since its shadow root is closed.
import type { Browser, CDPSession, Page, WebWorker } from 'puppeteer';
import { NO_CARD_DETECTOR } from '../../src/background/offscreen-client';

// ---------- the first-run consent ----------
// A fresh profile has no consent: the install opens the welcome page, and the shortcut opens its
// consent step instead of scanning (src/background/scan.ts), until the harness agrees for the user.

/** What a tab's URL says about the welcome page: its consent step, the page itself, or neither. */
/**
 * Chrome's flags for its interface language (src/shared/i18n.ts reads it), English unless DUEL_LENS_E2E_LANG says
 * another ("de", "ja"): every run checks English text. macOS ignores --lang, so Chrome is also given the
 * AppleLanguages default there.
 */
export function langArgs(lang = process.env.DUEL_LENS_E2E_LANG || 'en-US'): string[] {
  return [`--lang=${lang}`, ...(process.platform === 'darwin' ? ['-AppleLanguages', `(${lang})`] : [])];
}

export function welcomeKind(url: string): 'consent' | 'welcome' | null {
  const m = /^chrome-extension:\/\/[^/]+\/welcome\.html(#[^?]*)?$/.exec(url);
  if (!m) return null;
  return m[1] === '#consent' ? 'consent' : 'welcome';
}

/**
 * Brings `page` back to the front after another tab took it (the welcome page, the consent step), and
 * re-applies its emulated viewport: a page that went to the background is captured at its tab's real
 * size again (87 px shorter than the emulated viewport here), which cut off the frames placed at the
 * bottom edge (measured: captureVisibleTab gave 1500x913 for a 1500x1000 viewport until then).
 */
async function refocus(page: Page): Promise<void> {
  await page.bringToFront();
  const viewport = page.viewport();
  if (viewport) await page.setViewport(viewport);
}

/**
 * The install opens the welcome page (onInstalled, reason 'install'). Waits for it, closes it and
 * brings `page` back to the front, so the scans' active tab is the test page. Throws if it never opens.
 */
export async function settleInstall(browser: Browser, page: Page, timeoutMs = 30000): Promise<void> {
  const target = await browser.waitForTarget((t) => welcomeKind(t.url()) === 'welcome', { timeout: timeoutMs }).catch(() => {
    throw new Error(`the install did not open welcome.html within ${timeoutMs / 1000} s`);
  });
  await (await target.page())?.close();
  await refocus(page);
}

/**
 * The consent gate, end to end: before the consent, the shortcut must open welcome.html#consent, which
 * asks for it, and leave the test page alone (no Duel Lens element on it). Saves a screenshot of the
 * consent step to `shot` when given, closes that tab and brings `page` back.
 */
export async function checkConsentGate(browser: Browser, worker: WebWorker, page: Page, shot?: string): Promise<string> {
  await worker.evaluate(() => (globalThis as any).duelLensDebug.startScan());
  const target = await browser.waitForTarget((t) => welcomeKind(t.url()) === 'consent', { timeout: 20000 }).catch(() => {
    throw new Error('consent gate: a scan before the consent did not open welcome.html#consent');
  });
  const consent = (await target.page())!;
  await consent.setViewport({ width: 1280, height: 900 });
  await consent.waitForFunction("document.body.innerText.includes('Duel Lens needs your OK before its first scan.')", { timeout: 20000 });
  await consent.waitForFunction('document.activeElement && document.activeElement.id === "consent"', { timeout: 5000 });
  if (shot) await consent.screenshot({ path: shot });
  const touched = await page.evaluate("!!document.getElementById('duel-lens-host')");
  await consent.close();
  await refocus(page);
  if (touched) throw new Error('consent gate: the scan before the consent put Duel Lens on the page');
  return 'a scan before the consent opened welcome.html#consent (focused, "Duel Lens needs your OK before its first scan.") and left the page alone';
}

/** What "Agree and start" does (the E2E-only debug hook, src/background/debug-hook.ts). */
export async function grantConsent(worker: WebWorker): Promise<void> {
  await worker.evaluate(() => (globalThis as any).duelLensDebug.grantConsent());
}

/**
 * Runs `fn` (a function declaration, `this` = the root) on the Duel Lens host's closed shadow root,
 * through CDP (which the page itself can't do); null when there is no host.
 */
export async function inShadowRoot<T>(cdp: CDPSession, fn: string): Promise<T | null> {
  const { result: host } = await cdp.send('Runtime.evaluate', { expression: "document.getElementById('duel-lens-host')" });
  if (!host.objectId) return null;
  let rootId: string | undefined;
  try {
    const { node } = await cdp.send('DOM.describeNode', { objectId: host.objectId, depth: 1, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    rootId = (await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId })).object.objectId;
    if (!rootId) return null;
    const { result } = await cdp.send('Runtime.callFunctionOn', { objectId: rootId, functionDeclaration: fn, returnByValue: true });
    return result.value as T;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: host.objectId }).catch(() => {});
    if (rootId) await cdp.send('Runtime.releaseObject', { objectId: rootId }).catch(() => {});
  }
}

/**
 * The popover's picture, read through its closed shadow root (as real.ts reads the popover): the
 * first bytes of its src, and whether it is the user's own crop (the crop build, --no-remote-images) or
 * the card's image.
 */
export function readPopoverPicture(cdp: CDPSession): Promise<{ src: string | null; ownCrop: boolean; altThumbs: number } | null> {
  return inShadowRoot(
    cdp,
    `function () {
      const img = this.querySelector('.dv-card img');
      return {
        src: img ? (img.getAttribute('src') || '').slice(0, 22) : null,
        ownCrop: !!this.querySelector('.dv-card.crop'),
        altThumbs: this.querySelectorAll('.alt img').length,
      };
    }`,
  );
}

/** The popover's card name, its English subtitle (card text language) and the name's lang attribute. */
export function readPopoverName(cdp: CDPSession): Promise<{ name: string | null; english: string | null; lang: string | null } | null> {
  return inShadowRoot(
    cdp,
    `function () {
      const name = this.querySelector('.pop .dv-name');
      const en = this.querySelector('.pop .dv-en');
      return {
        name: name ? name.textContent.trim() : null,
        english: en ? en.textContent.replace(/\\s+/g, ' ').trim() : null,
        lang: name ? name.getAttribute('lang') : null,
      };
    }`,
  );
}

/** Where focus is in the overlay (a11y review B2): the focused element's classes, and whether it draws a focus ring. */
export interface ShadowFocus {
  /** The class of the element focused inside the shadow root, null when none is. */
  focused: string | null;
  /** The page's own view: document.activeElement is the host when focus is inside it. */
  hostFocused: boolean;
  /** Whether the focused element matches :focus-visible, and its computed outline style. */
  focusVisible: boolean;
  outline: string | null;
}

export async function readShadowFocus(cdp: CDPSession): Promise<ShadowFocus | null> {
  const inside = await inShadowRoot<Omit<ShadowFocus, 'hostFocused'>>(
    cdp,
    `function () {
      const el = this.activeElement;
      return {
        focused: el ? el.getAttribute('class') || el.tagName : null,
        focusVisible: !!el && el.matches(':focus-visible'),
        outline: el ? getComputedStyle(el).outlineStyle : null,
      };
    }`,
  );
  if (!inside) return null;
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: "document.activeElement === document.getElementById('duel-lens-host')",
    returnByValue: true,
  });
  return { ...inside, hostFocused: result.value === true };
}

/** The frozen frame's hint and whether a first corner is marked (a two-click box under way, a11y review M1). */
export function readArmedCorner(cdp: CDPSession): Promise<{ hint: string | null; corner: boolean } | null> {
  return inShadowRoot(
    cdp,
    `function () {
      const hint = this.querySelector('.hint');
      return { hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : null, corner: !!this.querySelector('.corner') };
    }`,
  );
}

/** The popover got focus when the answer came, without drawing a focus ring after a mouse scan (a11y review B2). */
export function checkPopoverFocus(f: ShadowFocus | null): string | null {
  if (!f) return 'no Duel Lens host to read focus from';
  if (!f.hostFocused || !f.focused?.split(' ').includes('pop')) return `focus is not on the popover (inside: ${f.focused ?? 'nothing'}, host focused: ${f.hostFocused})`;
  if (f.focusVisible && f.outline !== 'none') return `the focused popover draws a focus ring (${f.outline})`;
  return null;
}

/**
 * page.html's hostile page (security review H1): the Duel Lens tags it saw and defined, how many
 * ElementInternals it got hold of, and how many of those reached a shadow root.
 */
export async function readH1Probe(page: Page): Promise<{ tags: string[]; grabbed: number; leaked: number }> {
  return (await page.evaluate(`(() => {
    const p = window.h1Probe;
    if (!p) return { tags: [], grabbed: -1, leaked: -1 };
    const grabbed = p.internals.filter((x) => x.internals);
    return { tags: p.tags.slice(), grabbed: grabbed.length, leaked: grabbed.filter((x) => x.internals.shadowRoot != null).length };
  })()`)) as { tags: string[]; grabbed: number; leaked: number };
}

/**
 * Closes the overlay the way a user does, with Escape: once more when the first only cancelled an
 * armed corner (a click beside the outlines starts a two-click box). True once the host is gone.
 */
export async function closeOverlay(page: Page): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    const gone = await page
      .waitForFunction("!document.getElementById('duel-lens-host')", { polling: 'mutation', timeout: 1000 })
      .then(
        () => true,
        () => false,
      );
    if (gone) return true;
  }
  return false;
}

/** Gives focus to page.html's own control, as if the user had been on the video player when pressing the shortcut. */
export async function focusPageControl(page: Page): Promise<void> {
  await page.evaluate("document.getElementById('page-focus').focus()");
}

/**
 * After Duel Lens closed: the page's control has focus again and the page gets K (a11y review B1).
 * Null when both hold, else what went wrong.
 */
export async function checkPageFocusBack(page: Page): Promise<string | null> {
  const focused = (await page.evaluate("document.activeElement ? document.activeElement.id || document.activeElement.tagName : null")) as string | null;
  await page.evaluate('window.pageKeys = []');
  await page.keyboard.press('k');
  const keys = (await page.evaluate('window.pageKeys.slice()')) as string[];
  const problems = [
    focused === 'page-focus' ? null : `focus went to ${focused ?? 'nothing'}, not back to the page's control`,
    keys.includes('k') ? null : 'the page did not get K',
  ].filter(Boolean);
  return problems.length ? problems.join('; ') : null;
}

export async function hostState(page: Page) {
  return page.evaluate(() => {
    const host = document.getElementById('duel-lens-host');
    return host
      ? {
          state: host.getAttribute('data-duel-lens-state'),
          card: host.getAttribute('data-duel-lens-card'),
          confident: host.getAttribute('data-duel-lens-confident'),
        }
      : null;
  });
}

export async function waitForState(page: Page, states: string[], timeoutMs: number) {
  const start = Date.now();
  for (;;) {
    const s = await hostState(page);
    if (s?.state && states.includes(s.state)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${states.join('/')} (last: ${JSON.stringify(s)})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------- click to scan ----------
// Code evaluated in the page or the service worker is written as strings: tsx compiles with
// keepNames, whose __name() helper those contexts don't have.

export type Corners = [number, number][];

/**
 * Records, in the service worker, each begin-selection and cards-detected the background sends to a
 * tab (the capturedAt a fake detection must carry; when the real detection arrived and what it held).
 * With `suppress` set (--fake-detect), the build's own cards-detected is recorded but not delivered,
 * so it can't beat the harness's fake one to the tab (the tab takes the first for its screenshot).
 */
const INSTALL_TAB_TAP = `(() => {
  if (globalThis.__duelLensE2eTabTap) return true;
  const tabs = chrome.tabs;
  const original = tabs.sendMessage;
  const tap = { begin: null, detected: [], suppress: false, send: (...args) => original.apply(tabs, args) };
  // The screenshot's size, from its PNG header (IHDR: width and height at bytes 16 and 20).
  const pngSize = (url) => {
    try {
      const b = atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 45));
      const u32 = (i) => ((b.charCodeAt(i) << 24) | (b.charCodeAt(i + 1) << 16) | (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3)) >>> 0;
      return { width: u32(16), height: u32(20) };
    } catch (e) {
      return null;
    }
  };
  const wrapped = function (...args) {
    const msg = args[1];
    if (msg && msg.type === 'begin-selection') tap.begin = { tabId: args[0], capturedAt: msg.capturedAt, at: Date.now(), shot: pngSize(msg.screenshot || '') };
    if (msg && msg.type === 'cards-detected') {
      const d = msg.detection || {};
      tap.detected.push({ capturedAt: msg.capturedAt, boxes: (d.boxes || []).length, width: d.width, height: d.height, ms: d.ms, error: d.error || null, at: Date.now() });
      if (tap.suppress) return Promise.resolve({ ok: true });
    }
    return original.apply(tabs, args);
  };
  try { tabs.sendMessage = wrapped; } catch (e) {}
  if (tabs.sendMessage !== wrapped) {
    try { Object.defineProperty(tabs, 'sendMessage', { value: wrapped, configurable: true, writable: true }); } catch (e) {}
  }
  if (tabs.sendMessage !== wrapped) return false;
  globalThis.__duelLensE2eTabTap = tap;
  return true;
})()`;

/** Installs the tab tap (idempotent); `suppress` holds back the build's own detections (--fake-detect). */
export async function installTabTap(worker: WebWorker, suppress: boolean): Promise<boolean> {
  if (!((await worker.evaluate(INSTALL_TAB_TAP)) as boolean)) return false;
  await worker.evaluate(`globalThis.__duelLensE2eTabTap.suppress = ${suppress}`);
  return true;
}

export interface TabTap {
  begin: { tabId: number; capturedAt: number; at: number; shot: { width: number; height: number } | null } | null;
  detected: { capturedAt: number; boxes: number; width: number; height: number; ms: number; error: string | null; at: number }[];
}

export async function readTabTap(worker: WebWorker): Promise<TabTap | null> {
  return (await worker.evaluate('globalThis.__duelLensE2eTabTap || null')) as TabTap | null;
}

/** Centre, size and angle of a box from its corners (DetectedCardBox, shared/messages.ts), so a fake box is complete. */
function boxOf(pts: Corners) {
  const [p0, p1, , p3] = pts;
  return {
    cx: pts.reduce((s, p) => s + p[0], 0) / 4,
    cy: pts.reduce((s, p) => s + p[1], 0) / 4,
    w: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
    h: Math.hypot(p3[0] - p0[0], p3[1] - p0[1]),
    angle: Math.atan2(p1[1] - p0[1], p1[0] - p0[0]),
    conf: 1,
    pts,
  };
}

/**
 * --fake-detect: stands in for the detector. Sends the tab a cards-detected for the last
 * begin-selection, with these boxes (screenshot pixels), the way the background would.
 */
export async function sendFakeDetection(worker: WebWorker, boxes: Corners[], size: { width: number; height: number }) {
  const detection = { boxes: boxes.map(boxOf), width: size.width, height: size.height, ms: 0 };
  await worker.evaluate(`(async () => {
    const tap = globalThis.__duelLensE2eTabTap;
    if (!tap || !tap.begin) throw new Error('no begin-selection recorded');
    await tap.send(tap.begin.tabId, { type: 'cards-detected', capturedAt: tap.begin.capturedAt, detection: ${JSON.stringify(detection)} });
    return true;
  })()`);
}

/**
 * --click without --fake-detect needs a card detector. Thrown on the first scan when the build says
 * it has none: its detection's error is exactly NO_CARD_DETECTOR, and nothing else (click-review I2).
 */
export class NoDetector extends Error {}

/**
 * What one click-to-scan scan's detection says, before the click (click-review I2):
 * - `skip`: the build has no card detector (the detection's error is exactly NO_CARD_DETECTOR). The
 *   run stops with SKIPPED and exit 0 when this is the first scan; a later scan can't say it.
 * - `fail`: anything else that leaves nothing to click: no cards-detected reached the tab, the
 *   detection failed some other way (the detector didn't load, a decode error, a timeout, the
 *   offscreen document out of reach), or the tab outlined none of what the detection brought.
 * - null: the build's detector answered and the tab outlined its cards (maybe none: a frame of none).
 * `detection` is what the background sent the tab (installTabTap); `outlines` what the tab showed.
 */
export function checkDetection(
  outlines: number | null,
  detection: { boxes: number; error: string | null } | null | undefined,
  waitedMs: number,
): { skip: string } | { fail: string } | null {
  const waited = `${Math.round(waitedMs / 1000)} s`;
  if (!detection) return { fail: `no cards-detected reached the tab within ${waited} of the shortcut` };
  if (detection.error === NO_CARD_DETECTOR) return { skip: `the detection said: "${detection.error}"` };
  if (detection.error) return { fail: `the card detection failed: "${detection.error}"` };
  if (outlines === null) return { fail: `the detection found ${detection.boxes} cards, but the tab showed no outlines within ${waited}` };
  return null;
}

/** --fake-detect: the harness's own detection (sendFakeDetection) must have reached the tab. */
export function checkFakeDetection(outlines: number | null, waitedMs: number): { fail: string } | null {
  return outlines === null ? { fail: `the harness's detection never reached the tab: no outlines within ${Math.round(waitedMs / 1000)} s` } : null;
}

export function skipMessage(reason: string): string {
  return (
    `SKIPPED (click to scan): this build can't outline cards: ${reason}.\n` +
    'Run with --fake-detect to test the click UI on its own, or run again once the card detector is in the build.'
  );
}

/** Waits until the frozen frame shows the detector's outlines; returns how many (0 when it found none). */
export async function waitForOutlines(page: Page, timeoutMs: number): Promise<number> {
  const handle = await page.waitForFunction(
    `(() => {
      const host = document.getElementById('duel-lens-host');
      const n = host && host.getAttribute('data-duel-lens-cards');
      return n === null || n === undefined ? false : { n: Number(n) };
    })()`,
    { polling: 'mutation', timeout: timeoutMs },
  );
  return ((await handle.jsonValue()) as { n: number }).n;
}

/**
 * Clicks (press and release, no movement) and reports whether that started a scan; a click on no
 * outline leaves the frame frozen. When `settleMs` runs out, the state is read once more: on a
 * starved machine the page may answer the wait late, and a frame still frozen then is the verdict.
 */
export async function clickStartsScan(page: Page, x: number, y: number, settleMs = 1500): Promise<boolean> {
  await page.mouse.click(x, y);
  const started = await page
    .waitForFunction(
      `(() => {
        const host = document.getElementById('duel-lens-host');
        const s = host && host.getAttribute('data-duel-lens-state');
        return !!s && s !== 'selecting';
      })()`,
      { polling: 'mutation', timeout: settleMs },
    )
    .then(
      () => true,
      () => false,
    );
  if (started) return true;
  const s = await hostState(page);
  return !!s?.state && s.state !== 'selecting';
}

/** Whether (x, y) lies inside the quad (corners in order around it, as a detection gives them). */
export function insideQuad(pts: Corners, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const cross = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    if (cross !== 0 && sign !== 0 && cross !== sign) return false;
    if (cross !== 0) sign = cross;
  }
  return true;
}

// ---------- scan mode stays open (UX-1) and hover previews (UX-2) ----------

/** What the overlay shows besides its state: how many popovers, the hover preview or hover popover (its text and box), the bar, the frozen frame. */
export interface OverlayRead {
  popovers: number;
  preview: { text: string; box: { x: number; y: number; w: number; h: number } } | null;
  bar: string | null;
  frame: boolean;
}

export function readOverlay(cdp: CDPSession): Promise<OverlayRead | null> {
  return inShadowRoot(
    cdp,
    `function () {
      // The quick preview, or (Full details on hover, the default) the hovered card's passive popover.
      const pv = this.querySelector('.pv:not(.measuring), .pop.hovering:not(.measuring)');
      const r = pv ? pv.getBoundingClientRect() : null;
      const bar = this.querySelector('.bar');
      return {
        popovers: this.querySelectorAll('.pop:not(.hovering)').length,
        preview: pv ? { text: pv.textContent.replace(/\\s+/g, ' ').trim(), box: { x: r.x, y: r.y, w: r.width, h: r.height } } : null,
        bar: bar ? bar.textContent.replace(/\\s+/g, ' ').trim() : null,
        frame: !!this.querySelector('img.shot'),
      };
    }`,
  );
}

/**
 * An expression for the worker (or an extension page): `(keys) => Promise<values>`, read from the private IndexedDB
 * store (src/background/secure-store.ts: the history, its pictures, the API key; decision D-FF2). It opens the
 * database without a version and aborts any upgrade, so a read never creates it (a missing one reads as undefined).
 */
export const READ_PRIVATE_STORE = `((keys) => new Promise((resolve, reject) => {
  const none = () => keys.map(() => undefined);
  const req = indexedDB.open('duel-lens-private');
  req.onupgradeneeded = () => req.transaction.abort();
  req.onerror = () => (req.error && req.error.name === 'AbortError' ? resolve(none()) : reject(req.error));
  req.onsuccess = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('kv') || keys.length === 0) { db.close(); return resolve(none()); }
    const store = db.transaction('kv', 'readonly').objectStore('kv');
    const out = [];
    let left = keys.length;
    keys.forEach((key, i) => {
      const get = store.get(key);
      get.onsuccess = () => { out[i] = get.result; if (--left === 0) { db.close(); resolve(out); } };
      get.onerror = () => reject(get.error);
    });
  };
}))`;

/** How many scans the history holds (the private store's history, READ_PRIVATE_STORE). */
export async function historyCount(worker: WebWorker): Promise<number> {
  return (await worker.evaluate(`${READ_PRIVATE_STORE}(['history']).then(([h]) => (Array.isArray(h) ? h.length : 0))`)) as number;
}

/** "Show card details" in Options (Settings.display.reveal): scans started after this use it. */
export async function setReveal(worker: WebWorker, reveal: 'full' | 'preview' | 'click'): Promise<void> {
  await worker.evaluate(`chrome.storage.local.get('settings').then((s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), display: { ...((s.settings || {}).display || {}), reveal: ${JSON.stringify(reveal)} } } }))`);
}

/** Waits until the host's data-duel-lens-preview (the hover preview's top line, E2E builds) is present (or gone); returns it. */
export async function waitForPreview(page: Page, present: boolean, timeoutMs: number): Promise<string | null> {
  const handle = await page.waitForFunction(
    `(() => {
      const host = document.getElementById('duel-lens-host');
      const p = host ? host.getAttribute('data-duel-lens-preview') : null;
      return ${present ? 'p !== null && { p }' : 'p === null && { p: null }'};
    })()`,
    { polling: 'mutation', timeout: timeoutMs },
  );
  return ((await handle.jsonValue()) as { p: string | null }).p;
}

// ---------- Live (live.ts, firefox.ts --live) ----------

export interface LiveRun {
  /** What the debug hook answers: duelLensDebug[fn](...args) in the worker (Chrome) or the event page (Firefox). */
  call: (fn: string, ...args: unknown[]) => Promise<unknown>;
  page: Page;
  /** How long to watch the log after the clip starts (default: the clip's length and 2 s). */
  watchMs?: number;
  /** Chrome: open the card box over the video on the first card listed (a Live row's click), while the clip plays. */
  openBox?: boolean;
  /** Chrome: also sample the outlines on the video (the debug hook's `liveOutlines`) and report them over the first card. */
  outlines?: boolean;
}

export interface StepStats {
  n: number;
  p50: number;
  p95: number;
}

/** What one run of the Live clip measured (written to test/e2e/out/live-report.json). */
export interface LiveReport {
  expected: { name: string; cardId: number; placedS: number }[];
  /** Every card listed at the end, newest first, with its name from the card store (an alternate print has its own id). */
  listed: { cardId: number; name: string | null; firstVideoTime: number }[];
  /** Listed names that are none of the expected cards (the id when the store has no name). */
  wrongListed: string[];
  /** Seconds from each expected card's placement to the poll that first saw it listed; null when never. */
  secondsToListing: Record<string, number | null>;
  intervalMs: { samples: number; median: number | null };
  steps: { thumbMs: StepStats | null; encodeMs: StepStats | null; cropMs: StepStats | null } | null;
  longTasks: { count: number; longestMs: number };
  finalStatus: string | null;
  /** The hand's sweep over the right half (clip seconds), and whether the first card was listed within it. */
  handSweepS: [number, number];
  firstListedWhileHandMoved: boolean | null;
  /** The log every 2 s of watching: status, pace, cards being confirmed, cards listed. */
  trace: { s: number; status: string; intervalMs?: number; voting?: number; listed: number }[];
  /** The card box opened on the first listed card (runLiveClip's `openBox`): what the tab answered, null when not asked. */
  box: { cardId: number; shown: boolean } | null;
  /**
   * The Live outlines over the first card's place on the page (runLiveClip's `outlines`), null when not asked: the gold
   * and dashed ones over it at the first poll that saw a gold one while that card lay still and was listed (the last
   * such poll when none did), and the outlines of any kind over it at the end, when it has long been taken off.
   */
  outlines: { whileListed: { gold: number; dashed: number }; atEnd: number; goldRect: { x: number; y: number; w: number; h: number } | null; cardRect: { x: number; y: number; w: number; h: number } } | null;
}

export const quantile = (v: number[], q: number): number => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const stepStats = (v: number[]): StepStats | null => (v.length ? { n: v.length, p50: quantile(v, 0.5), p95: quantile(v, 0.95) } : null);

/**
 * Plays the clip on `page` (live.html) under Live: starts Live, waits until it is watching, starts the clip
 * and watches the log for `watchMs` (the clip's length and 2 s: 32 s at scale 1), polling every 250 ms; then reads the step timings.
 */
export async function runLiveClip({ call, page, watchMs, openBox = false, outlines: sampleOutlines = false }: LiveRun): Promise<LiveReport> {
  const meta = (await page.evaluate(`(() => { const v = document.getElementById('vid'); return { names: v.dataset.expect.split('|'), ids: v.dataset.ids.split('|').map(Number), placed: v.dataset.placed.split('|').map(Number), sweep: v.dataset.handSweep.split('-').map(Number), length: Number(v.dataset.length) }; })()`)) as {
    length: number;
    sweep: number[];
    names: string[];
    ids: number[];
    placed: number[];
  };
  watchMs ??= (meta.length + 2) * 1000;
  const expected = meta.names.map((name, i) => ({ name, cardId: meta.ids[i], placedS: meta.placed[i] }));
  await page.evaluate(`window.longTasks = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true })`);
  await page.bringToFront();
  await page.evaluate(`document.getElementById('page-focus').focus()`);
  await call('toggleLive');
  type Log = { status: string; voting?: number; intervalMs?: number; entries: { cardId: number; imageId: number; firstVideoTime: number }[] } | null;
  const readLog = async () => (await call('liveLog')) as Log;
  // The clip waits for Live to be watching, so the engine's cold start does not eat the first card's seconds.
  for (let i = 0; i < 240; i++) {
    const s = (await readLog())?.status;
    if (s === 'watching' || s === 'slow' || s === 'blocked') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await page.evaluate('window.startClip()');
  const t0 = Date.now();
  const firstSeenS: Record<number, number> = {};
  const intervals: number[] = [];
  let log: Log = null;
  const trace: LiveReport['trace'] = [];
  let box: LiveReport['box'] = null;
  type Outline = { state: 'reading' | 'promoted'; rect: { x: number; y: number; w: number; h: number } };
  const readOutlines = async () => ((await call('liveOutlines')) as Outline[] | null) ?? [];
  // The first card (the clip draws it centred on (330, 380) of 1280x720, 200 px tall, until 14 s) in page pixels.
  const stillUntilS = Number(await page.evaluate(`document.getElementById('vid').dataset.stillUntil.split('|')[0]`));
  const vidBox = sampleOutlines ? ((await page.evaluate(`(() => { const r = document.getElementById('vid').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`)) as { x: number; y: number; w: number; h: number }) : null;
  const cardH = 200;
  const cardW = Math.round((cardH * 421) / 614);
  const cardRect = vidBox ? { x: vidBox.x + ((330 - cardW / 2) / 1280) * vidBox.w, y: vidBox.y + ((380 - cardH / 2) / 720) * vidBox.h, w: (cardW / 1280) * vidBox.w, h: (cardH / 720) * vidBox.h } : null;
  const over = (o: Outline) => !!cardRect && o.rect.x + o.rect.w / 2 >= cardRect.x && o.rect.x + o.rect.w / 2 <= cardRect.x + cardRect.w && o.rect.y + o.rect.h / 2 >= cardRect.y && o.rect.y + o.rect.h / 2 <= cardRect.y + cardRect.h;
  let whileListed: { gold: number; dashed: number } | null = null;
  let goldRect: { x: number; y: number; w: number; h: number } | null = null;
  let pointing = false;
  while (Date.now() - t0 < watchMs) {
    log = await readLog();
    const now = (Date.now() - t0) / 1000;
    // Live outlines only the card under the pointer: rest the pointer where the first card lies, once Live runs.
    if (sampleOutlines && cardRect && log && !pointing) {
      await page.mouse.move(cardRect.x + cardRect.w / 2, cardRect.y + cardRect.h / 2, { steps: 3 });
      pointing = true;
    }
    // The first card listed is clicked in the panel: its box opens over the playing video, and Live must read on.
    const first = log?.entries[0];
    if (openBox && !box && first) {
      const reply = (await call('showLiveCard', first.cardId, first.imageId)) as { shown?: boolean } | null;
      box = { cardId: first.cardId, shown: reply?.shown === true };
    }
    // While the first card lies still and is listed, a gold outline must lie over it (the pointer rests on it).
    if (sampleOutlines && !goldRect && log?.entries.length && now < stillUntilS - 1) {
      const here = (await readOutlines()).filter(over);
      whileListed = { gold: here.filter((o) => o.state === 'promoted').length, dashed: here.filter((o) => o.state === 'reading').length };
      goldRect = here.find((o) => o.state === 'promoted')?.rect ?? null;
    }
    for (const e of log?.entries ?? []) firstSeenS[e.cardId] ??= now;
    if (log?.intervalMs !== undefined) intervals.push(log.intervalMs);
    if (!trace.length || now - trace[trace.length - 1].s >= 2) trace.push({ s: Math.round(now * 10) / 10, status: log?.status ?? '', intervalMs: log?.intervalMs, voting: log?.voting, listed: log?.entries.length ?? 0 });
    await new Promise((r) => setTimeout(r, 250));
  }
  const atEnd = sampleOutlines ? (await readOutlines()).filter(over).length : 0;
  const stats = (await call('liveStats')) as { thumbMs: number[]; encodeMs: number[]; cropMs: number[] } | null;
  const tasks = (await page.evaluate('window.longTasks')) as number[];
  const names = (await call('cardNames', (log?.entries ?? []).map((e) => e.cardId))) as Record<number, string>;
  const wanted = new Set(expected.map((e) => e.name));
  // First seen per name: two prints of one card count as the one.
  const firstSeenByName: Record<string, number> = {};
  for (const [id, s] of Object.entries(firstSeenS)) {
    const n = names[Number(id)];
    if (n) firstSeenByName[n] = Math.min(s, firstSeenByName[n] ?? Infinity);
  }
  const aS = firstSeenByName[expected[0].name] === undefined ? undefined : Math.round((firstSeenByName[expected[0].name] - expected[0].placedS) * 10) / 10;
  return {
    expected,
    listed: (log?.entries ?? []).map((e) => ({ cardId: e.cardId, name: names[e.cardId] ?? null, firstVideoTime: e.firstVideoTime })),
    wrongListed: (log?.entries ?? []).map((e) => names[e.cardId] ?? String(e.cardId)).filter((n) => !wanted.has(n)),
    secondsToListing: Object.fromEntries(expected.map((e) => [e.name, e.name in firstSeenByName ? Math.round((firstSeenByName[e.name] - e.placedS) * 10) / 10 : null])),
    intervalMs: { samples: intervals.length, median: intervals.length ? quantile(intervals, 0.5) : null },
    steps: stats && { thumbMs: stepStats(stats.thumbMs), encodeMs: stepStats(stats.encodeMs), cropMs: stepStats(stats.cropMs) },
    longTasks: { count: tasks.length, longestMs: tasks.length ? Math.max(...tasks) : 0 },
    finalStatus: log?.status ?? null,
    trace,
    handSweepS: [meta.sweep[0], meta.sweep[1]],
    box,
    outlines: sampleOutlines && cardRect ? { whileListed: whileListed ?? { gold: 0, dashed: 0 }, atEnd, goldRect, cardRect } : null,
    firstListedWhileHandMoved: aS === undefined ? null : expected[0].placedS + aS >= meta.sweep[0] && expected[0].placedS + aS < meta.sweep[1],
  };
}

/** The Live clip's assertions (D-L12); `strict` (Chrome only) adds the clip-time, pace and step bars, which Firefox's slower reads don't meet. Returns what failed. */
export function checkLiveReport(r: LiveReport, opts: { strict: boolean }): string[] {
  const bad: string[] = [];
  if (r.box && !r.box.shown) bad.push(`the card box did not open on card ${r.box.cardId}`);
  if (r.outlines) {
    const o = r.outlines;
    if (o.whileListed.gold !== 1) bad.push(`${o.whileListed.gold} gold outlines over ${r.expected[0].name} while it lay still and was listed (want 1)`);
    if (o.atEnd !== 0) bad.push(`${o.atEnd} outlines still over ${r.expected[0].name}'s place after it was taken off`);
  }
  for (const e of r.expected) {
    const s = r.secondsToListing[e.name];
    if (s === null) bad.push(`${e.name} was never listed`);
    else if (opts.strict && s > 15) bad.push(`${e.name} was listed ${s} s after its placement (limit 15 s)`);
  }
  if (r.wrongListed.length) bad.push(`other cards listed: ${r.wrongListed.join(', ')}`);
  const a = r.secondsToListing[r.expected[0].name];
  if (opts.strict && a !== null && r.expected[0].placedS + a >= 10) bad.push(`${r.expected[0].name} was listed at ${r.expected[0].placedS + a} s of clip time, not before 10 s`);
  if (opts.strict && r.firstListedWhileHandMoved === false) bad.push(`${r.expected[0].name} was not listed while the hand moved (${r.handSweepS[0]}-${r.handSweepS[1]} s)`);
  if (opts.strict) {
    if (r.intervalMs.median === null || r.intervalMs.median > 800) bad.push(`median intervalMs ${r.intervalMs.median} > 800`);
    if (!r.steps) bad.push('no step timings');
    for (const [k, v] of Object.entries(r.steps ?? {})) if (!v || v.p95 > 50) bad.push(`${k} p95 ${v?.p95} ms > 50`);
  }
  return bad;
}
