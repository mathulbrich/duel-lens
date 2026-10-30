import { beforeEach, describe, expect, it, vi } from 'vitest';
import { altArtworkId } from '../shared/alt-artwork';
import { FAILED_MS, getImageDataUrl, imageUrl, MAX_CACHED_IMAGES, MAX_CONCURRENT_DOWNLOADS, MIN_GAP_MS, NOT_FOUND_MS, resetImageDownloads } from './image-cache';

beforeEach(() => resetImageDownloads());

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

describe('downloads, politely (YGOPRODeck: at most 20 requests a second, each image once)', () => {
  const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200 });
  /** A clock that only moves when the code sleeps. */
  function clock() {
    const c = { t: 1_000_000, sleeps: [] as number[] };
    return { c, now: () => c.t, sleep: async (ms: number) => void (c.sleeps.push(ms), (c.t += ms)) };
  }

  it("uses the browser's fetch as a function, never as some object's method (the browser's throws \"Illegal invocation\" then)", async () => {
    const cache = fakeCache();
    const strictFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jpeg());
    });
    vi.stubGlobal('fetch', strictFetch);
    try {
      expect(await getImageDataUrl(11, 'full', { cache })).toMatch(/^data:image\/jpeg;base64,/);
      expect(strictFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('downloads an image once for everyone asking for it at the same time', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => jpeg());
    const { now, sleep } = clock();
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => getImageDataUrl(7, 'small', { cache, fetchFn, now, sleep })));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(a).toMatch(/^data:image\/jpeg;base64,/);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it(`runs at most ${MAX_CONCURRENT_DOWNLOADS} downloads at once, starting one every ${MIN_GAP_MS} ms at most`, async () => {
    const cache = fakeCache();
    let running = 0;
    let most = 0;
    const starts: number[] = [];
    const fetchFn = vi.fn(async () => {
      starts.push(performance.now());
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 800)); // much slower than the gap: the cap on downloads at once is what holds them
      running--;
      return jpeg();
    });
    await Promise.all(Array.from({ length: 6 }, (_, i) => getImageDataUrl(100 + i, 'small', { cache, fetchFn })));
    expect(fetchFn).toHaveBeenCalledTimes(6);
    expect(most).toBe(MAX_CONCURRENT_DOWNLOADS);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(MIN_GAP_MS - 5);
  });

  it('starts a full image (a card being looked at) before the thumbnails waiting, a board\'s for one', async () => {
    const cache = fakeCache();
    const order: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      order.push(String(url).includes('cards_small') ? 'small' : 'full');
      await new Promise((r) => setTimeout(r, 30));
      return jpeg();
    });
    const board = Array.from({ length: 8 }, (_, i) => getImageDataUrl(200 + i, 'small', { cache, fetchFn, sleep: async () => {} }));
    await new Promise((r) => setTimeout(r, 5)); // the board's first four are under way
    const scanned = getImageDataUrl(300, 'full', { cache, fetchFn, sleep: async () => {} });
    await Promise.all([...board, scanned]);
    expect(order.indexOf('full')).toBe(MAX_CONCURRENT_DOWNLOADS);
  });

  it("doesn't ask again for an image YGOPRODeck hasn't, for an hour", async () => {
    const cache = fakeCache();
    const { c, now, sleep } = clock();
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));
    expect(await getImageDataUrl(8, 'full', { cache, fetchFn, now, sleep })).toBeNull();
    expect(await getImageDataUrl(8, 'full', { cache, fetchFn, now, sleep })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    c.t += NOT_FOUND_MS + 1;
    await getImageDataUrl(8, 'full', { cache, fetchFn, now, sleep });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('tries a 429 or a 5xx again after a pause (Retry-After when given), then gives up for 10 minutes', async () => {
    const cache = fakeCache();
    const { c, now, sleep } = clock();
    const answers = [new Response('', { status: 429, headers: { 'Retry-After': '3' } }), new Response('', { status: 503 }), jpeg()];
    const fetchFn = vi.fn(async () => answers.shift()!);
    expect(await getImageDataUrl(9, 'full', { cache, fetchFn, now, sleep })).toMatch(/^data:image\/jpeg/);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(c.sleeps.filter((ms) => ms >= 1000)).toEqual([3000, 2000]);

    const failing = vi.fn(async () => new Response('', { status: 502 }));
    expect(await getImageDataUrl(10, 'full', { cache, fetchFn: failing, now, sleep })).toBeNull();
    expect(failing).toHaveBeenCalledTimes(3);
    expect(await getImageDataUrl(10, 'full', { cache, fetchFn: failing, now, sleep })).toBeNull();
    expect(failing).toHaveBeenCalledTimes(3);
    c.t += FAILED_MS + 1;
    await getImageDataUrl(10, 'full', { cache, fetchFn: failing, now, sleep });
    expect(failing).toHaveBeenCalledTimes(6);
  });
});
