import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createIndexUpdater } from '../offscreen/index-updater';
import { altArtworkId } from '../shared/alt-artwork';
import {
  DEFAULT_FAILURE_COOLDOWN_MS,
  STALE_RUN_MS,
  getIndexDeltaCount,
  getIndexUpdateStatus,
  runIndexUpdate,
  runIndexUpdateIfStale,
  type IndexUpdateDeps,
  type IndexUpdateStatus,
} from './index-update';

const NOW = 1_700_000_000_000;

function fakeStorage(initial: Record<string, unknown> = {}) {
  let data: Record<string, unknown> = { ...initial };
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

function jpegResponse(): Response {
  return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
}

/** Builds a full IndexUpdateDeps with fast, deterministic defaults (3 missing artworks,
 * everything succeeds). Individual tests override just what they're exercising. */
function makeDeps(overrides: Partial<IndexUpdateDeps> = {}): IndexUpdateDeps {
  return {
    getAllImageIds: vi.fn().mockResolvedValue([
      { imageId: 1, cardId: 10 },
      { imageId: 2, cardId: 20 },
      { imageId: 3, cardId: 30 },
    ]),
    indexMissing: vi.fn().mockResolvedValue({ missing: [1, 2, 3] }),
    embedArtworks: vi.fn().mockResolvedValue({ added: 1, failed: [] }),
    fetchFn: vi.fn(async () => jpegResponse()),
    now: () => NOW,
    storage: fakeStorage(),
    rateLimitPerSecond: 1000, // fast by default; the dedicated rate-limit test overrides this
    ...overrides,
  };
}

const statusOf = async (deps: IndexUpdateDeps) => (await deps.storage.get('indexUpdate')).indexUpdate as IndexUpdateStatus | undefined;
const failuresOf = async (deps: IndexUpdateDeps) =>
  (await deps.storage.get('indexUpdateFailures')).indexUpdateFailures as Record<string, { at: number; error: string }> | undefined;
const urlsFetched = (deps: IndexUpdateDeps) => (deps.fetchFn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));

describe("runIndexUpdate: the bundled index's extra artworks (synthetic ids: Konami's artworks YGOPRODeck lacks)", () => {
  const alt = altArtworkId(15619, 2);

  it('keeps them and never fetches them: with the offscreen half, only YGOPRODeck ids are asked about and downloaded', async () => {
    const offscreen = createIndexUpdater({
      modelId: 'm1',
      loadIndexMeta: async () => ({
        entries: [
          { imageId: 1, cardId: 10 },
          { imageId: alt, cardId: 10, source: 'konami', konamiId: 15619, artwork: 2 },
        ],
      }),
      loadDelta: async () => [],
      loadEmbedding: () => Promise.reject(new Error('not used')),
      decode: () => Promise.reject(new Error('not used')),
    });
    const indexMissing = vi.fn((imageIds: number[]) => offscreen.handle({ target: 'offscreen', type: 'index-missing', imageIds }) as Promise<{ missing: number[] }>);
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([
        { imageId: 1, cardId: 10 },
        { imageId: 2, cardId: 20 },
      ]),
      indexMissing,
    });

    await runIndexUpdate(deps);

    expect(indexMissing).toHaveBeenCalledWith([1, 2]);
    expect(urlsFetched(deps)).toEqual(['https://images.ygoprodeck.com/images/cards_cropped/2.jpg']);
    expect(await statusOf(deps)).toEqual({ state: 'idle', lastRun: NOW });
  });

  it('never downloads a synthetic id, even one reported missing and listed with a card', async () => {
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([
        { imageId: 1, cardId: 10 },
        { imageId: alt, cardId: 10 },
      ]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [1, alt] }),
    });

    await runIndexUpdate(deps);

    expect(urlsFetched(deps)).toEqual(['https://images.ygoprodeck.com/images/cards_cropped/1.jpg']);
    expect(urlsFetched(deps).some((u) => u.includes(String(alt)))).toBe(false);
  });
});

