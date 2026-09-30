import { describe, expect, it, vi } from 'vitest';
import { altArtworkId } from '../shared/alt-artwork';
import { getImageDataUrl, imageUrl, MAX_CACHED_IMAGES } from './image-cache';

/**
 * Minimal in-memory stand-in for the Cache API's `match`/`put`/`keys`/`delete`. Like the real one,
 * `keys()` lists entries oldest first, and putting a URL again moves it to the end.
 */
function fakeCache(initial: string[] = []) {
  const store = new Map<string, Response>(initial.map((url) => [url, new Response(new Uint8Array([1]))]));
  return {
    store,
    match: vi.fn(async (req: string) => store.get(req)?.clone()),
    put: vi.fn(async (req: string, res: Response) => {
      store.delete(req);
      store.set(req, res);
    }),
    keys: vi.fn(async () => [...store.keys()].map((url) => new Request(url))),
    delete: vi.fn(async (req: Request | string) => store.delete(typeof req === 'string' ? req : req.url)),
  };
}

describe('imageUrl', () => {
  it('builds the full and small image URLs', () => {
    expect(imageUrl(55144522, 'full')).toBe('https://images.ygoprodeck.com/images/cards/55144522.jpg');
    expect(imageUrl(55144522, 'small')).toBe('https://images.ygoprodeck.com/images/cards_small/55144522.jpg');
  });
});

describe('getImageDataUrl', () => {
  it('fetches and caches on the first call, and returns a data URL', async () => {
    const cache = fakeCache();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
    const fetchFn = vi.fn(async () => new Response(bytes.buffer, { status: 200 }));

    const result = await getImageDataUrl(55144522, 'full', { cache, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('makes no fetch on the second call (served from cache)', async () => {
    const cache = fakeCache();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchFn = vi.fn(async () => new Response(bytes.buffer, { status: 200 }));

    const first = await getImageDataUrl(55144522, 'full', { cache, fetchFn });
    const second = await getImageDataUrl(55144522, 'full', { cache, fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('answers null at once for an artwork YGOPRODeck has no image of (a synthetic id): no request, no cache read', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));

    for (const size of ['full', 'small'] as const) expect(await getImageDataUrl(altArtworkId(15619, 2), size, { cache, fetchFn })).toBeNull();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(cache.match).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('returns null on a 404 and does not cache it', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => new Response(null, { status: 404 }));

    const result = await getImageDataUrl(999, 'small', { cache, fetchFn });

    expect(result).toBeNull();
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('returns null when the fetch itself throws', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    });

    expect(await getImageDataUrl(1, 'full', { cache, fetchFn })).toBeNull();
  });
});

// Security review I3 (the --remote-images build only): the cache used to grow without a bound.
describe('the image cache is capped', () => {
  const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });

  it(`keeps at most ${MAX_CACHED_IMAGES} images, evicting the oldest first`, async () => {
    const urls = Array.from({ length: MAX_CACHED_IMAGES }, (_, i) => imageUrl(i + 1, 'full'));
    const cache = fakeCache(urls);

    await getImageDataUrl(900001, 'full', { cache, fetchFn: vi.fn(async () => jpeg()) });
    await getImageDataUrl(900002, 'small', { cache, fetchFn: vi.fn(async () => jpeg()) });

    expect(cache.store.size).toBe(MAX_CACHED_IMAGES);
    const kept = [...cache.store.keys()];
    expect(kept).not.toContain(urls[0]);
    expect(kept).not.toContain(urls[1]);
    expect(kept.slice(0, 2)).toEqual([urls[2], urls[3]]);
    expect(kept.slice(-2)).toEqual([imageUrl(900001, 'full'), imageUrl(900002, 'small')]);
  });

  it('evicts nothing while under the cap, and never on a cache hit', async () => {
    const cache = fakeCache([imageUrl(1, 'full')]);
    const fetchFn = vi.fn(async () => jpeg());

    await getImageDataUrl(2, 'full', { cache, fetchFn });
    await getImageDataUrl(1, 'full', { cache, fetchFn });

    expect(cache.delete).not.toHaveBeenCalled();
    expect(cache.store.size).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('still answers with the image when trimming the cache fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = fakeCache();
    cache.keys.mockRejectedValue(new Error('cache storage is broken'));

    expect(await getImageDataUrl(3, 'full', { cache, fetchFn: vi.fn(async () => jpeg()) })).toMatch(/^data:image\/jpeg;base64,/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
