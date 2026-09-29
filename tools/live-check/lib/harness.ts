// Extension-side helpers for the live check, copied (and trimmed or extended) from test/e2e/harness.ts
// and test/e2e/real.ts, which other agents own: the welcome page and consent, the service-worker taps
// that record what the background sends, and reading the closed shadow root through the DevTools
// protocol. Code evaluated in the page or the worker is written as strings (tsx's keepNames adds a
// __name() helper those contexts don't have).
// Puppeteer lives in the E2E harness's own install (test/e2e/package.json), not the root one; it is
// imported by path, as tools/store-shots does, so that `tsc --noEmit` resolves it too.
import puppeteerDefault from '../../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';
import type { Browser, CDPSession, Page, WebWorker } from '../../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

export const puppeteer = puppeteerDefault;
export type { Browser, CDPSession, Page, WebWorker };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a tab's URL says about the welcome page: its consent step, the page itself, or neither. */
export function welcomeKind(url: string): 'consent' | 'welcome' | null {
  const m = /^chrome-extension:\/\/[^/]+\/welcome\.html(#[^?]*)?$/.exec(url);
  if (!m) return null;
  return m[1] === '#consent' ? 'consent' : 'welcome';
}

/** The install opens the welcome page: wait for it, close it, and bring `page` back to the front. */
export async function settleInstall(browser: Browser, page: Page, timeoutMs = 30000): Promise<void> {
  const target = await browser.waitForTarget((t) => welcomeKind(t.url()) === 'welcome', { timeout: timeoutMs }).catch(() => null);
  if (target) await (await target.page())?.close();
  await page.bringToFront();
  const viewport = page.viewport();
  if (viewport) await page.setViewport(viewport);
}

/** What "Agree and start" does (the E2E-only debug hook, src/background/debug-hook.ts). */
export async function grantConsent(worker: WebWorker): Promise<void> {
  await worker.evaluate('globalThis.duelLensDebug.grantConsent()');
}

/**
 * Records, in the service worker, each crop sent to the offscreen engine and its raw answer
 * (test/e2e/real.ts INSTALL_TAP), plus each begin-selection and cards-detected sent to a tab
 * (test/e2e/harness.ts INSTALL_TAB_TAP), here keeping the detected boxes' corners too.
 */
const INSTALL_TAPS = `(() => {
  if (!globalThis.__liveRuntimeTap) {
    const runtime = chrome.runtime;
    const original = runtime.sendMessage;
    const tap = { last: null };
    const wrapped = function (...args) {
      const msg = args[0];
      const out = original.apply(runtime, args);
      if (msg && msg.target === 'offscreen' && msg.type === 'recognize') {
        const rec = { crop: msg.crop, result: null, error: null, at: Date.now(), done: 0 };
        tap.last = rec;
        Promise.resolve(out).then((r) => { rec.result = (r && r.result) || null; rec.done = Date.now(); }, (e) => { rec.error = String(e); rec.done = Date.now(); });
      }
      return out;
    };
    try { runtime.sendMessage = wrapped; } catch (e) {}
    if (runtime.sendMessage !== wrapped) {
      try { Object.defineProperty(runtime, 'sendMessage', { value: wrapped, configurable: true, writable: true }); } catch (e) {}
    }
    if (runtime.sendMessage === wrapped) globalThis.__liveRuntimeTap = tap;
  }
  if (!globalThis.__liveTabTap) {
    const tabs = chrome.tabs;
    const original = tabs.sendMessage;
    const tap = { begin: null, detected: [] };
    const pngSize = (url) => {
      try {
        const b = atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 45));
        const u32 = (i) => ((b.charCodeAt(i) << 24) | (b.charCodeAt(i + 1) << 16) | (b.charCodeAt(i + 2) << 8) | b.charCodeAt(i + 3)) >>> 0;
        return { width: u32(16), height: u32(20) };
      } catch (e) { return null; }
    };
    const wrapped = function (...args) {
      const msg = args[1];
      if (msg && msg.type === 'begin-selection') tap.begin = { tabId: args[0], capturedAt: msg.capturedAt, at: Date.now(), shot: pngSize(msg.screenshot || ''), bytes: (msg.screenshot || '').length };
      if (msg && msg.type === 'cards-detected') {
        const d = msg.detection || {};
        tap.detected.push({ capturedAt: msg.capturedAt, boxes: (d.boxes || []).map((b) => ({ pts: b.pts, conf: b.conf, kind: b.kind || null })), width: d.width, height: d.height, ms: d.ms, error: d.error || null, at: Date.now() });
        if (tap.detected.length > 20) tap.detected.shift();
      }
      return original.apply(tabs, args);
    };
    try { tabs.sendMessage = wrapped; } catch (e) {}
    if (tabs.sendMessage !== wrapped) {
      try { Object.defineProperty(tabs, 'sendMessage', { value: wrapped, configurable: true, writable: true }); } catch (e) {}
    }
    if (tabs.sendMessage === wrapped) globalThis.__liveTabTap = tap;
  }
  return !!globalThis.__liveRuntimeTap && !!globalThis.__liveTabTap;
})()`;

export async function installTaps(worker: WebWorker): Promise<boolean> {
  return (await worker.evaluate(INSTALL_TAPS)) as boolean;
}

export interface DetectedBox {
  pts: [number, number][];
  conf: number;
  kind: string | null;
}

export interface TabTap {
  begin: { tabId: number; capturedAt: number; at: number; shot: { width: number; height: number } | null; bytes: number } | null;
  detected: { capturedAt: number; boxes: DetectedBox[]; width: number; height: number; ms: number; error: string | null; at: number }[];
}

export async function readTabTap(worker: WebWorker): Promise<TabTap | null> {
  return (await worker.evaluate('globalThis.__liveTabTap || null')) as TabTap | null;
}

export interface RuntimeTap {
  crop: { dataUrl: string; width: number; height: number; source: string; videoHeight?: number; inner?: unknown } | null;
  result: any;
  error: string | null;
  at: number;
  done: number;
}

export async function readRuntimeTap(worker: WebWorker): Promise<RuntimeTap | null> {
  return (await worker.evaluate('globalThis.__liveRuntimeTap ? globalThis.__liveRuntimeTap.last : null')) as RuntimeTap | null;
}

export async function resetRuntimeTap(worker: WebWorker): Promise<void> {
  await worker.evaluate('if (globalThis.__liveRuntimeTap) globalThis.__liveRuntimeTap.last = null');
}

// ---------- the page side: the host element's mirrored state (E2E builds) and the closed shadow root ----------

export interface HostState {
  state: string | null;
  card: string | null;
  confident: string | null;
  cards: string | null;
}

export async function hostState(page: Page): Promise<HostState | null> {
  return (await page.evaluate(`(() => {
    const host = document.getElementById('duel-lens-host');
    return host ? {
      state: host.getAttribute('data-duel-lens-state'),
      card: host.getAttribute('data-duel-lens-card'),
      confident: host.getAttribute('data-duel-lens-confident'),
      cards: host.getAttribute('data-duel-lens-cards'),
    } : null;
  })()`)) as HostState | null;
}

/** Waits (mutation-driven) until the host's state is one of `states`; returns it, or null on timeout. */
export async function waitForState(page: Page, states: string[], timeoutMs: number): Promise<HostState | null> {
  try {
    await page.waitForFunction(
      `(() => { const h = document.getElementById('duel-lens-host'); const s = h && h.getAttribute('data-duel-lens-state'); return !!s && ${JSON.stringify(states)}.includes(s); })()`,
      { polling: 'mutation', timeout: timeoutMs },
    );
  } catch {
    return null;
  }
  return hostState(page);
}

/** Waits until the frozen frame shows the detector's outlines; returns how many (0: none found), or null on timeout. */
export async function waitForOutlines(page: Page, timeoutMs: number): Promise<number | null> {
  try {
    const handle = await page.waitForFunction(
      `(() => { const h = document.getElementById('duel-lens-host'); const n = h && h.getAttribute('data-duel-lens-cards'); return n === null || n === undefined ? false : { n: Number(n) }; })()`,
      { polling: 'mutation', timeout: timeoutMs },
    );
    return ((await handle.jsonValue()) as { n: number }).n;
  } catch {
    return null;
  }
}

/** Runs `fn` (a function declaration, as a string) with `this` = the Duel Lens host's closed shadow root. */
export async function inShadow<T>(cdp: CDPSession, fn: string): Promise<T | null> {
  const { result: host } = await cdp.send('Runtime.evaluate', { expression: "document.getElementById('duel-lens-host')" });
  if (!host.objectId) return null;
  let rootId: string | undefined;
  try {
    const { node } = await cdp.send('DOM.describeNode', { objectId: host.objectId, depth: 1, pierce: true });
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    rootId = (await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId })).object.objectId;
    if (!rootId) return null;
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', { objectId: rootId, functionDeclaration: fn, returnByValue: true });
    if (exceptionDetails) throw new Error(`Reading the shadow root failed: ${exceptionDetails.text}`);
    return result.value as T;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: host.objectId }).catch(() => {});
    if (rootId) await cdp.send('Runtime.releaseObject', { objectId: rootId }).catch(() => {});
  }
}

