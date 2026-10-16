import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardDetection } from '../shared/messages';
import { NO_CARD_DETECTOR } from './offscreen-client';
import { FRAME_SKIPPED_ON_WASM } from './frame-detect';
import { FRAME_DETECT_WAIT_MS, startScan, type ScanDeps } from './scan';

const DETECTION: CardDetection = {
  boxes: [{ cx: 100, cy: 120, w: 60, h: 88, angle: 0, conf: 0.95, pts: [[70, 76], [130, 76], [130, 164], [70, 164]] }],
  width: 1456,
  height: 819,
  ms: 300,
};

function fakeDeps(overrides: Partial<ScanDeps> = {}): ScanDeps {
  return {
    captureVisibleTab: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
    sendMessageToTab: vi.fn().mockResolvedValue({ ok: true }),
    injectContentScript: vi.fn().mockResolvedValue(undefined),
    setBadgeText: vi.fn().mockResolvedValue(undefined),
    setBadgeTitle: vi.fn().mockResolvedValue(undefined),
    warmup: vi.fn().mockResolvedValue(undefined),
    detectCards: vi.fn().mockResolvedValue(DETECTION),
    grabFrame: vi.fn().mockResolvedValue(undefined),
    noCardDetector: vi.fn().mockResolvedValue(false),
    hasConsent: vi.fn().mockResolvedValue(true),
    openConsent: vi.fn().mockResolvedValue(undefined),
    reveal: vi.fn().mockResolvedValue('hover'),
    banlist: vi.fn().mockResolvedValue('tcg'),
    now: () => 1000,
    ...overrides,
  };
}

/** The types of the messages sent to the tab, in order. */
const sentTypes = (deps: ScanDeps) => vi.mocked(deps.sendMessageToTab).mock.calls.map(([, m]) => (m as { type: string }).type);

/** What chrome.tabs.sendMessage says when no content script listens in the tab. */
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
/** The badge's title on a page Duel Lens can't script (chrome://, the Web Store, ...). */
const RESTRICTED = "Duel Lens can't read this page";
/** A scan that failed on a page Duel Lens runs on: the badge's title, and the page's notice (final review M1). */
const SCAN_FAILED_TITLE = "Duel Lens couldn't start the scan. Try again";
const SCAN_FAILED_MESSAGE = "Duel Lens couldn't start the scan. Try again.";

const tab = { id: 7, windowId: 1 } as chrome.tabs.Tab;

afterEach(() => {
  vi.useRealTimers();
});

