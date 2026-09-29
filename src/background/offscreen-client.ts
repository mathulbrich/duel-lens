// Talks to the offscreen document: creates it on demand (once, safe under concurrent
// callers), forwards `recognize`/`warmup`/`detect-cards`/self-updating-index messages to it, and
// closes it once it has sat idle, since a loaded engine holds about 400 MB of WASM heap.
import { NO_CARD_DETECTOR } from '../shared/messages';
import type {
  CardDetection,
  OffscreenDetectCardsResponse,
  OffscreenEmbedArtworksResponse,
  OffscreenIndexMissingResponse,
  OffscreenRecognizeResponse,
  ToOffscreen,
  ToOffscreenIndex,
} from '../shared/messages';
import type { CropPayload, RecognitionResult } from '../shared/types';

const OFFSCREEN_URL = 'offscreen.html';

/**
 * The offscreen document's answer to detect-cards when this build has no card detector
 * (offscreen/handler.ts; a test pins the two together). The tab (content/index.ts) and the E2E
 * harness tell it from every other detection error by this exact text.
 * TODO(lead): move to src/shared/messages.ts with the handler's copy (click-review.md I2).
 */
export { NO_CARD_DETECTOR };

/** The alarm that closes the offscreen document once it has sat idle (background/index.ts). */
export const OFFSCREEN_IDLE_ALARM = 'close-idle-offscreen';
/** How long after the last scan or embed the offscreen document is closed. */
export const OFFSCREEN_IDLE_MINUTES = 5;

// The document being created, until createDocument resolves. It guards against a second
// createDocument() (chrome.offscreen throws if a second document is created while one exists), and
// every request waits for it: see ensureOffscreen.
let creating: Promise<void> | null = null;
/** Requests sent to the offscreen document and not answered yet: it is never closed under them. */
let inFlight = 0;
/** A close in progress: a new request waits for it, then creates a new document. */
let closing: Promise<void> | null = null;

async function hasOffscreenDocument(): Promise<boolean> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return existing.length > 0;
}

/**
 * Resolves once the offscreen document exists and listens, creating it if needed (once, however
 * many callers ask at the same time).
 *
 * getContexts lists a new document as soon as its navigation commits, about 100 ms before
 * offscreen.js (18 MB) has run and registered its onMessage listener; createDocument resolves only
 * after that first load (click-review.md I1). So a document being created counts as absent: every
 * caller waits for createDocument, not only the one that called it, before trusting getContexts.
 */
export async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  if (!(await hasOffscreenDocument())) {
    creating ??= chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs ONNX Runtime Web to find and recognize the cards in a captured screenshot.',
      })
      .finally(() => {
        creating = null;
      });
  }
  // Also when getContexts listed it: another caller may have started creating it while we asked.
  if (creating) await creating;
}

/** What Chrome's sendMessage rejects with when no listener got the message. */
const NOT_LISTENING = 'Receiving end does not exist';
/**
 * The waits before re-sending a request nobody received (1.55 s in all), then its error stands. The
 * backstop for a document still loading that no `creating` covers: one a worker created before it
 * was stopped and restarted.
 */
const RESEND_WAITS_MS = [50, 100, 200, 400, 800];

const notListening = (e: unknown) => (e instanceof Error ? e.message : String(e)).includes(NOT_LISTENING);

/**
 * Ensures the document, then sends; re-sends, after a growing wait, only a request that no listener
 * received (so none has acted on it): the document hadn't registered its listener yet, or had gone
 * (ensureOffscreen creates it again first). Any other failure, or the last one, is thrown.
 */
