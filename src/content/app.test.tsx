// @vitest-environment happy-dom
// Flow tests through the real content entry (index.ts): begin-selection → drag →
// scanning → popover → actions → close. chrome.* is faked; the capture module is
// mocked here because its canvas work has its own tests (capture.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, createEvent, fireEvent, waitFor, within } from '@testing-library/preact';
import { altArtworkId, isAltArtwork } from '../shared/alt-artwork';
import type { AskAiResponse, DetectedCardBox, RecognizeResponse, ToBackground } from '../shared/messages';
import { NO_CARD_DETECTOR } from '../background/offscreen-client';
import { DEFAULT_SETTINGS } from '../shared/types';
import { trusted, trustEvents, untrusted } from './test-events';
import { ASH, BELLE, DROLL, OGRE, VEILER, VIDEO_CROP, response } from './test-fixtures';

const cap = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('./capture', () => ({
  grabVideoFrames: vi.fn(() => ['video-grab']),
  decodeScreenshot: vi.fn(async () => ({ width: 2048, height: 1536 })),
  cropSelection: vi.fn(async () => cap.result),
  cropDetectedCard: vi.fn(async () => cap.result),
}));

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
type Replies = { [K in ToBackground['type']]?: (msg: Extract<ToBackground, { type: K }>) => unknown };

const SHOT = 'data:image/png;base64,iVBORw0KGgo=';
// Belle and Ogre are within 0.10 of the top match, so the popover offers them ("Not it?"); Droll isn't.
const CONFIDENT = () => response([ASH, BELLE, OGRE, DROLL], [0.96, 0.93, 0.9, 0.84]);
const UNSURE = () => response([VEILER, DROLL, OGRE, BELLE], [0.74, 0.69, 0.52, 0.4], { confident: false, aiEnabled });

let listeners: Listener[];
let roots: ShadowRoot[];
let replies: Replies;
let sendMessage: Mock<(msg: ToBackground) => Promise<unknown>>;
let aiEnabled: boolean;
let storageGet: Mock<(key?: unknown) => Promise<unknown>>;
let distrust: () => void;

beforeEach(async () => {
  distrust = trustEvents(); // the user's own pointer, clicks and keys
  listeners = [];
  roots = [];
  aiEnabled = true;
  storageGet = vi.fn(async () => ({
    settings: { ...DEFAULT_SETTINGS, ai: { ...DEFAULT_SETTINGS.ai, enabled: true, apiKey: 'sk-secret' } },
  }));
  cap.result = { crop: VIDEO_CROP, videoTime: 1458, black: false, overVideo: true };
  replies = {
    recognize: () => CONFIDENT(),
    'get-image': (m) => ({ dataUrl: `data:image/jpeg;base64,${m.size}-${m.imageId}` }),
    'show-in-panel': () => ({ ok: true }),
    correct: () => ({ ok: true }),
    'open-options': () => ({ ok: true }),
  };
  sendMessage = vi.fn(async (msg: ToBackground) => (replies[msg.type] as ((m: ToBackground) => unknown) | undefined)?.(msg));
  vi.stubGlobal('chrome', {
    runtime: {
      // A live, non-invalidated context, as real content scripts always have; keys.ts
      // checks this to self-uninstall once an extension reload invalidates it.
      id: 'test-extension-id',
      onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      sendMessage,
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    // Storage holds D's settings, API key included. It says "enabled" on purpose: the UI
    // must follow RecognizeResponse.aiEnabled and never read storage.
    storage: { local: { get: storageGet } },
  });
  // The shadow root is closed; keep a handle on it the way a test (not the page) can.
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
    const r = attach.call(this, init);
    roots.push(r);
    return r;
  });
  document.title = 'Feature match';
  delete (window as { __duelLens?: unknown }).__duelLens;
  vi.resetModules();
  await import('./index');
});

afterEach(() => {
  // Close whatever is still open through the UI itself: Esc hides a preview, closes a popover, then leaves.
  for (let i = 0; i < 3 && document.getElementById('duel-lens-host'); i++) fireEvent.keyDown(document.body, { key: 'Escape' });
  document.querySelectorAll('#duel-lens-host').forEach((el) => el.remove());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  distrust();
});

// ---------- helpers ----------
/** A message from Duel Lens itself (the background), as chrome.runtime.onMessage delivers it. */
function send(msg: unknown, sender: object = { id: 'test-extension-id' }) {
  const sendResponse = vi.fn();
  const returned = listeners[0](msg, sender, sendResponse);
  return { sendResponse, returned };
}
const host = () => document.getElementById('duel-lens-host');
const state = () => host()?.getAttribute('data-duel-lens-state');
/** Queries inside the (closed) shadow root, from the UI's root element. */
const ui = () => within(roots[roots.length - 1].firstElementChild as HTMLElement);
/** The overlay's one status region (a11y review B2). */
const announcer = () => roots[roots.length - 1].querySelector<HTMLElement>('.dl > .announce');
const sent = (type: ToBackground['type']) => sendMessage.mock.calls.map(([m]) => m).filter((m) => m.type === type);
/** Queries inside the popover only (the status region repeats its outcome in words). */
const pop = () => within(ui().getByRole('dialog', { name: /card details/i }));
/** The bar's visible words: how many cards are outlined, "Finding cards…", and so on. */
const barText = () => roots[roots.length - 1].querySelector('.bar .hint')?.textContent;
/** The frozen frame, which stays through reads (UX-1). */
const frame = () => roots[roots.length - 1].querySelector('img.shot');
/** Leaves scan mode with the bar's ✕. */
const exitButton = () => ui().getByRole('button', { name: 'Exit Duel Lens' });
/** Closes the popover with its × (scan mode stays). */
const closeCard = () => fireEvent.click(ui().getByRole('button', { name: 'Close card details' }));

function begin() {
  return send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 1 });
}

function dragBox() {
  const layer = ui().getByRole('dialog', { name: /select a card/i });
  fireEvent.pointerDown(layer, { clientX: 100, clientY: 80, button: 0, pointerId: 1 });
  fireEvent.pointerMove(layer, { clientX: 220, clientY: 255, pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: 220, clientY: 255, pointerId: 1 });
}

async function scanToResult() {
  begin();
  dragBox();
  await waitFor(() => expect(state()).toBe('result'));
}