/** What the popover shows (test/e2e/real.ts READ_POPOVER), plus its box, picture and the hint. */
export const READ_UI = `function () {
  const clean = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const pop = this.querySelector('.pop');
  const pic = this.querySelector('.dv-card img');
  const hint = this.querySelector('.hint');
  const outlines = Array.from(this.querySelectorAll('svg.cards rect')).map((r) => rect(r));
  return {
    name: clean(this.querySelector('.dv-name')),
    match: clean(this.querySelector('.dv-match b')),
    matchLine: clean(this.querySelector('.dv-match')),
    lead: clean(this.querySelector('.dv-msg .lead')),
    notes: Array.from(this.querySelectorAll('.note')).map(clean),
    groups: Array.from(this.querySelectorAll('.dv-alts')).map((g) => ({ label: g.getAttribute('aria-label'), names: Array.from(g.querySelectorAll('.alt em')).map(clean) })),
    popover: rect(pop),
    popoverSide: pop ? pop.getAttribute('data-side') : null,
    scroll: (() => { const s = this.querySelector('.pop-scroll'); return s ? { client: s.clientHeight, scroll: s.scrollHeight } : null; })(),
    picture: pic ? { src: (pic.getAttribute('src') || '').slice(0, 22), ownCrop: !!this.querySelector('.dv-card.crop'), natural: { w: pic.naturalWidth, h: pic.naturalHeight }, shown: rect(pic) } : null,
    hint: hint ? { text: clean(hint), box: rect(hint), cls: hint.getAttribute('class') } : null,
    outlines,
    selection: rect(this.querySelector('.sel')),
    layer: !!this.querySelector('.layer'),
  };
}`;