async function sendToOffscreen<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await ensureOffscreen();
    try {
      return await send();
    } catch (e) {
      const wait = RESEND_WAITS_MS[attempt];
      if (wait === undefined || !notListening(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * (Re)schedules the idle close for OFFSCREEN_IDLE_MINUTES from now. An alarm, not a timer: the
 * service worker is stopped after 30 s without events, and a timer would die with it.
 */
function scheduleIdleClose(): void {
  void Promise.resolve()
    .then(() => chrome.alarms.create(OFFSCREEN_IDLE_ALARM, { delayInMinutes: OFFSCREEN_IDLE_MINUTES }))
    .catch((err: unknown) => console.warn('Duel Lens: could not schedule closing the idle offscreen document', err));
}

/**
 * Sends one request to the offscreen document, creating the document first if needed, once it
 * listens (sendToOffscreen). Every request (a scan, a warm-up, a card detection, an index message)
 * counts as activity: the idle close moves to OFFSCREEN_IDLE_MINUTES after the last one ends, and
 * never happens while one is in flight.
 */
async function withOffscreen<T>(send: () => Promise<T>): Promise<T> {
  inFlight++;
  scheduleIdleClose();
  try {
    // A failed close is the alarm handler's problem, not this request's: ensureOffscreen (in
    // sendToOffscreen) reuses the document if it survived, or creates a new one.
    while (closing) await closing.catch(() => {});
    return await sendToOffscreen(send);
  } finally {
    inFlight--;
    scheduleIdleClose();
  }
}

/**
 * The idle alarm fired: closes the offscreen document (freeing the engine's memory) unless a
 * request is in flight, in which case the close is scheduled again. The next scan creates a
 * new document (ensureOffscreen) and loads what it needs again. Never throws for a document
 * that is already gone.
 */
export async function closeOffscreenIfIdle(): Promise<void> {
  if (inFlight > 0) {
    scheduleIdleClose();
    return;
  }
  closing ??= closeNow().finally(() => {
    closing = null;
  });
  await closing;
}

async function closeNow(): Promise<void> {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
}

export async function recognizeViaOffscreen(crop: CropPayload): Promise<RecognitionResult> {
  const res = (await withOffscreen(() =>
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'recognize',
      crop,
    }),
  )) as OffscreenRecognizeResponse | undefined;
  // A missing/undefined answer (another extension page's listener got the message, an old
  // offscreen document) must read as a normal recognition failure, not a raw TypeError (review Minor).
  if (!res?.result) throw new Error("The recognition engine didn't answer. Try again.");
  return res.result;
}



const isId = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumber = isId;
const isOptionalText = (v: unknown) => v === undefined || typeof v === 'string';

function isIndexMissingResponse(res: unknown): res is OffscreenIndexMissingResponse {
  const r = res as Partial<OffscreenIndexMissingResponse>;
  return typeof r.modelId === 'string' && Array.isArray(r.missing) && r.missing.every(isId) && isOptionalText(r.error);
}

function isEmbedArtworksResponse(res: unknown): res is OffscreenEmbedArtworksResponse {
  const r = res as Partial<OffscreenEmbedArtworksResponse>;
  return (
    typeof r.modelId === 'string' &&
    isId(r.added) &&
    Array.isArray(r.failed) &&
    r.failed.every((f) => !!f && isId(f.imageId) && typeof f.error === 'string') &&
    isOptionalText(r.error) &&
    (r.placeholders === undefined || (Array.isArray(r.placeholders) && r.placeholders.every(isId)))
  );
}

/**
 * Sends a self-updating-index message and checks the answer's shape, so a missing or
 * malformed answer (another listener's, an old offscreen document's) fails with a readable
 * error here instead of as a TypeError deep in the caller.
 */
async function askIndex<R>(msg: ToOffscreenIndex, valid: (res: unknown) => res is R): Promise<R> {
  const res: unknown = await withOffscreen(() => chrome.runtime.sendMessage(msg));
  if (res === undefined || res === null) throw new Error(`The recognition engine didn't answer ${msg.type}. Try again.`);
  if (!valid(res)) throw new Error(`The recognition engine gave an unexpected answer to ${msg.type}: ${JSON.stringify(res).slice(0, 200)}`);
  return res;
}

/** Which of these artwork ids neither the bundled index nor the local delta covers yet. */
export function indexMissing(imageIds: number[]): Promise<OffscreenIndexMissingResponse> {
  return askIndex({ target: 'offscreen', type: 'index-missing', imageIds }, isIndexMissingResponse);
}

/** Embeds and locally indexes artwork crops the background already downloaded. */
export function embedArtworks(items: { imageId: number; cardId: number; dataUrl: string }[]): Promise<OffscreenEmbedArtworksResponse> {
  return askIndex({ target: 'offscreen', type: 'embed-artworks', items }, isEmbedArtworksResponse);
}

function isCardDetection(d: unknown): d is CardDetection {
  const r = d as Partial<CardDetection> | null | undefined;
  return (
    !!r &&
    Array.isArray(r.boxes) &&
    r.boxes.every(
      (b) =>
        !!b &&
        [b.cx, b.cy, b.w, b.h, b.angle, b.conf].every(isNumber) &&
        Array.isArray(b.pts) &&
        b.pts.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNumber)),
    ) &&
    [r.width, r.height, r.ms].every(isNumber) &&
    isOptionalText(r.error)
  );
}