// ---------- tests ----------
describe('content entry', () => {
  it('answers ping', () => {
    const { sendResponse } = send({ type: 'ping' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(host()).toBeNull();
  });

  it('ignores messages that are not addressed to it', () => {
    const { sendResponse, returned } = send({ type: 'recognize', crop: VIDEO_CROP });
    expect(sendResponse).not.toHaveBeenCalled();
    expect(returned).toBeUndefined();
  });

  it('registers one listener even when injected twice', async () => {
    vi.resetModules();
    await import('./index');
    expect(listeners).toHaveLength(1);
  });
});

describe('scan flow', () => {
  it('goes from begin-selection to a popover over the frame, which stays; its × closes it, and Esc then leaves without a trace', async () => {
    let release!: () => void;
    replies.recognize = () => new Promise<RecognizeResponse>((r) => (release = () => r(CONFIDENT())));
    const page = vi.fn();
    document.addEventListener('keydown', page);

    const { sendResponse } = begin();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(host()).not.toBeNull();
    expect(host()!.id).toBe('duel-lens-host');
    await waitFor(() => expect(state()).toBe('selecting'));

    dragBox();
    await waitFor(() => expect(state()).toBe('scanning'));
    const box = roots[roots.length - 1].querySelector('.sel.scanning');
    expect(box?.textContent).toBe('Matching artwork…'); // the box shows the foil sweep and its label
    expect(roots[roots.length - 1].querySelector('.layer.busy')).not.toBeNull(); // frame still frozen

    release();
    await waitFor(() => expect(state()).toBe('result'));
    expect(host()!.getAttribute('data-duel-lens-card')).toBe('Ash Blossom & Joyous Spring');
    expect(host()!.getAttribute('data-duel-lens-confident')).toBe('true');
    expect(ui().getByRole('heading', { name: 'Ash Blossom & Joyous Spring' })).toBeTruthy();
    expect(frame()).not.toBeNull(); // UX-1: the frozen frame stays, with the box read marked
    expect(roots[roots.length - 1].querySelector('.sel.done')).not.toBeNull();
    expect(ui().queryByRole('dialog', { name: /select a card/i })).toBeNull(); // the popover is the one dialog now

    // The crop came from the box, and the scan carried the page context.
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropSelection)).toHaveBeenCalledWith(
      { x: 100, y: 80, w: 120, h: 175 },
      { width: 2048, height: 1536 },
      ['video-grab'],
      { viewportWidth: window.innerWidth }, // recorded when the frame froze
    );
    expect(sent('recognize')).toEqual([
      {
        type: 'recognize',
        crop: VIDEO_CROP,
        context: { pageUrl: location.href, pageTitle: 'Feature match', videoTime: 1458 },
      },
    ]);

    // Images: the matched artwork in full, the alternatives small.
    await waitFor(() =>
      expect(ui().getByRole('dialog', { name: /card details/i }).querySelector('.dv-card img')?.getAttribute('src')).toBe(
        `data:image/jpeg;base64,full-${ASH.imageIds[0]}`,
      ),
    );
    expect(sent('get-image')).toEqual(
      expect.arrayContaining([
        { type: 'get-image', imageId: ASH.imageIds[0], size: 'full' },
        { type: 'get-image', imageId: BELLE.imageIds[0], size: 'small' },
      ]),
    );

    closeCard();
    expect(ui().queryByRole('dialog', { name: /card details/i })).toBeNull();
    expect(state()).toBe('selecting'); // scan mode stays
    expect(ui().getByRole('dialog', { name: /select a card/i })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(host()).toBeNull();
    // With Duel Lens gone, YouTube gets its K back.
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(page).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', page);
  });

  // Review (C, minor): a decoded screenshot is tens of MB and native video canvases hold
  // their own full-resolution backing store; both must be released promptly, not left
  // for GC, once the session ends.
  it('releases the screenshot bitmap and zeroes native video canvases when the session closes', async () => {
    const capture = await import('./capture');
    const bitmap = { width: 2048, height: 1536, close: vi.fn() };
    const grabCanvas = { width: 1920, height: 1080 };
    vi.mocked(capture.decodeScreenshot).mockResolvedValueOnce(bitmap as unknown as ImageBitmap);
    vi.mocked(capture.grabVideoFrames).mockReturnValueOnce([
      { canvas: grabCanvas, currentTime: 0, videoWidth: 1920, videoHeight: 1080, contentBox: { x: 0, y: 0, w: 1, h: 1 }, readable: true },
    ] as unknown as ReturnType<typeof capture.grabVideoFrames>);

    await scanToResult();
    fireEvent.click(exitButton());

    await waitFor(() => expect(bitmap.close).toHaveBeenCalledTimes(1));
    expect(grabCanvas.width).toBe(0);
    expect(grabCanvas.height).toBe(0);
  });

  it('a second scan while one is open replaces it, leaving no stale key handler behind', async () => {
    await scanToResult();
    begin(); // the shortcut pressed again while the popover is open
    expect(document.querySelectorAll('#duel-lens-host')).toHaveLength(1);
    expect(state()).toBe('selecting');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(host()).toBeNull();
    const page = vi.fn();
    document.addEventListener('keydown', page);
    fireEvent.keyDown(document.body, { key: 'k' });
    expect(page).toHaveBeenCalledTimes(1); // nothing from the first session still takes K
    document.removeEventListener('keydown', page);
  });

  it('Esc during the selection closes everything without scanning', async () => {
    begin();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(host()).toBeNull();
    expect(sent('recognize')).toEqual([]);
  });

  // An artwork YGOPRODeck lacks (ALT-ART): the index has Konami's vector under a synthetic imageId
  // (src/shared/alt-artwork.ts). The popover shows the card's own YGOPRODeck image and never asks for the synthetic id.
  const cardImages = () => (sent('get-image') as Extract<ToBackground, { type: 'get-image' }>[]).map((m) => [m.imageId, m.size] as const);

  it("shows the card's own YGOPRODeck image for a match on an artwork YGOPRODeck lacks, in the card view and its chips", async () => {
    replies.recognize = () =>
      response([ASH, BELLE, OGRE, DROLL], [], {
        candidates: [
          { cardId: ASH.id, imageId: altArtworkId(12950, 3), score: 0.96 },
          { cardId: BELLE.id, imageId: altArtworkId(12345, 2), score: 0.93 },
          { cardId: OGRE.id, imageId: OGRE.imageIds[0], score: 0.9 },
          { cardId: DROLL.id, imageId: DROLL.imageIds[0], score: 0.84 },
        ],
      });
    await scanToResult();

    await waitFor(() => expect(pop().getByRole('heading', { name: ASH.name })).toBeTruthy());
    await waitFor(() =>
      expect(ui().getByRole('dialog', { name: /card details/i }).querySelector('.dv-card img')?.getAttribute('src')).toBe(
        `data:image/jpeg;base64,full-${ASH.imageIds[0]}`,
      ),
    );
    expect(cardImages()).toEqual(expect.arrayContaining([[ASH.imageIds[0], 'full'], [BELLE.imageIds[0], 'small'], [OGRE.imageIds[0], 'small']]));
    expect(cardImages().filter(([id]) => isAltArtwork(id))).toEqual([]);

    // Picking the other match records its YGOPRODeck image in the history, not the synthetic id.
    fireEvent.click(ui().getByRole('button', { name: /Ghost Belle/ }));
    await waitFor(() => expect(sent('correct')).toEqual([{ type: 'correct', entryId: 'entry-1', cardId: BELLE.id, imageId: BELLE.imageIds[0] }]));
    await waitFor(() => expect(cardImages()).toContainEqual([BELLE.imageIds[0], 'full']));
    expect(cardImages().filter(([id]) => isAltArtwork(id))).toEqual([]);
  });

  it('does the same for every card of a "Low match" list', async () => {
    replies.recognize = () =>
      response([VEILER, DROLL, OGRE], [], {
        confident: false,
        suggested: true,
        candidates: [
          { cardId: VEILER.id, imageId: altArtworkId(8933, 2), score: 0.71 },
          { cardId: DROLL.id, imageId: altArtworkId(9999, 3), score: 0.7 },
          { cardId: OGRE.id, imageId: OGRE.imageIds[0], score: 0.69 },
        ],
      });
    await scanToResult();

    await waitFor(() => expect(cardImages()).toEqual(expect.arrayContaining([[VEILER.imageIds[0], 'full'], [DROLL.imageIds[0], 'small'], [OGRE.imageIds[0], 'small']])));
    expect(cardImages().filter(([id]) => isAltArtwork(id))).toEqual([]);
  });

  it('falls back to the small image, then to text only', async () => {
    replies['get-image'] = (m) => ({ dataUrl: m.size === 'small' && m.imageId !== ASH.imageIds[0] ? 'data:image/jpeg;base64,S' : null });
    await scanToResult();
    await waitFor(() => expect(sent('get-image')).toContainEqual({ type: 'get-image', imageId: ASH.imageIds[0], size: 'small' }));
    await waitFor(() => expect(ui().getByRole('dialog', { name: /card details/i }).querySelector('.dv.no-img')).not.toBeNull());
  });

  // The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ off): the popover shows the user's
  // own crop and never asks the background for a card image (legal-audit.md B2, option c).
  it('shows the scanned crop instead of a card image, and asks for none, in a build without remote images', async () => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
    await scanToResult();
    const dialog = () => ui().getByRole('dialog', { name: /card details/i });
    expect(dialog().querySelector('.dv-card img')?.getAttribute('src')).toBe(VIDEO_CROP.dataUrl);

    fireEvent.click(ui().getByRole('button', { name: /Ghost Belle/ })); // another match: still the crop
    await waitFor(() => expect(ui().getByRole('heading', { name: BELLE.name })).toBeTruthy());
    expect(dialog().querySelector('.dv-card img')?.getAttribute('src')).toBe(VIDEO_CROP.dataUrl);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent('get-image')).toEqual([]);
  });

  it('says "This video blocks screenshots" for an all-black crop from an unreadable video, without matching', async () => {
    cap.result = { crop: VIDEO_CROP, videoTime: 12, black: true, overVideo: true, videoReadable: false };
    begin();
    dragBox();
    await waitFor(() => expect(state()).toBe('error'));
    expect(pop().getByText('This video blocks screenshots')).toBeTruthy();
    expect(sent('recognize')).toEqual([]);
  });

  // Review (content copy): a real fade-to-black moment in a READABLE video is not DRM -
  // it must go through normal recognition ("nothing found"), not "blocks screenshots".
  it('runs normal recognition for an all-black crop from a readable video (a real dark frame)', async () => {
    cap.result = { crop: VIDEO_CROP, videoTime: 12, black: true, overVideo: true, videoReadable: true };
    replies.recognize = () => response([], []);
    begin();
    dragBox();
    await waitFor(() => expect(sent('recognize')).toHaveLength(1));
    expect(ui().queryByText('This video blocks screenshots')).toBeNull();
  });

  it("says a crop/decode failure couldn't read that part of the screen, not the restricted-page copy", async () => {
    const capture = await import('./capture');
    vi.mocked(capture.cropSelection).mockRejectedValueOnce(new Error('createImageBitmap failed'));
    begin();
    dragBox();
    await waitFor(() => expect(state()).toBe('error'));
    expect(pop().getByText("Couldn't read that part of the screen. Try again.")).toBeTruthy();
    expect(ui().queryByText("Duel Lens can't read this page.")).toBeNull();
  });

  it('explains a matcher failure and links to Options', async () => {
    replies.recognize = () => ({ ...CONFIDENT(), result: { ...CONFIDENT().result, candidates: [], error: 'model failed to load' } });
    begin();
    dragBox();
    await waitFor(() => expect(state()).toBe('error'));
    expect(pop().getByText(/model failed to load/)).toBeTruthy();
    fireEvent.click(ui().getByRole('button', { name: 'Open Options' }));
    expect(sent('open-options')).toEqual([{ type: 'open-options' }]);
  });

  it('says so when the extension is no longer reachable', async () => {
    replies.recognize = () => {
      throw new Error('Extension context invalidated.');
    };
    begin();
    dragBox();
    await waitFor(() => expect(state()).toBe('error'));
    expect(pop().getByText('Duel Lens was updated or restarted. Reload the page to scan again.')).toBeTruthy();
  });
});

