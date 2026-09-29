import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { decodeIndex, encodeIndexBinary, quantizeInt8, type LoadedIndex } from '../shared/index-format';
import type { DetectedCardBox, OffscreenDetectCardsResponse, OffscreenEmbedArtworksResponse, OffscreenIndexMissingResponse } from '../shared/messages';
import type { RGBAImage } from '../shared/preprocess';
import type { CropPayload, RecognitionResult } from '../shared/types';
import type { DeltaEntry } from './delta-index';
import type { CardDetector } from './detect-cards';
import type { Embedder, Engine } from './engine';
import { createOffscreenHandler, type OffscreenDeps } from './handler';

const CROP: CropPayload = { dataUrl: 'data:image/png;base64,AAAA', width: 4, height: 3, source: 'screenshot' };
const IMG: RGBAImage = { data: new Uint8ClampedArray(4 * 3 * 4), width: 4, height: 3 };
/** This extension, and its service worker: the one sender the offscreen document answers. */
const SELF = { id: 'duellensid', baseUrl: 'chrome-extension://duellensid/' };
const WORKER = { id: SELF.id, url: 'chrome-extension://duellensid/background.js' };

const okResult = (): RecognitionResult => ({
  candidates: [{ cardId: 5, imageId: 5, score: 0.9 }],
  confident: true,
  faceDown: false,
  modelId: 'm',
  best: { hypothesis: 'quad', rotation: 0 },
  timings: { detect: 1, embed: 2, search: 3, total: 6 },
});

/** A 3-d index of artworks 1 and 2 (cards 10 and 20), model 'm'. */
function tinyIndex(): LoadedIndex {
  const vectors = new Int8Array([...quantizeInt8(new Float32Array([1, 0, 0])), ...quantizeInt8(new Float32Array([0, 1, 0]))]);
  const meta = {
    modelId: 'm',
    dim: 3,
    count: 2,
    quant: 'int8' as const,
    builtAt: '2026-09-28T00:00:00Z',
    entries: [
      { imageId: 1, cardId: 10 },
      { imageId: 2, cardId: 20 },
    ],
  };
  return decodeIndex(encodeIndexBinary(3, 2, 'int8', vectors).buffer, meta);
}

/** An engine that answers okResult(), with nothing to prime; override what a test exercises. */
function fakeEngine(over: Partial<Engine> = {}): Engine {
  let index = tinyIndex();
  return {
    recognize: async () => okResult(),
    primeSteps: () => [],
    getIndex: () => index,
    setIndex: (next) => {
      index = next;
    },
    ...over,
  };
}

/** An in-memory local delta (the real one is IndexedDB, delta-index.ts). */
function memoryDelta(initial: DeltaEntry[] = []) {
  const entries = [...initial];
  return {
    entries,
    load: async (modelId: string) => entries.filter((e) => e.modelId === modelId),
    append: async (_modelId: string, added: DeltaEntry[]) => void entries.push(...added),
  };
}

function setup(over: Partial<OffscreenDeps> = {}) {
  const calls = { loads: 0, embedderLoads: 0, decoded: [] as string[], recognized: [] as RGBAImage[] };
  const engine: Engine = fakeEngine({
    recognize: async (img) => {
      calls.recognized.push(img);
      return okResult();
    },
  });
  const embedder: Embedder = { modelId: 'm', embed: async (images) => images.map(() => new Float32Array([0, 0, 1])) };
  const handler = createOffscreenHandler({
    modelId: 'm',
    extension: SELF,
    loadEngine: async () => {
      calls.loads++;
      return engine;
    },
    loadIndexMeta: async () => tinyIndex().meta,
    loadEmbedder: async () => {
      calls.embedderLoads++;
      return embedder;
    },
    loadCardBack: async () => null,
    delta: memoryDelta(),
    decode: async (url) => {
      calls.decoded.push(url);
      return IMG;
    },
    ...over,
  });
  /** Send a message (from the service worker, unless `sender` says otherwise); resolves with the response, or 'no response' if none comes in time. */
  const send = (msg: unknown, waitMs = 1000, sender: unknown = WORKER) =>
    new Promise<{ async: boolean; response: unknown }>((resolve) => {
      let asyncReply = false;
      const r = handler(msg, sender, (response) => resolve({ async: asyncReply, response }));
      asyncReply = r === true;
      setTimeout(() => resolve({ async: asyncReply, response: 'no response' }), r === true ? waitMs : 20);
    });
  return { handler, send, calls };
}

