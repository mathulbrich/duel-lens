import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CropPayload } from '../shared/types';
import {
  closeOffscreenIfIdle,
  detectCards,
  embedArtworks,
  ensureOffscreen,
  indexMissing,
  NO_CARD_DETECTOR,
  OFFSCREEN_IDLE_ALARM,
  recognizeViaOffscreen,
  warmupOffscreen,
} from './offscreen-client';

/**
 * A fake chrome.* with a real notion of the offscreen document (created, closed) and of alarms
 * on a fake clock: `advance(ms)` moves the clock and fires the idle alarm when it is due, the
 * way background/index.ts's onAlarm listener does.
 */
function fakeChrome(existingContexts: unknown[] = []) {
  let open = existingContexts.length > 0;
  let now = 0;
  const alarms = new Map<string, number>();
  const getContexts = vi.fn(async () => (open ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []));
  const createDocument = vi.fn(async () => void (open = true));
  const closeDocument = vi.fn(async () => {
    if (!open) throw new Error('No current offscreen document.');
    open = false;
  });
  const sendMessage = vi.fn();
  /** chrome.storage.session: outlives a restarted worker (a fresh module), as in Chrome. */
  const session = new Map<string, unknown>();
  const chromeObj = {
    storage: {
      session: {
        get: vi.fn(async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, v);
        }),
      },
    },
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getContexts,
      getURL: (p: string) => `chrome-extension://abc/${p}`,
      sendMessage,
    },
    offscreen: {
      Reason: { WORKERS: 'WORKERS' },
      createDocument,
      closeDocument,
    },
    alarms: {
      create: vi.fn(async (name: string, info: { delayInMinutes: number }) => void alarms.set(name, now + info.delayInMinutes * 60_000)),
      clear: vi.fn(async (name: string) => alarms.delete(name)),
    },
  };
  const advance = async (ms: number) => {
    now += ms;
    const when = alarms.get(OFFSCREEN_IDLE_ALARM);
    if (when !== undefined && when <= now) {
      alarms.delete(OFFSCREEN_IDLE_ALARM);
      await closeOffscreenIfIdle();
    }
  };
  return { chromeObj, getContexts, createDocument, closeDocument, sendMessage, advance, session, isOpen: () => open };
}

/** What Chrome's sendMessage rejects with when no listener got the message. */
const NOT_LISTENING = 'Could not establish connection. Receiving end does not exist.';

/**
 * Chrome's cold start (click-review.md I1): getContexts lists a new offscreen document as soon as
 * its navigation commits, ~100 ms before offscreen.js (18 MB) has run and registered its onMessage
 * listener; createDocument resolves only after that first load. This fake lists the document as
 * soon as createDocument is called, but resolves it and starts listening only on `load()`. Until
 * then every send is refused the way Chrome refuses it, and counted.
 */
