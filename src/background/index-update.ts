// The self-updating artwork index (background half): downloads and embeds artwork for any
// card the live index (bundled + local delta) doesn't cover yet, so new cards never need a
// hand rebuild of extension/data/index-<model>.bin. Runs on a weekly card-data refresh that
// finds new cards, on the first run after install, and whenever the user presses "Update
// now" in Options (index.ts and router.ts wire those triggers to `runIndexUpdate`).
//
// The actual downloading/embedding happens in two other places this module coordinates:
//  - the offscreen document embeds artwork crops into the local delta index
//    (src/offscreen/index-updater.ts, src/offscreen/delta-index.ts);
//  - this module downloads each artwork once (politely: rate-limited, with retry/backoff)
//    and hands it to the offscreen document in chunks.
import { getModel } from '../shared/models';
import { getAllImageIds } from './card-store';
import { embedArtworks as embedArtworksViaOffscreen, indexMissing as indexMissingViaOffscreen } from './offscreen-client';

export interface IndexUpdateStatus {
  state: 'idle' | 'running' | 'failed';
  /** Artworks still to download and embed in the current run. */
  pending?: number;
  /** Epoch ms of the last completed run. */
  lastRun?: number;
  error?: string;
}

/**
 * An artwork id skipped by later runs until its cooldown ends: the server doesn't have it
 * (HTTP 404), or it serves the card back in its place until the real art is uploaded (a
 * placeholder the offscreen document recognised: "art not available yet"). Only those are
 * stored: a network error, a 5xx that outlasted the retries or a failed embed is likely
 * transient, so the next run (or "Update now") simply tries it again.
 */
interface StoredFailure {
  /** Epoch ms this download last failed. */
  at: number;
  error: string;
  /** HTTP status of the failed download (404). Absent in entries stored before it was kept. */
  status?: number;
  /** The artwork is still YGOPRODeck's card-back placeholder. */
  placeholder?: boolean;
}

/** Whether a stored failure is a 404 (older entries only have its message, "HTTP 404"). */
const isNotFound = (f: StoredFailure) => f.status === 404 || f.error === 'HTTP 404';
/** Whether a stored failure waits out the cooldown: a 404, or art that isn't available yet. */
const hasCooldown = (f: StoredFailure) => isNotFound(f) || f.placeholder === true;

/** How a card-back placeholder is recorded (the Options page's words for it). */
export const ART_NOT_AVAILABLE = 'art not available yet';

export interface IndexUpdateDeps {
  getAllImageIds: () => Promise<{ imageId: number; cardId: number }[]>;
  /** `error`: the offscreen document couldn't check (its index can't be read); the run fails with it. */
  indexMissing: (imageIds: number[]) => Promise<{ missing: number[]; error?: string }>;
  /**
   * `error`: the offscreen document can't embed at all (its model can't load); the run stops and
   * fails with it. `placeholders`: artworks that are still the card back (not indexed; cooldown).
   */
  embedArtworks: (
    items: { imageId: number; cardId: number; dataUrl: string }[],
  ) => Promise<{ added: number; failed: { imageId: number; error: string }[]; error?: string; placeholders?: number[] }>;
  fetchFn: typeof fetch;
  now: () => number;
  storage: {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
  };
  /** Downloads started per second across the whole run. YGOPRODeck allows up to 20; default 8. */
  rateLimitPerSecond?: number;
  /** Artworks per embed-artworks message. Default 16. */
  chunkSize?: number;
  /**
   * How long an artwork the server doesn't have (HTTP 404), or serves only as the card-back
   * placeholder, is skipped by later runs. Default 7 days. Other failures get no cooldown: the
   * next run tries them again.
   */
  failureCooldownMs?: number;
}

const STATUS_KEY = 'indexUpdate';
const FAILURES_KEY = 'indexUpdateFailures';
export const DEFAULT_CHUNK_SIZE = 16;
export const DEFAULT_RATE_LIMIT_PER_SECOND = 8;
export const DEFAULT_FAILURE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** onInstalled/onStartup only start a run when the last one finished more than this long ago. */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;

const artworkUrl = (imageId: number) => `https://images.ygoprodeck.com/images/cards_cropped/${imageId}.jpg`;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const defaultDeps: IndexUpdateDeps = {
  getAllImageIds,
  indexMissing: indexMissingViaOffscreen,
  embedArtworks: embedArtworksViaOffscreen,
  fetchFn: (...args) => fetch(...args),
  now: () => Date.now(),
  storage: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  },
};

async function getStatus(deps: IndexUpdateDeps): Promise<IndexUpdateStatus> {
  const stored = await deps.storage.get(STATUS_KEY);
  const status = stored[STATUS_KEY] as IndexUpdateStatus | undefined;
  return status ?? { state: 'idle' };
}

async function setStatus(deps: IndexUpdateDeps, status: IndexUpdateStatus): Promise<void> {
  await deps.storage.set({ [STATUS_KEY]: status });
}