describe('startScan', () => {
  it('captures, pings the content script, sends begin-selection and warms up the offscreen doc', async () => {
    const deps = fakeDeps();
    await startScan(tab, deps);

    expect(deps.captureVisibleTab).toHaveBeenCalledWith(1);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'ping' });
    expect(deps.injectContentScript).not.toHaveBeenCalled();
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, {
      type: 'begin-selection',
      screenshot: 'data:image/png;base64,abc',
      capturedAt: 1000,
      reveal: 'hover',
      banlist: 'tcg',
    });
    expect(deps.warmup).toHaveBeenCalledTimes(1);
  });

  // UX-2: the content script must know how card details show ("Show card details" in Options) when
  // scan mode opens, and it can't read the settings itself (chrome.storage.local is closed to it).
  describe('"Show card details" (Settings.display.reveal)', () => {
    const beginSelection = (deps: ScanDeps) =>
      vi.mocked(deps.sendMessageToTab).mock.calls.map(([, m]) => m as { type: string; reveal?: string }).find((m) => m.type === 'begin-selection');

    it("sends the user's choice with begin-selection", async () => {
      const deps = fakeDeps({ reveal: vi.fn().mockResolvedValue('click') });
      await startScan(tab, deps);

      expect(beginSelection(deps)?.reveal).toBe('click');
    });

    it('sends it on the way without a card detector too', async () => {
      const deps = fakeDeps({ reveal: vi.fn().mockResolvedValue('click'), noCardDetector: vi.fn().mockResolvedValue(true) });
      await startScan(tab, deps);

      expect(beginSelection(deps)?.reveal).toBe('click');
    });

    it("sends the default, 'hover', when the settings can't be read, and still scans", async () => {
      const deps = fakeDeps({ reveal: vi.fn().mockRejectedValue(new Error('storage unavailable')) });
      await startScan(tab, deps);

      expect(beginSelection(deps)?.reveal).toBe('hover');
      expect(deps.setBadgeText).not.toHaveBeenCalledWith('!', 7);
    });

    it('reads it while the tab is captured, not after', async () => {
      const order: string[] = [];
      const deps = fakeDeps({
        reveal: vi.fn(async () => (order.push('reveal'), 'hover' as const)),
        captureVisibleTab: vi.fn(async () => (order.push('captureVisibleTab'), 'data:image/png;base64,abc')),
      });
      await startScan(tab, deps);

      expect(order).toEqual(['reveal', 'captureVisibleTab']);
    });
  });

  // The content script can't read chrome.storage.local for the setting itself; begin-selection carries it.
  describe('Banlist (Settings.display.banlist)', () => {
    const beginSelection = (deps: ScanDeps) =>
      vi.mocked(deps.sendMessageToTab).mock.calls.map(([, m]) => m as { type: string; banlist?: string }).find((m) => m.type === 'begin-selection');

    it("sends the user's choice with begin-selection", async () => {
      const deps = fakeDeps({ banlist: vi.fn().mockResolvedValue('ocg') });
      await startScan(tab, deps);

      expect(beginSelection(deps)?.banlist).toBe('ocg');
    });

    it('sends it on the way without a card detector too', async () => {
      const deps = fakeDeps({ banlist: vi.fn().mockResolvedValue('ocg'), noCardDetector: vi.fn().mockResolvedValue(true) });
      await startScan(tab, deps);

      expect(beginSelection(deps)?.banlist).toBe('ocg');
    });

    it("sends the default, 'tcg', when the settings can't be read, and still scans", async () => {
      const deps = fakeDeps({ banlist: vi.fn().mockRejectedValue(new Error('storage unavailable')) });
      await startScan(tab, deps);

      expect(beginSelection(deps)?.banlist).toBe('tcg');
      expect(deps.setBadgeText).not.toHaveBeenCalledWith('!', 7);
    });
  });

  it('sends prepare-capture to the tab before capturing', async () => {
    const deps = fakeDeps();
    await startScan(tab, deps);

    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'prepare-capture' });
  });

  // UX-1: scan mode stays open after a read, so the shortcut (or the toolbar icon: both call startScan)
  // pressed while it is open leaves it, instead of capturing the frozen frame again. The tab says so in
  // its answer to prepare-capture (PrepareCaptureReply.closed).
  describe('while scan mode is open in the tab', () => {
    const answering = (reply: unknown) =>
      vi.fn((_tabId: number, message: unknown) =>
        Promise.resolve((message as { type: string }).type === 'prepare-capture' ? reply : { ok: true }),
      );

    it('stops when the tab answers that it closed scan mode: no capture, and nothing else reaches the tab', async () => {
      const deps = fakeDeps({ sendMessageToTab: answering({ ok: true, closed: true }) });

      await expect(startScan(tab, deps)).resolves.toBeUndefined();

      expect(sentTypes(deps)).toEqual(['prepare-capture']);
      expect(deps.captureVisibleTab).not.toHaveBeenCalled();
      expect(deps.injectContentScript).not.toHaveBeenCalled();
      expect(deps.warmup).not.toHaveBeenCalled();
      expect(deps.detectCards).not.toHaveBeenCalled();
      expect(deps.reveal).not.toHaveBeenCalled();
      expect(deps.banlist).not.toHaveBeenCalled();
      expect(deps.setBadgeText).not.toHaveBeenCalled();
      expect(deps.setBadgeTitle).not.toHaveBeenCalled();
    });

    it.each([
      ['{ ok: true } (scan mode was not open)', { ok: true }],
      ['closed: false', { ok: true, closed: false }],
      ['closed as a string', { ok: true, closed: 'true' }],
      ['no answer', undefined],
      ['an error answer', { ok: false, error: 'boom' }],
    ])('scans as usual on any other answer: %s', async (_name, reply) => {
      const deps = fakeDeps({ sendMessageToTab: answering(reply) });

      await startScan(tab, deps);

      expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'begin-selection', 'cards-detected']));
    });
  });

  it('still captures when prepare-capture rejects (e.g. no content script yet)', async () => {
    const sendMessageToTab = vi.fn((_tabId: number, message: unknown) =>
      (message as { type: string }).type === 'prepare-capture'
        ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
        : Promise.resolve({ ok: true }),
    );
    const deps = fakeDeps({ sendMessageToTab });

    await expect(startScan(tab, deps)).resolves.toBeUndefined();

    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('still captures when prepare-capture never answers, waiting at most ~300ms', async () => {
    vi.useFakeTimers();
    const sendMessageToTab = vi.fn((_tabId: number, message: unknown) =>
      (message as { type: string }).type === 'prepare-capture' ? new Promise(() => {}) : Promise.resolve({ ok: true }),
    );
    const deps = fakeDeps({ sendMessageToTab });

    const scan = startScan(tab, deps);
    await vi.advanceTimersByTimeAsync(300);
    await scan;

    expect(deps.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('finds every card on the same screenshot, asked for right after begin-selection, and sends them to the tab', async () => {
    const deps = fakeDeps();
    await startScan(tab, deps);

    expect(deps.detectCards).toHaveBeenCalledWith('data:image/png;base64,abc');
    await vi.waitFor(() => expect(sentTypes(deps)).toContain('cards-detected'));
    expect(deps.sendMessageToTab).toHaveBeenLastCalledWith(7, { type: 'cards-detected', capturedAt: 1000, detection: DETECTION });
    expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'begin-selection', 'cards-detected']);
  });

  it('never delays begin-selection: detection starts once it is sent, without waiting for the tab to take it', async () => {
    const order: string[] = [];
    let takeSelection!: () => void;
    const deps = fakeDeps({
      sendMessageToTab: vi.fn((_tabId: number, message: unknown) => {
        const type = (message as { type: string }).type;
        order.push(type);
        return type === 'begin-selection' ? new Promise((resolve) => (takeSelection = () => resolve({ ok: true }))) : Promise.resolve({ ok: true });
      }),
      detectCards: vi.fn(async () => (order.push('detectCards'), DETECTION)),
    });

    const scan = startScan(tab, deps);
    await vi.waitFor(() => expect(order).toContain('detectCards'));
    expect(order).toEqual(['prepare-capture', 'ping', 'begin-selection', 'detectCards']);
    takeSelection();
    await scan;
    await vi.waitFor(() => expect(order).toContain('cards-detected'));
  });

  it('sends the detection even when it comes after begin-selection has settled, with its reason when there is none', async () => {
    let finish!: (d: CardDetection) => void;
    const none: CardDetection = { boxes: [], width: 1456, height: 819, ms: 3, error: NO_CARD_DETECTOR };
    const deps = fakeDeps({ detectCards: vi.fn(() => new Promise<CardDetection>((resolve) => (finish = resolve))) });

    await startScan(tab, deps);
    expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'begin-selection']);
    finish(none);
    await vi.waitFor(() => expect(deps.sendMessageToTab).toHaveBeenLastCalledWith(7, { type: 'cards-detected', capturedAt: 1000, detection: none }));
  });

  // features4-fullres.md: the tab's native video frame is detected too, and adds the cards the screenshot's run missed.
  describe('full resolution: the video frame', () => {
    // A 1000x800 CSS px viewport at devicePixelRatio 2 (the 2000x1600 screenshot); the 1920x1080 picture fills its width.
    const FRAME = { dataUrl: 'data:image/jpeg;base64,FRAME', width: 1920, height: 1080, box: { x: 0, y: 118.75, w: 1000, h: 562.5 }, viewportWidth: 1000 };
    const SHOT_DETECTION: CardDetection = {
      boxes: [{ cx: 530, cy: 644, w: 60, h: 88, angle: 0, conf: 0.95, kind: 'face-up', pts: [[500, 600], [560, 600], [560, 688], [500, 688]] }],
      width: 2000,
      height: 1600,
      ms: 160,
    };
    // A small card only the frame's run found (frame px), and the frame's outline of the screenshot's card.
    const SMALL = { cx: 960, cy: 540, w: 40, h: 56, angle: 0, conf: 0.6, kind: 'face-up' as const, pts: [[940, 512], [980, 512], [980, 568], [940, 568]] as [number, number][] };
    const SAME = { cx: 508.8, cy: 390.2, w: 58, h: 84, angle: 0, conf: 0.9, kind: 'face-up' as const, pts: [[479.8, 348.2], [537.8, 348.2], [537.8, 432.2], [479.8, 432.2]] as [number, number][] };
    const FRAME_DETECTION: CardDetection = { boxes: [SMALL], width: 1920, height: 1080, ms: 90 };
    const detectCards = (onFrame: CardDetection | Promise<CardDetection> = FRAME_DETECTION) =>
      vi.fn((image: string, opts?: { frame?: boolean }) => Promise.resolve(opts?.frame ? onFrame : SHOT_DETECTION));
    const sentDetection = (deps: ScanDeps) =>
      vi.mocked(deps.sendMessageToTab).mock.calls.map(([, m]) => m as { type: string; detection?: CardDetection }).find((m) => m.type === 'cards-detected')?.detection;

    it("asks the tab for this screenshot's frame once it has its selection, and detects it at the frame scale", async () => {
      const order: string[] = [];
      const deps = fakeDeps({
        sendMessageToTab: vi.fn(async (_tabId: number, message: unknown) => (order.push((message as { type: string }).type), { ok: true })),
        grabFrame: vi.fn(async () => (order.push('grab-frame'), FRAME)),
        detectCards: detectCards(),
      });
      await startScan(tab, deps);
      await vi.waitFor(() => expect(order).toContain('cards-detected'));
      expect(order).toEqual(['prepare-capture', 'ping', 'begin-selection', 'grab-frame', 'cards-detected']);
      expect(deps.grabFrame).toHaveBeenCalledWith(7, 1000);
      expect(deps.detectCards).toHaveBeenNthCalledWith(1, 'data:image/png;base64,abc');
      expect(deps.detectCards).toHaveBeenNthCalledWith(2, 'data:image/jpeg;base64,FRAME', { frame: true });
    });

    it("sends the screenshot's cards plus the ones only the frame found, in screenshot pixels", async () => {
      const deps = fakeDeps({ grabFrame: vi.fn().mockResolvedValue(FRAME), detectCards: detectCards({ ...FRAME_DETECTION, boxes: [SMALL, SAME] }) });
      await startScan(tab, deps);
      await vi.waitFor(() => expect(sentTypes(deps)).toContain('cards-detected'));
      const sent = sentDetection(deps)!;
      expect(sent.width).toBe(2000);
      expect(sent.boxes).toHaveLength(2); // SAME is the screenshot's card: its own box stays, the frame's is left out
      expect(sent.boxes[0]).toEqual(SHOT_DETECTION.boxes[0]);
      // frame px -> CSS px (x 1000/1920, + the picture's place) -> screenshot px (x 2)
      const k = (1000 / 1920) * 2;
      expect(sent.boxes[1].pts[0][0]).toBeCloseTo(940 * k, 9);
      expect(sent.boxes[1].pts[0][1]).toBeCloseTo(237.5 + 512 * k, 9);
      expect(sent.boxes[1].conf).toBe(0.6);
    });

    it("sends the screenshot's cards alone when the tab has no frame to give, or giving it fails", async () => {
      for (const grabFrame of [vi.fn().mockResolvedValue(undefined), vi.fn().mockRejectedValue(new Error('gone'))]) {
        const deps = fakeDeps({ grabFrame, detectCards: detectCards() });
        await startScan(tab, deps);
        await vi.waitFor(() => expect(sentTypes(deps)).toContain('cards-detected'));
        expect(sentDetection(deps)).toEqual(SHOT_DETECTION);
        expect(deps.detectCards).toHaveBeenCalledTimes(1);
      }
    });

    it("sends the screenshot's cards alone when the frame's run fails", async () => {
      const deps = fakeDeps({ grabFrame: vi.fn().mockResolvedValue(FRAME), detectCards: detectCards({ boxes: [], width: 0, height: 0, ms: 0, error: 'the model failed' }) });
      await startScan(tab, deps);
      await vi.waitFor(() => expect(sentTypes(deps)).toContain('cards-detected'));
      expect(sentDetection(deps)).toEqual(SHOT_DETECTION);
    });

    it(`waits for the frame's run at most ${FRAME_DETECT_WAIT_MS} ms after the screenshot's, then sends the screenshot's cards`, async () => {
      vi.useFakeTimers();
      const deps = fakeDeps({ grabFrame: vi.fn().mockResolvedValue(FRAME), detectCards: detectCards(new Promise<CardDetection>(() => {})) });
      await startScan(tab, deps);
      await vi.advanceTimersByTimeAsync(FRAME_DETECT_WAIT_MS - 50);
      expect(sentTypes(deps)).not.toContain('cards-detected');
      await vi.advanceTimersByTimeAsync(100);
      expect(sentDetection(deps)).toEqual(SHOT_DETECTION);
    });

    it("doesn't wait for the frame when the screenshot's detection failed: that answer goes at once", async () => {
      const failed: CardDetection = { boxes: [], width: 0, height: 0, ms: 0, error: 'no answer' };
      const deps = fakeDeps({
        grabFrame: vi.fn().mockResolvedValue(FRAME),
        detectCards: vi.fn((_image: string, opts?: { frame?: boolean }) => (opts?.frame ? new Promise<CardDetection>(() => {}) : Promise.resolve(failed))),
      });
      await startScan(tab, deps);
      await vi.waitFor(() => expect(sentDetection(deps)).toEqual(failed));
    });

    it("keeps the screenshot's outlines when merging the frame's fails", async () => {
      const broken = Object.defineProperty({ conf: 0.9 }, 'pts', {
        get() {
          throw new Error('a broken box');
        },
      }) as unknown as CardDetection['boxes'][number];
      const deps = fakeDeps({ grabFrame: vi.fn().mockResolvedValue(FRAME), detectCards: detectCards({ ...FRAME_DETECTION, boxes: [broken] }) });
      await startScan(tab, deps);
      await vi.waitFor(() => expect(sentTypes(deps)).toContain('cards-detected'));
      expect(sentDetection(deps)).toEqual(SHOT_DETECTION);
    });

    it('stops asking for frames once the offscreen document says its detector runs on WASM', async () => {
      const frameRuns = { off: false };
      const skipped: CardDetection = { boxes: [], width: 0, height: 0, ms: 1, error: FRAME_SKIPPED_ON_WASM };
      const first = fakeDeps({ frameRuns, grabFrame: vi.fn().mockResolvedValue(FRAME), detectCards: detectCards(skipped) });
      await startScan(tab, first);
      await vi.waitFor(() => expect(sentTypes(first)).toContain('cards-detected'));
      expect(sentDetection(first)).toEqual(SHOT_DETECTION);
      expect(frameRuns.off).toBe(true);
      const next = fakeDeps({ frameRuns, grabFrame: vi.fn().mockResolvedValue(FRAME), detectCards: detectCards() });
      await startScan(tab, next);
      await vi.waitFor(() => expect(sentTypes(next)).toContain('cards-detected'));
      expect(next.grabFrame).not.toHaveBeenCalled();
      expect(next.detectCards).toHaveBeenCalledTimes(1);
    });

    it('asks for no frame when the build is known to have no card detector', async () => {
      const deps = fakeDeps({ noCardDetector: vi.fn().mockResolvedValue(true), grabFrame: vi.fn().mockResolvedValue(FRAME) });
      await startScan(tab, deps);
      expect(deps.grabFrame).not.toHaveBeenCalled();
    });
  });

  // Review M1: once a detection said this build has no card detector (offscreen-client.ts remembers
  // it for the browser session), a shortcut neither flashes "Finding cards…" nor ships the screenshot.
  it('when this build is known to have no card detector, tells the tab so before begin-selection and asks for no detection', async () => {
    const deps = fakeDeps({ noCardDetector: vi.fn().mockResolvedValue(true) });
    await startScan(tab, deps);

    expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'cards-detected', 'begin-selection']);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, {
      type: 'cards-detected',
      capturedAt: 1000,
      detection: { boxes: [], width: 0, height: 0, ms: 0, error: NO_CARD_DETECTOR },
    });
    expect(deps.detectCards).not.toHaveBeenCalled();
    expect(deps.warmup).toHaveBeenCalledTimes(1); // a drag still needs the engine
  });

  it('asks the offscreen document when that is not known, or cannot be read', async () => {
    const deps = fakeDeps({ noCardDetector: vi.fn().mockRejectedValue(new Error('storage.session is unavailable')) });
    await startScan(tab, deps);

    expect(deps.detectCards).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'begin-selection', 'cards-detected']));
  });

  it('reports a page it cannot message on the badge the same way when the build is known to have no card detector', async () => {
    const deps = fakeDeps({
      noCardDetector: vi.fn().mockResolvedValue(true),
      sendMessageToTab: vi.fn((_tabId: number, message: unknown) =>
        (message as { type: string }).type === 'prepare-capture' ? Promise.resolve({ ok: true }) : Promise.reject(new Error('Receiving end does not exist.')),
      ),
      injectContentScript: vi.fn().mockRejectedValue(new Error('Cannot access a chrome:// URL')),
    });
    await expect(startScan(tab, deps)).resolves.toBeUndefined();
    expect(deps.setBadgeText).toHaveBeenCalledWith('!', 7);
    expect(deps.setBadgeTitle).toHaveBeenCalledWith(RESTRICTED, 7);
    expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'show-error']);
  });

  it('drops the detection silently when the tab has gone', async () => {
    const sendMessageToTab = vi.fn((_tabId: number, message: unknown) =>
      (message as { type: string }).type === 'cards-detected' ? Promise.reject(new Error('No tab with id: 7')) : Promise.resolve({ ok: true }),
    );
    const deps = fakeDeps({ sendMessageToTab });

    await expect(startScan(tab, deps)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(sentTypes(deps)).toContain('cards-detected'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.setBadgeText).not.toHaveBeenCalledWith('!', 7);
  });

  it('asks for no detection, and sends none, when begin-selection fails', async () => {
    // A page Duel Lens can't script (chrome://): the ping and the injection fail, so no begin-selection.
    const sendMessageToTab = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // prepare-capture
      .mockRejectedValueOnce(new Error('Receiving end does not exist.')); // ping
    const deps = fakeDeps({ sendMessageToTab, injectContentScript: vi.fn().mockRejectedValue(new Error('Cannot access a chrome:// URL')) });

    await startScan(tab, deps);
    expect(deps.detectCards).not.toHaveBeenCalled();

    const failing = fakeDeps({
      sendMessageToTab: vi.fn((_tabId: number, message: unknown) =>
        (message as { type: string }).type === 'begin-selection' ? Promise.reject(new Error('tab closed')) : Promise.resolve({ ok: true }),
      ),
    });
    await startScan(tab, failing);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentTypes(failing)).not.toContain('cards-detected');
  });

  it('runs prepare-capture, then capture, then warmup (unawaited), then ping/inject, then begin-selection', async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      sendMessageToTab: vi.fn((_tabId: number, message: unknown) => {
        order.push(`sendMessageToTab:${(message as { type: string }).type}`);
        return Promise.resolve({ ok: true });
      }),
      captureVisibleTab: vi.fn(() => {
        order.push('captureVisibleTab');
        return Promise.resolve('data:image/png;base64,abc');
      }),
      warmup: vi.fn(() => {
        order.push('warmup');
        return Promise.resolve(undefined);
      }),
    });

    await startScan(tab, deps);

    expect(order.slice(0, 5)).toEqual([
      'sendMessageToTab:prepare-capture',
      'captureVisibleTab',
      'warmup',
      'sendMessageToTab:ping',
      'sendMessageToTab:begin-selection',
    ]);
  });

  it('starts warmup right after capture, without waiting for ping/begin-selection to settle', async () => {
    // prepare-capture resolves normally; ping/begin-selection never resolve. If warmup
    // awaited either of those first, it would never be called, and this test would
    // time out instead of passing fast.
    const deps = fakeDeps({
      sendMessageToTab: vi.fn((_tabId: number, message: unknown) =>
        (message as { type: string }).type === 'prepare-capture' ? Promise.resolve({ ok: true }) : new Promise(() => {}),
      ),
    });

    startScan(tab, deps); // deliberately not awaited: startScan itself will hang on begin-selection
    // Flush every pending microtask (prepare-capture, captureVisibleTab, then the two
    // badge-clearing awaits) up to and including the warmup call, without depending on
    // exactly how many `await`s precede it.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deps.warmup).toHaveBeenCalledTimes(1);
  });

  it('injects content.js when the ping finds no listener', async () => {
    const sendMessageToTab = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // prepare-capture
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.')) // ping
      .mockResolvedValueOnce(undefined); // begin-selection
    const deps = fakeDeps({ sendMessageToTab });

    await startScan(tab, deps);

    expect(deps.injectContentScript).toHaveBeenCalledWith(7);
    expect(sendMessageToTab).toHaveBeenNthCalledWith(3, 7, expect.objectContaining({ type: 'begin-selection' }));
  });

  it('sets the badge to "!" and the restricted-page title on this tab when capture throws on a page with no content script, and does not throw', async () => {
    const deps = fakeDeps({
      captureVisibleTab: vi.fn().mockRejectedValue(new Error('Cannot access chrome:// URL')),
      sendMessageToTab: vi.fn().mockRejectedValue(new Error(NO_RECEIVER)), // nothing of Duel Lens runs on chrome://
    });

    await expect(startScan(tab, deps)).resolves.toBeUndefined();

    expect(deps.setBadgeText).toHaveBeenCalledWith('!', 7);
    expect(deps.setBadgeTitle).toHaveBeenCalledWith(RESTRICTED, 7);
    // prepare-capture is still attempted (it runs before capture regardless of how capture turns
    // out), and so is the show-error after it (best-effort), but ping/begin-selection never are.
    expect(sentTypes(deps)).toEqual(['prepare-capture', 'show-error']);
    expect(deps.warmup).not.toHaveBeenCalled();
  });

  // Final review M1: the shortcut pressed again while the popover shows hands the paused video and the
  // focus over to the new scan (prepare-capture). When that scan fails, the tab hears it at once
  // (show-error), instead of waiting 5 s for a begin-selection that never comes (content/index.ts).
  describe('a scan that fails on a page Duel Lens runs on', () => {
    it('tells the tab when the capture fails (Chrome allows 2 captures a second), and gives the badge its own title', async () => {
      const deps = fakeDeps({
        captureVisibleTab: vi.fn().mockRejectedValue(new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.')),
      });

      await expect(startScan(tab, deps)).resolves.toBeUndefined();

      expect(sentTypes(deps)).toEqual(['prepare-capture', 'show-error']);
      expect(deps.sendMessageToTab).toHaveBeenLastCalledWith(7, { type: 'show-error', message: SCAN_FAILED_MESSAGE });
      expect(deps.setBadgeText).toHaveBeenCalledWith('!', 7);
      expect(deps.setBadgeTitle).toHaveBeenCalledWith(SCAN_FAILED_TITLE, 7);
      expect(deps.setBadgeTitle).not.toHaveBeenCalledWith(RESTRICTED, 7); // the page can be read: its content script answered
      expect(deps.warmup).not.toHaveBeenCalled();
    });

    it('tells the tab when its selection fails to start after all, and gives the badge the same title', async () => {
      const deps = fakeDeps({
        sendMessageToTab: vi.fn((_tabId: number, message: unknown) =>
          (message as { type: string }).type === 'begin-selection'
            ? Promise.reject(new Error('The message port closed before a response was received.'))
            : Promise.resolve({ ok: true }),
        ),
      });

      await expect(startScan(tab, deps)).resolves.toBeUndefined();

      expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'begin-selection', 'show-error']);
      expect(deps.sendMessageToTab).toHaveBeenLastCalledWith(7, { type: 'show-error', message: SCAN_FAILED_MESSAGE });
      expect(deps.setBadgeTitle).toHaveBeenLastCalledWith(SCAN_FAILED_TITLE, 7);
    });

    it('does not wait long for a tab that never answers the show-error: the badge follows within ~300ms', async () => {
      vi.useFakeTimers();
      const deps = fakeDeps({
        captureVisibleTab: vi.fn().mockRejectedValue(new Error('capture failed')),
        sendMessageToTab: vi.fn((_tabId: number, message: unknown) =>
          (message as { type: string }).type === 'show-error' ? new Promise(() => {}) : Promise.resolve({ ok: true }),
        ),
      });

      const scan = startScan(tab, deps);
      await vi.advanceTimersByTimeAsync(300);
      await scan;

      expect(deps.setBadgeText).toHaveBeenCalledWith('!', 7);
      expect(deps.setBadgeTitle).toHaveBeenCalledWith(RESTRICTED, 7); // no answer: it can't tell
    });
  });

  // Critical 1 (review): on chrome://, the Web Store, etc., captureVisibleTab succeeds
  // under activeTab, but the ping finds nothing to answer it AND injection is rejected
  // ("Cannot access a chrome:// URL"). Previously this exception propagated out of
  // startScan uncaught, past index.ts's console.error, so the user saw nothing at all.
  it('sets the badge to "!" when capture succeeds but both the ping and the injection fail', async () => {
    const deps = fakeDeps({
      sendMessageToTab: vi.fn((_tabId: number, message: unknown) =>
        (message as { type: string }).type === 'prepare-capture' ? Promise.resolve({ ok: true }) : Promise.reject(new Error(NO_RECEIVER)),
      ),
      injectContentScript: vi.fn().mockRejectedValue(new Error('Cannot access a chrome:// URL')),
    });

    await expect(startScan(tab, deps)).resolves.toBeUndefined();

    expect(deps.setBadgeText).toHaveBeenCalledWith('!', 7);
    expect(deps.setBadgeTitle).toHaveBeenCalledWith(RESTRICTED, 7);
    expect(sentTypes(deps)).toEqual(['prepare-capture', 'ping', 'show-error']); // the show-error found no one either
  });

  it('sets the badge to "!" when begin-selection itself fails, even after a successful ping', async () => {
    const sendMessageToTab = vi
      .fn()
      .mockResolvedValueOnce({ ok: true }) // prepare-capture
      .mockResolvedValueOnce({ ok: true }) // ping succeeds
      .mockRejectedValueOnce(new Error('tab closed')) // begin-selection fails
      .mockRejectedValueOnce(new Error('tab closed')); // and the show-error after it
    const deps = fakeDeps({ sendMessageToTab });

    await expect(startScan(tab, deps)).resolves.toBeUndefined();

    expect(deps.setBadgeText).toHaveBeenCalledWith('!', 7);
    expect(deps.setBadgeTitle).toHaveBeenCalledWith(RESTRICTED, 7);
  });

  it('does nothing when the tab has no id', async () => {
    const deps = fakeDeps();
    await startScan({ windowId: 1 } as chrome.tabs.Tab, deps);
    expect(deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
  });
});

