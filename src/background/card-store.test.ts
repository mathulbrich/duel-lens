import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trimCard, type ApiCard } from '../shared/cards';
import type { CardRecord } from '../shared/types';
import { ensureSeeded, getAllImageIds, getAllNames, getCards, getMeta, openDb, refreshIfChanged } from './card-store';

// Fresh in-memory database for every test, so seeding/refresh tests don't see each other's data.
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

const potOfGreed: CardRecord = {
  id: 55144522,
  name: 'Pot of Greed',
  type: 'Spell Card',
  frameType: 'spell',
  desc: 'Draw 2 cards.',
  race: 'Normal',
  imageIds: [55144522],
};
const darkHole: CardRecord = {
  id: 53129443,
  name: 'Dark Hole',
  type: 'Spell Card',
  frameType: 'spell',
  desc: 'Destroy all monsters on the field.',
  race: 'Normal',
  imageIds: [53129443],
};

function loadBundled(cards: CardRecord[] = [potOfGreed, darkHole]) {
  return vi.fn().mockResolvedValue({ dbVersion: '1.0.0', updatedAt: '2026-01-01T00:00:00.000Z', cards });
}

describe('openDb', () => {
  it('creates the duel-lens database with the expected object stores', async () => {
    const db = await openDb();
    expect(db.name).toBe('duel-lens');
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['cards', 'crops', 'history', 'meta']);
  });
});

describe('ensureSeeded', () => {
  it('writes all cards once, and a second call is a no-op', async () => {
    const load = loadBundled();
    await ensureSeeded(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await getCards([potOfGreed.id, darkHole.id])).toEqual({
      [potOfGreed.id]: potOfGreed,
      [darkHole.id]: darkHole,
    });

    await ensureSeeded(load);
    expect(load).toHaveBeenCalledTimes(1); // not called again: already seeded
    expect(await getMeta()).toMatchObject({ dbVersion: '1.0.0', cardCount: 2 });
  });

  // onboarding-report.md, "Double seeding on first install": onInstalled seeds while the welcome page
  // it opens asks get-status, which seeds too. Both saw an empty store and loaded the 8.6 MB bundle twice.
  it('shares one seed between concurrent callers, so a first install loads the bundled cards once', async () => {
    const load = loadBundled();
    await Promise.all([ensureSeeded(load), ensureSeeded(load), ensureSeeded(load)]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await getMeta()).toMatchObject({ dbVersion: '1.0.0', cardCount: 2 });
  });

  it('tries again after a failed seed, instead of remembering the failure', async () => {
    const failing = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    await expect(ensureSeeded(failing)).rejects.toThrow('quota exceeded');
    const load = loadBundled();
    await ensureSeeded(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await getMeta()).toMatchObject({ cardCount: 2 });
  });
});

describe('getCards', () => {
  it('returns only the known ids, keyed by id', async () => {
    await ensureSeeded(loadBundled());
    const result = await getCards([potOfGreed.id, 999999]);
    expect(result).toEqual({ [potOfGreed.id]: potOfGreed });
  });
});

describe('getAllNames', () => {
  it('lists every card as {id, name}', async () => {
    await ensureSeeded(loadBundled());
    const names = await getAllNames();
    expect(names.sort((a, b) => a.id - b.id)).toEqual(
      [potOfGreed, darkHole].map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.id - b.id),
    );
  });
});

describe('getMeta', () => {
  it('reports dbVersion, updatedAt and the card count', async () => {
    await ensureSeeded(loadBundled());
    expect(await getMeta()).toEqual({ dbVersion: '1.0.0', updatedAt: '2026-01-01T00:00:00.000Z', cardCount: 2 });
  });

  it('reports cardCount 0 before seeding', async () => {
    expect(await getMeta()).toEqual({ cardCount: 0 });
  });
});