const RECOGNIZE = { target: 'offscreen', type: 'recognize', crop: CROP };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resultOf = (reply: { response: unknown }) => (reply.response as { result: RecognitionResult }).result;

describe('offscreen message handler', () => {
  it('ignores messages that are not addressed to the offscreen document', async () => {
    const { handler, calls } = setup();
    let responded = false;
    for (const msg of [{ type: 'recognize', crop: CROP }, { type: 'get-status' }, null, 'hello', { target: 'background' }]) {
      expect(handler(msg, WORKER, () => (responded = true))).toBe(false);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(responded).toBe(false);
    expect(calls.loads).toBe(0);
  });

  // Security review M2: every Duel Lens context receives a content script's runtime messages, so a
  // content script could address the offscreen document directly. Only the service worker (our id,
  // an extension URL) may.
  it("answers only Duel Lens's service worker: never a content script, another extension or an unknown sender", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, calls } = setup();
    let responded = false;
    const senders = [
      { id: SELF.id, url: 'https://www.youtube.com/watch?v=abc', tab: { id: 3 } }, // our content script
      { id: SELF.id }, // our id, no URL
      { id: 'otherextension', url: 'chrome-extension://otherextension/background.js' },
      { url: WORKER.url }, // no id
      {},
      undefined,
    ];
    for (const sender of senders) {
      for (const msg of [RECOGNIZE, { target: 'offscreen', type: 'warmup' }, { target: 'offscreen', type: 'index-missing', imageIds: [1] }]) {
        expect(handler(msg, sender, () => (responded = true))).toBe(false);
      }
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(responded).toBe(false);
    expect(calls.loads).toBe(0);
    expect(calls.decoded).toEqual([]);
    warn.mockRestore();
  });

  it('recognises a crop: decodes it, runs the engine, and answers { result } asynchronously', async () => {
    const { send, calls } = setup();
    const { async, response } = await send({ target: 'offscreen', type: 'recognize', crop: CROP });
    expect(async).toBe(true);
    const { result } = response as { result: RecognitionResult };
    expect(result.candidates[0].cardId).toBe(5);
    expect(result.confident).toBe(true);
    expect(calls.decoded).toEqual([CROP.dataUrl]);
    expect(calls.recognized).toEqual([IMG]);
    expect(result.timings.decode).toBeGreaterThanOrEqual(0);
    expect(result.timings.embed).toBe(2);
    expect(result.timings.total).toBeGreaterThanOrEqual(6);
  });

  it('loads the engine once, shared by warm-up and every scan', async () => {
    const { send, calls } = setup();
    const warm = send({ target: 'offscreen', type: 'warmup' });
    const scans = [1, 2, 3].map(() => send({ target: 'offscreen', type: 'recognize', crop: CROP }));
    expect((await warm).response).toEqual({ ok: true });
    await Promise.all(scans);
    expect(calls.loads).toBe(1);
  });

  it('turns a load failure into a readable error result, and tries again next time', async () => {
    let attempt = 0;
    const { send, calls } = setup({
      loadEngine: async () => {
        attempt++;
        if (attempt === 1) throw new Error('models/dinov2-small.int8.onnx: HTTP 404');
        return fakeEngine();
      },
    });
    const first = (await send({ target: 'offscreen', type: 'recognize', crop: CROP })).response as { result: RecognitionResult };
    expect(first.result.error).toMatch(/couldn't load/i);
    expect(first.result.error).toMatch(/HTTP 404/);
    expect(first.result.candidates).toEqual([]);
    expect(first.result.confident).toBe(false);
    expect(first.result.modelId).toBe('m');
    const second = (await send({ target: 'offscreen', type: 'recognize', crop: CROP })).response as { result: RecognitionResult };
    expect(second.result.error).toBeUndefined();
    expect(attempt).toBe(2);
    expect(calls.decoded).toHaveLength(1);
  });

  it('reports a warm-up failure to whoever asked', async () => {
    const { send } = setup({
      loadEngine: async () => {
        throw new Error('no WebAssembly');
      },
    });
    expect((await send({ target: 'offscreen', type: 'warmup' })).response).toEqual({
      ok: false,
      error: expect.stringMatching(/no WebAssembly/),
    });
  });

  it('always answers, even if the engine throws', async () => {
    const { send } = setup({
      loadEngine: async () =>
        fakeEngine({
          recognize: async () => {
            throw new Error('out of memory');
          },
        }),
    });
    const { result } = (await send({ target: 'offscreen', type: 'recognize', crop: CROP })).response as {
      result: RecognitionResult;
    };
    expect(result.error).toMatch(/out of memory/);
    expect(result.candidates).toEqual([]);
  });

  it('runs one scan at a time: an overlapping scan waits for the one before', async () => {
    const spans: [number, number][] = [];
    const engine: Engine = fakeEngine({
      recognize: async () => {
        const start = performance.now();
        await sleep(30);
        spans.push([start, performance.now()]);
        return okResult();
      },
    });
    const { send } = setup({ loadEngine: async () => engine });
    const replies = await Promise.all([send(RECOGNIZE), send(RECOGNIZE), send(RECOGNIZE)]);
    for (const r of replies) expect(resultOf(r).candidates[0].cardId).toBe(5);
    spans.sort((a, b) => a[0] - b[0]);
    expect(spans).toHaveLength(3);
    expect(spans[1][0]).toBeGreaterThanOrEqual(spans[0][1]);
    expect(spans[2][0]).toBeGreaterThanOrEqual(spans[1][1]);
  });

  it('queues scans behind the load, but ahead of priming: a scan that arrives during the load runs first', async () => {
    const events: string[] = [];
    const { send } = setup({
      loadEngine: async () => {
        events.push('load');
        await sleep(30);
        events.push('loaded');
        return fakeEngine({
          recognize: async () => (events.push('scan'), okResult()),
          primeSteps: () => [async () => void events.push('prime')],
        });
      },
    });
    await Promise.all([send({ target: 'offscreen', type: 'warmup' }), send(RECOGNIZE)]);
    await vi.waitFor(() => expect(events).toContain('prime'));
    expect(events).toEqual(['load', 'loaded', 'scan', 'prime']);
  });

  it('primes the engine once it is loaded, when no scan is waiting', async () => {
    const events: string[] = [];
    const { send } = setup({
      loadEngine: async () =>
        fakeEngine({ primeSteps: () => [async () => void events.push('prime embedder'), async () => void events.push('prime detector')] }),
    });
    expect((await send({ target: 'offscreen', type: 'warmup' })).response).toEqual({ ok: true });
    await vi.waitFor(() => expect(events).toEqual(['prime embedder', 'prime detector']));
  });

  it('lets a scan that arrives while priming is still queued go ahead of it', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const { send } = setup({
      loadEngine: async () =>
        fakeEngine({
          recognize: async () => (events.push('scan'), okResult()),
          primeSteps: () => [
            async () => {
              events.push('prime 1');
              await new Promise<void>((resolve) => (releaseFirst = resolve));
            },
            async () => void events.push('prime 2'),
            async () => void events.push('prime 3'),
          ],
        }),
    });
    await send({ target: 'offscreen', type: 'warmup' });
    await vi.waitFor(() => expect(events).toEqual(['prime 1']));
    const scan = send(RECOGNIZE); // queued behind the running step, ahead of the steps still queued
    await sleep(5);
    releaseFirst();
    expect(resultOf(await scan).error).toBeUndefined();
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events).toEqual(['prime 1', 'scan', 'prime 2', 'prime 3']);
  });

  it("passes the user's box (crop.inner) to the engine", async () => {
    const seen: unknown[] = [];
    const { send } = setup({
      loadEngine: async () => fakeEngine({ recognize: async (_img, inner) => (seen.push(inner), okResult()) }),
    });
    await send({ ...RECOGNIZE, crop: { ...CROP, inner: { x: 1, y: 0, w: 2, h: 3 } } });
    await send(RECOGNIZE);
    expect(seen).toEqual([{ x: 1, y: 0, w: 2, h: 3 }, undefined]);
  });

  it("passes a clicked card's outline (crop.outline) to the engine, and nothing for a drag", async () => {
    const seen: unknown[] = [];
    const { send } = setup({
      loadEngine: async () => fakeEngine({ recognize: async (_img, _inner, outline) => (seen.push(outline), okResult()) }),
    });
    const outline: [number, number][] = [
      [1, 1],
      [3, 1],
      [3, 4],
      [1, 4],
    ];
    await send({ ...RECOGNIZE, crop: { ...CROP, outline } });
    await send(RECOGNIZE);
    expect(seen).toEqual([outline, undefined]);
  });

  it('answers when decoding throws', async () => {
    const { send } = setup({
      decode: () => {
        throw new Error('bad PNG');
      },
    });
    const result = resultOf(await send(RECOGNIZE));
    expect(result.error).toMatch(/bad PNG/);
    expect(result.candidates).toEqual([]);
  });

  it('answers when the engine returns something unusable', async () => {
    const { send } = setup({
      loadEngine: async () => fakeEngine({ recognize: async () => undefined as unknown as RecognitionResult }),
    });
    const result = resultOf(await send(RECOGNIZE));
    expect(result.error).toBeTruthy();
    expect(result.candidates).toEqual([]);
    expect(result.confident).toBe(false);
  });

  it("times out a stuck job's caller, but only starts the next job once the stuck one settles", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const started: number[] = [];
      let releaseFirst: (() => void) | undefined;
      let n = 0;
      const { send } = setup({
        loadEngine: async () =>
          fakeEngine({
            recognize: async () => {
              const id = ++n;
              started.push(id);
              if (id === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
              return okResult();
            },
          }),
      });

      const stuck = send(RECOGNIZE, 40_000);
      await vi.advanceTimersByTimeAsync(0); // let the first job reach the engine and get stuck there
      expect(started).toEqual([1]);

      const next = send(RECOGNIZE, 40_000);
      await vi.advanceTimersByTimeAsync(30_000); // past the 30s timeout both callers are waiting on
      expect(resultOf(await stuck).error).toMatch(/too long/i);
      expect(resultOf(await next).error).toMatch(/too long/i);
      // The second job never overlapped the stuck one: it's still queued behind it.
      expect(started).toEqual([1]);

      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(0);
      // Only once the stuck job actually settles does the queue move on to the next one.
      expect(started).toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an offscreen message type it does not know', () => {
    const { handler } = setup();
    expect(handler({ target: 'offscreen', type: 'self-destruct' }, WORKER, () => {})).toBe(false);
  });

  it('turns an unreadable crop into an error result', async () => {
    const { send } = setup({
      decode: async () => {
        throw new Error('The crop is not a data URL');
      },
    });
    const { result } = (await send({ target: 'offscreen', type: 'recognize', crop: CROP })).response as {
      result: RecognitionResult;
    };
    expect(result.error).toMatch(/not a data URL/);
    expect(result.candidates).toEqual([]);
  });
});