function coldStartChrome(answer: (msg: { type: string }) => unknown) {
  const fake = fakeChrome();
  let listening = false;
  let finishLoad!: () => void;
  const loaded = new Promise<void>((resolve) => (finishLoad = resolve));
  const listDocument = fake.createDocument.getMockImplementation()!;
  fake.createDocument.mockImplementation(async () => {
    await listDocument(); // getContexts lists it from here on
    await loaded;
  });
  let refused = 0;
  fake.sendMessage.mockImplementation(async (msg: { type: string }) => {
    if (!listening) {
      refused++;
      throw new Error(NOT_LISTENING);
    }
    return answer(msg);
  });
  const load = () => {
    listening = true;
    finishLoad();
  };
  return { ...fake, load, refused: () => refused };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a cold start: requests sent while the offscreen document loads (review I1)', () => {
  const SHOT = 'data:image/png;base64,SHOT';
  const crop: CropPayload = { dataUrl: 'data:image/png;base64,x', width: 1, height: 1, source: 'screenshot' };
  const items = [{ imageId: 1, cardId: 10, dataUrl: 'data:image/jpeg;base64,x' }];
  const DETECTION = { boxes: [], width: 1456, height: 819, ms: 2, error: NO_CARD_DETECTOR };
  const RESULT = { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} };
  const answers: Record<string, unknown> = {
    warmup: { ok: true },
    'detect-cards': { detection: DETECTION },
    recognize: { result: RESULT },
    'index-missing': { modelId: 'm', missing: [2] },
    'embed-artworks': { modelId: 'm', added: 1, failed: [] },
  };

  it("holds every request made while a new document loads until it listens, and sends none into it before", async () => {
    const fake = coldStartChrome((msg) => answers[msg.type]);
    vi.stubGlobal('chrome', fake.chromeObj);

    // The shortcut's warm-up creates the document...
    const warm = warmupOffscreen();
    await vi.waitFor(() => expect(fake.createDocument).toHaveBeenCalledTimes(1));
    // ...and in the ~100 ms before it listens come the shortcut's detect-cards, a quick drag's
    // recognize and an index update's messages. getContexts already lists the document for them.
    const detection = detectCards(SHOT);
    const result = recognizeViaOffscreen(crop);
    const missing = indexMissing([1, 2]);
    const embedded = embedArtworks(items);
    await new Promise((resolve) => setTimeout(resolve, 20));
    fake.load();

    await expect(detection).resolves.toEqual(DETECTION);
    await expect(result).resolves.toEqual(RESULT);
    await expect(missing).resolves.toEqual(answers['index-missing']);
    await expect(embedded).resolves.toEqual(answers['embed-artworks']);
    await expect(warm).resolves.toBeUndefined();
    expect(fake.refused()).toBe(0);
    expect(fake.createDocument).toHaveBeenCalledTimes(1);
    expect(fake.sendMessage.mock.calls.map(([m]) => (m as { type: string }).type).sort()).toEqual(
      ['detect-cards', 'embed-artworks', 'index-missing', 'recognize', 'warmup'],
    );
  });

  it('re-sends a request nobody received: a listed document that is not listening yet, created by a worker since restarted', async () => {
    const fake = fakeChrome([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    vi.stubGlobal('chrome', fake.chromeObj);
    fake.sendMessage
      .mockRejectedValueOnce(new Error(NOT_LISTENING))
      .mockRejectedValueOnce(new Error(NOT_LISTENING))
      .mockResolvedValue({ result: RESULT });

    await expect(recognizeViaOffscreen(crop)).resolves.toEqual(RESULT);
    expect(fake.sendMessage).toHaveBeenCalledTimes(3);
    expect(fake.createDocument).not.toHaveBeenCalled();
  });

  it('creates the document again before re-sending when it went away in between (it crashed)', async () => {
    const fake = fakeChrome([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    vi.stubGlobal('chrome', fake.chromeObj);
    fake.sendMessage.mockImplementationOnce(async () => {
      await fake.closeDocument(); // gone before it could answer
      throw new Error(NOT_LISTENING);
    });
    fake.sendMessage.mockResolvedValue({ detection: DETECTION });

    await expect(detectCards(SHOT)).resolves.toEqual(DETECTION);
    expect(fake.createDocument).toHaveBeenCalledTimes(1);
    expect(fake.isOpen()).toBe(true);
  });

  it('never re-sends a request that something received, whatever became of it', async () => {
    const fake = fakeChrome([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    vi.stubGlobal('chrome', fake.chromeObj);
    fake.sendMessage.mockRejectedValue(new Error('The message port closed before a response was received.'));

    await expect(recognizeViaOffscreen(crop)).rejects.toThrow('The message port closed before a response was received.');
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    await expect(detectCards(SHOT)).resolves.toMatchObject({ boxes: [], error: expect.stringContaining('The message port closed') });
    expect(fake.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('gives up after a bounded number of tries, backing off, when the document never listens', async () => {
    vi.useFakeTimers();
    const fake = fakeChrome([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    vi.stubGlobal('chrome', fake.chromeObj);
    const sentAt: number[] = [];
    fake.sendMessage.mockImplementation(async () => {
      sentAt.push(Date.now());
      throw new Error(NOT_LISTENING);
    });

    const start = Date.now();
    const scan = recognizeViaOffscreen(crop).then(
      () => 'answered',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(scan).resolves.toBe(NOT_LISTENING);
    const tries = sentAt.map((t) => t - start);
    expect(tries.length).toBeGreaterThanOrEqual(3);
    expect(tries.length).toBeLessThanOrEqual(8);
    // Each wait is longer than the one before, and they end within 2 s.
    const waits = tries.slice(1).map((t, i) => t - tries[i]);
    expect(waits.every((w, i) => i === 0 || w > waits[i - 1])).toBe(true);
    expect(tries.at(-1)!).toBeLessThanOrEqual(2000);
  });
});

describe('ensureOffscreen', () => {
  it('creates the offscreen document only once under concurrent calls', async () => {
    const { chromeObj, createDocument } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);

    await Promise.all([ensureOffscreen(), ensureOffscreen()]);

    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('does nothing when an offscreen document already exists', async () => {
    const { chromeObj, createDocument } = fakeChrome([{ contextType: 'OFFSCREEN_DOCUMENT' }]);
    vi.stubGlobal('chrome', chromeObj);

    await ensureOffscreen();

    expect(createDocument).not.toHaveBeenCalled();
  });
});

describe('recognizeViaOffscreen', () => {
  it('ensures the document exists and forwards the crop, returning the result', async () => {
    const { chromeObj, sendMessage, createDocument } = fakeChrome();
    sendMessage.mockResolvedValue({
      result: { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} },
    });
    vi.stubGlobal('chrome', chromeObj);
    const crop: CropPayload = { dataUrl: 'data:image/png;base64,x', width: 1, height: 1, source: 'screenshot' };

    const result = await recognizeViaOffscreen(crop);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'recognize', crop });
    expect(result.modelId).toBe('m');
  });

  // Review Minor: the offscreen document answering with nothing (its listener not yet
  // registered) must not surface as a raw TypeError ("Cannot read properties of undefined").
  it("throws a readable error instead of a TypeError when the offscreen document doesn't answer", async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    sendMessage.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', chromeObj);
    const crop: CropPayload = { dataUrl: 'data:image/png;base64,x', width: 1, height: 1, source: 'screenshot' };

    await expect(recognizeViaOffscreen(crop)).rejects.toThrow("The recognition engine didn't answer. Try again.");
  });

  it('throws the same readable error when the answer has no result field', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    sendMessage.mockResolvedValue({});
    vi.stubGlobal('chrome', chromeObj);
    const crop: CropPayload = { dataUrl: 'data:image/png;base64,x', width: 1, height: 1, source: 'screenshot' };

    await expect(recognizeViaOffscreen(crop)).rejects.toThrow("The recognition engine didn't answer. Try again.");
  });
});

describe('indexMissing', () => {
  it('ensures the document exists and forwards the imageIds, returning the response', async () => {
    const { chromeObj, sendMessage, createDocument } = fakeChrome();
    sendMessage.mockResolvedValue({ modelId: 'm', missing: [3, 4] });
    vi.stubGlobal('chrome', chromeObj);

    const result = await indexMissing([1, 2, 3, 4]);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'index-missing', imageIds: [1, 2, 3, 4] });
    expect(result).toEqual({ modelId: 'm', missing: [3, 4] });
  });

  it("throws a readable error when the offscreen document doesn't answer", async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    sendMessage.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', chromeObj);

    await expect(indexMissing([1])).rejects.toThrow("The recognition engine didn't answer index-missing. Try again.");
  });

  it("passes on an answer's error: the offscreen document couldn't check its index", async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    const answer = { modelId: 'm', missing: [], error: "Duel Lens couldn't check which artworks its index is missing (no WebAssembly)" };
    sendMessage.mockResolvedValue(answer);
    await expect(indexMissing([1])).resolves.toEqual(answer);
  });

  it('refuses an answer whose error is not text', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    sendMessage.mockResolvedValue({ modelId: 'm', missing: [], error: { code: 1 } });
    await expect(indexMissing([1])).rejects.toThrow(/unexpected answer to index-missing/);
  });

  it('refuses an answer that is not an index-missing response, instead of passing it on mis-typed', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    for (const answer of [{ error: 'the model failed to load' }, { modelId: 'm', missing: 'none' }, { modelId: 'm', missing: [1, 'x'] }, { missing: [] }]) {
      sendMessage.mockResolvedValueOnce(answer);
      await expect(indexMissing([1])).rejects.toThrow(/unexpected answer to index-missing/);
    }
  });
});

