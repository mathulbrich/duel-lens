// Caches YGOPRODeck display images (Cache API) and hands them to pages as data URLs,
// because images.ygoprodeck.com sends no CORS headers so pages can't fetch it directly.
// Every build but the crop build (--no-remote-images) uses it (router.ts, __DUEL_LENS_REMOTE_IMAGES__).
import { isAltArtwork } from '../shared/alt-artwork';

const CACHE_NAME = 'card-images-v1';

/** At most this many images stay cached (security review I3): past it, the oldest go first. It used to grow without a bound. */
export const MAX_CACHED_IMAGES = 1500;

export type ImageSize = 'full' | 'small';

export interface ImageCacheDeps {
  /** A subset of the Cache API used here, injectable for tests. */
  cache: Pick<Cache, 'match' | 'put' | 'keys' | 'delete'>;
  fetchFn: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

// ---------- downloads, politely (YGOPRODeck's API guide: at most 20 requests a second; download each image once) ----------
/** At most this many image downloads at once... */
export const MAX_CONCURRENT_DOWNLOADS = 4;
/** ...and one starting every MIN_GAP_MS at most: about 6 a second, wherever the requests come from (a board of 60 cards included). */
export const MIN_GAP_MS = 150;
/** A 429, a 5xx or a network error is tried again this many times, waiting 1 s, then 2 s (or the Retry-After, up to 10 s). */
const RETRIES = 2;
/** An image YGOPRODeck doesn't have (a 4xx) isn't asked for again for an hour... */
export const NOT_FOUND_MS = 60 * 60_000;
/** ...and one that kept failing, for 10 minutes. */
export const FAILED_MS = 10 * 60_000;

/** Each image being downloaded, shared by everyone who asks for it meanwhile. */
const inFlight = new Map<string, Promise<string | null>>();
/** Images not to ask for again before their time (NOT_FOUND_MS, FAILED_MS). */
const failedUntil = new Map<string, number>();
let active = 0;
let nextStart = 0;
/** Downloads waiting for a place, a full image (a card someone is looking at) ahead of every thumbnail. */
const waiting: { resolve: () => void; size: ImageSize }[] = [];

/** Test-only: forgets the downloads in flight, the failures and the limiter's state. */
export function resetImageDownloads(): void {
  inFlight.clear();
  failedUntil.clear();
  active = 0;
  nextStart = 0;
  waiting.length = 0;
}

async function acquire(size: ImageSize, d: Pick<ImageCacheDeps, 'now' | 'sleep'>): Promise<void> {
  while (active >= MAX_CONCURRENT_DOWNLOADS) {
    await new Promise<void>((resolve) => {
      const entry = { resolve, size };
      // A full image goes after the full images already waiting, before every thumbnail.
      const at = size === 'full' ? waiting.findIndex((w) => w.size === 'small') : -1;
      if (at < 0) waiting.push(entry);
      else waiting.splice(at, 0, entry);
    });
  }
  active++;
  const now = d.now();
  const start = Math.max(now, nextStart);
  nextStart = start + MIN_GAP_MS;
  if (start > now) await d.sleep(start - now);
}

function release(): void {
  active--;
  waiting.shift()?.resolve();
}

/** The image's response, or null when YGOPRODeck hasn't it or keeps failing (remembered: failedUntil). */
async function download(url: string, size: ImageSize, d: Pick<ImageCacheDeps, 'fetchFn' | 'now' | 'sleep'>): Promise<Response | null> {
  if ((failedUntil.get(url) ?? 0) > d.now()) return null;
  for (let attempt = 0; ; attempt++) {
    await acquire(size, d);
    let res: Response | null;
    try {
      res = await d.fetchFn(url);
    } catch {
      res = null;
    } finally {
      release();
    }
    if (res?.ok) {
      failedUntil.delete(url);
      return res;
    }
    const status = res?.status ?? 0;
    if (status !== 0 && status !== 429 && status < 500) {
      failedUntil.set(url, d.now() + NOT_FOUND_MS);
      return null;
    }
    if (attempt >= RETRIES) {
      failedUntil.set(url, d.now() + FAILED_MS);
      return null;
    }
    const retryAfter = Number(res?.headers.get('Retry-After'));
    await d.sleep(Math.min(10_000, retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt));
  }
}

let cachePromise: Promise<Cache> | null = null;
function defaultCache(): Promise<Cache> {
  if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
  return cachePromise;
}

export function imageUrl(imageId: number, size: ImageSize): string {
  const dir = size === 'small' ? 'cards_small' : 'cards';
  return `https://images.ygoprodeck.com/images/${dir}/${imageId}.jpg`;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunkSize = 0x8000; // avoid a stack overflow from String.fromCharCode(...hugeArray)
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * Keeps the cache at MAX_CACHED_IMAGES, deleting the oldest entries (the Cache API lists its keys in
 * the order they were added). Run after each new image, never on a cache hit. A failure here only
 * leaves the cache larger for now: the image itself is still answered.
 */
async function evictOldest(cache: Pick<Cache, 'keys' | 'delete'>): Promise<void> {
  try {
    const keys = await cache.keys();
    for (const request of keys.slice(0, Math.max(0, keys.length - MAX_CACHED_IMAGES))) await cache.delete(request);
  } catch (err) {
    console.warn('Duel Lens: could not trim the card image cache', err);
  }
}

/**
 * Fetches (once) and caches a card's display image, returning it as a JPEG data URL.
 * Returns null when the image can't be fetched (e.g. a 404 for an unknown image id), and at once,
 * without a request, for an artwork YGOPRODeck has no image of (a synthetic id, src/shared/alt-artwork.ts:
 * the router shows its card's own image instead).
 */
export async function getImageDataUrl(
  imageId: number,
  size: ImageSize = 'full',
  deps?: Partial<ImageCacheDeps>,
): Promise<string | null> {
  if (isAltArtwork(imageId)) return null;
  const cache = deps?.cache ?? (await defaultCache());
  const d = {
    // Never `fetch` itself as a property: called as d.fetchFn(), the browser's fetch throws "Illegal invocation".
    fetchFn: deps?.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init)),
    now: deps?.now ?? (() => Date.now()),
    sleep: deps?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
  };
  const url = imageUrl(imageId, size);
  const toDataUrl = async (res: Response) => `data:image/jpeg;base64,${arrayBufferToBase64(await res.arrayBuffer())}`;

  const cached = await cache.match(url);
  if (cached) return toDataUrl(cached);
  let pending = inFlight.get(url);
  if (!pending) {
    pending = (async () => {
      const fetched = await download(url, size, d);
      if (!fetched) return null;
      await cache.put(url, fetched.clone());
      await evictOldest(cache);
      return toDataUrl(fetched);
    })().finally(() => inFlight.delete(url));
    inFlight.set(url, pending);
  }
  return pending;
}
