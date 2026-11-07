// Message handling for the offscreen document, kept free of chrome.* and model loading
// so it can be tested; index.ts wires it to chrome.runtime.onMessage.
import type { IndexMeta } from '../shared/index-format';
import { NO_CARD_DETECTOR } from '../shared/messages';
import {
  isToOffscreen,
  isToOffscreenIndex,
  senderKind,
  type CardDetection,
  type DetectedCardBox,
  type ExtensionIdentity,
  type OffscreenDetectCardsResponse,
  type OffscreenEmbedArtworksResponse,
  type OffscreenIndexMissingResponse,
  type OffscreenRecognizeResponse,
  type OkResponse,
  type ToOffscreenIndex,
  type LiveAnalyzeRequest,
  type LiveAnalyzeResponse,
  type WarmState,
  type WarmStep,
} from '../shared/messages';
import { cropRGBA, type RGBAImage } from '../shared/preprocess';
import type { CropPayload, RecognitionResult } from '../shared/types';
import { mergeIndex, type DeltaEntry } from './delta-index';
import { FRAME_SKIPPED_ON_WASM, type CardDetector } from './detect-cards';
import { CARD_DETECTOR } from './detector/spec';
import { elapsedMs } from './elapsed';
import type { Embedder, Engine } from './engine';
import { createIndexUpdater } from './index-updater';