describe('embedArtworks', () => {
  it('ensures the document exists and forwards the items, returning the response', async () => {
    const { chromeObj, sendMessage, createDocument } = fakeChrome();
    const items = [{ imageId: 1, cardId: 10, dataUrl: 'data:image/jpeg;base64,x' }];
    sendMessage.mockResolvedValue({ modelId: 'm', added: 1, failed: [] });
    vi.stubGlobal('chrome', chromeObj);

    const result = await embedArtworks(items);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'embed-artworks', items });
    expect(result).toEqual({ modelId: 'm', added: 1, failed: [] });
  });

  it("throws a readable error when the offscreen document doesn't answer", async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    sendMessage.mockResolvedValue(undefined);
    vi.stubGlobal('chrome', chromeObj);

    await expect(embedArtworks([])).rejects.toThrow("The recognition engine didn't answer embed-artworks. Try again.");
  });

  it('refuses an answer that is not an embed-artworks response, instead of passing it on mis-typed', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    for (const answer of [
      { error: 'the model failed to load' },
      { modelId: 'm', added: 1 },
      { modelId: 'm', added: '1', failed: [] },
      { modelId: 'm', added: 0, failed: [{ imageId: 1 }] },
    ]) {
      sendMessage.mockResolvedValueOnce(answer);
      await expect(embedArtworks([])).rejects.toThrow(/unexpected answer to embed-artworks/);
    }
  });

  it("passes on an answer's error: the offscreen document can't embed at all", async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    const answer = { modelId: 'm', added: 0, failed: [{ imageId: 1, error: 'no WebAssembly' }], error: "Duel Lens couldn't add new artworks to its index (no WebAssembly)" };
    sendMessage.mockResolvedValue(answer);
    await expect(embedArtworks([{ imageId: 1, cardId: 10, dataUrl: 'data:,' }])).resolves.toEqual(answer);
    sendMessage.mockResolvedValue({ ...answer, error: 404 });
    await expect(embedArtworks([{ imageId: 1, cardId: 10, dataUrl: 'data:,' }])).rejects.toThrow(/unexpected answer to embed-artworks/);
  });

  it('passes on the artworks the offscreen document found to be card-back placeholders', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    const answer = { modelId: 'm', added: 0, failed: [], placeholders: [100460002] };
    sendMessage.mockResolvedValue(answer);
    await expect(embedArtworks([{ imageId: 100460002, cardId: 100460002, dataUrl: 'data:,' }])).resolves.toEqual(answer);
    sendMessage.mockResolvedValue({ ...answer, placeholders: ['100460002'] });
    await expect(embedArtworks([{ imageId: 100460002, cardId: 100460002, dataUrl: 'data:,' }])).rejects.toThrow(/unexpected answer/);
  });

  it('passes on per-item failures reported by the offscreen document', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    const answer = { modelId: 'm', added: 0, failed: [{ imageId: 1, error: 'no WebAssembly' }] };
    sendMessage.mockResolvedValue(answer);
    await expect(embedArtworks([{ imageId: 1, cardId: 10, dataUrl: 'data:,' }])).resolves.toEqual(answer);
  });
});

