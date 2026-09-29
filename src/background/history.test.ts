import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '../shared/types';
import { addEntry, clearHistory, getCurrentId, getHistory, getThumb, setCurrent, setThumb, updateEntry } from './history';

/** Minimal chrome.storage.{local,session} fake, promise-based (as MV3 code uses it). */
function fakeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    }),
    keys: () => Object.keys(data),
  };
}

let local: ReturnType<typeof fakeStorageArea>;

beforeEach(() => {
  local = fakeStorageArea();
  vi.stubGlobal('chrome', {
    storage: { local, session: fakeStorageArea() },
  });
});

function entry(id: string, at: number): HistoryEntry {
  return { id, cardId: 1, imageId: 1, score: 0.9, confident: true, at, pageUrl: 'https://x', pageTitle: 't', source: 'screenshot' };
}

describe('addEntry', () => {
  it('adds newest first and caps history at 300', async () => {
    for (let i = 0; i < 305; i++) await addEntry(entry(String(i), i));
    const history = await getHistory();
    expect(history).toHaveLength(300);
    expect(history[0].id).toBe('304'); // newest first
    expect(history.at(-1)?.id).toBe('5'); // the oldest 5 were dropped
  });
});

// live-check p3: nine identical "Synchro Overtake 436:32" rows, from scanning one paused card again and again.
describe('addEntry: the same card again at the same moment of the video', () => {
  const PAGE = 'https://www.youtube.com/watch?v=bBbjafm1u2Q';
  const scan = (id: string, videoTime: number | undefined, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
    ...entry(id, 1000 + (videoTime ?? 0)),
    pageUrl: PAGE,
    source: 'video',
    ...(videoTime === undefined ? {} : { videoTime }),
    ...over,
  });

  it('replaces the previous entry, keeping the newest scan (its time, id and match)', async () => {
    await addEntry(scan('a', 26191, { score: 0.8, confident: false }));
    await addEntry(scan('b', 26192.5, { score: 0.86, at: 5000 }));

    expect(await getHistory()).toEqual([scan('b', 26192.5, { score: 0.86, at: 5000 })]);
  });

  it('merges a whole run of rescans into one entry, within 2 s of video time each (a paused video, or a second or two later)', async () => {
    for (const [i, t] of [26191, 26191, 26191, 26193, 26192, 26194].entries()) await addEntry(scan(`s${i}`, t));

    expect((await getHistory()).map((e) => [e.id, e.videoTime])).toEqual([['s5', 26194]]);
  });

  it("deletes a merged entry's picture (the crop build, --no-remote-images), and keeps the others'", async () => {
    await addEntry(scan('older', 100, { cardId: 7 }));
    await setThumb('older', 'data:image/jpeg;base64,OLDER');
    await addEntry(scan('a', 26191));
    await setThumb('a', 'data:image/jpeg;base64,A');

    await addEntry(scan('b', 26192));
    await setThumb('b', 'data:image/jpeg;base64,B');

    expect((await getHistory()).map((e) => e.id)).toEqual(['b', 'older']);
    expect(local.keys().filter((k) => k.startsWith('thumb:')).sort()).toEqual(['thumb:b', 'thumb:older']);
  });

  it('keeps separate entries for another card, another page, more than 2 s apart, or a scan with no video time', async () => {
    const cases: [string, HistoryEntry, HistoryEntry][] = [
      ['another card', scan('a', 26191), scan('b', 26191, { cardId: 2 })],
      ['another page', scan('a', 26191), scan('b', 26191, { pageUrl: 'https://www.youtube.com/watch?v=other' })],
      ['2.5 s later', scan('a', 26191), scan('b', 26193.5)],
      ['2.5 s earlier', scan('a', 26191), scan('b', 26188.5)],
      ['no video time now', scan('a', 26191), scan('b', undefined, { source: 'screenshot' })],
      ['no video time before', scan('a', undefined, { source: 'screenshot' }), scan('b', 26191)],
      ['two screenshots of one page', scan('a', undefined, { source: 'screenshot' }), scan('b', undefined, { source: 'screenshot' })],
    ];
    for (const [what, first, second] of cases) {
      await clearHistory();
      await addEntry(first);
      await addEntry(second);
      expect((await getHistory()).map((e) => e.id), what).toEqual(['b', 'a']);
    }
  });

  it('merges exactly 2 s apart', async () => {
    await addEntry(scan('a', 26191));
    await addEntry(scan('b', 26193));
    expect((await getHistory()).map((e) => e.id)).toEqual(['b']);
  });

  it('merges only into the newest entry: the same card after another one is a new row', async () => {
    await addEntry(scan('a', 26191));
    await addEntry(scan('other', 26191.5, { cardId: 2 }));
    await addEntry(scan('b', 26192));
    expect((await getHistory()).map((e) => e.id)).toEqual(['b', 'other', 'a']);
  });
});