export interface UiRead {
  name: string | null;
  match: string | null;
  matchLine: string | null;
  lead: string | null;
  notes: (string | null)[];
  groups: { label: string | null; names: (string | null)[] }[];
  popover: { x: number; y: number; w: number; h: number } | null;
  popoverSide: string | null;
  scroll: { client: number; scroll: number } | null;
  picture: { src: string; ownCrop: boolean; natural: { w: number; h: number }; shown: { x: number; y: number; w: number; h: number } | null } | null;
  hint: { text: string | null; box: { x: number; y: number; w: number; h: number } | null; cls: string | null } | null;
  outlines: ({ x: number; y: number; w: number; h: number } | null)[];
  selection: { x: number; y: number; w: number; h: number } | null;
  layer: boolean;
}

export async function readUi(cdp: CDPSession): Promise<UiRead | null> {
  return inShadow<UiRead>(cdp, READ_UI);
}

export type Outcome = 'confident' | 'unsure' | 'face-down' | 'nothing' | 'error' | 'no-outline';

/** The popover's answer as a user reads it (test/e2e/real.ts readOutcome). */
export function outcomeOf(state: string | null, p: UiRead | null): { outcome: Outcome; top: string | null; others: string[]; message?: string } {
  const group = (label: string) => (p?.groups.find((g) => g.label === label)?.names ?? []).filter((n): n is string => !!n);
  if (!p) return { outcome: 'error', top: null, others: [], message: 'no popover' };
  if (state === 'error') return { outcome: 'error', top: null, others: [], message: p.lead ?? 'error' };
  if (p.lead?.startsWith('Face-down card')) return { outcome: 'face-down', top: null, others: [] };
  if (p.lead?.startsWith("Couldn't match this")) return { outcome: 'nothing', top: null, others: [] };
  if (p.name) {
    const unsure = p.match?.startsWith('Not sure') ?? false;
    return { outcome: unsure ? 'unsure' : 'confident', top: p.name, others: group('Other matches') };
  }
  return { outcome: 'error', top: null, others: [], message: `unrecognised popover: ${JSON.stringify(p).slice(0, 300)}` };
}

/**
 * Closes the overlay the way a user does, with Escape: again when the first press only dropped an armed
 * corner (since F1, a click on no outline starts a two-click box, and Esc drops its corner first), as
 * test/e2e/harness.ts closeOverlay does. Up to 3 presses, waiting up to 1 s after each for the host to
 * go. Returns whether it went.
 */
export async function closeOverlay(page: Page): Promise<boolean> {
  if (!(await hostState(page))) return true;
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Escape');
    const start = Date.now();
    while (Date.now() - start < 1000) {
      if (!(await hostState(page))) return true;
      await sleep(50);
    }
  }
  return false;
}

/** Whether (x, y) lies inside the quad (corners in order around it). */
export function insideQuad(pts: [number, number][], x: number, y: number): boolean {
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