/** chrome.storage.session key: a detect-cards answer said NO_CARD_DETECTOR. */
const NO_DETECTOR_KEY = 'noCardDetector';
/** This worker's copy of that (only ever true: an unknown is asked again). */
let noDetectorKnown = false;

/**
 * Whether this build is known to have no card detector: an earlier detect-cards said so (scan.ts
 * then tells the tab at once and sends nothing to detect). Kept in chrome.storage.session, which
 * outlives this service worker but is cleared when the extension is reloaded or updated (a new
 * build may have a detector) and when the browser restarts. False when not known; never throws.
 */
export async function knownNoCardDetector(): Promise<boolean> {
  if (noDetectorKnown) return true;
  try {
    const stored = await chrome.storage.session.get(NO_DETECTOR_KEY);
    noDetectorKnown = stored?.[NO_DETECTOR_KEY] === true;
  } catch {
    // Unknown: detect-cards asks the offscreen document, which answers the same.
  }
  return noDetectorKnown;
}

function rememberNoCardDetector(): void {
  noDetectorKnown = true;
  void Promise.resolve()
    .then(() => chrome.storage.session.set({ [NO_DETECTOR_KEY]: true }))
    .catch(() => {}); // this worker still knows; a restarted one asks once more
}

/**
 * Click to scan: every card the detector finds on a whole screenshot (captureVisibleTab's PNG data
 * URL), in the screenshot's pixels. Never throws: when detection can't run (no detector in this
 * build, the offscreen document didn't answer) or fails, the detection is empty and `error` says why.
 * An answer that this build has no card detector is remembered (knownNoCardDetector).
 */
export async function detectCards(dataUrl: string): Promise<CardDetection> {
  const failed = (error: string): CardDetection => ({ boxes: [], width: 0, height: 0, ms: 0, error });
  const msg: ToOffscreen = { target: 'offscreen', type: 'detect-cards', dataUrl };
  let res: unknown;
  try {
    res = await withOffscreen(() => chrome.runtime.sendMessage(msg));
  } catch (e) {
    return failed(`Duel Lens couldn't reach its card detector (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res === undefined || res === null) return failed("The recognition engine didn't answer detect-cards.");
  const detection = (res as Partial<OffscreenDetectCardsResponse>).detection;
  if (!isCardDetection(detection)) return failed(`The recognition engine gave an unexpected answer to detect-cards: ${JSON.stringify(res).slice(0, 200)}`);
  if (detection.error === NO_CARD_DETECTOR) rememberNoCardDetector();
  return detection;
}

/** Best-effort: warms the model/index up so the first real scan is fast. Never throws. */
export async function warmupOffscreen(): Promise<void> {
  try {
    await withOffscreen(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'warmup' }));
  } catch {
    // The first real recognize() will pay the cold-start cost instead.
  }
}
