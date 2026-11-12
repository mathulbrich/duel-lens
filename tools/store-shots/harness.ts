// Helpers for driving the E2E build in the store screenshots (render.ts). Copied and adapted from the
// end-to-end harness (test/e2e/harness.ts), which stays untouched: the content script mirrors its UI
// state onto the host element's data attributes (E2E builds only), and its shadow root is closed, so
// the popover and the outlines are read through the DevTools protocol.
// Code evaluated in the page or the service worker is written as strings: tsx compiles with keepNames,
// whose __name() helper those contexts don't have.
import type { Browser, CDPSession, Page, WebWorker } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

/** What a tab's URL says about the welcome page: its consent step, the page itself, or neither. */
export function welcomeKind(url: string): 'consent' | 'welcome' | null {
  const m = /^chrome-extension:\/\/[^/]+\/welcome\.html(#[^?]*)?$/.exec(url);
  if (!m) return null;
  return m[1] === '#consent' ? 'consent' : 'welcome';
}

/**
 * Brings `page` back to the front and re-applies its emulated viewport: a page that went to the
 * background is captured at its tab's real size otherwise (test/e2e/harness.ts, refocus).
 */
export async function refocus(page: Page): Promise<void> {
  await page.bringToFront();
  const viewport = page.viewport();
  if (viewport) await page.setViewport(viewport);
}

/** The welcome page the install opened (onInstalled, reason 'install'). */
export async function installWelcomePage(browser: Browser, timeoutMs = 30000): Promise<Page> {
  const target = await browser.waitForTarget((t) => welcomeKind(t.url()) === 'welcome', { timeout: timeoutMs }).catch(() => {
    throw new Error(`the install did not open welcome.html within ${timeoutMs / 1000} s`);
  });
  const page = await target.page();
  if (!page) throw new Error('the welcome tab has no page');
  return page;
}

export interface HostState {
  state: string | null;
  card: string | null;
  confident: string | null;
  cards: string | null;
}

export async function hostState(page: Page): Promise<HostState | null> {
  return (await page.evaluate(`(() => {
    const host = document.getElementById('duel-lens-host');
    return host
      ? {
          state: host.getAttribute('data-duel-lens-state'),
          card: host.getAttribute('data-duel-lens-card'),
          confident: host.getAttribute('data-duel-lens-confident'),
          cards: host.getAttribute('data-duel-lens-cards'),
        }
      : null;
  })()`)) as HostState | null;
}

export async function waitForState(page: Page, states: string[], timeoutMs: number): Promise<HostState> {
  const start = Date.now();
  for (;;) {
    const s = await hostState(page);
    if (s?.state && states.includes(s.state)) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${states.join('/')} (last: ${JSON.stringify(s)})`);
    await new Promise((r) => setTimeout(r, 100));
  }
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

/** Two animation frames: whatever the last state change drew is on screen. */
export async function settle(page: Page, extraMs = 0): Promise<void> {
  await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  if (extraMs) await new Promise((r) => setTimeout(r, extraMs));
}

/** What "Agree and start" does, through the E2E-only debug hook (src/background/debug-hook.ts). */
export async function grantConsent(worker: WebWorker): Promise<void> {
  await worker.evaluate('globalThis.duelLensDebug.grantConsent()');
}

/** What Alt+Shift+Y does, through the E2E-only debug hook, on the active tab. */
export async function startScan(worker: WebWorker): Promise<void> {
  await worker.evaluate('globalThis.duelLensDebug.startScan()');
}

/** Scan mode's host (the frozen frame, its outlines and the popover) and Live's (the pill, the outline, the card box). */
export const SCAN_HOST = 'duel-lens-host';
export const LIVE_HOST = 'duel-lens-live';

/** Runs `fn` (a function declaration, as a string) with `this` bound to a host's closed shadow root (scan mode's by default). */
async function inShadowRoot<T>(cdp: CDPSession, fn: string, hostId = SCAN_HOST): Promise<T | null> {
  const { result: host } = await cdp.send('Runtime.evaluate', { expression: `document.getElementById(${JSON.stringify(hostId)})` });
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

export interface PopoverView {
  /** The box's top row: the lens and "Duel Lens" (drawn in capitals). */
  brand: string | null;
  /** The card shown (its name), or null. */
  name: string | null;
  /** The match line: none on a sure match, "Not sure" on an unsure one (its percentage only in the tooltip). */
  match: string | null;
  /** The match line's tooltip: the artwork match's percentage, how and from what it matched ("97% … · card outline · 1080p video"). */
  matchTitle: string | null;
  /** The facts under the name (Attribute, Level, ATK/DEF, ban status, "Genesys 20 pts"…). */
  facts: string[];
  /** The coloured frame around the picture by ban status (forbidden, limited, semi), or null. */
  banFrame: string | null;
  /** The bottom line's labelled columns (PASSCODE, ARCHETYPE, PRICE) and its links; none on an unpinned box. */
  meta: string[];
  links: string[];
  /** Every button's words (its text, else its name): the foot's, the chips', the ×. */
  buttons: string[];
  /** The box is a hovered card's, not pinned yet (Full details on hover). */
  hovering: boolean;
  /** The unsure layout ("Not sure", with "Could also be"). */
  unsure: boolean;
  /** The chips' label ("Not it?" / "Could also be") and the chips (name, percentage). */
  chipsLabel: string | null;
  chips: { name: string; score: string | null }[];
  /** The "Ask AI" button is offered. */
  askAi: boolean;
  /**
   * The picture: the first bytes of its src, whether it is the user's own crop (the old store build)
   * or the card's official image, its alt text, and whether it has loaded.
   */
  picture: { src: string; ownCrop: boolean; alt: string | null; loaded: boolean; width: number } | null;
  /** The chips' small pictures: how many chips, and how many have a loaded picture. */
  chipPictures: number;
  chipPicturesLoaded: number;
  /** A lead message instead of a card ("Couldn't match this…", "Face-down card…"). */
  message: string | null;
  /** A toast is showing. */
  toast: string | null;
  /** The popover's box on the page (CSS px). */
  box: { x: number; y: number; w: number; h: number } | null;
}

/**
 * The popover, read through its closed shadow root. Only the popover's own parts (`.pop`) count: in scan
 * mode a hover preview can show beside it and reuse the card view's classes. The toast is the page's.
 */
export async function readPopover(cdp: CDPSession, hostId = SCAN_HOST): Promise<PopoverView | null> {
  return inShadowRoot<PopoverView>(
    cdp,
    `function () {
      const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
      // A pinned box before a hovered one (a click pins the hovered card).
      const pop = this.querySelector('.pop:not(.hovering)') || this.querySelector('.pop');
      const q = (sel) => (pop ? pop.querySelector(sel) : null);
      const qa = (sel) => (pop ? Array.from(pop.querySelectorAll(sel)) : []);
      const img = q('.dv-card img');
      const r = pop ? pop.getBoundingClientRect() : null;
      const match = q('.dv-match');
      const chipImgs = qa('.dv-alts .alt img');
      const frame = q('.ban-frame');
      return {
        brand: text(q('.ov-top .brand')),
        name: text(q('.dv-name')),
        match: text(match),
        matchTitle: match ? match.getAttribute('title') : null,
        facts: qa('.dv-facts .fact').map((f) => text(f)),
        banFrame: frame ? ['forbidden', 'limited', 'semi'].find((t) => frame.classList.contains(t)) || '?' : null,
        meta: qa('.dv-meta dt').map((d) => text(d)),
        links: qa('.dv-links a').map((a) => text(a)),
        buttons: qa('button').map((b) => text(b) || b.getAttribute('aria-label') || ''),
        hovering: !!pop && pop.classList.contains('hovering'),
        unsure: !!q('.unsure'),
        chipsLabel: text(q('.dv-alts > span')),
        chips: qa('.dv-alts .alt').map((b) => ({ name: text(b.querySelector('em')), score: text(b.querySelector('b')) })),
        askAi: qa('button').some((b) => b.textContent.trim() === 'Ask AI'),
        picture: img
          ? { src: (img.getAttribute('src') || '').slice(0, 23), ownCrop: !!q('.dv-card.crop'), alt: img.getAttribute('alt'), loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth }
          : null,
        chipPictures: qa('.dv-alts .alt').length,
        chipPicturesLoaded: chipImgs.filter((i) => i.complete && i.naturalWidth > 0).length,
        message: text(q('.dv-msg .lead')),
        toast: text(this.querySelector('.toast')),
        box: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      };
    }`,
    hostId,
  );
}

/**
 * Waits until the popover's pictures have loaded: the card's official image (fetched from
 * images.ygoprodeck.com by the service worker) and every chip's small one. Returns the popover then.
 */
export async function waitForPictures(cdp: CDPSession, timeoutMs = 30000, hostId = SCAN_HOST): Promise<PopoverView> {
  const start = Date.now();
  for (;;) {
    const view = await readPopover(cdp, hostId);
    if (view?.picture?.loaded && view.chipPicturesLoaded === view.chipPictures) return view;
    if (Date.now() - start > timeoutMs) throw new Error(`the popover's pictures did not load within ${timeoutMs / 1000} s: ${JSON.stringify(view?.picture)}, chips ${view?.chipPicturesLoaded}/${view?.chipPictures}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Closes the overlay the way a user does, with Escape: once more when the first only dropped a first
 * corner (a click beside the outlines starts a two-click box). True once the host is gone.
 * (test/e2e/harness.ts, closeOverlay.)
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

export interface OutlineView {
  /** Each outline as drawn: its centre, size and angle (degrees), in CSS px. */
  outlines: { cx: number; cy: number; w: number; h: number; angle: number }[];
  /** The bar's hint ("8 cards") and the bar's whole visible text, and whether the bar sits low (at the bottom). */
  hint: string | null;
  bar: string | null;
  hintLow: boolean;
  /** A card is lit (hovered or in keyboard focus). */
  lit: boolean;
  /** The frame is dimmed around the outlined cards (the spotlight; none while a card is lit). */
  spotlight: boolean;
}

/** The frozen frame's outlines and bar, read through the closed shadow root. */
export async function readOutlines(cdp: CDPSession): Promise<OutlineView | null> {
  return inShadowRoot<OutlineView>(
    cdp,
    `function () {
      const bar = this.querySelector('.bar');
      const hint = bar && bar.querySelector('.hint');
      // The bar's words as drawn (its screen-reader-only status left out).
      const seen = (el) => Array.from(el.childNodes).map((n) => (n.nodeType === 3 ? n.textContent : n.classList && n.classList.contains('sr-only') ? '' : seen(n))).join('');
      return {
        // Each outline is drawn twice, a dark line under the bright one: the bright ones only.
        outlines: Array.from(this.querySelectorAll('svg.cards rect:not(.under)')).map((r) => {
          const x = Number(r.getAttribute('x'));
          const y = Number(r.getAttribute('y'));
          const w = Number(r.getAttribute('width'));
          const h = Number(r.getAttribute('height'));
          const m = /rotate\\(([-\\d.e]+)/.exec(r.getAttribute('transform') || '');
          return { cx: x + w / 2, cy: y + h / 2, w, h, angle: m ? Number(m[1]) : 0 };
        }),
        hint: hint ? hint.textContent.trim() : null,
        bar: bar ? seen(bar).replace(/\\s+/g, ' ').trim() : null,
        hintLow: !!(bar && bar.classList.contains('low')),
        lit: !!this.querySelector('.sel.hover'),
        spotlight: !!this.querySelector('svg.spotlight'),
      };
    }`,
  );
}

/** Whether (x, y) lies inside a turned box (centre, size, angle in degrees), with `pad` px around it. */
export function insideBox(b: { cx: number; cy: number; w: number; h: number; angle: number }, x: number, y: number, pad = 0): boolean {
  const a = (b.angle * Math.PI) / 180;
  const dx = x - b.cx;
  const dy = y - b.cy;
  const u = dx * Math.cos(a) + dy * Math.sin(a);
  const v = -dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(u) <= b.w / 2 + pad && Math.abs(v) <= b.h / 2 + pad;
}

/** Drags with the mouse from (x0, y0) to (x1, y1) in `steps` moves, as a user would; `release` false keeps it held. */
export async function drag(page: Page, from: [number, number], to: [number, number], steps = 12, release = true): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await page.mouse.move(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
  }
  if (release) await page.mouse.up();
}

export interface LiveView {
  /** The pill at the video's top-left corner: its word ("Live check", drawn in capitals), its count, where it sits. */
  pill: { word: string | null; count: string | null; ready: boolean; x: number; y: number; w: number; h: number } | null;
  /** The outline drawn on the video (only around the card under the pointer): solid gold when listed ("promoted"). */
  outlines: { state: string; x: number; y: number; w: number; h: number }[];
}

/** Live's pill and outline, read through the Live host's closed shadow root (the card box: readPopover(cdp, LIVE_HOST)). */
export async function readLive(cdp: CDPSession): Promise<LiveView | null> {
  return inShadowRoot<LiveView>(
    cdp,
    `function () {
      const text = (el) => (el ? el.textContent.replace(/\\s+/g, ' ').trim() : null);
      const pill = this.querySelector('.live-pill');
      const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return {
        pill: pill
          ? { word: text(pill.querySelector('.live-word')), count: text(pill.querySelector('.live-count')), ready: !pill.querySelector('.live-ready'), ...box(pill) }
          : null,
        outlines: Array.from(this.querySelectorAll('.live-outline')).map((o) => ({ state: o.classList.contains('promoted') ? 'promoted' : 'reading', ...box(o) })),
      };
    }`,
    LIVE_HOST,
  );
}