// ---------- click to scan ----------
// The page is window.innerWidth x innerHeight CSS px; the screenshot and the detection are twice
// that (devicePixelRatio 2), like the decoded bitmap above.
/** An upright card with its top-left corner at (x, y), in screenshot pixels. */
function card(x: number, y: number, w: number, h: number): DetectedCardBox {
  return {
    cx: x + w / 2,
    cy: y + h / 2,
    w,
    h,
    angle: 0,
    conf: 0.9,
    pts: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
  };
}
// On the page: A at (100,80) 120x175 (the box dragBox() draws), B at (500,100) 120x175.
const A = card(200, 160, 240, 350);
const B = card(1000, 200, 240, 350);

function detected(boxes: DetectedCardBox[], capturedAt = 1, extra: { error?: string } = {}) {
  return send({
    type: 'cards-detected',
    capturedAt,
    detection: { boxes, width: window.innerWidth * 2, height: window.innerHeight * 2, ms: 180, ...extra },
  });
}

const outlines = () => ui().queryAllByRole('button', { name: /^Card \d+ of \d+$/ });
const cardsAttr = () => host()?.getAttribute('data-duel-lens-cards');

function clickAt(x: number, y: number) {
  const layer = roots[roots.length - 1].querySelector<HTMLElement>('.layer')!; // a dialog only while no popover shows
  fireEvent.pointerDown(layer, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(layer, { clientX: x, clientY: y, pointerId: 1 });
}

describe('click to scan', () => {
  it('outlines the cards found on this screenshot, and mirrors how many for end-to-end tests', async () => {
    begin();
    expect(barText()).toBe('Finding cards…');
    const { sendResponse } = detected([A, B]);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await waitFor(() => expect(outlines()).toHaveLength(2));
    expect(barText()).toBe('2 cards');
    expect(cardsAttr()).toBe('2');
  });

  it('ignores a cards-detected for another screenshot (a stale capturedAt)', async () => {
    begin(); // capturedAt 1
    detected([A, B], 0);
    detected([A], 2);
    await Promise.resolve();
    expect(outlines()).toHaveLength(0);
    expect(barText()).toBe('Finding cards…');
    expect(cardsAttr()).toBeNull();
    detected([A, B], 1);
    await waitFor(() => expect(outlines()).toHaveLength(2));
  });

  it("scans a clicked card: crops its screenshot pixels, sends recognize and anchors the popover to it", async () => {
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    clickAt(560, 187); // the middle of B on the page

    await waitFor(() => expect(state()).toBe('result'));
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropDetectedCard)).toHaveBeenCalledWith(
      { x: 1000, y: 200, w: 240, h: 350 }, // B's bounds in screenshot pixels, as detected
      { width: 2048, height: 1536 },
      ['video-grab'],
      {
        viewportWidth: window.innerWidth,
        shotWidth: window.innerWidth * 2,
        // Its corners too, as detected: the crop carries them for the engine (click-regression-report.md).
        shotPts: [
          [1000, 200],
          [1240, 200],
          [1240, 550],
          [1000, 550],
        ],
        // And where it was clicked (CSS px): the engine checks the card it finds in the crop against it (click-stack-report.md).
        click: [560, 187],
      },
    );
    expect(vi.mocked(capture.cropSelection)).not.toHaveBeenCalled();
    expect(sent('recognize')).toEqual([
      { type: 'recognize', crop: VIDEO_CROP, context: { pageUrl: location.href, pageTitle: 'Feature match', videoTime: 1458 } },
    ]);
    // The finished box sits on the card (3 px outside its edge), and the popover beside the card
    // (right of B: 500 + 120 + 12 gap).
    const done = roots[roots.length - 1].querySelector<HTMLElement>('.sel.done')!;
    expect([done.style.left, done.style.top, done.style.width, done.style.height]).toEqual(['497px', '97px', '126px', '181px']);
    const pop = ui().getByRole('dialog', { name: /card details/i });
    await waitFor(() => expect(pop.style.left).toBe('632px'));
  });

  it('shows the card being matched with the foil sweep, then the popover', async () => {
    let release!: () => void;
    replies.recognize = () => new Promise<RecognizeResponse>((r) => (release = () => r(CONFIDENT())));
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    clickAt(160, 167); // A
    await waitFor(() => expect(state()).toBe('scanning'));
    const root = roots[roots.length - 1];
    expect(root.querySelector('.sel.scanning')).not.toBeNull();
    expect(root.querySelector('.sel-anchor .sel-label')?.textContent).toBe('Matching artwork…');
    expect(outlines()).toHaveLength(2); // UX-1: every outline stays, dimmed under the sweep
    release();
    await waitFor(() => expect(state()).toBe('result'));
    expect(host()!.getAttribute('data-duel-lens-card')).toBe('Ash Blossom & Joyous Spring');
  });

  it('scans the card chosen with the keyboard (Tab, Tab, Enter)', async () => {
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(sent('recognize')).toHaveLength(1));
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropDetectedCard).mock.calls[0][0]).toEqual({ x: 1000, y: 200, w: 240, h: 350 });
    // Nothing was clicked on the frame: no click point goes with the crop.
    expect(vi.mocked(capture.cropDetectedCard).mock.calls[0][3]).not.toHaveProperty('click');
  });

  it('a click beside the cards scans nothing: the frame stays frozen, and it sets a first corner', async () => {
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    clickAt(900, 600);
    await Promise.resolve();
    expect(state()).toBe('selecting');
    expect(host()).not.toBeNull();
    expect(sent('recognize')).toEqual([]);
    expect(ui().getByText('Click the opposite corner')).toBeTruthy();
  });

  // a11y review M1 (WCAG 2.5.7): a box without dragging.
  it('scans the box between two clicks, beside the cards or on them, like a drag', async () => {
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    clickAt(40, 30);
    clickAt(160, 167); // on card A: the second corner, not a pick
    await waitFor(() => expect(state()).toBe('result'));
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropSelection).mock.calls[0][0]).toEqual({ x: 40, y: 30, w: 120, h: 137 });
    expect(vi.mocked(capture.cropDetectedCard)).not.toHaveBeenCalled();
  });

  it('says "Finding cards…" for up to 1.5 s, then the drag hint when no detection comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    begin();
    expect(barText()).toBe('Finding cards…');
    await act(async () => {
      vi.advanceTimersByTime(1400);
    });
    expect(barText()).toBe('Finding cards…');
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(barText()).toBe('Drag a box around a card');
  });

  it('still outlines cards whose detection comes after the 1.5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    begin();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await act(async () => {
      detected([A, B]);
    });
    expect(outlines()).toHaveLength(2);
    expect(barText()).toBe('2 cards');
  });

  it('shows the drag hint at once when the detection says there is no detector, and no outlines', async () => {
    begin();
    expect(barText()).toBe('Finding cards…');
    detected([], 1, { error: NO_CARD_DETECTOR });
    await waitFor(() => expect(barText()).toBe('Drag a box around a card'));
    expect(outlines()).toHaveLength(0);
    expect(cardsAttr()).toBe('0');
  });

  // Live check p4: the plain drag hint didn't say that no card was found.
  it('says so when the detector found no card, and to drag a box', async () => {
    begin();
    detected([]);
    await waitFor(() => expect(barText()).toBe('No cards found. Drag a box around one.'));
    expect(outlines()).toHaveLength(0);
  });

  it('once a detection said it could not run, starts the next scans on the drag hint (no "Finding cards…")', async () => {
    begin();
    detected([], 1, { error: NO_CARD_DETECTOR });
    await waitFor(() => expect(barText()).toBe('Drag a box around a card'));
    fireEvent.keyDown(document.body, { key: 'Escape' });

    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 2 });
    expect(barText()).toBe('Drag a box around a card');
    // Cards still get outlined if a detection brings some after all.
    detected([A, B], 2);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // And a detection that found cards makes the next scan wait for them again.
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 3 });
    expect(barText()).toBe('Finding cards…');
  });

  // Review M2: only "no card detector in this build" says anything about the next scans.
  it('after a detection that failed for another reason, the next scan waits for cards again ("Finding cards…")', async () => {
    const transient = "Duel Lens couldn't reach its card detector (Could not establish connection. Receiving end does not exist.)";
    begin();
    detected([], 1, { error: transient });
    await waitFor(() => expect(barText()).toBe('Drag a box around a card'));
    fireEvent.keyDown(document.body, { key: 'Escape' });

    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 2 });
    expect(barText()).toBe('Finding cards…');
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // A stale detection's failure (an earlier screenshot's) doesn't either.
    detected([], 1, { error: "Duel Lens couldn't find the cards: it took too long" });
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 3 });
    expect(barText()).toBe('Finding cards…');
  });

  // Review M1: the background says so before begin-selection once it knows (scan.ts).
  it('opens on the drag hint, with no "Finding cards…" at all, when the no-detector answer comes before its begin-selection', () => {
    detected([], 5, { error: NO_CARD_DETECTOR });
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 5 });
    expect(barText()).toBe('Drag a box around a card');
  });

  it('without any detection (no card detector answered yet), a drag scans exactly as before and a click only sets a corner', async () => {
    begin();
    clickAt(160, 167);
    await Promise.resolve();
    expect(state()).toBe('selecting');
    dragBox();
    await waitFor(() => expect(state()).toBe('result'));
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropSelection)).toHaveBeenCalledWith(
      { x: 100, y: 80, w: 120, h: 175 },
      { width: 2048, height: 1536 },
      ['video-grab'],
      { viewportWidth: window.innerWidth },
    );
    expect(vi.mocked(capture.cropDetectedCard)).not.toHaveBeenCalled();
    expect(sent('recognize')).toHaveLength(1);
  });

  it('lets a drag in progress finish as a drag when the detection arrives in the middle of it', async () => {
    begin();
    const layer = ui().getByRole('dialog', { name: /select a card/i });
    fireEvent.pointerDown(layer, { clientX: 100, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 150, clientY: 150, pointerId: 1 });
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    fireEvent.pointerMove(layer, { clientX: 220, clientY: 255, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 220, clientY: 255, pointerId: 1 });
    await waitFor(() => expect(sent('recognize')).toHaveLength(1));
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropSelection).mock.calls[0][0]).toEqual({ x: 100, y: 80, w: 120, h: 175 });
    expect(vi.mocked(capture.cropDetectedCard)).not.toHaveBeenCalled();
  });

  it('uses a detection that arrives before its own begin-selection', async () => {
    detected([A, B], 7);
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 7 });
    await waitFor(() => expect(outlines()).toHaveLength(2));
  });

  it("doesn't carry cards into the next scan", async () => {
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 2 });
    await Promise.resolve();
    expect(outlines()).toHaveLength(0);
    expect(barText()).toBe('Finding cards…');
  });
});