// The Chrome Web Store's rule (2026-07-01): the user agrees to the data handling before it first
// happens (legal-audit.md B4). Until they do, the shortcut and the toolbar icon open the welcome
// page's consent step instead of scanning, and nothing touches the page.
describe('startScan before the first-run consent', () => {
  /** Everything a scan does to the page or with its pixels. */
  function expectNothingTaken(deps: ScanDeps) {
    expect(deps.sendMessageToTab).not.toHaveBeenCalled(); // not even prepare-capture
    expect(deps.captureVisibleTab).not.toHaveBeenCalled();
    expect(deps.injectContentScript).not.toHaveBeenCalled();
    expect(deps.warmup).not.toHaveBeenCalled();
    expect(deps.detectCards).not.toHaveBeenCalled();
    expect(deps.setBadgeText).not.toHaveBeenCalled();
  }

  it('opens the welcome page at its consent step instead, and takes nothing from the page', async () => {
    const deps = fakeDeps({ hasConsent: vi.fn().mockResolvedValue(false) });

    await startScan(tab, deps);

    expect(deps.openConsent).toHaveBeenCalledWith(tab);
    expectNothingTaken(deps);
  });

  it('scans as usual once the user has agreed', async () => {
    const deps = fakeDeps({ hasConsent: vi.fn().mockResolvedValue(true) });

    await startScan(tab, deps);

    expect(deps.openConsent).not.toHaveBeenCalled();
    expect(deps.captureVisibleTab).toHaveBeenCalledWith(1);
    expect(sentTypes(deps)).toContain('begin-selection');
  });

  it('counts a consent it cannot read as not given', async () => {
    const deps = fakeDeps({ hasConsent: vi.fn().mockRejectedValue(new Error('storage unavailable')) });

    await startScan(tab, deps);

    expect(deps.openConsent).toHaveBeenCalledWith(tab);
    expectNothingTaken(deps);
  });

  it('does not throw when the welcome page cannot be opened', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = fakeDeps({ hasConsent: vi.fn().mockResolvedValue(false), openConsent: vi.fn().mockRejectedValue(new Error('no window')) });

    await expect(startScan(tab, deps)).resolves.toBeUndefined();

    expectNothingTaken(deps);
    error.mockRestore();
  });
});
