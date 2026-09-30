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
  const fetchFn = deps?.fetchFn ?? fetch;
  const url = imageUrl(imageId, size);

  let res = await cache.match(url);
  if (!res) {
    let fetched: Response;
    try {
      fetched = await fetchFn(url);
    } catch {
      return null;
    }
    if (!fetched.ok) return null;
    await cache.put(url, fetched.clone());
    await evictOldest(cache);
    res = fetched;
  }

  const buf = await res.arrayBuffer();
  return `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
}