describe('popover actions', () => {
  // UX-1: "Open in side panel" no longer ends the session.
  it('Keep sends show-in-panel, and scan mode stays, the popover too', async () => {
    await scanToResult();
    fireEvent.click(ui().getByRole('button', { name: 'Keep in side panel' }));
    await waitFor(() => expect(sent('show-in-panel')).toEqual([{ type: 'show-in-panel', entryId: 'entry-1' }]));
    await new Promise((r) => setTimeout(r, 10));
    expect(host()).not.toBeNull();
    expect(state()).toBe('result');
    expect(frame()).not.toBeNull();
  });

  it('Keep shows the reason in a toast when the side panel cannot open', async () => {
    replies['show-in-panel'] = () => ({ ok: false, error: 'Press Alt+Shift+U to open the side panel' });
    await scanToResult();
    fireEvent.keyDown(document.body, { key: 's' });
    expect(await ui().findByText('Press Alt+Shift+U to open the side panel')).toBeTruthy();
    expect(host()).not.toBeNull();
  });

  it('picking another match records the correction and shows that card', async () => {
    await scanToResult();
    fireEvent.click(ui().getByRole('button', { name: /Ghost Belle/ }));
    await waitFor(() => expect(ui().getByRole('heading', { name: BELLE.name })).toBeTruthy());
    expect(sent('correct')).toEqual([{ type: 'correct', entryId: 'entry-1', cardId: BELLE.id, imageId: BELLE.imageIds[0] }]);
    expect(host()!.getAttribute('data-duel-lens-card')).toBe(BELLE.name);
  });

  it('Ask AI sends the crop and candidates, then shows the card the AI names', async () => {
    replies.recognize = () => UNSURE();
    replies['ask-ai'] = (): AskAiResponse => ({
      cardId: DROLL.id,
      imageId: DROLL.imageIds[0],
      answer: 'Droll & Lock Bird',
      confident: true,
    });
    await scanToResult();
    expect(host()!.getAttribute('data-duel-lens-confident')).toBe('false');
    fireEvent.click(ui().getByRole('button', { name: 'Ask AI' }));
    await waitFor(() => expect(ui().getByRole('heading', { name: DROLL.name })).toBeTruthy());
    expect(sent('ask-ai')).toEqual([{ type: 'ask-ai', crop: VIDEO_CROP, candidates: UNSURE().result.candidates }]);
    expect(ui().getByText('AI says: Droll & Lock Bird')).toBeTruthy();
    expect(sent('correct')).toEqual([{ type: 'correct', entryId: 'entry-1', cardId: DROLL.id, imageId: DROLL.imageIds[0] }]);
  });

  it('never reads chrome.storage, so the settings and API key stay out of the page', async () => {
    replies.recognize = () => UNSURE();
    await scanToResult();
    expect(await ui().findByRole('button', { name: 'Ask AI' })).toBeTruthy();
    expect(storageGet).not.toHaveBeenCalled();
  });

  it('shows an unsure AI answer as such, without switching the card or recording a correction', async () => {
    replies.recognize = () => UNSURE();
    replies['ask-ai'] = (): AskAiResponse => ({
      cardId: DROLL.id,
      imageId: DROLL.imageIds[0],
      answer: 'Droll & Lock Bird',
      confident: false,
    });
    await scanToResult();
    fireEvent.click(ui().getByRole('button', { name: 'Ask AI' }));
    expect(await ui().findByText("AI isn't sure: Droll & Lock Bird")).toBeTruthy();
    expect(ui().getByRole('heading', { name: VEILER.name })).toBeTruthy(); // the local match stays
    expect(ui().getByText(/Not sure/)).toBeTruthy();
    expect(ui().queryByText('AI agrees')).toBeNull();
    expect(sent('correct')).toEqual([]);
    expect(host()!.getAttribute('data-duel-lens-card')).toBe(VEILER.name);
  });

  it('shows "Turn on AI check in Options" when the response says the AI check is off', async () => {
    aiEnabled = false;
    replies.recognize = () => UNSURE();
    await scanToResult();
    fireEvent.click(await ui().findByRole('button', { name: 'Turn on AI check in Options' }));
    expect(sent('open-options')).toEqual([{ type: 'open-options' }]);
  });

  it('a click on the page outside the frozen frame leaves scan mode', async () => {
    await scanToResult();
    fireEvent.pointerDown(document.body);
    expect(host()).toBeNull();
  });
});

describe('prepare-capture', () => {
  // A manual frame queue: each flushFrame() runs the callbacks of one animation frame.
  let frames: FrameRequestCallback[];
  const flushFrame = () => frames.splice(0).forEach((cb) => cb(performance.now()));
  beforeEach(() => {
    frames = [];
  });
  const stubFrames = () =>
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));

  it('answers at once when nothing is shown', () => {
    stubFrames();
    const { sendResponse, returned } = send({ type: 'prepare-capture' });
    expect(sendResponse.mock.calls).toEqual([[{ ok: true }]]); // no `closed`: a capture follows
    expect(returned).not.toBe(true);
  });

  // UX-1: the shortcut (or the toolbar icon) while scan mode is open leaves it instead of capturing the frozen frame.
  it('while scan mode is open, leaves it and answers { ok, closed } at once: no capture follows, no frames are grabbed', async () => {
    const capture = await import('./capture');
    await scanToResult();
    const grabs = vi.mocked(capture.grabVideoFrames).mock.calls.length;
    const page = vi.fn();
    document.addEventListener('keydown', page);
    stubFrames();

    const { sendResponse, returned } = send({ type: 'prepare-capture' });
    expect(returned).not.toBe(true); // answered at once, no repaint to wait for
    expect(sendResponse.mock.calls).toEqual([[{ ok: true, closed: true }]]);
    expect(host()).toBeNull();
    expect(vi.mocked(capture.grabVideoFrames).mock.calls.length).toBe(grabs);

    fireEvent.keyDown(document.body, { key: 'k' }); // and the keys are back with the page
    expect(page).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', page);
  });

  it('while only a toast shows (no scan mode), takes it off and answers { ok: true } after the repaint: the capture goes on', () => {
    send({ type: 'show-error', message: 'x' });
    stubFrames();
    const { sendResponse, returned } = send({ type: 'prepare-capture' });
    expect(returned).toBe(true);
    flushFrame();
    flushFrame();
    expect(sendResponse.mock.calls).toEqual([[{ ok: true }]]); // no `closed`
  });

  it('also takes a toast off the page', () => {
    send({ type: 'show-error', message: "Duel Lens can't read this page." });
    expect(host()).not.toBeNull();
    stubFrames();
    const { sendResponse } = send({ type: 'prepare-capture' });
    expect(host()).toBeNull();
    flushFrame();
    flushFrame();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('still answers if animation frames never come (a hidden or occluded window)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    send({ type: 'show-error', message: 'x' });
    stubFrames(); // frames are queued but never flushed
    const { sendResponse } = send({ type: 'prepare-capture' });
    expect(sendResponse).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('answers { ok: false, error } when the teardown itself throws, instead of leaving the message unanswered', () => {
    send({ type: 'show-error', message: 'x' });
    expect(host()).not.toBeNull();
    // Force the synchronous throw inside prepareCapture's teardown (toastOnly.close() -> host.destroy() -> host.remove()).
    const remove = vi.spyOn(Element.prototype, 'remove').mockImplementation(() => {
      throw new Error('teardown failed');
    });
    try {
      const { sendResponse, returned } = send({ type: 'prepare-capture' });
      expect(returned).not.toBe(true);
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'teardown failed' });
    } finally {
      remove.mockRestore();
    }
  });
});