async function getFailures(deps: IndexUpdateDeps): Promise<Record<string, StoredFailure>> {
  const stored = await deps.storage.get(FAILURES_KEY);
  const failures = stored[FAILURES_KEY];
  return failures && typeof failures === 'object' ? (failures as Record<string, StoredFailure>) : {};
}

/** Reads the persisted self-updating-index status (for `get-status`). Never throws. */
export async function getIndexUpdateStatus(deps: IndexUpdateDeps = defaultDeps): Promise<IndexUpdateStatus> {
  try {
    return await getStatus(deps);
  } catch {
    return { state: 'idle' };
  }
}

/**
 * At most `perSecond` downloads start per second, shared across every caller of the
 * returned function (mirrors tools/lib/http.ts's createRateLimiter, reimplemented here so
 * the shippable extension bundle doesn't depend on the Node data tools).
 */
function createRateLimiter(perSecond: number): () => Promise<void> {
  const interval = 1000 / perSecond;
  let next = -Infinity;
  return () => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + interval;
    const wait = slot - now;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  };
}

function arrayBufferToDataUrl(buf: ArrayBuffer, contentType: string): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000; // avoid a stack overflow from String.fromCharCode(...hugeArray)
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return `data:${contentType};base64,${btoa(binary)}`;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/**
 * Downloads one artwork as a data URL, rate-limited and retrying transient failures
 * (network errors, 429, 5xx) with doubling backoff. A 404 (no artwork at this id) is
 * thrown immediately, without retrying - it won't succeed later either.
 */
async function downloadArtwork(deps: IndexUpdateDeps, imageId: number, limiter: () => Promise<void>): Promise<string> {
  const retries = 3;
  const backoffMs = 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter();
    try {
      const res = await deps.fetchFn(artworkUrl(imageId));
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return arrayBufferToDataUrl(buf, res.headers.get('content-type') || 'image/jpeg');
      }
      await res.body?.cancel?.().catch(() => {});
      if (res.status === 404) throw new HttpError(404);
      lastErr = new HttpError(res.status);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw err;
      lastErr = err;
    }
    if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface RunContext {
  deps: IndexUpdateDeps;
  limiter: () => Promise<void>;
  chunkSize: number;
  failures: Record<string, StoredFailure>;
  now: number;
}

/**
 * Downloads and embeds every item in `toDo`, in order: rate-limited downloads feed a
 * buffer that's sent to the offscreen document (`embedArtworks`) once it reaches
 * `chunkSize`, so a single artwork is never downloaded more than once. Persists a rough
 * `pending` progress count every `chunkSize` items, not every single one, so it doesn't
 * spam chrome.storage.local. A 404, or an artwork the offscreen document found to be the
 * card-back placeholder, is recorded into `ctx.failures` for the caller to persist (its
 * cooldown); other per-artwork failures are only counted, so the next run tries them
 * again. None of them stops the run; an offscreen document that can't embed at all (its
 * answer's `error`) does: this throws, and the run is marked failed. Returns how many
 * artworks failed for a reason other than a 404.
 */
async function processMissing(toDo: { imageId: number; cardId: number }[], ctx: RunContext): Promise<number> {
  const { deps, limiter, chunkSize, failures, now } = ctx;
  let buffer: { imageId: number; cardId: number; dataUrl: string }[] = [];
  let processed = 0;
  let transient = 0;

  const flushBuffer = async () => {
    if (buffer.length === 0) return;
    const sent = buffer;
    buffer = [];
    let res: Awaited<ReturnType<IndexUpdateDeps['embedArtworks']>>;
    try {
      res = await deps.embedArtworks(sent);
    } catch (err) {
      // The offscreen document never answered for this whole chunk (e.g. it crashed or was
      // torn down mid-batch): none of these were embedded, so leave them missing rather than
      // recording them as known-bad - the next run's index-missing will offer them again.
      console.error(`Duel Lens: embed-artworks failed for a chunk of ${sent.length} artwork(s)`, err);
      return;
    }
    // It can't embed anything (its model can't load): downloading the rest would be wasted.
    if (res.error) throw new Error(res.error);
    transient += res.failed.length;
    for (const f of res.failed) console.warn(`Duel Lens: could not embed artwork ${f.imageId} (next run retries it): ${f.error}`);
    for (const imageId of res.placeholders ?? []) {
      failures[String(imageId)] = { at: now, error: ART_NOT_AVAILABLE, placeholder: true };
      console.info(`Duel Lens: artwork ${imageId} is still the card back (${ART_NOT_AVAILABLE}); trying again in a week`);
    }
  };

  for (const item of toDo) {
    let dataUrl: string | undefined;
    try {
      dataUrl = await downloadArtwork(deps, item.imageId, limiter);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        failures[String(item.imageId)] = { at: now, error: message(err), status: 404 };
      } else {
        transient++;
        console.warn(`Duel Lens: could not download artwork ${item.imageId} (next run retries it): ${message(err)}`);
      }
    }
    if (dataUrl !== undefined) {
      buffer.push({ ...item, dataUrl });
      if (buffer.length >= chunkSize) await flushBuffer();
    }
    processed++;
    if (processed % chunkSize === 0 || processed === toDo.length) {
      await setStatus(deps, { state: 'running', pending: toDo.length - processed });
    }
  }
  await flushBuffer();
  return transient;
}