describe('getAllImageIds', () => {
  it('lists every artwork id paired with its card id', async () => {
    await ensureSeeded(loadBundled());
    const ids = await getAllImageIds();
    expect(ids.sort((a, b) => a.imageId - b.imageId)).toEqual(
      [potOfGreed, darkHole].map((c) => ({ imageId: c.imageIds[0], cardId: c.id })).sort((a, b) => a.imageId - b.imageId),
    );
  });

  it('lists every alternate artwork of a card, keeping the first card for a shared image id', async () => {
    const altArt: CardRecord = { ...potOfGreed, id: 99999991, imageIds: [potOfGreed.id, 1111] };
    await ensureSeeded(loadBundled([potOfGreed, altArt]));

    const ids = await getAllImageIds();

    expect(ids.sort((a, b) => a.imageId - b.imageId)).toEqual([
      { imageId: 1111, cardId: altArt.id },
      { imageId: potOfGreed.id, cardId: potOfGreed.id }, // first card (potOfGreed) keeps the shared id
    ]);
  });

  it('skips skill cards and the "???" tournament placeholder, like tools/lib/artworks.ts', async () => {
    const skill: CardRecord = { ...potOfGreed, id: 77777, frameType: 'skill', imageIds: [77777] };
    const placeholder: CardRecord = { ...potOfGreed, id: 149694341, imageIds: [149694341] };
    await ensureSeeded(loadBundled([potOfGreed, skill, placeholder]));

    const ids = await getAllImageIds();

    expect(ids).toEqual([{ imageId: potOfGreed.id, cardId: potOfGreed.id }]);
  });

  it('returns an empty list before seeding', async () => {
    expect(await getAllImageIds()).toEqual([]);
  });
});

describe('refreshIfChanged', () => {
  const ashApi: ApiCard = {
    id: 14558127,
    name: 'Ash Blossom & Joyous Spring',
    type: 'Tuner Monster',
    frameType: 'effect',
    desc: 'Negate that effect.',
    race: 'Zombie',
    atk: 0,
    def: 1800,
    level: 3,
    attribute: 'FIRE',
    card_images: [{ id: 14558127 }],
  };
  const potApi: ApiCard = { id: 55144522, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.', race: 'Normal', card_images: [{ id: 55144522 }] };
  /** The Genesys list: the same cards, with `genesys_points` (0 for most). */
  const genesysList = { data: [{ ...ashApi, misc_info: [{ genesys_points: 20 }] }, { ...potApi, misc_info: [{ genesys_points: 0 }] }] };

  /** `genesysBody`: the Genesys list's answer (JSON), a Response as it is, or an Error to throw. */
  function fetchReturning(versionBody: unknown, cardBody?: unknown, genesysBody: unknown = genesysList) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('checkDBVer')) {
        return new Response(JSON.stringify(versionBody), { status: 200 });
      }
      if (url.includes('format=genesys')) {
        if (genesysBody instanceof Error) throw genesysBody;
        return genesysBody instanceof Response ? genesysBody : new Response(JSON.stringify(genesysBody), { status: 200 });
      }
      if (url.includes('cardinfo')) {
        return new Response(JSON.stringify(cardBody), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
  }

  it('returns "unchanged" and never calls cardinfo when the version matches', async () => {
    await ensureSeeded(loadBundled());
    const fetchFn = fetchReturning([{ database_version: '1.0.0' }]);
    const status = await refreshIfChanged(fetchFn as unknown as typeof fetch);
    expect(status).toBe('unchanged');
    const calledUrls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('cardinfo'))).toBe(false);
    expect(await getMeta()).toMatchObject({ dbVersion: '1.0.0', cardCount: 2 });
  });

  it('downloads, trims and replaces the cards on a version change, with their Genesys points, and returns "updated"', async () => {
    await ensureSeeded(loadBundled());
    const fetchFn = fetchReturning([{ database_version: '2.0.0' }], { data: [ashApi] });
    const status = await refreshIfChanged(fetchFn as unknown as typeof fetch);
    expect(status).toBe('updated');
    expect(await getCards([ashApi.id])).toEqual({ [ashApi.id]: { ...trimCard(ashApi), genesysPoints: 20 } });
    expect(await getCards([potOfGreed.id])).toEqual({}); // old data was replaced, not merged
    const meta = await getMeta();
    expect(meta.dbVersion).toBe('2.0.0');
    expect(meta.cardCount).toBe(1);
  });

  // The store build has no host permission for db.ygoprodeck.com: the weekly refresh works because the
  // API answers any origin (Access-Control-Allow-Origin: *, checked 2026-09-29 on checkDBVer.php and
  // cardinfo.php, with and without format=genesys). That holds only for CORS-simple requests: a GET with
  // no custom header (a header such as X-Client would need a preflight) and no credentials ("*" forbids them).
  it('asks with plain GETs only (the URL alone), which the API answers cross-origin without host access', async () => {
    await ensureSeeded(loadBundled());
    const fetchFn = fetchReturning([{ database_version: '2.0.0' }], { data: [ashApi] });
    expect(await refreshIfChanged(fetchFn as unknown as typeof fetch)).toBe('updated');
    expect(fetchFn.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://db.ygoprodeck.com/api/v7/checkDBVer.php',
      'https://db.ygoprodeck.com/api/v7/cardinfo.php?misc=yes',
      'https://db.ygoprodeck.com/api/v7/cardinfo.php?format=genesys&misc=yes',
    ]);
    for (const call of fetchFn.mock.calls) expect(call).toHaveLength(1); // no init: GET, no headers, no credentials
  });

  it('returns "failed" and keeps the old data on a network error', async () => {
    await ensureSeeded(loadBundled());
    const fetchFn = vi.fn().mockRejectedValue(new Error('offline'));
    const status = await refreshIfChanged(fetchFn as unknown as typeof fetch);
    expect(status).toBe('failed');
    expect(await getCards([potOfGreed.id])).toEqual({ [potOfGreed.id]: potOfGreed });
    expect(await getMeta()).toMatchObject({ dbVersion: '1.0.0', cardCount: 2 });
  });

  // Without the Genesys list, the new card list still replaces the old one (it is what the version
  // change was about), and each card keeps the points the store had for it: a failed request never
  // wipes them. It is logged; the next database change tries again.
  describe('without the Genesys points', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each([
      ['a network error', new Error('offline')],
      ['an HTTP error', new Response('Service Unavailable', { status: 503 })],
      ['an answer without a card list', { error: 'No card matching your query was found in the database.' }],
      ['an answer that gives no card any points (a changed format)', { data: [ashApi, potApi] }],
    ])('(%s) still updates the cards, which keep the points stored', async (_, genesysBody) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await ensureSeeded(loadBundled([{ ...potOfGreed, genesysPoints: 30 }, darkHole]));
      const fetchFn = fetchReturning([{ database_version: '2.0.0' }], { data: [ashApi, potApi] }, genesysBody);

      expect(await refreshIfChanged(fetchFn as unknown as typeof fetch)).toBe('updated');

      expect(await getCards([ashApi.id, potApi.id, darkHole.id])).toEqual({
        [ashApi.id]: trimCard(ashApi), // a new card: no points stored for it
        [potApi.id]: { ...trimCard(potApi), genesysPoints: 30 }, // kept
      });
      expect(await getMeta()).toMatchObject({ dbVersion: '2.0.0', cardCount: 2 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not get the Genesys points'), expect.anything());
    });
  });
});