describe('updateEntry', () => {
  it('merges a patch into the matching entry and returns it', async () => {
    await addEntry(entry('a', 1));
    const updated = await updateEntry('a', { cardId: 42, imageId: 42, corrected: true });
    expect(updated).toMatchObject({ id: 'a', cardId: 42, imageId: 42, corrected: true });
    const [stored] = await getHistory();
    expect(stored).toMatchObject({ cardId: 42, corrected: true });
  });

  it('returns undefined for an unknown id and leaves history untouched', async () => {
    await addEntry(entry('a', 1));
    expect(await updateEntry('missing', { corrected: true })).toBeUndefined();
    expect(await getHistory()).toHaveLength(1);
  });
});

describe('setCurrent / getCurrentId', () => {
  it('round-trips through chrome.storage.session', async () => {
    await setCurrent('a');
    expect(await getCurrentId()).toBe('a');
  });
});

describe('clearHistory', () => {
  it('empties history and clears the current entry', async () => {
    await addEntry(entry('a', 1));
    await setCurrent('a');
    await clearHistory();
    expect(await getHistory()).toEqual([]);
    expect(await getCurrentId()).toBeUndefined();
  });
});

// The crop build (`--no-remote-images`) keeps a small picture of each scan (thumbnail.ts) for the side
// panel, in its own key (thumb:<entry id>): the history list itself stays small, and the side panel
// reads one at a time.
describe('scan thumbnails', () => {
  const THUMB = 'data:image/jpeg;base64,/9j/';

  it('keeps a thumbnail for an entry, and gives it back', async () => {
    await addEntry(entry('a', 1));
    await setThumb('a', THUMB);
    expect(await getThumb('a')).toBe(THUMB);
    expect(await getThumb('b')).toBeUndefined();
  });

  it('keeps none for an entry no longer in the history (cleared while the thumbnail was made)', async () => {
    await setThumb('gone', THUMB);
    expect(await getThumb('gone')).toBeUndefined();
    expect(local.keys()).not.toContain('thumb:gone');
  });

  it("drops an entry's thumbnail with the entry, past the 300 newest", async () => {
    for (let i = 0; i < 300; i++) await addEntry(entry(String(i), i));
    await setThumb('0', THUMB); // the oldest
    await setThumb('299', THUMB);

    await addEntry(entry('300', 300));

    expect(await getThumb('0')).toBeUndefined();
    expect(await getThumb('299')).toBe(THUMB);
    expect(local.keys().filter((k) => k.startsWith('thumb:'))).toEqual(['thumb:299']);
  });

  it('Clear history deletes every thumbnail too', async () => {
    await addEntry(entry('a', 1));
    await addEntry(entry('b', 2));
    await setThumb('a', THUMB);
    await setThumb('b', THUMB);

    await clearHistory();

    expect(local.keys().filter((k) => k.startsWith('thumb:'))).toEqual([]);
  });
});