describe('detectCards (click to scan)', () => {
  const SHOT = 'data:image/png;base64,SHOT';
  const detection = {
    boxes: [{ cx: 100, cy: 120, w: 60, h: 88, angle: 0.01, conf: 0.95, pts: [[70, 76], [130, 76], [130, 164], [70, 164]] }],
    width: 1456,
    height: 819,
    ms: 310,
  };

  it('ensures the document exists and forwards the screenshot, returning the detection', async () => {
    const { chromeObj, sendMessage, createDocument } = fakeChrome();
    sendMessage.mockResolvedValue({ detection });
    vi.stubGlobal('chrome', chromeObj);

    await expect(detectCards(SHOT)).resolves.toEqual(detection);

    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ target: 'offscreen', type: 'detect-cards', dataUrl: SHOT });
  });

  it("passes on the offscreen document's reason when it found nothing (no detector in this build)", async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    const none = { boxes: [], width: 1456, height: 819, ms: 2, error: NO_CARD_DETECTOR };
    sendMessage.mockResolvedValue({ detection: none });
    vi.stubGlobal('chrome', chromeObj);

    await expect(detectCards(SHOT)).resolves.toEqual(none);
  });

  it('never throws: no answer, a malformed one or a failed send is an empty detection with the reason', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    vi.stubGlobal('chrome', chromeObj);
    const empty = (error: RegExp) => ({ boxes: [], width: 0, height: 0, ms: 0, error: expect.stringMatching(error) });

    sendMessage.mockResolvedValueOnce(undefined);
    await expect(detectCards(SHOT)).resolves.toEqual(empty(/didn't answer/));
    for (const answer of [{}, { detection: { boxes: 'none', width: 1, height: 1, ms: 1 } }, { detection: { ...detection, boxes: [{ cx: 1 }] } }, { detection: { ...detection, error: 7 } }]) {
      sendMessage.mockResolvedValueOnce(answer);
      await expect(detectCards(SHOT)).resolves.toEqual(empty(/unexpected answer to detect-cards/));
    }
    sendMessage.mockRejectedValueOnce(new Error('Could not establish connection'));
    await expect(detectCards(SHOT)).resolves.toEqual(empty(/Could not establish connection/));
  });
});

