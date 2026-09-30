// @vitest-environment happy-dom
// Review Critical #1: with a classic scrollbar, the fixed-position overlay is narrower than
// the captured viewport (clientWidth < innerWidth), but captureVisibleTab includes the
// scrollbar. The frozen frame must be drawn at the captured viewport size, and the crop must
// use that same viewport, recorded when the frame froze, or the box and the crop drift apart.
// Runs the real content entry and the real capture code; only the canvas is faked.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/preact';
import type { ToBackground } from '../shared/messages';
import { trustEvents } from './test-events';
import { ASH, response } from './test-fixtures';

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

// A 1920x1080 viewport captured at devicePixelRatio 2.
const BITMAP = { width: 3840, height: 2160, close: () => undefined };
const SHOT = 'data:image/png;base64,iVBORw0KGgo=';

let listeners: Listener[];
let roots: ShadowRoot[];
let draws: unknown[][];
let sent: ToBackground[];
const saved = new Map<string, PropertyDescriptor | undefined>();
let distrust: () => void;
/** Duel Lens itself, as the sender of its messages (the content script ignores anyone else's). */
const OURS = { id: 'test-extension-id' };

function setViewport(innerW: number, innerH: number, clientW: number) {
  for (const [obj, key, value] of [
    [window, 'innerWidth', innerW],
    [window, 'innerHeight', innerH],
    [document.documentElement, 'clientWidth', clientW],
    [document.documentElement, 'clientHeight', innerH],
  ] as const) {
    const id = `${obj === window ? 'w' : 'd'}.${key}`;
    if (!saved.has(id)) saved.set(id, Object.getOwnPropertyDescriptor(obj, key));
    Object.defineProperty(obj, key, { value, configurable: true });
  }
}

beforeEach(async () => {
  distrust = trustEvents(); // the user's own pointer
  listeners = [];
  roots = [];
  draws = [];
  sent = [];
  vi.stubGlobal('chrome', {
    runtime: {
      // A live, non-invalidated context; keys.ts checks this to self-uninstall once an
      // extension reload invalidates it.
      id: 'test-extension-id',
      onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      getURL: (p: string) => `chrome-extension://test/${p}`,
      sendMessage: vi.fn(async (msg: ToBackground) => {
        sent.push(msg);
        if (msg.type === 'recognize') return response([ASH], [0.95]);
        if (msg.type === 'get-image') return { dataUrl: null };
        return { ok: true };
      }),
    },
  });
  // The real cropSelection draws into a <canvas>; happy-dom has no 2D context, so record it.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: (...args: unknown[]) => void draws.push(args),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({
          width: w,
          height: h,
          data: new Uint8ClampedArray(w * h * 4).fill(128),
        }),
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CROP');
  vi.stubGlobal('createImageBitmap', vi.fn(async () => BITMAP));
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const r = attach.call(this, init);
    roots.push(r);
    return r;
  });
  delete (window as { __duelLens?: unknown }).__duelLens;
  vi.resetModules();
  await import('./index');
});

afterEach(() => {
  // Close whatever is still open through the UI itself: Esc hides a preview, closes a popover, then leaves.
  for (let i = 0; i < 3 && document.getElementById('duel-lens-host'); i++) fireEvent.keyDown(document.body, { key: 'Escape' });
  for (const [id, desc] of saved) {
    const [which, key] = id.split('.');
    const obj = which === 'w' ? window : document.documentElement;
    if (desc) Object.defineProperty(obj, key, desc);
    else delete (obj as unknown as Record<string, unknown>)[key];
  }
  saved.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  distrust();
});

it('keeps the frozen frame and the crop aligned with the page when a scrollbar narrows the overlay', async () => {
  setViewport(1920, 1080, 1903); // a 17 px classic scrollbar
  listeners[0]({ type: 'begin-selection', screenshot: SHOT, capturedAt: 1 }, OURS, () => undefined);
  const root = roots[roots.length - 1];

  // The frame is drawn at the captured viewport size, not squeezed into the 1903 px overlay.
  const shot = root.querySelector('img.shot') as HTMLImageElement;
  expect(shot.style.width).toBe('1920px');
  expect(shot.style.height).toBe('1080px');

  // Even if the window changes while the frame is frozen, the crop uses the frozen geometry.
  setViewport(1600, 900, 1583);

  const layer = root.querySelector('.layer')!;
  fireEvent.pointerDown(layer, { clientX: 1000, clientY: 300, button: 0, pointerId: 1 });
  fireEvent.pointerMove(layer, { clientX: 1100, clientY: 450, pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: 1100, clientY: 450, pointerId: 1 });

  await waitFor(() => expect(sent.some((m) => m.type === 'recognize')).toBe(true));
  // Box (1000,300,100,150) x (3840/1920 = 2) -> (2000,600,200,300), +4% -> (1992,588,216,324).
  expect(draws[0]).toEqual([BITMAP, 1992, 588, 216, 324, 0, 0, 216, 324]);
  const recognize = sent.find((m) => m.type === 'recognize') as Extract<ToBackground, { type: 'recognize' }>;
  expect(recognize.crop.inner).toEqual({ x: 8, y: 12, w: 200, h: 300 });
});

// Click to scan: the detector's box is in screenshot pixels. A click on the card crops exactly
// what a drag of the card's bounds would (above), without a round trip through CSS pixels.
it("crops a clicked card from the screenshot's own pixels, with the margin, at devicePixelRatio 2", async () => {
  setViewport(1920, 1080, 1903);
  listeners[0]({ type: 'begin-selection', screenshot: SHOT, capturedAt: 1 }, OURS, () => undefined);
  // The card (2000,600)-(2200,900) on the 3840x2160 screenshot is (1000,300)-(1100,450) on the page.
  const pts: [number, number][] = [
    [2000, 600],
    [2200, 600],
    [2200, 900],
    [2000, 900],
  ];
  listeners[0](
    {
      type: 'cards-detected',
      capturedAt: 1,
      detection: { boxes: [{ cx: 2100, cy: 750, w: 200, h: 300, angle: 0, conf: 0.97, pts }], width: 3840, height: 2160, ms: 150 },
    },
    OURS,
    () => undefined,
  );
  const root = roots[roots.length - 1];
  await waitFor(() => expect(root.querySelectorAll('[aria-label="Card 1 of 1"]')).toHaveLength(1));
  const outline = root.querySelector('[aria-label="Card 1 of 1"]')!;
  // Drawn on the page 3 px outside the card: (1000,300)-(1100,450) -> (997,297) 106x156.
  expect(['x', 'y', 'width', 'height'].map((a) => outline.getAttribute(a))).toEqual(['997', '297', '106', '156']);

  const layer = root.querySelector('.layer')!;
  fireEvent.pointerDown(layer, { clientX: 1050, clientY: 375, button: 0, pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: 1050, clientY: 375, pointerId: 1 });

  await waitFor(() => expect(sent.some((m) => m.type === 'recognize')).toBe(true));
  // (2000,600,200,300) +4% -> (1992,588,216,324): the same pixels as the drag above.
  expect(draws[0]).toEqual([BITMAP, 1992, 588, 216, 324, 0, 0, 216, 324]);
  const recognize = sent.find((m) => m.type === 'recognize') as Extract<ToBackground, { type: 'recognize' }>;
  expect(recognize.crop.inner).toEqual({ x: 8, y: 12, w: 200, h: 300 });
  expect(recognize.crop.source).toBe('screenshot');
});