describe('offscreen message handler: the self-updating index', () => {
  const ITEMS = [1, 2, 3].map((i) => ({ imageId: 100 + i, cardId: 1000 + i, dataUrl: `data:image/jpeg;base64,${i}` }));
  const deltaEntry = (imageId: number): DeltaEntry => ({ modelId: 'm', imageId, cardId: imageId * 10, vector: Int8Array.of(0, 0, 127) });

  it('answers index-missing from the bundled index metadata and the local delta, without loading the engine or a model', async () => {
    const { send, calls } = setup({ delta: memoryDelta([deltaEntry(3)]) });
    const { async, response } = await send({ target: 'offscreen', type: 'index-missing', imageIds: [1, 2, 3, 4] });
    expect(async).toBe(true);
    expect(response).toEqual({ modelId: 'm', missing: [4] } satisfies OffscreenIndexMissingResponse);
    expect(calls.loads).toBe(0);
    expect(calls.embedderLoads).toBe(0);
  });

  it('embeds new artworks with the embedding model alone: no engine load, no priming', async () => {
    const delta = memoryDelta();
    const { send, calls } = setup({ delta });
    const { response } = await send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS.slice(0, 2) });
    expect(response).toEqual({ modelId: 'm', added: 2, failed: [] } satisfies OffscreenEmbedArtworksResponse);
    expect(calls.loads).toBe(0);
    expect(calls.embedderLoads).toBe(1);
    expect(delta.entries.map((e) => e.imageId)).toEqual([101, 102]);
    // index-missing sees them at once.
    const missing = await send({ target: 'offscreen', type: 'index-missing', imageIds: [101, 102, 103] });
    expect(missing.response).toEqual({ modelId: 'm', missing: [103] });
  });

  it("leaves out a downloaded artwork that is YGOPRODeck's card-back placeholder, and says so", async () => {
    // The fake embedder puts every image at [0, 0, 1]: here, the card back.
    const delta = memoryDelta();
    const { send } = setup({ delta, loadCardBack: async () => Float32Array.of(0, 0, 1) });
    const { response } = await send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS.slice(0, 2) });
    expect(response).toEqual({ modelId: 'm', added: 0, failed: [], placeholders: [101, 102] });
    expect(delta.entries).toEqual([]);
  });

  it("answers embed-artworks with an error when the card back can't be read from the bundled index", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = setup({ loadCardBack: () => Promise.reject(new Error('data/index-m.bin is missing from the extension')) });
    const { response } = await send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS.slice(0, 1) });
    expect(response).toMatchObject({ added: 0, error: expect.stringMatching(/index-m\.bin is missing/) });
    error.mockRestore();
  });

  it("adds new artworks to a loaded engine's live index at once, so the next scan can find them", async () => {
    let engine!: Engine;
    const { send } = setup({ loadEngine: async () => (engine = fakeEngine()) });
    await send(RECOGNIZE); // loads the engine
    await send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS.slice(0, 2) });
    await vi.waitFor(() => expect(engine.getIndex().meta.entries.map((e) => e.imageId)).toEqual([1, 2, 101, 102]));
  });

  it('runs a scan queued during an embed-artworks chunk between two embeds, never alongside one', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    let embeds = 0;
    const embedder: Embedder = {
      modelId: 'm',
      embed: async (images) => {
        const n = ++embeds;
        events.push(`embed ${n}`);
        if (n === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        events.push(`embed ${n} done`);
        return images.map(() => new Float32Array([0, 0, 1]));
      },
    };
    const { send } = setup({
      loadEngine: async () => fakeEngine({ recognize: async () => (events.push('scan'), okResult()) }),
      loadEmbedder: async () => embedder,
    });
    const chunk = send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS });
    await vi.waitFor(() => expect(events).toEqual(['embed 1']));
    const scan = send(RECOGNIZE);
    await sleep(5);
    releaseFirst();
    expect(resultOf(await scan).candidates[0].cardId).toBe(5);
    expect((await chunk).response).toEqual({ modelId: 'm', added: 3, failed: [] });
    expect(events).toEqual(['embed 1', 'embed 1 done', 'scan', 'embed 2', 'embed 2 done', 'embed 3', 'embed 3 done']);
  });

  it("answers index-missing with an error, and nothing missing, when the bundled index can't be read", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = setup({
      loadIndexMeta: async () => {
        throw new Error('data/index-m.meta.json is missing from the extension');
      },
    });
    const { response } = await send({ target: 'offscreen', type: 'index-missing', imageIds: [1, 2] });
    expect(response).toEqual({ modelId: 'm', missing: [], error: expect.stringMatching(/index-m\.meta\.json is missing/) });
    expect(JSON.stringify(error.mock.calls)).toMatch(/index-missing/);
    error.mockRestore();
  });

  it("answers index-missing with an error when the local delta can't be read", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = setup({
      delta: { load: () => Promise.reject(new Error('IndexedDB is broken')), append: async () => {} },
    });
    const { response } = await send({ target: 'offscreen', type: 'index-missing', imageIds: [1, 2] });
    expect(response).toEqual({ modelId: 'm', missing: [], error: expect.stringMatching(/IndexedDB is broken/) });
    error.mockRestore();
  });

  it("answers embed-artworks with an error, and every item failed, when the embedding model can't load", async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send, calls } = setup({
      loadEmbedder: async () => {
        throw new Error('no WebAssembly');
      },
    });
    const { response } = await send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS.slice(0, 2) });
    expect(response).toEqual({
      modelId: 'm',
      added: 0,
      failed: [
        { imageId: 101, error: expect.stringMatching(/no WebAssembly/) },
        { imageId: 102, error: expect.stringMatching(/no WebAssembly/) },
      ],
      error: expect.stringMatching(/no WebAssembly/),
    });
    expect(calls.decoded).toEqual([]);
    error.mockRestore();
  });

  it('still scans after an index message failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { send } = setup({ loadEmbedder: () => Promise.reject(new Error('no WebAssembly')) });
    await send({ target: 'offscreen', type: 'embed-artworks', items: ITEMS.slice(0, 1) });
    expect(resultOf(await send(RECOGNIZE)).candidates[0].cardId).toBe(5);
    vi.restoreAllMocks();
  });
});

