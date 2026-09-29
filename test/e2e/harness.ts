// Helpers shared by both modes of the end-to-end test (run.ts): the content script mirrors its UI
// state onto the host element's data attributes (src/content/host.ts), since its shadow root is closed.
import type { Browser, CDPSession, Page, WebWorker } from 'puppeteer';
import { NO_CARD_DETECTOR } from '../../src/background/offscreen-client';

// ---------- the first-run consent ----------
// A fresh profile has no consent: the install opens the welcome page, and the shortcut opens its
// consent step instead of scanning (src/background/scan.ts), until the harness agrees for the user.

/** What a tab's URL says about the welcome page: its consent step, the page itself, or neither. */
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
async function inShadowRoot<T>(cdp: CDPSession, fn: string): Promise<T | null> {
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