describe('ensureSeeded on a store seeded before Genesys points existed', () => {
  /** The store as an earlier version left it: cards and their database version, no Genesys points. */
  async function earlierStore(cards: CardRecord[]) {
    const db = await openDb();
    const tx = db.transaction(['cards', 'meta'], 'readwrite');
    for (const c of cards) tx.objectStore('cards').put(c);
    tx.objectStore('meta').put('2.0.0', 'dbVersion');
    await new Promise((resolve) => (tx.oncomplete = resolve));
  }

  // After the extension's update: without this, the points would wait for YGOPRODeck's next database change.
  it("copies the bundle's points onto the stored cards once, keeping their other data", async () => {
    const newerPot: CardRecord = { ...potOfGreed, desc: 'Draw 2 cards. (a newer text than the bundle)' };
    await earlierStore([newerPot, darkHole]);
    const load = loadBundled([{ ...potOfGreed, genesysPoints: 30 }, darkHole]);

    await ensureSeeded(load);

    expect(await getCards([potOfGreed.id, darkHole.id])).toEqual({
      [potOfGreed.id]: { ...newerPot, genesysPoints: 30 },
      [darkHole.id]: darkHole,
    });
    expect(await getMeta()).toMatchObject({ dbVersion: '2.0.0', cardCount: 2 });
    await ensureSeeded(load);
    expect(load).toHaveBeenCalledTimes(1); // once: later calls stay a no-op
  });
});