describe('offscreen message handler: finding every card on a screenshot (click to scan)', () => {
  /** A 16:9 screenshot. */
  const wide = (): RGBAImage => ({ data: new Uint8ClampedArray(160 * 90 * 4), width: 160, height: 90 });
  const DETECT = { target: 'offscreen', type: 'detect-cards', dataUrl: 'data:image/png;base64,SHOT' };
  const WARMUP = { target: 'offscreen', type: 'warmup' };
  const detectionOf = (reply: { response: unknown }) => (reply.response as OffscreenDetectCardsResponse).detection;
  const card = (cx: number, cy: number, conf = 0.95): DetectedCardBox => ({ cx, cy, w: 20, h: 29, angle: 0, conf, pts: [[cx - 10, cy - 14.5], [cx + 10, cy - 14.5], [cx + 10, cy + 14.5], [cx - 10, cy + 14.5]] });
  /** A card detector whose model runs (two per screenshot, like two tiles) go through the handler's schedule. */
  function twoRuns(run: (i: number) => Promise<void> = async () => {}) {
    const seen: RGBAImage[] = [];
    let n = 0;
    const detector: CardDetector = {
      detect: async (img, schedule) => {
        seen.push(img);
        await Promise.all([0, 1].map(() => schedule!(() => run(++n))));
        return [card(20, 45), card(130, 45, 0.9)];
      },
    };
    return { detector, seen };
  }

  it('answers at once, decoding nothing and loading nothing, when no card detector is registered (the case today)', async () => {
    const { send, calls } = setup();
    const reply = await send(DETECT);
    expect(reply.async).toBe(true);
    expect(detectionOf(reply)).toEqual({ boxes: [], width: 0, height: 0, ms: expect.any(Number), error: 'no card detector in this build' });
    expect(calls.decoded).toEqual([]);
    expect(calls.loads).toBe(0);
  });

  it('decodes the screenshot, loads the detector once, and answers { detection } with its outlines', async () => {
    const { detector, seen } = twoRuns();
    let loads = 0;
    const { send, calls } = setup({ loadCardDetector: async () => (loads++, detector), decode: async (url) => (calls.decoded.push(url), wide()) });
    const first = detectionOf(await send(DETECT));
    expect(first).toEqual({ boxes: [card(20, 45), card(130, 45, 0.9)], width: 160, height: 90, ms: expect.any(Number) });
    await send(DETECT);
    expect(loads).toBe(1);
    expect(calls.decoded).toEqual([DETECT.dataUrl, DETECT.dataUrl]);
    expect(seen.map((i) => [i.width, i.height])).toEqual([
      [160, 90],
      [160, 90],
    ]);
    expect(calls.loads).toBe(0); // the recognition engine isn't needed to find cards
  });

  it('answers with an error, never throwing, when the detector fails', async () => {
    const failing: CardDetector = { detect: async () => Promise.reject(new Error('ORT run failed')) };
    const { send } = setup({ loadCardDetector: async () => failing, decode: async () => wide() });
    expect(detectionOf(await send(DETECT))).toMatchObject({ boxes: [], width: 160, height: 90, error: expect.stringMatching(/ORT run failed/) });
  });

  it("answers with an error when the screenshot can't be decoded, or the detector can't load (tried again next time)", async () => {
    const bad = setup({
      loadCardDetector: async () => twoRuns().detector,
      decode: async () => {
        throw new Error('bad PNG');
      },
    });
    expect(detectionOf(await bad.send(DETECT))).toMatchObject({ boxes: [], error: expect.stringMatching(/bad PNG/) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    const flaky = setup({
      loadCardDetector: async () => {
        if (++attempts === 1) throw new Error('models/detector.onnx: HTTP 404');
        return twoRuns().detector;
      },
      decode: async () => wide(),
    });
    expect(detectionOf(await flaky.send(DETECT))).toMatchObject({ boxes: [], error: expect.stringMatching(/couldn't load its card detector.*HTTP 404/) });
    expect(detectionOf(await flaky.send(DETECT)).boxes).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('runs its model runs on the work queue, never alongside a scan; a scan waiting when a run’s turn comes goes first', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const { detector } = twoRuns(async (k) => {
      events.push(`run ${k}`);
      if (k === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
      events.push(`run ${k} done`);
    });
    const { send } = setup({
      loadEngine: async () => fakeEngine({ recognize: async () => (events.push('scan'), okResult()) }),
      loadCardDetector: async () => detector,
      decode: async () => wide(),
    });
    await send(WARMUP); // the engine is loaded
    const detection = send(DETECT);
    await vi.waitFor(() => expect(events).toEqual(['run 1']));
    const scan = send(RECOGNIZE); // the user dragged before the outlines came
    await sleep(5);
    releaseFirst();
    expect(resultOf(await scan).candidates[0].cardId).toBe(5);
    expect(detectionOf(await detection).error).toBeUndefined();
    expect(events).toEqual(['run 1', 'run 1 done', 'scan', 'run 2', 'run 2 done']);
  });

  it("loads the detector at the shortcut's warm-up, and runs it ahead of the engine's priming", async () => {
    const events: string[] = [];
    const { detector } = twoRuns(async () => void events.push('run'));
    const { send } = setup({
      loadCardDetector: async () => (events.push('load detector'), detector),
      loadEngine: async () => {
        events.push('load engine');
        await sleep(20);
        return fakeEngine({ primeSteps: () => [async () => void events.push('prime')] });
      },
      decode: async () => wide(),
    });
    await Promise.all([send(WARMUP), send(DETECT)]);
    await vi.waitFor(() => expect(events).toContain('prime'));
    expect(events).toEqual(['load detector', 'load engine', 'run', 'run', 'prime']);
  });

  it('goes ahead of priming steps still queued when it arrives', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const { detector } = twoRuns(async () => void events.push('run'));
    const { send } = setup({
      loadEngine: async () =>
        fakeEngine({
          primeSteps: () => [
            async () => {
              events.push('prime 1');
              await new Promise<void>((resolve) => (releaseFirst = resolve));
            },
            async () => void events.push('prime 2'),
          ],
        }),
      loadCardDetector: async () => detector,
      decode: async () => wide(),
    });
    await send(WARMUP);
    await vi.waitFor(() => expect(events).toEqual(['prime 1']));
    const detection = send(DETECT);
    await sleep(5);
    releaseFirst();
    await detection;
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events).toEqual(['prime 1', 'run', 'run', 'prime 2']);
  });

  it('answers a stuck detection with an error after the time limit', async () => {
    const { send } = setup({ loadCardDetector: () => new Promise<CardDetector>(() => {}), decode: async () => wide(), timeoutMs: 30 });
    expect(detectionOf(await send(DETECT))).toMatchObject({ boxes: [], error: expect.stringMatching(/too long/) });
  });
});
