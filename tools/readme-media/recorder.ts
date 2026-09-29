// Recording helpers for the README's GIFs (render.ts): a screencast of a page (CDP
// Page.startScreencast, lossless PNG frames with the browser's own frame times) and a timeline of what
// the "user" did (pointer moves, presses, keys), on the same clock. make_gif.py draws the pointer, the
// click ripples and the key badges from that timeline onto the frames afterwards, so nothing is added
// to the page itself: Duel Lens's screenshot of the tab (the frozen frame) and its card detector never
// see them.
// Code evaluated in the page is written as strings: tsx compiles with keepNames, whose __name() helper
// the page doesn't have (tools/store-shots/harness.ts).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession, Page } from '../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Seconds since the epoch: the clock of the screencast's frame times. */
export const now = () => Date.now() / 1000;

export interface Frame {
  t: number;
  file: string;
}

/** A screencast of one page: every frame the page paints, as a PNG with its time. */
export class Screencast {
  readonly frames: Frame[] = [];
  private cdp: CDPSession | null = null;
  private writes: Promise<void>[] = [];
  private n = 0;

  constructor(
    private readonly page: Page,
    private readonly dir: string,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const cdp = await this.page.createCDPSession();
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      const file = path.join(this.dir, `f${String(this.n++).padStart(5, '0')}.png`);
      this.frames.push({ t: f.metadata.timestamp ?? now(), file });
      this.writes.push(writeFile(file, Buffer.from(f.data, 'base64')));
      cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    // A still page paints nothing new: this first frame is what it shows now.
    const first = path.join(this.dir, 'f-start.png');
    const t = now();
    const shot = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    await writeFile(first, Buffer.from(shot.data, 'base64'));
    this.frames.push({ t, file: first });
  }

  async stop(): Promise<Frame[]> {
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await sleep(150);
      await this.cdp.detach().catch(() => {});
      this.cdp = null;
    }
    await Promise.all(this.writes);
    return [...this.frames].sort((a, b) => a.t - b.t).map((f) => ({ t: f.t, file: f.file }));
  }
}

export type Cursor = 'arrow' | 'hand' | 'cross' | 'none';

export type TimelineEvent =
  | { t: number; type: 'move'; x: number; y: number; cursor: Cursor; layer?: number }
  | { t: number; type: 'down' | 'up'; x: number; y: number; layer?: number }
  | { t: number; type: 'key'; label: string; until: number };

/** What the viewer should see of the pointer: its kind under (x, y), as the page would draw it. */
export type CursorProbe = (x: number, y: number) => Promise<Cursor>;

/**
 * The "user" on a page: pointer moves at a human pace, presses and keys, each logged with its time,
 * so make_gif.py can draw them. Real input goes to the page through Puppeteer (trusted events).
 */
export class Actor {
  readonly events: TimelineEvent[] = [];
  x: number;
  y: number;

  constructor(
    private readonly page: Page,
    private readonly probe: CursorProbe,
    start: [number, number],
    private readonly layer = 0,
  ) {
    [this.x, this.y] = start;
  }

  /** Puts the pointer at its start (no event): call before the recording starts. */
  async place(): Promise<void> {
    await this.page.mouse.move(this.x, this.y);
    this.events.push({ t: now(), type: 'move', x: this.x, y: this.y, cursor: await this.probe(this.x, this.y), layer: this.layer });
  }

  /**
   * Moves the pointer to (x, y) in about `ms`, easing in and out, logging each step. The steps follow the
   * clock, not a count: on a busy machine there are fewer of them, and the move still takes `ms`.
   */
  async move(x: number, y: number, ms = 700): Promise<void> {
    const x0 = this.x;
    const y0 = this.y;
    const start = Date.now();
    for (;;) {
      const k = Math.min(1, (Date.now() - start) / ms);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // ease in-out
      const px = x0 + (x - x0) * e;
      const py = y0 + (y - y0) * e;
      await this.page.mouse.move(px, py);
      const t = now();
      this.x = px;
      this.y = py;
      this.events.push({ t, type: 'move', x: px, y: py, cursor: await this.probe(px, py), layer: this.layer });
      if (k >= 1) break;
      await sleep(20);
    }
  }

  async down(): Promise<void> {
    this.events.push({ t: now(), type: 'down', x: this.x, y: this.y, layer: this.layer });
    await this.page.mouse.down();
  }

  async up(): Promise<void> {
    await this.page.mouse.up();
    this.events.push({ t: now(), type: 'up', x: this.x, y: this.y, layer: this.layer });
    // The pointer's look can change with the click (a card read, a corner set).
    await sleep(60);
    this.events.push({ t: now(), type: 'move', x: this.x, y: this.y, cursor: await this.probe(this.x, this.y), layer: this.layer });
  }