export interface OffscreenDeps {
  /** Model id reported in error results. */
  modelId: string;
  /**
   * This extension (`chrome.runtime.id`, `chrome.runtime.getURL('')`): only its service worker's
   * messages are answered. Every Duel Lens context also receives the content script's runtime
   * messages, so without this a content script could address the offscreen document directly.
   */
  extension: ExtensionIdentity;
  /**
   * Load the model, the index and the card detector (when one is registered), and build the engine,
   * for scans (priming comes after, as queued jobs). The self-updating index's messages never load
   * it (loaders.ts).
   */
  loadEngine: () => Promise<Engine>;
  /** Live check's Light engine (loaders.ts loadLightEngine): reads of crops marked `light`. Optional: loadEngine's then. */
  loadLightEngine?: () => Promise<Engine>;
  /** The bundled index's metadata alone (index-missing): no model. */
  loadIndexMeta: () => Promise<Pick<IndexMeta, 'entries'>>;
  /** The embedding model alone (embed-artworks): the same one loadEngine uses. */
  loadEmbedder: () => Promise<Embedder>;
  /**
   * The card back's vector in the model's space, for embed-artworks' placeholder check
   * (placeholder-art.ts); null when the bundled index has no card-back entry.
   */
  loadCardBack: () => Promise<Float32Array | null>;
  decode: (dataUrl: string) => Promise<RGBAImage>;
  /** The local artwork delta. Default: delta-index.ts's IndexedDB store. */
  delta?: {
    load(modelId: string): Promise<DeltaEntry[]>;
    append(modelId: string, entries: DeltaEntry[]): Promise<void>;
  };
  /**
   * A scan still unanswered after this long is answered with an error, and the queue moves
   * on (default 30 s). Nothing that works takes near this long.
   */
  timeoutMs?: number;
  /**
   * Click to scan's card detector (detect-cards.ts), loaded once, at the shortcut's warm-up or the
   * first detect-cards. The engine's scans use the same one (loaders.ts shares the load). Without one
   * (a --no-detector build), detect-cards answers at once that there is no card detector in this build.
   */
  loadCardDetector?: () => Promise<CardDetector>;
  /** How long the shortcut's warm-up waits for the first card detection before it loads the engine (WARMUP_DETECTION_WAIT_MS). */
  warmupDetectionWaitMs?: number;
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

const SCAN_TIMEOUT_MS = 30_000;
/**
 * The shortcut's warm-up loads the card detector, and the engine only once the detector has answered the first
 * screenshot after it, or after this long. The embedder's session holds this document's thread for about a
 * second on a slow computer (test/e2e/low-end/README.md), so the outlines waited behind it. The embedder then
 * loads while the user picks a card; a scan that comes first loads it at once.
 */
export const WARMUP_DETECTION_WAIT_MS = 3000;
const NO_DETECTOR = NO_CARD_DETECTOR;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A box already known overlaps a found one this much or more (as the tracker matches them): not read again. */
const ANALYZE_SKIP_IOU = 0.3;
/** The margin around a card cut from a Live frame, a share of its size on each side (content/capture.ts CROP_MARGIN). */
const ANALYZE_MARGIN = 0.04;
/**
 * Live's look around the pointer, when the frame's look found no card under it: a crop of the frame at the scale a
 * screenshot is seen at (spec.ts longSide), this long in the model's pixels (a quarter of that frame). It finds the
 * small cards a smaller look at the whole frame misses (shared/live.ts LIVE_EFFORTS detectSide), as fast as a 640 look.
 */
const ANALYZE_ZOOM = 640;

/** The part of `img` (its pixels) Live's pointer look sees, around `p` (shares of the frame), kept inside the frame. */
export function zoomArea(img: { width: number; height: number }, p: { x: number; y: number }): { x: number; y: number; w: number; h: number } {
  const long = Math.max(img.width, img.height);
  const side = ANALYZE_ZOOM / Math.min(1, CARD_DETECTOR.longSide / long); // the crop's long side, frame pixels
  const w = Math.min(img.width, Math.round((side * img.width) / long));
  const h = Math.min(img.height, Math.round((side * img.height) / long));
  const x = Math.max(0, Math.min(img.width - w, Math.round(p.x * img.width - w / 2)));
  const y = Math.max(0, Math.min(img.height - h, Math.round(p.y * img.height - h / 2)));
  return { x, y, w, h };
}

/** A detected box's bounds as shares of the frame. */
function frameBox(b: DetectedCardBox, img: RGBAImage): { x: number; y: number; w: number; h: number } {
  const xs = b.pts.map((q) => q[0]);
  const ys = b.pts.map((q) => q[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x: x / img.width, y: y / img.height, w: (Math.max(...xs) - x) / img.width, h: (Math.max(...ys) - y) / img.height };
}

function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

/** A card cut from the frame as Live's crop is (content/live/crop.ts liveCrop): its bounds plus a margin, clamped to the
 *  frame; its whole outline and bounds in the crop's pixels (they may run past it, for a card cut by the frame's edge). */
function cutFrom(img: RGBAImage, b: DetectedCardBox): { image: RGBAImage; inner: { x: number; y: number; w: number; h: number }; outline: [number, number][] } {
  const xs = b.pts.map((q) => q[0]);
  const ys = b.pts.map((q) => q[1]);
  const bx = Math.min(...xs);
  const by = Math.min(...ys);
  const bw = Math.max(...xs) - bx;
  const bh = Math.max(...ys) - by;
  const x0 = Math.max(0, Math.floor(bx - bw * ANALYZE_MARGIN));
  const y0 = Math.max(0, Math.floor(by - bh * ANALYZE_MARGIN));
  const x1 = Math.min(img.width, Math.ceil(bx + bw * (1 + ANALYZE_MARGIN)));
  const y1 = Math.min(img.height, Math.ceil(by + bh * (1 + ANALYZE_MARGIN)));
  return {
    image: cropRGBA(img, x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)),
    inner: { x: bx - x0, y: by - y0, w: bw, h: bh },
    outline: b.pts.map(([x, y]) => [x - x0, y - y0] as [number, number]),
  };
}

/** The card finder's warm-up frame (primeFinder): a Live frame's size, grey as the detector's padding. */
const PRIME_FRAME = { w: 1280, h: 720 } as const;

export function createOffscreenHandler(deps: OffscreenDeps): Listener {
  const limit = deps.timeoutMs ?? SCAN_TIMEOUT_MS;
  const warmupWait = deps.warmupDetectionWaitMs ?? WARMUP_DETECTION_WAIT_MS;

  const failed = (error: string, timings: Record<string, number> = {}): RecognitionResult => ({
    candidates: [],
    confident: false,
    faceDown: false,
    modelId: deps.modelId,
    timings,
    error,
  });

  // Engine work (loading the engine, the embedding model alone or the card detector, each scan,
  // each priming step, each card-detector run, each artwork embed of the self-updating index) runs
  // one job at a time. This isn't optional:
  // the WASM-only ORT build we load (see web-embedder.ts) has no guard against two concurrent
  // session.run() calls — no "Session already started" check, since that guard exists only in
  // the JSEP/WebGPU bundles we don't ship — so a scan's model runs must never interleave with
  // another job's.
  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = tail.then(job);
    // The next job starts only once this one actually settles, never sooner: a stuck job
    // blocks every later job rather than letting one start alongside it. Its own caller still
    // gets a timeout from settle() below, independently of when (or whether) the queue itself
    // unblocks.
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Scans queued but not started yet: optional work (priming) and card-detector runs let them go first. */
  let scansWaiting = 0;
  /** Card-detector runs (click to scan) queued but not started yet: priming lets them go first. */
  let detectorRunsWaiting = 0;

  /**
   * Queues optional work (a priming step) that yields to scans and card-detector runs: when its
   * turn comes while one is waiting, it goes back to the end of the queue, behind it. Never rejects.
   */
  function enqueueIdle(job: () => Promise<void>): void {
    void enqueue(async () => {
      if (scansWaiting > 0 || detectorRunsWaiting > 0) {
        enqueueIdle(job);
        return;
      }
      await job();
    }).catch((e: unknown) => console.debug('[DuelLens] background engine work failed', e));
  }

  /**
   * The card detector's Schedule (detect-cards.ts): queues one of its model runs, ahead of priming.
   * When its turn comes while a scan is waiting (the user dragged before the outlines came), it goes
   * back to the end of the queue, behind that scan: a scan waits at most for the run in progress.
   */
  function enqueueDetectorRun<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const turn = () => {
        detectorRunsWaiting++;
        void enqueue(async () => {
          detectorRunsWaiting--;
          if (scansWaiting > 0) return turn();
          try {
            resolve(await run());
          } catch (e) {
            reject(e);
          }
        });
      };
      turn();
    });
  }

  /** Always settles with a value: the job's, or `fallback` on error or after the time limit. */
  function settle<T>(job: Promise<T>, fallback: (why: string) => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => resolve(fallback('it took too long')), limit);
      job.then(
        (value) => (clearTimeout(timer), resolve(value)),
        (e: unknown) => (clearTimeout(timer), resolve(fallback(message(e)))),
      );
    });
  }

  /** When each start step finished (WarmState): Live's "getting ready", and the start's timings. */
  const doneAt: WarmState['done'] = {};
  function mark(step: WarmStep) {
    if (doneAt[step] !== undefined) return;
    doneAt[step] = Math.round(performance.now());
    console.debug(`[DuelLens] start: ${step} at ${doneAt[step]} ms`);
  }

  let engine: Promise<Engine> | null = null;
  /**
   * One shared load, queued like a scan; a failed load is forgotten so the next message tries
   * again. Once loaded, the engine's priming steps are queued as optional work: a scan or detection
   * that arrived during the load (already queued) runs before them, and so does one that arrives
   * while they are still queued.
   */
  function warmup(): Promise<Engine> {
    if (!engine) {
      engine = startEngine(deps.loadEngine, 'engine', (failed) => {
        if (engine === failed) engine = null;
      });
      [...warmupsWaiting].forEach((done) => done());
    }
    return engine;
  }

  let lightEngine: Promise<Engine> | null = null;
  /** Live check's Light engine, loaded once as warmup's is (the default engine without a Light model). */
  function warmupLight(): Promise<Engine> {
    if (!deps.loadLightEngine) return warmup();
    lightEngine ??= startEngine(deps.loadLightEngine, 'the Light engine', (failed) => {
      if (lightEngine === failed) lightEngine = null;
    });
    return lightEngine;
  }

  /** An engine's load on the queue; once loaded, its priming steps go as optional work. A failed load is `forget`-ten. */
  function startEngine(load: () => Promise<Engine>, what: string, forget: (failed: Promise<Engine>) => void): Promise<Engine> {
    const loading = enqueue(load);
    loading.then(
      (eng) => {
        mark('reader');
        try {
          for (const step of eng.primeSteps()) enqueueIdle(() => step().then(() => mark('reader-run')));
        } catch (e) {
          console.debug('[DuelLens] could not queue the priming runs', e);
        }
      },
      (e: unknown) => {
        console.error(`[DuelLens] ${what} failed to load`, e);
        forget(loading);
      },
    );
    return loading;
  }

  async function scan(crop: CropPayload, ready: Promise<Engine>, queuedAt: number): Promise<RecognitionResult> {
    const waited = elapsedMs(queuedAt);
    let loaded: Engine;
    try {
      loaded = await ready;
    } catch (e) {
      return failed(`Duel Lens couldn't load its card recognition: ${message(e)}`, { wait: waited });
    }
    let t = performance.now();
    let img: RGBAImage;
    try {
      img = await deps.decode(crop.dataUrl);
    } catch (e) {
      return failed(`Duel Lens couldn't read the selected pixels: ${message(e)}`, { decode: elapsedMs(t) });
    }
    const decode = elapsedMs(t);
    t = performance.now();
    const result = await loaded.recognize(img, crop.inner, crop.outline, crop.click, { detected: crop.detected === true, thorough: crop.thorough === true });
    mark('reader-run');
    result.timings = {
      ...(waited >= 1 ? { wait: waited } : {}),
      decode,
      ...result.timings,
      total: Math.round((decode + (result.timings.total ?? elapsedMs(t))) * 10) / 10,
    };
    const top = result.candidates[0];
    console.debug('[DuelLens] recognize', result.timings, top ? { ...top, confident: result.confident, best: result.best } : 'nothing');
    return result;
  }

  /** Every scan resolves with a result: errors, bad input and stuck work become `result.error`. */
  function recognize(crop: CropPayload): Promise<RecognitionResult> {
    const queuedAt = performance.now();
    let job: Promise<RecognitionResult>;
    try {
      const ready = crop.light === true ? warmupLight() : warmup();
      scansWaiting++;
      job = enqueue(() => {
        scansWaiting--;
        return scan(crop, ready, queuedAt);
      });
    } catch (e) {
      job = Promise.reject(e);
    }
    return settle(job, (why) => failed(`Duel Lens couldn't match this crop: ${why}`, { total: elapsedMs(queuedAt) }));
  }

  /** Warm-ups waiting to load the engine (warmupAfterDetection): each goes on at the next detection, or any load. */
  const warmupsWaiting = new Set<() => void>();

  /** The shortcut's warm-up: the engine, after the card detector's first detection (WARMUP_DETECTION_WAIT_MS). */
  function warmupAfterDetection(): Promise<Engine> {
    if (engine || !detectorLoad()) return warmup();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        warmupsWaiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, warmupWait);
      warmupsWaiting.add(done);
    }).then(warmup);
  }

  let cardDetector: Promise<CardDetector> | null = null;
  /**
   * The card detector, loaded once and queued like the engine (a failed load is forgotten, so the
   * next message tries again); null when none is registered.
   */
  function detectorLoad(): Promise<CardDetector> | null {
    const load = deps.loadCardDetector;
    if (!load) return null;
    if (!cardDetector) {
      const loading = enqueue(load);
      cardDetector = loading;
      loading.then(() => mark('finder'), () => undefined);
      loading.catch((e: unknown) => {
        console.error('[DuelLens] the card detector failed to load', e);
        if (cardDetector === loading) cardDetector = null;
      });
    }
    return cardDetector;
  }

  /** The card finder's first run is queued (primeFinder): one at a time, however many warm-ups ask. */
  let priming = false;
  /**
   * The card finder's first run, on a blank 1280x720 frame (a Live frame's size), unless a real one came first: the
   * graphics card prepares the model on its first run (4.4 s on an RX 570), so Live's first frame doesn't wait for it.
   * Optional work (enqueueIdle): a scan or a real detection waiting goes first, and one that ran meanwhile ends it.
   */
  function primeFinder() {
    const loading = detectorLoad();
    if (!loading || priming || doneAt['finder-run'] !== undefined) return;
    priming = true;
    void loading.then(
      (detector) =>
        enqueueIdle(async () => {
          try {
            if (doneAt['finder-run'] !== undefined) return;
            const blank: RGBAImage = { width: PRIME_FRAME.w, height: PRIME_FRAME.h, data: new Uint8ClampedArray(PRIME_FRAME.w * PRIME_FRAME.h * 4).fill(114) };
            await detector.detect(blank, (run) => run()); // already the queue's turn: run now
            mark('finder-run');
          } catch (e) {
            console.debug("[DuelLens] the card finder's first run failed", e);
          } finally {
            priming = false;
          }
        }),
      () => void (priming = false),
    );
  }

  /**
   * A Live frame in one go: decoded once, its cards found, and up to `max` of them (the pointed one first, then the
   * largest; none already known: `skip`) cut from that same frame and read, each a scan on the queue. Saves a round
   * trip and an image encode and decode per card. Always settles: `detection.error` says why nothing was found.
   */
  function analyzeFrame(msg: LiveAnalyzeRequest): Promise<LiveAnalyzeResponse> {
    const start = performance.now();
    const none = (error: string): LiveAnalyzeResponse => ({ detection: { boxes: [], width: 0, height: 0, ms: elapsedMs(start), error }, reads: [] });
    const loading = detectorLoad();
    if (!loading) return Promise.resolve(none(NO_CARD_DETECTOR));
    const ready = msg.light === true ? warmupLight() : warmup();
    const job = (async (): Promise<LiveAnalyzeResponse> => {
      let img: RGBAImage;
      try {
        img = await deps.decode(msg.dataUrl);
      } catch (e) {
        return none(`Duel Lens couldn't read the frame: ${message(e)}`);
      }
      const steps = { decode: elapsedMs(start), wait: 0, find: 0, look: 0 };
      const detector = await loading;
      // Each run's own time apart from its wait for the queue (a scan or a read going on).
      const timed = (key: 'find' | 'look') => <T>(run: () => Promise<T>) => {
        const queued = performance.now();
        return enqueueDetectorRun(() => {
          steps.wait += elapsedMs(queued);
          const began = performance.now();
          return run().finally(() => (steps[key] += elapsedMs(began)));
        });
      };
      const boxes = await detector.detect(img, timed('find'), msg.detectSide ? { longSide: msg.detectSide } : undefined);
      mark('finder-run');
      const p = msg.pointer;
      const at = (b: DetectedCardBox) => frameBox(b, img);
      const holds = (r: { x: number; y: number; w: number; h: number }) => !!p && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
      if (msg.look && p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && !boxes.some((b) => holds(at(b)))) {
        // Nothing found under the pointer: a closer look there, for a card too small for the whole frame's look.
        const z = zoomArea(img, p);
        const near = await detector.detect(cropRGBA(img, z.x, z.y, z.w, z.h), timed('look'), { longSide: ANALYZE_ZOOM });
        for (const b of near) {
          const moved: DetectedCardBox = { ...b, cx: b.cx + z.x, cy: b.cy + z.y, pts: b.pts.map(([x, y]) => [x + z.x, y + z.y] as [number, number]) };
          if (!boxes.some((k) => overlap(at(k), at(moved)) >= ANALYZE_SKIP_IOU)) boxes.push(moved);
        }
      }
      const detection = { boxes, width: img.width, height: img.height, ms: elapsedMs(start), steps };
      const reads: LiveAnalyzeResponse['reads'] = boxes.map(() => null);
      const norm = boxes.map(at);
      const skipped = (i: number) => (msg.skip ?? []).some((k) => overlap(k, norm[i]) >= ANALYZE_SKIP_IOU);
      const under = (i: number) => holds(norm[i]);
      const order = boxes
        .map((_, i) => i)
        .filter((i) => boxes[i].kind === 'face-up' && !skipped(i))
        .sort((a, b) => Number(under(b)) - Number(under(a)) || norm[b].w * norm[b].h - norm[a].w * norm[a].h)
        .slice(0, Math.max(0, msg.max));
      let engine: Engine;
      try {
        engine = await ready;
      } catch (e) {
        return { detection: { ...detection, error: `Duel Lens couldn't load its card recognition: ${message(e)}` }, reads };
      }
      let tried = 0; // a read that failed spent the budget too
      for (const i of order) {
        if (msg.budgetMs !== undefined && tried > 0 && elapsedMs(start) >= msg.budgetMs) break;
        tried++;
        const cut = cutFrom(img, boxes[i]);
        scansWaiting++;
        reads[i] = await enqueue(async () => {
          scansWaiting--;
          const result = await engine.recognize(cut.image, cut.inner, cut.outline, null, { detected: true, thorough: msg.thorough === true });
          mark('reader-run');
          return result;
        }).catch(() => null);
      }
      return { detection, reads };
    })();
    return settle(job, (why) => none(`Duel Lens couldn't analyse the frame: ${why}`));
  }

  /**
   * Click to scan: every card on a whole screenshot. Without a card detector, answers at once.
   * Otherwise the screenshot is decoded while the detector loads, and the detector's runs go on the
   * work queue (enqueueDetectorRun). Always settles with a detection: when anything fails, `error`
   * says why and `boxes` is empty.
   */
  function detectCards(dataUrl: string, frame = false): Promise<CardDetection> {
    const start = performance.now();
    let size = { width: 0, height: 0 };
    const answer = (boxes: CardDetection['boxes'], error?: string): CardDetection => ({
      boxes,
      ...size,
      ms: elapsedMs(start),
      ...(error === undefined ? {} : { error }),
    });
    const loading = detectorLoad();
    if (!loading) return Promise.resolve(answer([], NO_DETECTOR));
    const job = (async (): Promise<CardDetection> => {
      // A video frame's run (background/frame-detect.ts) is skipped on WASM, before decoding it: there the 1600-px
      // run would hold the scan's outlines back. The screenshot's cards then go alone.
      if (frame && (await loading.then((d) => d.backend?.(), () => undefined)) === 'wasm') return answer([], FRAME_SKIPPED_ON_WASM);
      let img: RGBAImage;
      try {
        img = await deps.decode(dataUrl);
      } catch (e) {
        return answer([], `Duel Lens couldn't read the screenshot: ${message(e)}`);
      }
      size = { width: img.width, height: img.height };
      const decoded = elapsedMs(start);
      let detector: CardDetector;
      try {
        detector = await loading;
      } catch (e) {
        return answer([], `Duel Lens couldn't load its card detector: ${message(e)}`);
      }
      try {
        // A native video frame (`frame`) is seen at the detector's frame scale (background/frame-detect.ts).
        const detection = answer(await (frame ? detector.detect(img, enqueueDetectorRun, { frame: true }) : detector.detect(img, enqueueDetectorRun)));
        mark('finder-run');
        console.debug('[DuelLens] detect-cards', { size, frame, cards: detection.boxes.length, decode: decoded, ms: detection.ms });
        return detection;
      } catch (e) {
        return answer([], `Duel Lens couldn't find the cards: ${message(e)}`);
      }
    })();
    const settled = settle(job, (why) => answer([], `Duel Lens couldn't find the cards: ${why}`));
    void settled.then(() => [...warmupsWaiting].forEach((done) => done()));
    return settled;
  }

  /**
   * Artworks the self-updating index just persisted: an engine already loaded (or loading)
   * searches them from its next scan on. Without one, nothing to do: a later load merges them
   * from the delta (load-engine.ts).
   */
  function addToLiveIndex(entries: DeltaEntry[]): void {
    // The Light engine searches the same index (models.ts indexOf): it gets them too.
    for (const loaded of [engine, lightEngine]) {
      if (!loaded) continue;
      loaded.then(
        (eng) => {
          try {
            eng.setIndex(mergeIndex(eng.getIndex(), entries));
          } catch (e) {
            console.warn('[DuelLens] could not add new artworks to the live index; the next load will', e);
          }
        },
        () => {}, // a failed load is reported by startEngine()
      );
    }
  }

  /**
   * The self-updating index's messages, which never load the whole engine: index-missing reads
   * the bundled index's metadata and the local delta, and embed-artworks loads the embedding
   * model alone. Each artwork embed is its own turn on the queue (not the whole message), so a
   * scan that arrives mid-chunk runs between two embeds instead of after all of them. Always
   * settles with an answer of the message's own type; when what it needs can't be loaded, the
   * answer says so in `error` (index-missing: nothing missing; embed-artworks: every item failed).
   */
  function updateIndex(msg: ToOffscreenIndex): Promise<OffscreenIndexMissingResponse | OffscreenEmbedArtworksResponse> {
    let job: Promise<OffscreenIndexMissingResponse | OffscreenEmbedArtworksResponse>;
    try {
      job = createIndexUpdater({
        modelId: deps.modelId,
        decode: deps.decode,
        loadIndexMeta: deps.loadIndexMeta,
        loadDelta: deps.delta?.load,
        appendDelta: deps.delta?.append,
        loadEmbedding: async () => {
          const embedder = await enqueue(deps.loadEmbedder);
          return { embed: (images) => enqueue(() => embedder.embed(images)), cardBack: await deps.loadCardBack() };
        },
        onAdded: addToLiveIndex,
      }).handle(msg);
    } catch (e) {
      job = Promise.reject(e);
    }
    return job.catch((e: unknown) => {
      console.error(`[DuelLens] ${msg.type} failed`, e);
      if (msg.type === 'index-missing') {
        return {
          modelId: deps.modelId,
          missing: [],
          error: `Duel Lens couldn't check which artworks its index is missing (${message(e)})`,
        } satisfies OffscreenIndexMissingResponse;
      }
      const items = Array.isArray(msg.items) ? msg.items : [];
      return {
        modelId: deps.modelId,
        added: 0,
        failed: items.map((i) => ({ imageId: i.imageId, error: message(e) })),
        error: `Duel Lens couldn't add new artworks to its index (${message(e)})`,
      } satisfies OffscreenEmbedArtworksResponse;
    });
  }

  const reply = (sendResponse: (response: unknown) => void, response: unknown) => {
    try {
      sendResponse(response);
    } catch (e) {
      console.warn('[DuelLens] could not send the response', e);
    }
  };

  return (msg, sender, sendResponse) => {
    if (!isToOffscreen(msg)) return false; // not ours: never answer
    // Only Duel Lens's own extension contexts, in practice the service worker (security review M2):
    // never a content script, whose URL is its web page's, nor another extension.
    if (senderKind(sender as chrome.runtime.MessageSender | undefined, deps.extension) !== 'extension-page') {
      console.warn(`[DuelLens] offscreen: ignored "${String(msg.type)}" from outside Duel Lens's own pages`);
      return false;
    }
    if (msg.type === 'warm-live') {
      // Live check's warm-up: both models loaded and run once now, so the first rest on a card finds them ready.
      primeFinder();
      const ok = (msg.light === true ? warmupLight() : warmup()).then((): OkResponse => ({ ok: true }));
      void settle(ok, (why): OkResponse => ({ ok: false, error: why })).then((r) => reply(sendResponse, r));
      return true;
    }
    if (msg.type === 'warm-state') {
      reply(sendResponse, { done: { ...doneAt }, now: Math.round(performance.now()) } satisfies WarmState);
      return false;
    }
    if (msg.type === 'warmup') {
      // The shortcut's warm-up: the card detector, its first detection, then the engine (warmupAfterDetection).
      void detectorLoad()?.catch(() => {});
      const ok = warmupAfterDetection().then((): OkResponse => ({ ok: true }));
      void settle(ok, (why): OkResponse => ({ ok: false, error: why })).then((r) => reply(sendResponse, r));
      return true;
    }
    if (msg.type === 'recognize') {
      void recognize(msg.crop).then((result) => reply(sendResponse, { result } satisfies OffscreenRecognizeResponse));
      return true;
    }
    if (msg.type === 'analyze-frame') {
      void analyzeFrame(msg).then((r) => reply(sendResponse, r));
      return true;
    }
    if (msg.type === 'detect-cards') {
      void detectCards(msg.dataUrl, msg.frame === true).then((detection) => reply(sendResponse, { detection } satisfies OffscreenDetectCardsResponse));
      return true;
    }
    if (isToOffscreenIndex(msg)) {
      void updateIndex(msg).then((r) => reply(sendResponse, r));
      return true;
    }
    return false;
  };
}
