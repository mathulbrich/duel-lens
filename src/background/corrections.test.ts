import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Candidate } from '../shared/types';
import { clearCorrections, clearStaged, countCorrections, getAllCorrections, maybeSaveCorrection, openDb, stage } from './corrections';

// Fresh in-memory database and staging map for every test, so one test's data never leaks into another's.
beforeEach(() => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  clearStaged();
});

const topGuess: Candidate[] = [
  { cardId: 1, imageId: 1, score: 0.72 },
  { cardId: 2, imageId: 2, score: 0.65 },
  { cardId: 3, imageId: 3, score: 0.6 },
];

describe('openDb', () => {
  it('creates the duel-lens-corrections database with the corrections store (indexed by `at`) and a meta store', async () => {
    const db = await openDb();
    expect(db.name).toBe('duel-lens-corrections');
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['corrections', 'meta']);
    const tx = db.transaction('corrections', 'readonly');
    expect(Array.from(tx.objectStore('corrections').indexNames)).toEqual(['by_at']);
  });
});

describe('stage + maybeSaveCorrection', () => {
  it('saves nothing for an entry that was never staged (a worker restart, or a scan from before this feature)', async () => {
    await maybeSaveCorrection('never-staged', 2, 2, true);
    expect(await getAllCorrections()).toEqual([]);
  });

  it('saves nothing when the setting is off, even though something was staged', async () => {
    stage('e1', { dataUrl: 'data:image/png;base64,AAA', candidates: topGuess, modelId: 'dinov2-small-duel-v3b' });
    await maybeSaveCorrection('e1', 2, 2, false);
    expect(await getAllCorrections()).toEqual([]);
  });

  it('saves nothing when the picked card is the engine\'s own top guess (not a correction)', async () => {
    stage('e1', { dataUrl: 'data:image/png;base64,AAA', candidates: topGuess, modelId: 'dinov2-small-duel-v3b' });
    await maybeSaveCorrection('e1', 1, 1, true);
    expect(await getAllCorrections()).toEqual([]);
  });

  // Review fix 4: switching back to the engine's own top guess must not leave a stale "wrong" label.
  describe('re-confirming the engine\'s own top guess after an earlier correction', () => {
    it('removes the previously-saved correction for that entry', async () => {
      stage('e1', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
      await maybeSaveCorrection('e1', 2, 2, true); // wrong guess saved
      expect(await countCorrections()).toBe(1);

      await maybeSaveCorrection('e1', 1, 1, true); // the user changes their mind back to card 1 (the top guess)

      expect(await countCorrections()).toBe(0);
      expect(await getAllCorrections()).toEqual([]);
    });

    it('removes it even when the setting is currently off (cleanup, not a new save)', async () => {
      stage('e1', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
      await maybeSaveCorrection('e1', 2, 2, true);

      await maybeSaveCorrection('e1', 1, 1, false);

      expect(await countCorrections()).toBe(0);
    });

    it('leaves other entries alone', async () => {
      stage('e1', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
      stage('e2', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
      await maybeSaveCorrection('e1', 2, 2, true);
      await maybeSaveCorrection('e2', 3, 3, true);

      await maybeSaveCorrection('e1', 1, 1, true); // only e1 is re-confirmed

      const all = await getAllCorrections();
      expect(all.map((r) => r.entryId)).toEqual(['e2']);
    });
  });

  it('saves the crop, the pick, the top-5 and the model id when the pick differs from the top guess', async () => {
    stage('e1', { dataUrl: 'data:image/png;base64,AAA', candidates: topGuess, modelId: 'dinov2-small-duel-v3b' });
    await maybeSaveCorrection('e1', 2, 99, true);

    const all = await getAllCorrections();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      entryId: 'e1',
      dataUrl: 'data:image/png;base64,AAA',
      cardId: 2,
      imageId: 99,
      topCandidates: topGuess,
      modelId: 'dinov2-small-duel-v3b',
    });
    expect(typeof all[0].at).toBe('number');
  });

  it('keeps at most the top 5 candidates, even when the engine returned more', async () => {
    const many: Candidate[] = Array.from({ length: 10 }, (_, i) => ({ cardId: i + 1, imageId: i + 1, score: 1 - i / 10 }));
    stage('e1', { dataUrl: 'data:image/png;base64,AAA', candidates: many, modelId: 'm' });
    await maybeSaveCorrection('e1', 2, 2, true);

    const [record] = await getAllCorrections();
    expect(record.topCandidates).toHaveLength(5);
  });

  it('overwrites the same entry on a second correction, instead of keeping both', async () => {
    stage('e1', { dataUrl: 'data:image/png;base64,AAA', candidates: topGuess, modelId: 'm' });
    await maybeSaveCorrection('e1', 2, 2, true);
    await maybeSaveCorrection('e1', 3, 3, true); // the user changed their mind

    const all = await getAllCorrections();
    expect(all).toHaveLength(1);
    expect(all[0].cardId).toBe(3);
  });

  it('caps the store at the latest 500, dropping the oldest by time', async () => {
    for (let i = 0; i < 501; i++) {
      stage(`e${i}`, { dataUrl: 'data:image/png;base64,AAA', candidates: topGuess, modelId: 'm' });
      // Distinct `at` values: fake-indexeddb runs fast enough that Date.now() alone could tie.
      const db = await openDb();
      const tx = db.transaction('corrections', 'readwrite');
      tx.objectStore('corrections').put({
        entryId: `e${i}`,
        dataUrl: 'd',
        cardId: 2,
        imageId: 2,
        topCandidates: topGuess,
        modelId: 'm',
        at: i,
      });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
    // One more correction, through the real path, to trigger the cap.
    stage('e-latest', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
    await maybeSaveCorrection('e-latest', 2, 2, true);

    expect(await countCorrections()).toBe(500);
    const all = await getAllCorrections();
    expect(all.some((r) => r.entryId === 'e0')).toBe(false); // the oldest was dropped
    expect(all.some((r) => r.entryId === 'e-latest')).toBe(true); // the newest survives
  });
});

// Review fix 3: a total-size cap besides the count, and dropping the oldest without loading every
// record's image first (an ascending cursor on the `by_at` index, stopping as soon as both caps are
// satisfied, instead of getAll()).
describe('maybeSaveCorrection: total-size cap (~50 MB)', () => {
  it('drops the oldest once the total size would exceed the cap, even though the count is far under 500', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024); // 9 MB each: 6 of them cross 50 MB, nowhere near the count cap
    for (let i = 0; i < 6; i++) {
      stage(`e${i}`, { dataUrl: big, candidates: topGuess, modelId: 'm' });
      await maybeSaveCorrection(`e${i}`, 2, 2, true);
    }

    const all = await getAllCorrections();
    expect(all.length).toBeLessThan(6); // the size cap dropped at least one before reaching 500
    expect(all.some((r) => r.entryId === 'e0')).toBe(false); // the oldest was dropped
    expect(all.some((r) => r.entryId === 'e5')).toBe(true); // the newest survives
  });

  it('frees space when a correction is removed (re-confirming the top guess), so later saves see it', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    for (let i = 0; i < 5; i++) {
      stage(`e${i}`, { dataUrl: big, candidates: topGuess, modelId: 'm' });
      await maybeSaveCorrection(`e${i}`, 2, 2, true);
    }
    expect(await countCorrections()).toBe(5); // 45 MB: under the 50 MB cap, nothing dropped yet

    // Freeing e0's ~9 MB (back to the engine's own top guess) means the next save doesn't need to
    // drop e1 (the next-oldest) to stay under the cap.
    stage('e0', { dataUrl: big, candidates: topGuess, modelId: 'm' }); // re-stage (the in-memory map keeps the original anyway)
    await maybeSaveCorrection('e0', 1, 1, true); // back to the top guess: removes e0's record

    stage('e5', { dataUrl: big, candidates: topGuess, modelId: 'm' });
    await maybeSaveCorrection('e5', 2, 2, true);

    const all = await getAllCorrections();
    expect(all.map((r) => r.entryId).sort()).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});

describe('countCorrections / clearCorrections', () => {
  it('counts what is saved, and clears it all on "Delete all"', async () => {
    stage('e1', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
    stage('e2', { dataUrl: 'd', candidates: topGuess, modelId: 'm' });
    await maybeSaveCorrection('e1', 2, 2, true);
    await maybeSaveCorrection('e2', 3, 3, true);
    expect(await countCorrections()).toBe(2);

    await clearCorrections();
    expect(await countCorrections()).toBe(0);
    expect(await getAllCorrections()).toEqual([]);
  });

  it('also resets the total-size tracking, so a save right after is not capped by stale leftover size', async () => {
    const big = 'x'.repeat(9 * 1024 * 1024);
    for (let i = 0; i < 5; i++) {
      stage(`e${i}`, { dataUrl: big, candidates: topGuess, modelId: 'm' });
      await maybeSaveCorrection(`e${i}`, 2, 2, true);
    }
    await clearCorrections();

    stage('e-new', { dataUrl: big, candidates: topGuess, modelId: 'm' });
    await maybeSaveCorrection('e-new', 2, 2, true);

    expect(await getAllCorrections()).toHaveLength(1);
  });
});