describe('runIndexUpdate: ordering', () => {
  it('collects ids, asks what is missing, downloads, then embeds - flushing a chunk as soon as it fills', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      chunkSize: 2,
      getAllImageIds: vi.fn(async () => {
        calls.push('getAllImageIds');
        return [
          { imageId: 1, cardId: 10 },
          { imageId: 2, cardId: 20 },
          { imageId: 3, cardId: 30 },
        ];
      }),
      indexMissing: vi.fn(async (ids: number[]) => {
        calls.push(`indexMissing:${ids.join(',')}`);
        return { missing: [1, 2, 3] };
      }),
      fetchFn: vi.fn(async (url: string | URL | Request) => {
        calls.push(`download:${String(url).match(/(\d+)\.jpg/)?.[1]}`);
        return jpegResponse();
      }),
      embedArtworks: vi.fn(async (items: { imageId: number }[]) => {
        calls.push(`embed:${items.map((i) => i.imageId).join(',')}`);
        return { added: items.length, failed: [] };
      }),
    });

    await runIndexUpdate(deps);

    expect(calls).toEqual([
      'getAllImageIds',
      'indexMissing:1,2,3',
      'download:1',
      'download:2',
      'embed:1,2', // the first chunk of 2 flushes the moment it fills
      'download:3',
      'embed:3', // the trailing partial chunk flushes at the end of the run
    ]);
  });

  it('marks the run idle with a lastRun timestamp when it completes', async () => {
    const deps = makeDeps();
    await runIndexUpdate(deps);
    expect(await statusOf(deps)).toEqual({ state: 'idle', lastRun: NOW });
  });

  it('downloads each missing artwork\'s cards_cropped URL exactly once', async () => {
    const deps = makeDeps();
    await runIndexUpdate(deps);
    const urls = urlsFetched(deps);
    expect(urls.sort()).toEqual([
      'https://images.ygoprodeck.com/images/cards_cropped/1.jpg',
      'https://images.ygoprodeck.com/images/cards_cropped/2.jpg',
      'https://images.ygoprodeck.com/images/cards_cropped/3.jpg',
    ]);
  });
});