describe('show-error', () => {
  it('shows the message as a toast that goes away by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { sendResponse } = send({ type: 'show-error', message: "Duel Lens can't read this page." });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(ui().getByText("Duel Lens can't read this page.")).toBeTruthy();
    vi.advanceTimersByTime(5000);
    expect(host()).toBeNull();
  });
});

// ---------- only Duel Lens's own messages (security review M2/L3) ----------

describe('messages from others', () => {
  it('ignores a message from another extension, or with no sender id: no toast, no frozen frame, no answer', () => {
    for (const sender of [{ id: 'another-extension' }, {}]) {
      const toast = send({ type: 'show-error', message: 'Spoofed' }, sender);
      const frame = send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 9 }, sender);
      expect(toast.sendResponse).not.toHaveBeenCalled();
      expect(frame.sendResponse).not.toHaveBeenCalled();
      expect(toast.returned).toBeUndefined();
      expect(host()).toBeNull();
    }
    expect(send({ type: 'ping' }).sendResponse).toHaveBeenCalledWith({ ok: true }); // ours still is answered
  });
});

// ---------- a11y review B1: focus goes to the overlay, and back to the page ----------

describe('focus', () => {
  let pageButton: HTMLButtonElement;
  beforeEach(() => {
    pageButton = document.createElement('button');
    pageButton.textContent = 'Play';
    document.body.append(pageButton);
    pageButton.focus();
  });
  const layer = () => roots[roots.length - 1].querySelector('.layer');

  it('moves into the selection dialog as it opens', () => {
    begin();
    expect(roots[roots.length - 1].activeElement).toBe(layer());
  });

  it('comes back to the page element that had it, on Esc during the selection', () => {
    begin();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(host()).toBeNull();
    expect(document.activeElement).toBe(pageButton);
  });

  it('stays in Duel Lens when the popover closes, and comes back when Duel Lens does; the page gets its keys again', async () => {
    await scanToResult();
    expect(roots[roots.length - 1].activeElement).toBe(ui().getByRole('dialog', { name: /card details/i }));
    closeCard();
    expect(roots[roots.length - 1].activeElement).toBe(layer()); // a box was read: no outline to go back to
    expect(document.activeElement).not.toBe(pageButton);
    fireEvent.click(exitButton());
    expect(document.activeElement).toBe(pageButton);
    const page = vi.fn();
    pageButton.addEventListener('keydown', page);
    fireEvent.keyDown(pageButton, { key: 'k' });
    expect(page).toHaveBeenCalledTimes(1);
  });

  it('comes back on a click outside, and after an error closes', async () => {
    await scanToResult();
    fireEvent.pointerDown(document.body);
    expect(document.activeElement).toBe(pageButton);
    cap.result = { crop: VIDEO_CROP, videoTime: 12, black: true, overVideo: true, videoReadable: false };
    begin();
    dragBox();
    await waitFor(() => expect(state()).toBe('error'));
    fireEvent.keyDown(document.body, { key: 'Escape' }); // closes the error's popover
    fireEvent.keyDown(document.body, { key: 'Escape' }); // leaves
    expect(document.activeElement).toBe(pageButton);
  });

  // A new scan takes it over (the new overlay has focus); it comes back to the page element the user
  // first left when that one closes. In between, the page shows no focus ring for the new screenshot.
  it('comes back, through a new scan that replaced the open one, to where it was before the first', async () => {
    await scanToResult();
    begin(); // the shortcut again, straight to begin-selection
    expect(roots[roots.length - 1].activeElement).toBe(layer());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(document.activeElement).toBe(pageButton);
  });

  // UX-1: the shortcut while scan mode is open leaves it (prepare-capture answers `closed`): focus comes back at once.
  it('comes back at once when the shortcut leaves scan mode', async () => {
    await scanToResult();
    send({ type: 'prepare-capture' });
    expect(host()).toBeNull();
    expect(document.activeElement).toBe(pageButton);
  });

  it('stays where the user moved it on the page', async () => {
    await scanToResult();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus(); // moved to the page by some other means
    fireEvent.keyDown(document.body, { key: 'Escape' }); // the popover
    fireEvent.keyDown(document.body, { key: 'Escape' }); // scan mode
    expect(host()).toBeNull();
    expect(document.activeElement).toBe(other);
  });
});

// ---------- a11y review B2 and M4: the outcome in words, in English ----------

describe('the status region', () => {
  it('is one region, there from the start, that says "Matching artwork…" and then the answer', async () => {
    let release!: () => void;
    replies.recognize = () => new Promise<RecognizeResponse>((r) => (release = () => r(CONFIDENT())));
    begin();
    const region = announcer()!;
    expect(region.getAttribute('role')).toBe('status');
    expect(region.className).toContain('sr-only');
    expect(region.textContent).toBe('');
    dragBox();
    await waitFor(() => expect(region.textContent).toBe('Matching artwork…'));
    release();
    await waitFor(() => expect(region.textContent).toBe('Ash Blossom & Joyous Spring.'));
    expect(announcer()).toBe(region); // the same node throughout
  });

  it('says "Not sure", no card, or the error', async () => {
    replies.recognize = () => UNSURE();
    await scanToResult();
    expect(announcer()!.textContent).toBe('Not sure. Closest: Effect Veiler, 3 more possible matches.');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    replies.recognize = () => response([], [], { confident: false });
    await scanToResult();
    expect(announcer()!.textContent).toBe('No card found.');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    cap.result = { crop: VIDEO_CROP, videoTime: 12, black: true, overVideo: true, videoReadable: false };
    begin();
    dragBox();
    await waitFor(() => expect(announcer()!.textContent).toBe('This video blocks screenshots'));
  });

  it('marks the overlay as English, whatever the page is in (a toast too)', () => {
    begin();
    expect(roots[roots.length - 1].querySelector('.dl')!.getAttribute('lang')).toBe('en');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    send({ type: 'show-error', message: "Duel Lens can't read this page." });
    expect(roots[roots.length - 1].querySelector('.dl')!.getAttribute('lang')).toBe('en');
  });
});

// ---------- security review M1: the page's own events don't drive the overlay ----------

describe('only real input', () => {
  it('keeps the popover open on a pointerdown or an Escape the page made', async () => {
    await scanToResult();
    fireEvent(document.body, untrusted(createEvent.pointerDown(document.body)));
    fireEvent(document.body, untrusted(createEvent.keyDown(document.body, { key: 'Escape' })));
    expect(host()).not.toBeNull();
    fireEvent.pointerDown(document.body); // the user's own click outside still closes it
    expect(host()).toBeNull();
  });
});

// ---------- live check M2: a click on the video only dismisses ----------