async function runOnce(deps: IndexUpdateDeps): Promise<void> {
  const chunkSize = deps.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const cooldownMs = deps.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
  const limiter = createRateLimiter(deps.rateLimitPerSecond ?? DEFAULT_RATE_LIMIT_PER_SECOND);
  const now = deps.now();
  try {
    await setStatus(deps, { state: 'running' });

    const cards = await deps.getAllImageIds();
    const cardIdByImage = new Map(cards.map((c) => [c.imageId, c.cardId]));
    const { missing, error } = await deps.indexMissing(cards.map((c) => c.imageId));
    // The offscreen document couldn't check (its index can't be read): nothing is known to be
    // missing, and finishing normally would hide that until the next run a day later.
    if (error) throw new Error(error);

    // Ids the server answered 404 for, or served only the card-back placeholder for, recently
    // are skipped this run (but kept on record, so a *still*-recent one isn't forgotten and
    // re-attempted every run): its artwork won't appear on an immediate retry, and this avoids
    // hammering YGOPRODeck for it every run. Any other stored failure (older versions stored
    // every kind) is dropped and tried again.
    const previousFailures = await getFailures(deps);
    const failures: Record<string, StoredFailure> = {};
    for (const [id, f] of Object.entries(previousFailures)) if (hasCooldown(f) && now - f.at < cooldownMs) failures[id] = f;

    const toDo = missing
      .filter((imageId) => cardIdByImage.has(imageId) && !(String(imageId) in failures))
      .map((imageId) => ({ imageId, cardId: cardIdByImage.get(imageId)! }));

    await setStatus(deps, { state: 'running', pending: toDo.length });
    const transient = await processMissing(toDo, { deps, limiter, chunkSize, failures, now });
    if (transient > 0) console.warn(`Duel Lens: ${transient} artwork(s) failed this run; the next run tries them again`);
    await deps.storage.set({ [FAILURES_KEY]: failures });
    await setStatus(deps, { state: 'idle', lastRun: now });
  } catch (err) {
    console.error('Duel Lens: index update failed', err);
    await setStatus(deps, { state: 'failed', error: message(err) }).catch(() => {});
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Downloads and embeds artwork for any card the live index doesn't cover yet. Never
 * throws: every failure (a single artwork, or the run itself) is caught, logged, and
 * recorded in the persisted status instead, so callers can always fire this and forget it.
 * A second call while a run is already in progress joins that run rather than starting a
 * duplicate (concurrent downloads/embeds of the same artwork, doubled rate-limit budget).
 */
export function runIndexUpdate(deps: IndexUpdateDeps = defaultDeps): Promise<void> {
  inFlight ??= runOnce(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Starts a run only when the last completed one was more than `staleMs` ago (or never). */
export async function runIndexUpdateIfStale(deps: IndexUpdateDeps = defaultDeps, staleMs = STALE_RUN_MS): Promise<void> {
  const status = await getIndexUpdateStatus(deps);
  if (status.lastRun !== undefined && deps.now() - status.lastRun < staleMs) return;
  await runIndexUpdate(deps);
}

// ---------- delta index size, for the Options page ----------
// A minimal, read-only reader for the offscreen document's delta database. IndexedDB is
// shared by every context of the extension (background, offscreen, options), so this can
// read it directly without waking the offscreen document (which would load the whole ONNX
// engine) just to answer a count. Schema (name, version, store, index) kept byte-for-byte
// in sync with src/offscreen/delta-index.ts's openDeltaDb, so whichever context happens to
// open this database first creates the same schema - opening at a matching version with no
// pending upgrade otherwise leaves the object store missing forever (IndexedDB only runs
// `onupgradeneeded` when the requested version is higher than the database's current one).
const DELTA_DB_NAME = 'duel-lens-index';
const DELTA_DB_VERSION = 1;
const DELTA_STORE = 'entries';
const DELTA_MODEL_INDEX = 'modelId';

function openDeltaDbForCount(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DELTA_DB_NAME, DELTA_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DELTA_STORE)) {
        const store = db.createObjectStore(DELTA_STORE, { keyPath: ['modelId', 'imageId'] });
        store.createIndex(DELTA_MODEL_INDEX, 'modelId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Number of artworks embedded on this computer (the local delta) for the active model. */
export async function getIndexDeltaCount(modelId: string = getModel().id): Promise<number> {
  try {
    const db = await openDeltaDbForCount();
    const count = await new Promise<number>((resolve, reject) => {
      const req = db.transaction(DELTA_STORE, 'readonly').objectStore(DELTA_STORE).index(DELTA_MODEL_INDEX).count(modelId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count;
  } catch (err) {
    console.error('Duel Lens: could not read the local artwork index size', err);
    return 0;
  }
}