  /** A click where the pointer is: pressed for about 90 ms, as a person clicks. */
  async click(): Promise<void> {
    await this.down();
    await sleep(90);
    await this.up();
  }

  /** Shows a key badge for `seconds` (make_gif.py draws it), then presses the key when `key` is given. */
  async key(label: string, seconds: number, key?: string): Promise<void> {
    const t = now();
    this.events.push({ t, type: 'key', label, until: t + seconds });
    if (key) {
      await sleep(180); // the badge first, then what it does
      await this.page.keyboard.press(key as never);
    }
  }

  /** Re-reads the pointer's look where it is (after the page changed under it). */
  async refresh(): Promise<void> {
    this.events.push({ t: now(), type: 'move', x: this.x, y: this.y, cursor: await this.probe(this.x, this.y), layer: this.layer });
  }

  /** Hides the pointer from now on (until it moves again). */
  hide(): void {
    this.events.push({ t: now(), type: 'move', x: this.x, y: this.y, cursor: 'none', layer: this.layer });
  }
}

/**
 * Runs `fn` (a function declaration, as a string) with `this` bound to Duel Lens's closed shadow root,
 * with `args`. Null when Duel Lens isn't open. (tools/store-shots/harness.ts, inShadowRoot.)
 */
export async function inShadowRoot<T>(cdp: CDPSession, fn: string, args: unknown[] = []): Promise<T | null> {
  const { result: host } = (await cdp.send('Runtime.evaluate', { expression: "document.getElementById('duel-lens-host')" })) as {
    result: { objectId?: string };
  };
  if (!host.objectId) return null;
  let rootId: string | undefined;
  try {
    const { node } = (await cdp.send('DOM.describeNode', { objectId: host.objectId, depth: 1, pierce: true })) as {
      node: { shadowRoots?: { backendNodeId: number }[] };
    };
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    rootId = ((await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId })) as { object: { objectId?: string } }).object.objectId;
    if (!rootId) return null;
    const { result, exceptionDetails } = (await cdp.send('Runtime.callFunctionOn', {
      objectId: rootId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (exceptionDetails) throw new Error(`in Duel Lens's shadow root: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    return result.value;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: host.objectId }).catch(() => {});
    if (rootId) await cdp.send('Runtime.releaseObject', { objectId: rootId }).catch(() => {});
  }
}

/** Duel Lens's shadow root as a remote object (kept, not released), or null when Duel Lens isn't open. */
async function shadowRootObject(cdp: CDPSession): Promise<string | null> {
  const { result: host } = (await cdp.send('Runtime.evaluate', { expression: "document.getElementById('duel-lens-host')" })) as {
    result: { objectId?: string };
  };
  if (!host.objectId) return null;
  try {
    const { node } = (await cdp.send('DOM.describeNode', { objectId: host.objectId, depth: 1, pierce: true })) as {
      node: { shadowRoots?: { backendNodeId: number }[] };
    };
    const shadow = node.shadowRoots?.[0];
    if (!shadow) return null;
    return ((await cdp.send('DOM.resolveNode', { backendNodeId: shadow.backendNodeId })) as { object: { objectId?: string } }).object.objectId ?? null;
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: host.objectId }).catch(() => {});
  }
}

/**
 * The pointer Duel Lens's UI shows at (x, y): the crosshair on the frozen frame, the hand over an
 * outlined card or a button, the arrow elsewhere (styles.ts: .layer, .layer.on-card, .btn, .alt). The
 * shadow root is looked up once per Duel Lens overlay, so a probe is one round trip.
 */
export function duelLensCursor(cdp: CDPSession): CursorProbe {
  let root: string | null = null;
  const fn = `function (x, y) {
    if (!this.host || !this.host.isConnected) return 'stale';
    const layer = this.querySelector('.layer');
    if (layer) {
      if (layer.classList.contains('busy')) return 'arrow';
      return layer.classList.contains('on-card') ? 'hand' : 'cross';
    }
    const el = this.elementFromPoint ? this.elementFromPoint(x, y) : null;
    return el && el.closest && el.closest('button, a') ? 'hand' : 'arrow';
  }`;
  return async (x, y) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!root) root = await shadowRootObject(cdp).catch(() => null);
      if (!root) return 'arrow';
      try {
        const { result, exceptionDetails } = (await cdp.send('Runtime.callFunctionOn', {
          objectId: root,
          functionDeclaration: fn,
          arguments: [{ value: x }, { value: y }],
          returnByValue: true,
        })) as { result: { value: string }; exceptionDetails?: unknown };
        if (!exceptionDetails && result.value !== 'stale') return result.value as Cursor;
      } catch {
        // The page navigated: look the root up again.
      }
      root = null;
    }
    return 'arrow';
  };
}