// Review M1: without a card detector, every shortcut used to ship the screenshot to the offscreen
// document for a fixed answer, and the tab to flash "Finding cards…" until it came (scan.ts).
describe('remembering that this build has no card detector', () => {
  const SHOT = 'data:image/png;base64,SHOT';
  const none = { boxes: [], width: 1456, height: 819, ms: 2, error: NO_CARD_DETECTOR };
  /** The module as a newly started service worker loads it: nothing in memory. */
  async function freshWorker() {
    vi.resetModules();
    return import('./offscreen-client');
  }

  it('remembers the answer "no card detector in this build" in storage.session, so a restarted worker knows it too', async () => {
    const fake = fakeChrome();
    vi.stubGlobal('chrome', fake.chromeObj);
    fake.sendMessage.mockResolvedValue({ detection: none });
    const client = await freshWorker();

    expect(await client.knownNoCardDetector()).toBe(false);
    await expect(client.detectCards(SHOT)).resolves.toEqual(none);
    expect(await client.knownNoCardDetector()).toBe(true);
    await vi.waitFor(() => expect([...fake.session.values()]).toEqual([true]));
    const restarted = await freshWorker();
    expect(await restarted.knownNoCardDetector()).toBe(true);
  });

  it('remembers nothing from any other answer: cards found, another error, a failed send', async () => {
    const fake = fakeChrome();
    vi.stubGlobal('chrome', fake.chromeObj);
    const client = await freshWorker();
    const cards = { ...none, boxes: [{ cx: 100, cy: 120, w: 60, h: 88, angle: 0, conf: 0.95, pts: [[70, 76], [130, 76], [130, 164], [70, 164]] }] };
    delete (cards as { error?: string }).error;
    fake.sendMessage
      .mockResolvedValueOnce({ detection: cards })
      .mockResolvedValueOnce({ detection: { ...none, error: "Duel Lens couldn't find the cards: it took too long" } })
      .mockResolvedValueOnce({ detection: { ...none, error: "Duel Lens couldn't load its card detector: model missing" } })
      .mockRejectedValueOnce(new Error('The message port closed before a response was received.'))
      .mockResolvedValueOnce(undefined);
    for (let i = 0; i < 5; i++) await client.detectCards(SHOT);

    expect(fake.sendMessage).toHaveBeenCalledTimes(5);
    expect(await client.knownNoCardDetector()).toBe(false);
    expect(fake.session.size).toBe(0);
  });

  it('knows nothing when storage.session cannot be read, and detection still works when it cannot be written', async () => {
    const fake = fakeChrome();
    vi.stubGlobal('chrome', fake.chromeObj);
    fake.chromeObj.storage.session.get.mockRejectedValue(new Error('storage.session is unavailable'));
    fake.chromeObj.storage.session.set.mockRejectedValue(new Error('storage.session is unavailable'));
    fake.sendMessage.mockResolvedValue({ detection: none });
    const client = await freshWorker();

    expect(await client.knownNoCardDetector()).toBe(false);
    await expect(client.detectCards(SHOT)).resolves.toEqual(none);
    expect(await client.knownNoCardDetector()).toBe(true); // this worker still knows
  });

  it("is the offscreen handler's own answer without a card detector, word for word", async () => {
    const { createOffscreenHandler } = await import('../offscreen/handler');
    const unused = () => Promise.reject(new Error('not needed without a card detector'));
    const handler = createOffscreenHandler({
      modelId: 'm',
      extension: { id: 'duellensid', baseUrl: 'chrome-extension://duellensid/' },
      loadEngine: unused,
      loadIndexMeta: unused,
      loadEmbedder: unused,
      loadCardBack: unused,
      decode: unused,
    });
    const worker = { id: 'duellensid', url: 'chrome-extension://duellensid/background.js' };
    const answer = await new Promise<unknown>((resolve) => handler({ target: 'offscreen', type: 'detect-cards', dataUrl: SHOT }, worker, resolve));
    expect(answer).toMatchObject({ detection: { boxes: [], error: NO_CARD_DETECTOR } });
    expect(NO_CARD_DETECTOR).toBe('no card detector in this build');
  });
});