describe('a click outside, on the video', () => {
  let video: HTMLVideoElement;
  let under: Element[];
  const page = { pointerdown: vi.fn(), mousedown: vi.fn(), mouseup: vi.fn(), click: vi.fn() };
  beforeEach(() => {
    video = document.createElement('video');
    document.body.append(video);
    under = [document.body];
    Object.defineProperty(document, 'elementsFromPoint', { value: vi.fn(() => under), configurable: true });
    for (const [type, fn] of Object.entries(page)) {
      fn.mockClear();
      document.addEventListener(type, fn);
    }
  });
  afterEach(() => {
    for (const [type, fn] of Object.entries(page)) document.removeEventListener(type, fn);
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  /** A whole click at (x, y) on `target`: pointerdown, mousedown, pointerup, mouseup, click. */
  function clickOn(target: Element, x = 300, y = 200) {
    const at = { clientX: x, clientY: y, pointerId: 1, button: 0 };
    fireEvent.pointerDown(target, at);
    fireEvent.mouseDown(target, at);
    fireEvent.pointerUp(target, at);
    fireEvent.mouseUp(target, at);
    fireEvent.click(target, at);
  }

  it('closes the popover without the page seeing the click (YouTube would toggle playback)', async () => {
    await scanToResult();
    Object.values(page).forEach((fn) => fn.mockClear()); // the scan's own drag bubbled out of the overlay
    under = [document.createElement('div'), video, document.body]; // the player's chrome, then the video
    clickOn(video);
    expect(host()).toBeNull();
    expect(page.pointerdown).not.toHaveBeenCalled();
    expect(page.mousedown).not.toHaveBeenCalled();
    expect(page.mouseup).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    clickOn(video); // the next click is the page's again
    expect(page.click).toHaveBeenCalledTimes(1);
  });

  it('lets a click off the video through, as before', async () => {
    await scanToResult();
    Object.values(page).forEach((fn) => fn.mockClear());
    const link = document.createElement('a');
    document.body.append(link);
    under = [link, document.body];
    clickOn(link);
    expect(host()).toBeNull();
    expect(page.pointerdown).toHaveBeenCalledTimes(1);
    expect(page.click).toHaveBeenCalledTimes(1);
  });
});

// ---------- live check m1: the video doesn't run on under the frozen frame ----------

describe('the video under Duel Lens', () => {
  /** A video element that plays, pauses and reports it, in the viewport. */
  function videoEl(playing: boolean) {
    const v = document.createElement('video');
    let on = playing;
    Object.defineProperty(v, 'paused', { get: () => !on, configurable: true });
    v.pause = vi.fn(() => {
      on = false;
    });
    v.play = vi.fn(async () => {
      on = true;
    });
    v.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, toJSON() {} }) as DOMRect;
    document.body.append(v);
    return v;
  }

  it('pauses the playing videos once the frame is frozen, and plays only those again when Duel Lens closes', () => {
    const playing = videoEl(true);
    const stopped = videoEl(false);
    begin();
    expect(playing.pause).toHaveBeenCalledTimes(1);
    expect(stopped.pause).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(playing.play).toHaveBeenCalledTimes(1);
    expect(stopped.play).not.toHaveBeenCalled();
  });

  it('keeps them paused through a new scan that replaces the open one (begin-selection), and plays them when that one closes', async () => {
    const playing = videoEl(true);
    await scanToResult();
    begin();
    expect(playing.play).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(playing.play).toHaveBeenCalledTimes(1);
  });

  // UX-1: the shortcut while scan mode is open leaves it, and they play again at once.
  it('plays them again at once when the shortcut leaves scan mode (prepare-capture)', async () => {
    const playing = videoEl(true);
    await scanToResult();
    send({ type: 'prepare-capture' });
    expect(playing.play).toHaveBeenCalledTimes(1);
  });

  it('grabs the video frames at prepare-capture, just before the screenshot, and crops from that grab', async () => {
    const capture = await import('./capture');
    const grab = { canvas: null, currentTime: 3, videoWidth: 1920, videoHeight: 1080, contentBox: { x: 0, y: 0, w: 10, h: 10 }, readable: false };
    vi.mocked(capture.grabVideoFrames).mockReturnValueOnce([grab] as unknown as ReturnType<typeof capture.grabVideoFrames>);
    const { sendResponse } = send({ type: 'prepare-capture' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(vi.mocked(capture.grabVideoFrames)).toHaveBeenCalledTimes(1);
    begin();
    dragBox();
    await waitFor(() => expect(state()).toBe('result'));
    expect(vi.mocked(capture.grabVideoFrames)).toHaveBeenCalledTimes(1); // not grabbed again
    expect(vi.mocked(capture.cropSelection).mock.calls[0][2]).toEqual([grab]);
  });
});

// ---------- live check m2: the page's layout must not change under Duel Lens ----------

describe('layout changes', () => {
  it('keeps F, T and I (fullscreen, theater, miniplayer) from the page while the frame is frozen', () => {
    const page = vi.fn();
    document.addEventListener('keydown', page);
    begin();
    for (const key of ['f', 't', 'i']) fireEvent.keyDown(document.body, { key });
    expect(page).not.toHaveBeenCalled();
    document.removeEventListener('keydown', page);
  });

  it('closes the popover when the page goes fullscreen or the window is resized, but not on a 2 px wobble', async () => {
    await scanToResult();
    document.dispatchEvent(trusted(new Event('fullscreenchange'))); // the browser's own, as when the user presses F11
    expect(host()).toBeNull();
    await scanToResult();
    const w = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { value: w + 2, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host()).not.toBeNull();
    Object.defineProperty(window, 'innerWidth', { value: w + 40, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host()).toBeNull();
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
  });

  // Final review M2 (security review M1): the page's own script can't close the popover with a made-up event.
  it("keeps the popover open on a fullscreenchange the page's script dispatched", async () => {
    await scanToResult();
    document.dispatchEvent(untrusted(new Event('fullscreenchange')));
    expect(host()).not.toBeNull();
    document.dispatchEvent(trusted(new Event('fullscreenchange')));
    expect(host()).toBeNull();
  });
});

// ---------- live check m4: outlines on the video, not on the page's thumbnails ----------

describe('outlines around a video', () => {
  // On the page: A at (100,80), C at (800,100), both 120x175.
  const C = card(1600, 200, 240, 350);

  it('keeps only the cards inside a video that covers a quarter of the viewport or more', async () => {
    const capture = await import('./capture');
    const video = { canvas: null, currentTime: 3, videoWidth: 1920, videoHeight: 1080, contentBox: { x: 0, y: 0, w: 700, h: 500 }, readable: false };
    vi.mocked(capture.grabVideoFrames).mockReturnValueOnce([video] as unknown as ReturnType<typeof capture.grabVideoFrames>);
    begin();
    detected([A, C]);
    await waitFor(() => expect(cardsAttr()).toBe('1'));
    expect(outlines().map((o) => o.getAttribute('aria-label'))).toEqual(['Card 1 of 1']);
  });

  it('keeps every card beside a small video, or with none', async () => {
    const capture = await import('./capture');
    const small = { canvas: null, currentTime: 3, videoWidth: 480, videoHeight: 270, contentBox: { x: 0, y: 0, w: 300, h: 200 }, readable: false };
    vi.mocked(capture.grabVideoFrames).mockReturnValueOnce([small] as unknown as ReturnType<typeof capture.grabVideoFrames>);
    begin();
    detected([A, C]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
  });
});

// ---------- live check m6: "nothing" after a click gets its own advice ----------

describe('a picked card that reads nothing', () => {
  it('gets the advice for a picked card, not the framing advice', async () => {
    replies.recognize = () => response([], [], { confident: false });
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
    clickAt(160, 167);
    await waitFor(() => expect(state()).toBe('result'));
    expect(ui().getByText(/Couldn't read this card\./)).toBeTruthy();
  });
});

// ---------- UX-1: scan mode stays open after a read ----------

/** A promise and its resolve, for a reply the test releases. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('scan mode stays open (UX-1)', () => {
  const layerEl = () => roots[roots.length - 1].querySelector<HTMLElement>('.layer')!;
  const outlineOf = (n: number) => ui().getByRole('button', { name: `Card ${n} of 2` });

  async function openOnCards() {
    begin();
    detected([A, B]);
    await waitFor(() => expect(outlines()).toHaveLength(2));
  }

  it('reads another card on a click: its popover replaces the first (the matching state meanwhile), and every read is recorded', async () => {
    await openOnCards();
    clickAt(160, 167); // A
    await waitFor(() => expect(host()!.getAttribute('data-duel-lens-card')).toBe(ASH.name));
    expect(frame()).not.toBeNull();
    expect(outlines()).toHaveLength(2);
    const second = deferred<RecognizeResponse>();
    replies.recognize = () => second.promise;
    clickAt(560, 187); // B
    await waitFor(() => expect(state()).toBe('scanning'));
    expect(ui().getAllByRole('dialog', { name: /card details/i })).toHaveLength(1);
    expect(ui().getByRole('dialog', { name: /card details/i }).getAttribute('aria-busy')).toBe('true');
    second.resolve(response([BELLE, OGRE], [0.95, 0.7]));
    await waitFor(() => expect(host()!.getAttribute('data-duel-lens-card')).toBe(BELLE.name));
    expect(ui().getAllByRole('dialog', { name: /card details/i })).toHaveLength(1);
    expect(announcer()!.textContent).toBe(`${BELLE.name}.`);
    // Both reads recorded (no peek: this is click mode).
    expect(sent('recognize').map((m) => (m as { record?: boolean }).record)).toEqual([undefined, undefined]);
  });

  it('does nothing on a click on the card whose details already show', async () => {
    await openOnCards();
    clickAt(160, 167);
    await waitFor(() => expect(state()).toBe('result'));
    clickAt(160, 167);
    await new Promise((r) => setTimeout(r, 10));
    expect(sent('recognize')).toHaveLength(1);
  });

  it('Esc closes the popover and gives focus back to the card’s outline, the outlines stay; the next Esc leaves', async () => {
    await openOnCards();
    clickAt(560, 187); // B
    await waitFor(() => expect(state()).toBe('result'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(ui().queryByRole('dialog', { name: /card details/i })).toBeNull();
    expect(roots[roots.length - 1].activeElement).toBe(outlineOf(2));
    expect(outlines()).toHaveLength(2);
    expect(state()).toBe('selecting');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(host()).toBeNull();
  });

  it('a click on no card with a popover open closes it and sets no corner; a drag there reads a box', async () => {
    await openOnCards();
    clickAt(160, 167);
    await waitFor(() => expect(state()).toBe('result'));
    clickAt(900, 600);
    expect(state()).toBe('selecting');
    expect(roots[roots.length - 1].querySelector('.corner')).toBeNull();
    clickAt(160, 167); // A again: read again, the popover was closed
    await waitFor(() => expect(state()).toBe('result'));
    const layer = layerEl();
    fireEvent.pointerDown(layer, { clientX: 700, clientY: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 800, clientY: 550, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 800, clientY: 550, pointerId: 1 });
    await waitFor(() => expect(sent('recognize')).toHaveLength(3));
    const capture = await import('./capture');
    expect(vi.mocked(capture.cropSelection).mock.calls[0][0]).toEqual({ x: 700, y: 400, w: 100, h: 150 });
  });

  // The lead's ruling: K and Space (YouTube's play/pause) leave and play the video, even over a popover with a Keep.
  it.each([
    ['K', 'k'],
    ['Space', ' '],
  ])('%s leaves scan mode and plays the videos Duel Lens paused, even with a keepable popover open; the page never gets the key', async (_, key) => {
    const v = document.createElement('video');
    let on = true;
    Object.defineProperty(v, 'paused', { get: () => !on, configurable: true });
    v.pause = vi.fn(() => void (on = false));
    v.play = vi.fn(async () => void (on = true));
    v.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, toJSON() {} }) as DOMRect;
    document.body.append(v);
    const page = vi.fn();
    document.addEventListener('keydown', page);
    document.addEventListener('keyup', page);
    await scanToResult();
    expect(ui().getByRole('button', { name: 'Keep in side panel' })).toBeTruthy();
    fireEvent.keyDown(document.body, { key });
    expect(host()).toBeNull();
    expect(v.play).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(document.body, { key }); // its release is Duel Lens's too (it would press the page's play button)
    expect(page).not.toHaveBeenCalled();
    expect(sent('show-in-panel')).toEqual([]);
    document.removeEventListener('keydown', page);
    document.removeEventListener('keyup', page);
  });

  it('S keeps the card in the side panel, and scan mode stays', async () => {
    await scanToResult();
    fireEvent.keyDown(document.body, { key: 's' });
    await waitFor(() => expect(sent('show-in-panel')).toEqual([{ type: 'show-in-panel', entryId: 'entry-1' }]));
    expect(host()).not.toBeNull();
  });

  it('stays open while the side panel Keep opened takes its room (a resize), and leaves on a later resize', async () => {
    await scanToResult();
    const w = window.innerWidth;
    fireEvent.click(ui().getByRole('button', { name: 'Keep in side panel' }));
    await waitFor(() => expect(sent('show-in-panel')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    Object.defineProperty(window, 'innerWidth', { value: w - 320, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host()).not.toBeNull();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host()).toBeNull();
  });

  it('leaves with the bar’s ✕ ("Exit Duel Lens"), focus back to the page', async () => {
    const pageButton = document.createElement('button');
    document.body.append(pageButton);
    pageButton.focus();
    await scanToResult();
    fireEvent.click(exitButton());
    expect(host()).toBeNull();
    expect(document.activeElement).toBe(pageButton);
  });
});

// ---------- UX-2: hover previews ----------

describe('hover previews (UX-2)', () => {
  const C = card(1600, 200, 240, 350); // on the page: (800,100) 120x175
  const layerEl = () => roots[roots.length - 1].querySelector<HTMLElement>('.layer')!;
  const pv = () => roots[roots.length - 1].querySelector<HTMLElement>('.pv');
  const previewAttr = () => host()?.getAttribute('data-duel-lens-preview') ?? null;
  const peeks = () => sent('recognize').filter((m) => (m as { record?: boolean }).record === false);
  const records = () => sent('recognize').filter((m) => (m as { record?: boolean }).record !== false);
  const hoverOn = (x: number, y: number) => fireEvent.pointerMove(layerEl(), { clientX: x, clientY: y, pointerId: 1 });
  const rest = (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  /** The background's answer: a peek (record false) gets no history entry. */
  const answer = (make: () => RecognizeResponse) => (m: Extract<ToBackground, { type: 'recognize' }>) =>
    m.record === false ? { ...make(), entry: undefined } : make();

  async function openHover(reveal: 'hover' | 'click' | null = 'hover', boxes = [A, B, C]) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    replies.recognize = answer(CONFIDENT);
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 1, ...(reveal ? { reveal } : {}) });
    detected(boxes);
    await rest();
  }

  it('shows a compact preview once the pointer rests 250 ms on an outline, from a read that records nothing', async () => {
    await openHover();
    hoverOn(160, 167); // A
    await rest(240);
    expect(peeks()).toHaveLength(0);
    await rest(20);
    expect(peeks()).toHaveLength(1);
    expect(pv()!.querySelector('.pv-head')!.textContent).toBe(ASH.name);
    expect(pv()!.textContent).toContain('[Zombie / Tuner / Effect]');
    expect(pv()!.textContent).toContain('ATK 0 / DEF 1800');
    expect(pv()!.querySelector('img, button')).toBeNull(); // no image (no network), no buttons
    expect(previewAttr()).toBe(ASH.name);
    expect(records()).toEqual([]);
    expect(sent('get-image')).toEqual([]);
    expect(state()).toBe('selecting'); // no popover
  });

  it('shows nothing for a pointer passing over outlines faster', async () => {
    await openHover();
    hoverOn(160, 167);
    await rest(150);
    hoverOn(560, 187);
    await rest(150);
    hoverOn(700, 600); // off the cards
    await rest(600);
    expect(peeks()).toHaveLength(0);
    expect(pv()).toBeNull();
  });

  it('Esc hides it without moving the pointer, and scan mode stays; it shows again once the pointer leaves and comes back, from its first read', async () => {
    await openHover();
    hoverOn(160, 167);
    await rest(260);
    expect(pv()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(pv()).toBeNull();
    expect(host()).not.toBeNull();
    await rest(1000);
    expect(pv()).toBeNull(); // the pointer is still on it: dismissed
    hoverOn(700, 600);
    hoverOn(160, 167);
    await rest(260);
    expect(pv()).not.toBeNull();
    expect(peeks()).toHaveLength(1); // kept for the session: no second read
  });

  it('can be reached by the pointer (150 ms after it leaves the card), stays while the pointer is on it, and goes when it leaves', async () => {
    await openHover();
    hoverOn(160, 167);
    await rest(260);
    hoverOn(700, 600); // leaves the card
    await rest(100);
    fireEvent.pointerEnter(pv()!); // reached it within the grace
    await rest(1000);
    expect(pv()).not.toBeNull();
    fireEvent.pointerLeave(pv()!);
    await rest(140);
    expect(pv()).not.toBeNull();
    await rest(20);
    expect(pv()).toBeNull();
  });

  it('goes 150 ms after the pointer leaves its card when the pointer doesn’t reach it', async () => {
    await openHover();
    hoverOn(160, 167);
    await rest(260);
    hoverOn(700, 600);
    await rest(140);
    expect(pv()).not.toBeNull();
    await rest(20);
    expect(pv()).toBeNull();
  });

  it('shows for keyboard focus on an outline as for a hover, and says it in words', async () => {
    await openHover();
    fireEvent.keyDown(document.body, { key: 'Tab' }); // card 1 (A)
    await rest(260);
    expect(pv()!.querySelector('.pv-head')!.textContent).toBe(ASH.name);
    const said = roots[roots.length - 1].querySelector('.layer .said')!;
    expect(said.textContent).toBe(`Card 1 of 3: ${ASH.name}. FIRE, Level 3, Zombie / Tuner / Effect, ATK 0 / DEF 1800.`);
    expect(ui().getByRole('button', { name: 'Card 1 of 3' }).getAttribute('aria-describedby')).toBe('dl-preview');
    fireEvent.keyDown(document.body, { key: 'Tab' }); // card 2 (B): A's goes, B's comes
    await rest(160);
    expect(pv()).toBeNull();
    await rest(100);
    expect(peeks()).toHaveLength(2);
    expect(pv()).not.toBeNull();
  });

  it('never records, corrects or asks the AI: an unsure card says "Not sure: <name>" with no Ask AI', async () => {
    await openHover();
    replies.recognize = answer(UNSURE);
    hoverOn(160, 167);
    await rest(260);
    expect(pv()!.querySelector('.pv-head')!.textContent).toBe(`Not sure: ${VEILER.name}`);
    expect(peeks()).toHaveLength(1);
    expect(records()).toEqual([]);
    expect(sent('correct')).toEqual([]);
    expect(sent('ask-ai')).toEqual([]);
  });

  it('reads one card at a time, and the latest one wanted comes next', async () => {
    await openHover();
    const first = deferred<RecognizeResponse>();
    replies.recognize = (m) => (peeks().length === 1 ? first.promise : answer(CONFIDENT)(m));
    hoverOn(160, 167); // A
    await rest(260);
    expect(peeks()).toHaveLength(1);
    hoverOn(560, 187); // B, while A is read
    await rest(260);
    hoverOn(860, 187); // C, while A is still read: C replaces B
    await rest(260);
    expect(peeks()).toHaveLength(1);
    await act(async () => first.resolve({ ...CONFIDENT(), entry: undefined }));
    await rest();
    expect(peeks()).toHaveLength(2); // C, not B
    const capture = await import('./capture');
    const cropped = vi.mocked(capture.cropDetectedCard).mock.calls.map((c) => c[0]);
    expect(cropped).toEqual([{ x: 200, y: 160, w: 240, h: 350 }, C.pts.length ? { x: 1600, y: 200, w: 240, h: 350 } : null]);
    expect(pv()).not.toBeNull(); // C's (A's answer came while the pointer was elsewhere: kept, not shown)
    hoverOn(700, 600);
    hoverOn(160, 167);
    await rest(260);
    expect(peeks()).toHaveLength(2); // A's read was kept
  });

  it('a click on a previewed card opens its full popover at once and records the same crop: one history entry', async () => {
    await openHover();
    const capture = await import('./capture');
    let n = 0;
    vi.mocked(capture.cropDetectedCard).mockImplementation(async () => ({ crop: { ...VIDEO_CROP, dataUrl: `data:image/png;base64,C${++n}` }, videoTime: 7, black: false, overVideo: true, videoReadable: true }));
    const record = deferred<RecognizeResponse>();
    hoverOn(160, 167);
    await rest(260);
    replies.recognize = () => record.promise;
    clickAt(160, 167);
    await rest();
    expect(state()).toBe('result'); // at once, from the preview's read
    expect(pop().getByRole('heading', { name: ASH.name })).toBeTruthy();
    expect(pv()).toBeNull();
    expect((pop().getByRole('button', { name: 'Keep in side panel' }) as HTMLButtonElement).disabled).toBe(true);
    expect(records()).toHaveLength(1);
    expect((records()[0] as Extract<ToBackground, { type: 'recognize' }>).crop).toEqual((peeks()[0] as Extract<ToBackground, { type: 'recognize' }>).crop);
    expect(vi.mocked(capture.cropDetectedCard)).toHaveBeenCalledTimes(1);
    fireEvent.click(pop().getByRole('button', { name: /Ghost Belle/ })); // a pick before the entry comes
    expect(sent('correct')).toEqual([]);
    await act(async () => record.resolve(CONFIDENT()));
    await rest();
    expect((pop().getByRole('button', { name: 'Keep in side panel' }) as HTMLButtonElement).disabled).toBe(false);
    expect(sent('correct')).toEqual([{ type: 'correct', entryId: 'entry-1', cardId: BELLE.id, imageId: BELLE.imageIds[0] }]);
    expect(records()).toHaveLength(1);
  });

  it('keeps the card it shows (no flicker) and attaches no entry when the recorded read names another card', async () => {
    await openHover();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hoverOn(160, 167);
    await rest(260);
    replies.recognize = () => response([VEILER, ASH], [0.9, 0.8]);
    clickAt(160, 167);
    await rest();
    await rest();
    expect(pop().getByRole('heading', { name: ASH.name })).toBeTruthy();
    expect(pop().queryByRole('button', { name: 'Keep in side panel' })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('with a popover open, shows another card’s preview apart from it, and none for the card the popover shows', async () => {
    await openHover();
    clickAt(160, 167); // A, read (not previewed)
    await rest();
    await rest();
    expect(state()).toBe('result');
    hoverOn(560, 187); // B
    await rest(260);
    expect(pv()!.querySelector('.pv-head')!.textContent).toBe(ASH.name);
    expect(ui().getAllByRole('dialog', { name: /card details/i })).toHaveLength(1); // the popover is still A's
    expect(host()!.getAttribute('data-duel-lens-card')).toBe(ASH.name);
    hoverOn(160, 167); // A: its details already show
    await rest(600);
    expect(pv()).toBeNull();
    expect(peeks()).toHaveLength(1);
  });

  it('Esc hides the preview first, then closes the popover, then leaves', async () => {
    await openHover();
    clickAt(160, 167);
    await rest();
    await rest();
    hoverOn(560, 187);
    await rest(260);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(pv()).toBeNull();
    expect(state()).toBe('result');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(state()).toBe('selecting');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(host()).toBeNull();
  });

  it('opens the full popover on a click on the preview itself', async () => {
    await openHover();
    hoverOn(160, 167);
    await rest(260);
    fireEvent.click(pv()!);
    await rest();
    expect(state()).toBe('result');
    expect(records()).toHaveLength(1);
  });

  it.each([['click'], [null]] as const)('shows no preview and reads nothing on a hover in "Click" mode (reveal %s: absent is "click")', async (reveal) => {
    await openHover(reveal);
    hoverOn(160, 167);
    await rest(1000);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    await rest(1000);
    expect(sent('recognize')).toEqual([]);
    expect(pv()).toBeNull();
  });
});

describe('hover previews (UX-2): Esc with the pointer on the preview', () => {
  it('hides it, and the card shows it again when the pointer comes back to it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    replies.recognize = (m) => (m.record === false ? { ...CONFIDENT(), entry: undefined } : CONFIDENT());
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 1, reveal: 'hover' });
    detected([A, B]);
    const rest = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    await rest();
    const layer = roots[roots.length - 1].querySelector<HTMLElement>('.layer')!;
    const pv = () => roots[roots.length - 1].querySelector<HTMLElement>('.pv');
    fireEvent.pointerMove(layer, { clientX: 160, clientY: 167, pointerId: 1 });
    await rest(260);
    fireEvent.pointerLeave(layer); // onto the preview, which lies over the frame
    fireEvent.pointerEnter(pv()!);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(pv()).toBeNull();
    fireEvent.pointerMove(layer, { clientX: 160, clientY: 167, pointerId: 1 });
    await rest(260);
    expect(pv()).not.toBeNull();
  });
});

// ---------- review M1: the hover-preview races ----------

describe('hover previews (UX-2): races', () => {
  const layerEl = () => roots[roots.length - 1].querySelector<HTMLElement>('.layer')!;
  const pv = () => roots[roots.length - 1].querySelector<HTMLElement>('.pv');
  const peeks = () => sent('recognize').filter((m) => (m as { record?: boolean }).record === false);
  const records = () => sent('recognize').filter((m) => (m as { record?: boolean }).record !== false);
  const rest = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const hoverOn = (x: number, y: number) => fireEvent.pointerMove(layerEl(), { clientX: x, clientY: y, pointerId: 1 });

  /** Scan mode on A and B, hover previews on; the first peek waits for the test. */
  async function openWithPendingPeek() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const peek = deferred<RecognizeResponse>();
    replies.recognize = (m) => (m.record === false && peeks().length === 1 ? peek.promise : m.record === false ? { ...CONFIDENT(), entry: undefined } : CONFIDENT());
    send({ type: 'begin-selection', screenshot: SHOT, capturedAt: 1, reveal: 'hover' });
    detected([A, B]);
    await rest();
    hoverOn(160, 167); // A
    await rest(260);
    expect(peeks()).toHaveLength(1);
    return peek;
  }

  it('drops a peek that answers after scan mode closed: nothing shows, nothing throws', async () => {
    const peek = await openWithPendingPeek();
    fireEvent.click(exitButton());
    expect(host()).toBeNull();
    await act(async () => peek.resolve({ ...CONFIDENT(), entry: undefined }));
    await rest(500);
    expect(host()).toBeNull();
  });

  it('a click on a card whose peek is under way waits for it and pins from it: one read of each kind, one history entry', async () => {
    const peek = await openWithPendingPeek();
    clickAt(160, 167); // A, its peek still under way
    await rest();
    expect(state()).toBe('scanning');
    expect(sent('recognize')).toHaveLength(1); // no second read of A
    await act(async () => peek.resolve({ ...CONFIDENT(), entry: undefined }));
    await rest();
    expect(state()).toBe('result');
    expect(host()!.getAttribute('data-duel-lens-card')).toBe(ASH.name);
    expect(peeks()).toHaveLength(1);
    expect(records()).toHaveLength(1); // the record of that same crop
    expect(pv()).toBeNull(); // no preview for the card pinned
    await rest(600);
    expect(pv()).toBeNull();
  });

  it('shows no preview for a peek that answers after another card was clicked', async () => {
    const peek = await openWithPendingPeek();
    clickAt(560, 187); // B, not previewed: read as usual
    await rest();
    await rest();
    expect(host()!.getAttribute('data-duel-lens-card')).toBe(ASH.name); // CONFIDENT's card, B's read
    await act(async () => peek.resolve({ ...CONFIDENT(), entry: undefined }));
    await rest(600);
    expect(pv()).toBeNull();
    expect(state()).toBe('result');
    expect(records()).toHaveLength(1);
  });
});

describe('the side panel’s resize grace (review M2)', () => {
  it('lets the panel take width, but a zoom (a height change too) during the grace still leaves', async () => {
    await scanToResult();
    const [w, h] = [window.innerWidth, window.innerHeight];
    fireEvent.click(ui().getByRole('button', { name: 'Keep in side panel' }));
    await waitFor(() => expect(sent('show-in-panel')).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    Object.defineProperty(window, 'innerWidth', { value: w - 320, configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host()).not.toBeNull();
    Object.defineProperty(window, 'innerWidth', { value: Math.round((w - 320) / 1.1), configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: Math.round(h / 1.1), configurable: true });
    window.dispatchEvent(new Event('resize'));
    expect(host()).toBeNull();
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
  });
});