describe('runIndexUpdate: rate limiting', () => {
  it('paces downloads at the configured rate, shared across the whole run', async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      const deps = makeDeps({
        rateLimitPerSecond: 4,
        chunkSize: 100,
        getAllImageIds: vi.fn().mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ imageId: i + 1, cardId: i + 1 }))),
        indexMissing: vi.fn().mockResolvedValue({ missing: Array.from({ length: 8 }, (_, i) => i + 1) }),
        fetchFn: vi.fn(async () => {
          fetches++;
          return jpegResponse();
        }),
      });

      const run = runIndexUpdate(deps);
      await vi.advanceTimersByTimeAsync(1400);
      expect(fetches).toBeLessThan(8);
      await vi.advanceTimersByTimeAsync(1000);
      await run;
      expect(fetches).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runIndexUpdate: failure handling', () => {
  it('skips a 404 without retrying it, and records the failure', async () => {
    const deps = makeDeps({ fetchFn: vi.fn(async () => new Response('', { status: 404 })) });

    await runIndexUpdate(deps);

    expect(deps.fetchFn).toHaveBeenCalledTimes(3); // one attempt per missing id, no retries for a 404
    const failures = await failuresOf(deps);
    expect(Object.keys(failures ?? {}).sort()).toEqual(['1', '2', '3']);
    expect(failures?.['1'].error).toMatch(/404/);
    // A per-item failure doesn't fail the run itself.
    expect(await statusOf(deps)).toEqual({ state: 'idle', lastRun: NOW });
  });

  it('retries a transient (5xx) failure with doubling backoff before succeeding', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const deps = makeDeps({
        getAllImageIds: vi.fn().mockResolvedValue([{ imageId: 1, cardId: 10 }]),
        indexMissing: vi.fn().mockResolvedValue({ missing: [1] }),
        fetchFn: vi.fn(async () => {
          attempt++;
          return attempt <= 3 ? new Response('', { status: 503 }) : jpegResponse();
        }),
      });

      const run = runIndexUpdate(deps);
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100); // 1s, 2s, 4s doubling backoff
      await run;

      expect(attempt).toBe(4); // three failures, then one success, all for the same artwork
      expect(await statusOf(deps)).toMatchObject({ state: 'idle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on a persistent 5xx for this run only: no cooldown, the next run tries again', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deps = makeDeps({
        getAllImageIds: vi.fn().mockResolvedValue([{ imageId: 1, cardId: 10 }]),
        indexMissing: vi.fn().mockResolvedValue({ missing: [1] }),
        fetchFn: vi.fn(async () => new Response('', { status: 500 })),
      });

      let run = runIndexUpdate(deps);
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);
      await run;
      expect(deps.fetchFn).toHaveBeenCalledTimes(4);
      expect((await failuresOf(deps))?.['1']).toBeUndefined();

      run = runIndexUpdate(deps);
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);
      await run;
      expect(deps.fetchFn).toHaveBeenCalledTimes(8);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('puts only a 404 on the 7-day cooldown: the next run skips it', async () => {
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([{ imageId: 1, cardId: 10 }]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [1] }),
      fetchFn: vi.fn(async () => new Response('', { status: 404 })),
    });
    await runIndexUpdate(deps);
    await runIndexUpdate(deps);
    expect(deps.fetchFn).toHaveBeenCalledTimes(1);
    expect((await failuresOf(deps))?.['1']).toMatchObject({ at: NOW, error: 'HTTP 404' });
  });

  it('retries a network error on the next run', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let online = false;
      const deps = makeDeps({
        getAllImageIds: vi.fn().mockResolvedValue([{ imageId: 1, cardId: 10 }]),
        indexMissing: vi.fn().mockResolvedValue({ missing: [1] }),
        fetchFn: vi.fn(async () => {
          if (!online) throw new TypeError('Failed to fetch');
          return jpegResponse();
        }),
      });
      const run = runIndexUpdate(deps);
      await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 100);
      await run;
      expect(deps.embedArtworks).not.toHaveBeenCalled();

      online = true; // e.g. onStartup fired before Wi-Fi reconnected
      await runIndexUpdate(deps);
      expect(deps.embedArtworks).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("lets 'Update now' retry earlier transient failures at once, while a 404 keeps its cooldown", async () => {
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([
        { imageId: 1, cardId: 10 },
        { imageId: 2, cardId: 20 },
      ]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [1, 2] }),
    });
    // Recorded a second ago, by a run under the old rule that put every failure on cooldown.
    await deps.storage.set({
      indexUpdateFailures: { '1': { at: NOW - 1000, error: 'HTTP 503' }, '2': { at: NOW - 1000, error: 'HTTP 404' } },
    });

    await runIndexUpdate(deps); // what the router's 'update-index' runs

    const urls = urlsFetched(deps);
    expect(urls.some((u) => u.includes('/1.jpg'))).toBe(true);
    expect(urls.some((u) => u.includes('/2.jpg'))).toBe(false);
    expect(Object.keys((await failuresOf(deps)) ?? {})).toEqual(['2']);
  });

  it('does not retry an id whose failure is still within the cooldown from a previous run', async () => {
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([
        { imageId: 1, cardId: 10 },
        { imageId: 2, cardId: 20 },
      ]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [1, 2] }),
    });
    await deps.storage.set({ indexUpdateFailures: { '1': { at: NOW - 1000, error: 'HTTP 404' } } });

    await runIndexUpdate(deps);

    const urls = urlsFetched(deps);
    expect(urls.some((u) => u.includes('/1.jpg'))).toBe(false); // skipped: failed 1s ago, well within the cooldown
    expect(urls.some((u) => u.includes('/2.jpg'))).toBe(true);
    // The still-fresh failure is preserved across the run, not dropped.
    expect((await failuresOf(deps))?.['1']).toEqual({ at: NOW - 1000, error: 'HTTP 404' });
  });

  it('retries an id again once its failure cooldown has expired', async () => {
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([{ imageId: 1, cardId: 10 }]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [1] }),
    });
    await deps.storage.set({ indexUpdateFailures: { '1': { at: NOW - DEFAULT_FAILURE_COOLDOWN_MS - 1, error: 'HTTP 404' } } });

    await runIndexUpdate(deps);

    expect(urlsFetched(deps).some((u) => u.includes('/1.jpg'))).toBe(true);
    expect(await failuresOf(deps)).toEqual({}); // the old entry aged out, and this attempt succeeded
  });

  it('does not fail the run over an artwork the offscreen document failed to embed, and retries it next run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = makeDeps({
      getAllImageIds: vi.fn().mockResolvedValue([
        { imageId: 1, cardId: 10 },
        { imageId: 2, cardId: 20 },
      ]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [1, 2] }),
      embedArtworks: vi.fn().mockResolvedValue({ added: 1, failed: [{ imageId: 2, error: 'decode failed' }] }),
    });

    await runIndexUpdate(deps);

    expect(await statusOf(deps)).toEqual({ state: 'idle', lastRun: NOW });
    expect((await failuresOf(deps))?.['2']).toBeUndefined(); // no cooldown for an embed failure
    (deps.indexMissing as ReturnType<typeof vi.fn>).mockResolvedValue({ missing: [2] });
    await runIndexUpdate(deps);
    expect(urlsFetched(deps).filter((u) => u.includes('/2.jpg'))).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("marks the run failed with the offscreen document's own error when it can't check its index, and downloads nothing", async () => {
    const error = "Duel Lens couldn't check which artworks its index is missing (data/index-m.meta.json is missing from the extension)";
    const deps = makeDeps({ indexMissing: vi.fn().mockResolvedValue({ missing: [], error }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runIndexUpdate(deps);

    expect(await statusOf(deps)).toEqual({ state: 'failed', error });
    expect(deps.fetchFn).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("stops the run and marks it failed when the offscreen document can't embed at all (its model can't load)", async () => {
    const error = "Duel Lens couldn't add new artworks to its index (no WebAssembly)";
    const ids = [1, 2, 3, 4, 5];
    const deps = makeDeps({
      chunkSize: 2,
      getAllImageIds: vi.fn().mockResolvedValue(ids.map((imageId) => ({ imageId, cardId: imageId * 10 }))),
      indexMissing: vi.fn().mockResolvedValue({ missing: ids }),
      embedArtworks: vi.fn(async (items: { imageId: number }[]) => ({
        added: 0,
        failed: items.map((i) => ({ imageId: i.imageId, error: 'no WebAssembly' })),
        error,
      })),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runIndexUpdate(deps);

    expect(await statusOf(deps)).toEqual({ state: 'failed', error });
    expect(deps.embedArtworks).toHaveBeenCalledTimes(1);
    expect(urlsFetched(deps)).toHaveLength(2); // no more downloads once the first chunk said so
    expect(await failuresOf(deps)).toBeUndefined(); // nothing put on a cooldown: the next run retries them all
    vi.restoreAllMocks();
  });

  it("records an artwork that is still YGOPRODeck's card-back placeholder as not available yet, skips it for 7 days, then retries it", async () => {
    let now = NOW;
    const deps = makeDeps({
      now: () => now,
      getAllImageIds: vi.fn().mockResolvedValue([{ imageId: 100460002, cardId: 100460002 }]),
      indexMissing: vi.fn().mockResolvedValue({ missing: [100460002] }),
      embedArtworks: vi.fn().mockResolvedValue({ added: 0, failed: [], placeholders: [100460002] }),
    });

    await runIndexUpdate(deps);
    expect((await failuresOf(deps))?.['100460002']).toEqual({ at: NOW, error: 'art not available yet', placeholder: true });
    expect(await statusOf(deps)).toEqual({ state: 'idle', lastRun: NOW });

    now = NOW + DEFAULT_FAILURE_COOLDOWN_MS - 1;
    await runIndexUpdate(deps);
    expect(urlsFetched(deps)).toHaveLength(1); // still on its cooldown

    now = NOW + DEFAULT_FAILURE_COOLDOWN_MS + 1;
    await runIndexUpdate(deps);
    expect(urlsFetched(deps)).toHaveLength(2); // a week later: tried again
  });

  it('marks the run itself failed (not just one item) when something upstream throws', async () => {
    const deps = makeDeps({ indexMissing: vi.fn().mockRejectedValue(new Error('offscreen document crashed')) });

    await expect(runIndexUpdate(deps)).resolves.toBeUndefined(); // never throws

    expect(await statusOf(deps)).toEqual({ state: 'failed', error: 'offscreen document crashed' });
  });
});

describe('runIndexUpdate: resuming after a partial run', () => {
  it('only downloads/embeds what index-missing still reports missing (already-embedded items are skipped)', async () => {
    const deps = makeDeps({
      // Simulates a previous run that embedded id 1 before being interrupted: the live index
      // (bundled + delta) the offscreen document checks against already covers it.
      indexMissing: vi.fn().mockResolvedValue({ missing: [2, 3] }),
    });

    await runIndexUpdate(deps);

    const urls = urlsFetched(deps);
    expect(urls.some((u) => u.includes('/1.jpg'))).toBe(false);
    expect(urls.some((u) => u.includes('/2.jpg'))).toBe(true);
    expect(urls.some((u) => u.includes('/3.jpg'))).toBe(true);
  });

  it('starts a fresh run even if storage was left saying "running" by a worker that died mid-run', async () => {
    const deps = makeDeps();
    await deps.storage.set({ indexUpdate: { state: 'running', pending: 2 } satisfies IndexUpdateStatus });

    await runIndexUpdate(deps);

    expect(await statusOf(deps)).toEqual({ state: 'idle', lastRun: NOW });
  });

  it('persists a shrinking pending count as chunks complete, for a mid-run status read', async () => {
    const pendingSeen: (number | undefined)[] = [];
    const set = vi.fn(async (items: Record<string, unknown>) => {
      const status = items.indexUpdate as IndexUpdateStatus | undefined;
      if (status?.state === 'running') pendingSeen.push(status.pending);
    });
    const deps = makeDeps({ chunkSize: 1, storage: { get: vi.fn().mockResolvedValue({}), set } });

    await runIndexUpdate(deps);

    expect(pendingSeen).toEqual([undefined, 3, 2, 1, 0]);
  });
});

describe('runIndexUpdate: join-in-flight', () => {
  it('a second call while a run is in progress joins it rather than starting a duplicate', async () => {
    let release!: () => void;
    const deps = makeDeps({
      getAllImageIds: vi.fn(
        () =>
          new Promise<{ imageId: number; cardId: number }[]>((resolve) => {
            release = () => resolve([{ imageId: 1, cardId: 10 }]);
          }),
      ),
    });

    const first = runIndexUpdate(deps);
    const second = runIndexUpdate(deps);
    await vi.waitFor(() => expect(deps.getAllImageIds).toHaveBeenCalled());
    release();
    await Promise.all([first, second]);

    expect(deps.getAllImageIds).toHaveBeenCalledTimes(1);
  });

  it('a call after the previous run finished starts an independent new run', async () => {
    const deps = makeDeps();
    await runIndexUpdate(deps);
    await runIndexUpdate(deps);
    expect(deps.getAllImageIds).toHaveBeenCalledTimes(2);
  });
});

describe('getIndexUpdateStatus', () => {
  it('defaults to idle when nothing has ever been stored', async () => {
    const deps = makeDeps();
    expect(await getIndexUpdateStatus(deps)).toEqual({ state: 'idle' });
  });

  it('returns whatever status was last persisted', async () => {
    const deps = makeDeps();
    await deps.storage.set({ indexUpdate: { state: 'failed', error: 'boom' } });
    expect(await getIndexUpdateStatus(deps)).toEqual({ state: 'failed', error: 'boom' });
  });

  it('falls back to idle instead of throwing when storage itself fails', async () => {
    const deps = makeDeps({ storage: { get: vi.fn().mockRejectedValue(new Error('quota')), set: vi.fn() } });
    expect(await getIndexUpdateStatus(deps)).toEqual({ state: 'idle' });
  });
});

describe('runIndexUpdateIfStale', () => {
  it('runs when there is no recorded last run (first run after install)', async () => {
    const deps = makeDeps();
    await runIndexUpdateIfStale(deps);
    expect(deps.getAllImageIds).toHaveBeenCalledTimes(1);
  });

  it('runs when the last run was longer ago than the stale window', async () => {
    const deps = makeDeps();
    await deps.storage.set({ indexUpdate: { state: 'idle', lastRun: NOW - STALE_RUN_MS - 1 } });
    await runIndexUpdateIfStale(deps);
    expect(deps.getAllImageIds).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the last run was recent', async () => {
    const deps = makeDeps();
    await deps.storage.set({ indexUpdate: { state: 'idle', lastRun: NOW - 1000 } });
    await runIndexUpdateIfStale(deps);
    expect(deps.getAllImageIds).not.toHaveBeenCalled();
  });
});

describe('getIndexDeltaCount', () => {
  beforeEach(() => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  });

  it('is 0 before anything has ever been embedded on this computer', async () => {
    expect(await getIndexDeltaCount('m1')).toBe(0);
  });

  it('counts entries written by the offscreen document\'s delta-index module for the given model only', async () => {
    // Written through the real offscreen module, so this doubles as a check that the two
    // schemas (this reader's and src/offscreen/delta-index.ts's) actually stay compatible.
    const { appendDelta } = await import('../offscreen/delta-index');
    await appendDelta('m1', [
      { modelId: 'm1', imageId: 1, cardId: 10, vector: Int8Array.from([1]) },
      { modelId: 'm1', imageId: 2, cardId: 20, vector: Int8Array.from([1]) },
    ]);
    await appendDelta('m2', [{ modelId: 'm2', imageId: 3, cardId: 30, vector: Int8Array.from([1]) }]);

    expect(await getIndexDeltaCount('m1')).toBe(2);
    expect(await getIndexDeltaCount('m2')).toBe(1);
    expect(await getIndexDeltaCount('m3')).toBe(0);
  });
});