describe('warmupOffscreen', () => {
  it('never throws, even if the offscreen document is not ready', async () => {
    const { chromeObj, sendMessage } = fakeChrome();
    sendMessage.mockRejectedValue(new Error('not ready'));
    vi.stubGlobal('chrome', chromeObj);

    await expect(warmupOffscreen()).resolves.toBeUndefined();
  });
});

describe('closing the offscreen document when idle', () => {
  const MINUTE = 60_000;
  const crop: CropPayload = { dataUrl: 'data:image/png;base64,x', width: 1, height: 1, source: 'screenshot' };
  const answer = { result: { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} } };

  it('closes it once it has sat idle for 5 minutes after the last scan', async () => {
    const fake = fakeChrome();
    fake.sendMessage.mockResolvedValue(answer);
    vi.stubGlobal('chrome', fake.chromeObj);

    await recognizeViaOffscreen(crop);
    expect(fake.isOpen()).toBe(true);
    await fake.advance(5 * MINUTE - 1000);
    expect(fake.closeDocument).not.toHaveBeenCalled();
    await fake.advance(1000);
    expect(fake.closeDocument).toHaveBeenCalledTimes(1);
    expect(fake.isOpen()).toBe(false);
  });

  it('starts the 5 minutes again with every scan or embed', async () => {
    const fake = fakeChrome();
    fake.sendMessage.mockImplementation(async (msg: { type: string }) =>
      msg.type === 'recognize' ? answer : { modelId: 'm', added: 1, failed: [] },
    );
    vi.stubGlobal('chrome', fake.chromeObj);

    await recognizeViaOffscreen(crop);
    await fake.advance(4 * MINUTE);
    await embedArtworks([{ imageId: 1, cardId: 10, dataUrl: 'data:,' }]);
    await fake.advance(4 * MINUTE); // 8 minutes after the scan, 4 after the embed
    expect(fake.isOpen()).toBe(true);
    await fake.advance(1 * MINUTE);
    expect(fake.isOpen()).toBe(false);
  });

  it('never closes it while a request is still being answered', async () => {
    const fake = fakeChrome();
    let answerScan!: () => void;
    fake.sendMessage.mockImplementation(() => new Promise((resolve) => (answerScan = () => resolve(answer))));
    vi.stubGlobal('chrome', fake.chromeObj);

    const scan = recognizeViaOffscreen(crop);
    await vi.waitFor(() => expect(fake.sendMessage).toHaveBeenCalled());
    await fake.advance(6 * MINUTE);
    expect(fake.closeDocument).not.toHaveBeenCalled();
    answerScan();
    await scan;
    await fake.advance(5 * MINUTE);
    expect(fake.isOpen()).toBe(false);
  });

  it('creates it again for a scan after it was closed', async () => {
    const fake = fakeChrome();
    fake.sendMessage.mockResolvedValue(answer);
    vi.stubGlobal('chrome', fake.chromeObj);

    await recognizeViaOffscreen(crop);
    await fake.advance(5 * MINUTE);
    expect(fake.isOpen()).toBe(false);

    const result = await recognizeViaOffscreen(crop);
    expect(result.modelId).toBe('m');
    expect(fake.createDocument).toHaveBeenCalledTimes(2);
    expect(fake.isOpen()).toBe(true);
  });

  it('lets a close that already started finish before a new scan creates the document again', async () => {
    const fake = fakeChrome();
    fake.sendMessage.mockResolvedValue(answer);
    vi.stubGlobal('chrome', fake.chromeObj);
    await recognizeViaOffscreen(crop);
    const events: string[] = [];
    let finishClose!: () => void;
    const realClose = fake.closeDocument.getMockImplementation()!;
    const realCreate = fake.createDocument.getMockImplementation()!;
    fake.closeDocument.mockImplementationOnce(async () => {
      events.push('closing');
      await new Promise<void>((resolve) => (finishClose = resolve));
      await realClose();
      events.push('closed');
    });
    fake.createDocument.mockImplementation(async () => {
      await realCreate();
      events.push('created');
    });
    fake.sendMessage.mockImplementation(async () => (events.push('scan sent'), answer));

    const close = closeOffscreenIfIdle();
    await vi.waitFor(() => expect(events).toEqual(['closing']));
    const scan = recognizeViaOffscreen(crop);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['closing']);
    finishClose();
    await Promise.all([close, scan]);
    expect(events).toEqual(['closing', 'closed', 'created', 'scan sent']);
  });

  it('still runs a scan that arrives while a failing close is in flight', async () => {
    const fake = fakeChrome();
    fake.sendMessage.mockResolvedValue(answer);
    vi.stubGlobal('chrome', fake.chromeObj);
    await recognizeViaOffscreen(crop);
    let failClose!: () => void;
    fake.closeDocument.mockImplementationOnce(
      () => new Promise<void>((_, reject) => (failClose = () => reject(new Error('closeDocument failed')))),
    );

    const close = closeOffscreenIfIdle();
    await vi.waitFor(() => expect(fake.closeDocument).toHaveBeenCalledTimes(1));
    const scan = recognizeViaOffscreen(crop);
    failClose();
    await expect(close).rejects.toThrow('closeDocument failed');
    await expect(scan).resolves.toEqual(answer.result);
  });

  it('does nothing when the idle alarm fires and there is no document', async () => {
    const fake = fakeChrome();
    vi.stubGlobal('chrome', fake.chromeObj);
    await expect(closeOffscreenIfIdle()).resolves.toBeUndefined();
    expect(fake.closeDocument).not.toHaveBeenCalled();
  });
});
