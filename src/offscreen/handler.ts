// Message handling for the offscreen document, kept free of chrome.* and model loading
// so it can be tested; index.ts wires it to chrome.runtime.onMessage.
import type { IndexMeta } from '../shared/index-format';
import { NO_CARD_DETECTOR } from '../shared/messages';
import {
  isToOffscreen,
  isToOffscreenIndex,
  senderKind,
  type CardDetection,
  type ExtensionIdentity,
  type OffscreenDetectCardsResponse,
  type OffscreenEmbedArtworksResponse,
  type OffscreenIndexMissingResponse,
  type OffscreenRecognizeResponse,
  type OkResponse,
  type ToOffscreenIndex,
} from '../shared/messages';
import type { RGBAImage } from '../shared/preprocess';
import type { CropPayload, RecognitionResult } from '../shared/types';
import { mergeIndex, type DeltaEntry } from './delta-index';
import type { CardDetector } from './detect-cards';
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
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;

const SCAN_TIMEOUT_MS = 30_000;
const NO_DETECTOR = NO_CARD_DETECTOR;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createOffscreenHandler(deps: OffscreenDeps): Listener {
  const limit = deps.timeoutMs ?? SCAN_TIMEOUT_MS;

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

  let engine: Promise<Engine> | null = null;
  /**
   * One shared load, queued like a scan; a failed load is forgotten so the next message tries
   * again. Once loaded, the engine's priming steps are queued as optional work: a scan or detection
   * that arrived during the load (already queued) runs before them, and so does one that arrives
   * while they are still queued.
   */
  function warmup(): Promise<Engine> {
    if (!engine) {
      const loading = enqueue(deps.loadEngine);
      engine = loading;
      loading.then(
        (eng) => {
          try {
            for (const step of eng.primeSteps()) enqueueIdle(step);
          } catch (e) {
            console.debug('[DuelLens] could not queue the priming runs', e);
          }
        },
        (e: unknown) => {
          console.error('[DuelLens] engine failed to load', e);
          if (engine === loading) engine = null;
        },
      );
    }
    return engine;
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
    const result = await loaded.recognize(img, crop.inner, crop.outline, crop.click);
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
      const ready = warmup();
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
      loading.catch((e: unknown) => {
        console.error('[DuelLens] the card detector failed to load', e);
        if (cardDetector === loading) cardDetector = null;
      });
    }
    return cardDetector;
  }

  /**
   * Click to scan: every card on a whole screenshot. Without a card detector, answers at once.
   * Otherwise the screenshot is decoded while the detector loads, and the detector's runs go on the
   * work queue (enqueueDetectorRun). Always settles with a detection: when anything fails, `error`
   * says why and `boxes` is empty.
   */
  function detectCards(dataUrl: string): Promise<CardDetection> {
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
        const detection = answer(await detector.detect(img, enqueueDetectorRun));
        console.debug('[DuelLens] detect-cards', { size, cards: detection.boxes.length, decode: decoded, ms: detection.ms });
        return detection;
      } catch (e) {
        return answer([], `Duel Lens couldn't find the cards: ${message(e)}`);
      }
    })();
    return settle(job, (why) => answer([], `Duel Lens couldn't find the cards: ${why}`));
  }

  /**
   * Artworks the self-updating index just persisted: an engine already loaded (or loading)
   * searches them from its next scan on. Without one, nothing to do: a later load merges them
   * from the delta (load-engine.ts).
   */
  function addToLiveIndex(entries: DeltaEntry[]): void {
    const loaded = engine;
    if (!loaded) return;
    loaded.then(
      (eng) => {
        try {
          eng.setIndex(mergeIndex(eng.getIndex(), entries));
        } catch (e) {
          console.warn('[DuelLens] could not add new artworks to the live index; the next load will', e);
        }
      },
      () => {}, // a failed load is reported by warmup()
    );
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
    if (msg.type === 'warmup') {
      // The shortcut's warm-up: its card detection comes first, then any scan.
      void detectorLoad()?.catch(() => {});
      const ok = warmup().then((): OkResponse => ({ ok: true }));
      void settle(ok, (why): OkResponse => ({ ok: false, error: why })).then((r) => reply(sendResponse, r));
      return true;
    }
    if (msg.type === 'recognize') {
      void recognize(msg.crop).then((result) => reply(sendResponse, { result } satisfies OffscreenRecognizeResponse));
      return true;
    }
    if (msg.type === 'detect-cards') {
      void detectCards(msg.dataUrl).then((detection) => reply(sendResponse, { detection } satisfies OffscreenDetectCardsResponse));
      return true;
    }
    if (isToOffscreenIndex(msg)) {
      void updateIndex(msg).then((r) => reply(sendResponse, r));
      return true;
    }
    return false;
  };
}
