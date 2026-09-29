import { describe, expect, it, vi } from 'vitest';
import type { RecognizeResponse } from '../shared/messages';
import { DEFAULT_MODEL_ID } from '../shared/models';
import { CARD_BACK_ID, DEFAULT_SETTINGS, type CardRecord, type CropPayload, type RecognitionResult } from '../shared/types';
import { handleMessage, type RouterDeps } from './router';

function makeDeps(overrides: {
  cardStore?: Partial<RouterDeps['cardStore']>;
  imageCache?: Partial<RouterDeps['imageCache']>;
  history?: Partial<RouterDeps['history']>;
  offscreen?: Partial<RouterDeps['offscreen']>;
  indexUpdate?: Partial<RouterDeps['indexUpdate']>;
  ai?: Partial<RouterDeps['ai']>;
  settings?: Partial<RouterDeps['settings']>;
  crops?: Partial<RouterDeps['crops']>;
  sidePanel?: Partial<RouterDeps['sidePanel']>;
  openOptionsPage?: RouterDeps['openOptionsPage'];
  anthropicClient?: RouterDeps['anthropicClient'];
  permissions?: Partial<RouterDeps['permissions']>;
  consent?: Partial<RouterDeps['consent']>;
  remoteImages?: RouterDeps['remoteImages'];
  thumbnail?: RouterDeps['thumbnail'];
  now?: RouterDeps['now'];
  newId?: RouterDeps['newId'];
} = {}): RouterDeps {
  return {
    cardStore: {
      getCards: vi.fn().mockResolvedValue({}),
      getAllNames: vi.fn().mockResolvedValue([]),
      getMeta: vi.fn().mockResolvedValue({ cardCount: 0 }),
      refreshIfChanged: vi.fn().mockResolvedValue('unchanged'),
      ensureSeeded: vi.fn().mockResolvedValue(undefined),
      ...overrides.cardStore,
    },
    imageCache: { getImageDataUrl: vi.fn().mockResolvedValue(null), ...overrides.imageCache },
    history: {
      addEntry: vi.fn().mockResolvedValue(undefined),
      updateEntry: vi.fn().mockResolvedValue(undefined),
      setCurrent: vi.fn().mockResolvedValue(undefined),
      setThumb: vi.fn().mockResolvedValue(undefined),
      ...overrides.history,
    },
    offscreen: { recognize: vi.fn(), ...overrides.offscreen },
    indexUpdate: {
      run: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
      getDeltaCount: vi.fn().mockResolvedValue(0),
      ...overrides.indexUpdate,
    },
    ai: { identify: vi.fn(), test: vi.fn(), ...overrides.ai },
    settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), ...overrides.settings },
    crops: { save: vi.fn().mockResolvedValue(undefined), relabel: vi.fn().mockResolvedValue(undefined), ...overrides.crops },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined), ...overrides.sidePanel },
    openOptionsPage: overrides.openOptionsPage ?? vi.fn().mockResolvedValue(undefined),
    anthropicClient: overrides.anthropicClient ?? vi.fn().mockReturnValue({ messages: { create: vi.fn() } }),
    permissions: { hasAnthropic: vi.fn().mockResolvedValue(true), ...overrides.permissions },
    consent: { grant: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(undefined), ...overrides.consent },
    remoteImages: overrides.remoteImages ?? true,
    thumbnail: overrides.thumbnail ?? vi.fn().mockResolvedValue('data:image/jpeg;base64,THUMB'),
    now: overrides.now ?? (() => 1700000000000),
    newId: overrides.newId ?? (() => 'entry-1'),
  };
}

const crop: CropPayload = { dataUrl: 'data:image/png;base64,x', width: 10, height: 10, source: 'screenshot' };
const sender = {} as chrome.runtime.MessageSender;

function card(id: number, name: string): CardRecord {
  return { id, name, type: 'Spell Card', frameType: 'spell', desc: '', imageIds: [id] };
}

describe('recognize', () => {
  it('forwards the crop to offscreen, loads candidate cards, and records history', async () => {
    const result: RecognitionResult = {
      candidates: [
        { cardId: 1, imageId: 1, score: 0.9 },
        { cardId: 2, imageId: 2, score: 0.5 },
      ],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const cards = { 1: card(1, 'A'), 2: card(2, 'B') };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue(cards) },
    });

    const response = await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    );

    expect(deps.offscreen.recognize).toHaveBeenCalledWith(crop);
    expect(deps.cardStore.getCards).toHaveBeenCalledWith([1, 2]);
    expect(deps.history.addEntry).toHaveBeenCalledTimes(1);
    expect(deps.history.setCurrent).toHaveBeenCalledWith('entry-1');
    expect(response).toEqual({
      result,
      cards,
      entry: {
        id: 'entry-1',
        cardId: 1,
        imageId: 1,
        score: 0.9,
        confident: true,
        at: 1700000000000,
        pageUrl: 'https://x',
        pageTitle: 't',
        source: 'screenshot',
      },
      aiEnabled: false, // makeDeps' default settings.get() resolves DEFAULT_SETTINGS (ai.enabled: false)
    });
  });

  describe('aiEnabled', () => {
    it('is true when the AI check is enabled, a key is saved and the permission granted (makeDeps: granted)', async () => {
      const deps = makeDeps({
        offscreen: { recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }) },
        settings: { get: vi.fn().mockResolvedValue({ ai: { enabled: true, apiKey: 'sk-test', model: 'claude-opus-5' }, debug: { saveCrops: false } }) },
      });

      const response = (await handleMessage(
        { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
        sender,
        deps,
      )) as RecognizeResponse;

      expect(response.aiEnabled).toBe(true);
    });

    it('is false when the AI check is enabled but no key is saved', async () => {
      const deps = makeDeps({
        offscreen: { recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }) },
        settings: { get: vi.fn().mockResolvedValue({ ai: { enabled: true, apiKey: '', model: 'claude-opus-5' }, debug: { saveCrops: false } }) },
      });

      const response = (await handleMessage(
        { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
        sender,
        deps,
      )) as RecognizeResponse;

      expect(response.aiEnabled).toBe(false);
    });

    it('is false when the AI check is disabled, even with a key saved', async () => {
      const deps = makeDeps({
        offscreen: { recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }) },
        settings: { get: vi.fn().mockResolvedValue({ ai: { enabled: false, apiKey: 'sk-test', model: 'claude-opus-5' }, debug: { saveCrops: false } }) },
      });

      const response = (await handleMessage(
        { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
        sender,
        deps,
      )) as RecognizeResponse;

      expect(response.aiEnabled).toBe(false);
    });

    it('is false, not thrown, when reading settings fails', async () => {
      const deps = makeDeps({
        offscreen: { recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }) },
        settings: { get: vi.fn().mockRejectedValue(new Error('storage unavailable')) },
      });

      const response = (await handleMessage(
        { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
        sender,
        deps,
      )) as RecognizeResponse;

      expect(response.aiEnabled).toBe(false);
    });

    // Final review M12: ask-ai refuses without the optional api.anthropic.com permission (the user revoked it
    // at chrome://extensions, say), so the popover must not offer "Ask AI" then either.
    it('is false when the AI check is enabled with a key, but the api.anthropic.com permission is not granted', async () => {
      const deps = makeDeps({
        offscreen: { recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }) },
        settings: { get: vi.fn().mockResolvedValue({ ai: { enabled: true, apiKey: 'sk-test', model: 'claude-opus-5' }, debug: { saveCrops: false } }) },
        permissions: { hasAnthropic: vi.fn().mockResolvedValue(false) },
      });

      const response = (await handleMessage(
        { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
        sender,
        deps,
      )) as RecognizeResponse;

      expect(response.aiEnabled).toBe(false);
      expect(deps.permissions.hasAnthropic).toHaveBeenCalled();
    });

    it('is false, not thrown, when the permission check fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const deps = makeDeps({
        offscreen: { recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }) },
        settings: { get: vi.fn().mockResolvedValue({ ai: { enabled: true, apiKey: 'sk-test', model: 'claude-opus-5' }, debug: { saveCrops: false } }) },
        permissions: { hasAnthropic: vi.fn().mockRejectedValue(new Error('permissions API unavailable')) },
      });

      const response = (await handleMessage(
        { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
        sender,
        deps,
      )) as RecognizeResponse;

      expect(response.aiEnabled).toBe(false);
      error.mockRestore();
    });
  });

  it('does not add a history entry when nothing was found', async () => {
    const result: RecognitionResult = { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} };
    const deps = makeDeps({ offscreen: { recognize: vi.fn().mockResolvedValue(result) } });

    const response = (await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    )) as RecognizeResponse;

    expect(deps.history.addEntry).not.toHaveBeenCalled();
    expect(response.entry).toBeUndefined();
    expect(response.cards).toEqual({});
  });

  it('still returns a well-typed RecognizeResponse (via RecognitionResult.error) when offscreen throws', async () => {
    const deps = makeDeps({ offscreen: { recognize: vi.fn().mockRejectedValue(new Error('offscreen document crashed')) } });

    const response = (await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    )) as RecognizeResponse;

    expect(response.result.candidates).toEqual([]);
    expect(response.result.error).toBe('offscreen document crashed');
    expect(response.cards).toEqual({});
    expect(response.entry).toBeUndefined();
    expect(deps.history.addEntry).not.toHaveBeenCalled();
  });

  it('saves a debug crop labelled with the top card when settings.debug.saveCrops is on', async () => {
    const result: RecognitionResult = {
      candidates: [{ cardId: 1, imageId: 1, score: 0.9 }],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
      settings: { get: vi.fn().mockResolvedValue({ ai: DEFAULT_SETTINGS.ai, debug: { saveCrops: true } }) },
    });

    await handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps);

    expect(deps.crops.save).toHaveBeenCalledWith(
      expect.objectContaining({ dataUrl: crop.dataUrl, cardId: 1, entryId: 'entry-1' }),
    );
  });

  it('does not save a debug crop when saveCrops is off', async () => {
    const result: RecognitionResult = {
      candidates: [{ cardId: 1, imageId: 1, score: 0.9 }],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
    });

    await handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps);

    expect(deps.crops.save).not.toHaveBeenCalled();
  });

  // Review Minor 2 (raised to Important): a failed side effect must not turn a
  // successful match into an error response of the wrong shape.
  it('still returns the recognized result and cards when saving history fails', async () => {
    const result: RecognitionResult = {
      candidates: [{ cardId: 1, imageId: 1, score: 0.9 }],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const cards = { 1: card(1, 'A') };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue(cards) },
      history: { addEntry: vi.fn().mockRejectedValue(new Error('storage quota exceeded')) },
    });

    const response = (await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    )) as RecognizeResponse;

    expect(response.result).toEqual(result);
    expect(response.cards).toEqual(cards);
  });

  it('still returns the recognized result (marked as unloaded data) when loading candidate cards fails', async () => {
    const result: RecognitionResult = {
      candidates: [{ cardId: 1, imageId: 1, score: 0.9 }],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockRejectedValue(new Error('IndexedDB is blocked')) },
    });

    const response = (await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    )) as RecognizeResponse;

    // Important 1: a card store failure (like a missing record below) is a distinct,
    // actionable error - not indistinguishable from "nothing plausible matched".
    expect(response.result.error).toBe("Card data isn't loaded. Open Options and check for updates.");
    expect(response.cards).toEqual({});
    expect(response.entry).toBeUndefined();
    expect(deps.history.addEntry).not.toHaveBeenCalled();
  });

  // Important 1: a failed first `ensureSeeded` (quota, IDB error) or a shipped index
  // newer than the stored card snapshot must read as "card data isn't loaded", not as a
  // silent recognition failure ("Couldn't match this") - the engine really did match.
  it('reports a distinct error and records no history entry when the top match has no card record', async () => {
    const result: RecognitionResult = {
      candidates: [
        { cardId: 1, imageId: 1, score: 0.9 },
        { cardId: 2, imageId: 2, score: 0.5 },
      ],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      // The top candidate (1) has no record; only the second one does - a stale/partial store.
      cardStore: { getCards: vi.fn().mockResolvedValue({ 2: card(2, 'B') }) },
    });

    const response = (await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    )) as RecognizeResponse;

    expect(response.result.error).toBe("Card data isn't loaded. Open Options and check for updates.");
    expect(response.entry).toBeUndefined();
    expect(deps.history.addEntry).not.toHaveBeenCalled();
    expect(deps.crops.save).not.toHaveBeenCalled();
  });

  it('records a face-down card as the card back, which has no card record and needs none', async () => {
    const result: RecognitionResult = {
      candidates: [
        { cardId: CARD_BACK_ID, imageId: 9001, score: 0.95, source: 'embedding' },
        { cardId: 2, imageId: 2, score: 0.41, source: 'embedding' },
      ],
      confident: true,
      faceDown: true,
      modelId: 'm',
      recognizer: 'embedding',
      timings: {},
    };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 2: card(2, 'B') }) },
    });

    const response = (await handleMessage(
      { type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } },
      sender,
      deps,
    )) as RecognizeResponse;

    // Not "card data isn't loaded": the popover says "Face-down card", the side panel too.
    expect(response.result).toEqual(result);
    expect(response.entry).toMatchObject({ id: 'entry-1', cardId: CARD_BACK_ID, imageId: 9001, confident: true });
    expect(deps.history.addEntry).toHaveBeenCalledTimes(1);
    expect(deps.history.setCurrent).toHaveBeenCalledWith('entry-1');
  });
});

describe('lazy card-store seeding', () => {
  // Important 1 / ledger M8: seeding only in runtime.onInstalled means a failed first
  // attempt (quota, IDB error) never heals. A lazy, memoised ensureSeeded before the
  // first card read of the message lets the very next read retry and self-heal.
  it('ensures the card store is seeded before reading cards, for recognize', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      offscreen: {
        recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }),
      },
      cardStore: {
        ensureSeeded: vi.fn(async () => {
          calls.push('ensureSeeded');
        }),
        getCards: vi.fn(async () => {
          calls.push('getCards');
          return {};
        }),
      },
    });

    await handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps);

    expect(calls).toEqual(['ensureSeeded', 'getCards']);
  });

  it('ensures the card store is seeded before reading cards, for get-cards', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      cardStore: {
        ensureSeeded: vi.fn(async () => {
          calls.push('ensureSeeded');
        }),
        getCards: vi.fn(async () => {
          calls.push('getCards');
          return {};
        }),
      },
    });

    await handleMessage({ type: 'get-cards', ids: [1] }, sender, deps);

    expect(calls).toEqual(['ensureSeeded', 'getCards']);
  });

  it('ensures the card store is seeded before reading cards, for ask-ai and get-status too', async () => {
    const askAiCalls: string[] = [];
    const askAiDeps = makeDeps({
      cardStore: {
        ensureSeeded: vi.fn(async () => {
          askAiCalls.push('ensureSeeded');
        }),
        getCards: vi.fn(async () => {
          askAiCalls.push('getCards');
          return {};
        }),
      },
      ai: { identify: vi.fn().mockResolvedValue({ name: 'Pot of Greed', confident: true }) },
    });
    await handleMessage({ type: 'ask-ai', crop, candidates: [] }, sender, askAiDeps);
    expect(askAiCalls[0]).toBe('ensureSeeded');

    const statusCalls: string[] = [];
    const statusDeps = makeDeps({
      cardStore: {
        ensureSeeded: vi.fn(async () => {
          statusCalls.push('ensureSeeded');
        }),
        getMeta: vi.fn(async () => {
          statusCalls.push('getMeta');
          return { cardCount: 0 };
        }),
      },
    });
    await handleMessage({ type: 'get-status' }, sender, statusDeps);
    expect(statusCalls).toEqual(['ensureSeeded', 'getMeta']);
  });

  it('shares one in-flight seed attempt across concurrent card reads (memoised)', async () => {
    const ensureSeeded = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      offscreen: {
        recognize: vi.fn().mockResolvedValue({ candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }),
      },
      cardStore: { ensureSeeded },
    });

    await Promise.all([
      handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps),
      handleMessage({ type: 'get-cards', ids: [1] }, sender, deps),
    ]);

    expect(ensureSeeded).toHaveBeenCalledTimes(1);
  });

  it('retries on the next read after a failed seed attempt (self-heals)', async () => {
    const ensureSeeded = vi.fn().mockRejectedValueOnce(new Error('quota exceeded')).mockResolvedValueOnce(undefined);
    const deps = makeDeps({ cardStore: { ensureSeeded } });

    await handleMessage({ type: 'get-cards', ids: [1] }, sender, deps);
    await handleMessage({ type: 'get-cards', ids: [1] }, sender, deps);

    expect(ensureSeeded).toHaveBeenCalledTimes(2);
  });
});

describe('get-cards', () => {
  it('delegates to the card store', async () => {
    const cards = { 1: card(1, 'A') };
    const deps = makeDeps({ cardStore: { getCards: vi.fn().mockResolvedValue(cards) } });

    const response = await handleMessage({ type: 'get-cards', ids: [1, 2] }, sender, deps);

    expect(deps.cardStore.getCards).toHaveBeenCalledWith([1, 2]);
    expect(response).toEqual({ cards });
  });

  it('returns an empty map instead of rejecting when the card store throws', async () => {
    const deps = makeDeps({ cardStore: { getCards: vi.fn().mockRejectedValue(new Error('IndexedDB is blocked')) } });

    const response = await handleMessage({ type: 'get-cards', ids: [1, 2] }, sender, deps);

    expect(response).toEqual({ cards: {} });
  });
});

describe('get-image', () => {
  it('delegates to the image cache', async () => {
    const deps = makeDeps({ imageCache: { getImageDataUrl: vi.fn().mockResolvedValue('data:image/jpeg;base64,x') } });

    const response = await handleMessage({ type: 'get-image', imageId: 5, size: 'small' }, sender, deps);

    expect(deps.imageCache.getImageDataUrl).toHaveBeenCalledWith(5, 'small');
    expect(response).toEqual({ dataUrl: 'data:image/jpeg;base64,x' });
  });

  it('returns a null dataUrl instead of rejecting when the image cache throws', async () => {
    const deps = makeDeps({ imageCache: { getImageDataUrl: vi.fn().mockRejectedValue(new Error('fetch failed')) } });

    const response = await handleMessage({ type: 'get-image', imageId: 5, size: 'small' }, sender, deps);

    expect(response).toEqual({ dataUrl: null });
  });
});

describe('correct', () => {
  it('updates the history entry with corrected: true and relabels the debug crop', async () => {
    const deps = makeDeps();

    const response = await handleMessage({ type: 'correct', entryId: 'e1', cardId: 9, imageId: 9 }, sender, deps);

    expect(deps.history.updateEntry).toHaveBeenCalledWith('e1', { cardId: 9, imageId: 9, corrected: true });
    expect(deps.crops.relabel).toHaveBeenCalledWith('e1', 9);
    expect(response).toEqual({ ok: true });
  });
});

describe('show-in-panel', () => {
  it("returns the shortcut hint when sidePanel.open throws (no user gesture)", async () => {
    const deps = makeDeps({ sidePanel: { open: vi.fn().mockRejectedValue(new Error('user gesture required')) } });

    const response = await handleMessage(
      { type: 'show-in-panel', entryId: 'e1' },
      { tab: { windowId: 1 } } as chrome.runtime.MessageSender,
      deps,
    );

    expect(response).toEqual({ ok: false, error: 'Press Alt+Shift+U to open the side panel' });
    expect(deps.history.setCurrent).toHaveBeenCalledWith('e1');
  });

  it('succeeds and opens the panel in the sender tab/window when the gesture is valid', async () => {
    const deps = makeDeps();

    const response = await handleMessage(
      { type: 'show-in-panel', entryId: 'e1' },
      { tab: { windowId: 1, id: 2 } } as chrome.runtime.MessageSender,
      deps,
    );

    expect(deps.sidePanel.open).toHaveBeenCalledWith({ windowId: 1, tabId: 2 });
    expect(response).toEqual({ ok: true });
  });
});

describe('ask-ai', () => {
  it('identifies via the AI client using the top-5 candidate names, then matches locally', async () => {
    const potOfGreed = card(42, 'Pot of Greed');
    const potOfDesires = card(10, 'Pot of Desires');
    const cardsById: Record<number, CardRecord> = { 10: potOfDesires, 42: potOfGreed };
    const deps = makeDeps({
      cardStore: {
        getCards: vi.fn(async (ids: number[]) => {
          const out: Record<number, CardRecord> = {};
          for (const id of ids) if (cardsById[id]) out[id] = cardsById[id];
          return out;
        }),
        getAllNames: vi.fn().mockResolvedValue([
          { id: 42, name: 'Pot of Greed' },
          { id: 10, name: 'Pot of Desires' },
        ]),
      },
      ai: { identify: vi.fn().mockResolvedValue({ name: 'Pot of Greed', confident: true }) },
    });

    const response = await handleMessage(
      { type: 'ask-ai', crop, candidates: [{ cardId: 10, imageId: 10, score: 0.4 }] },
      sender,
      deps,
    );

    expect(deps.ai.identify).toHaveBeenCalledWith(crop, ['Pot of Desires'], DEFAULT_SETTINGS, expect.anything());
    expect(response).toEqual({ cardId: 42, imageId: 42, answer: 'Pot of Greed', confident: true });
  });

  it('surfaces an error from the AI client as-is, without attempting to match', async () => {
    const deps = makeDeps({ ai: { identify: vi.fn().mockResolvedValue({ error: 'The AI check is turned off. Enable it in Options.' }) } });

    const response = await handleMessage({ type: 'ask-ai', crop, candidates: [] }, sender, deps);

    expect(response).toEqual({ error: 'The AI check is turned off. Enable it in Options.' });
  });

  // Important 4: matchName always returns *a* nearest name, so without a threshold an
  // answer that isn't in the database (or is a typo'd non-match) would come back as a
  // confidently-wrong cardId - exactly what the spec forbids.
  it('does not map a weak match to a card, and carries the confident flag through', async () => {
    const deps = makeDeps({
      cardStore: {
        getAllNames: vi.fn().mockResolvedValue([
          { id: 42, name: 'Pot of Greed' },
          { id: 10, name: 'Pot of Desires' },
        ]),
      },
      ai: { identify: vi.fn().mockResolvedValue({ name: 'Zzyzx the Nonexistent Wyrm', confident: false }) },
    });

    const response = await handleMessage({ type: 'ask-ai', crop, candidates: [] }, sender, deps);

    expect(response).toEqual({
      answer: 'Zzyzx the Nonexistent Wyrm',
      confident: false,
      error: 'No local card matches "Zzyzx the Nonexistent Wyrm".',
    });
  });

  it('maps a strong match to a card even when Claude itself is not confident', async () => {
    const deps = makeDeps({
      cardStore: {
        getCards: vi.fn().mockResolvedValue({ 42: card(42, 'Pot of Greed') }),
        getAllNames: vi.fn().mockResolvedValue([{ id: 42, name: 'Pot of Greed' }]),
      },
      ai: { identify: vi.fn().mockResolvedValue({ name: 'Pot of Greed', confident: false }) },
    });

    const response = await handleMessage({ type: 'ask-ai', crop, candidates: [] }, sender, deps);

    expect(response).toEqual({ cardId: 42, imageId: 42, answer: 'Pot of Greed', confident: false });
  });

  it('returns an error instead of rejecting when something inside throws unexpectedly', async () => {
    const deps = makeDeps({ cardStore: { getAllNames: vi.fn().mockRejectedValue(new Error('IndexedDB is blocked')) } });

    const response = await handleMessage(
      { type: 'ask-ai', crop, candidates: [] },
      sender,
      { ...deps, ai: { ...deps.ai, identify: vi.fn().mockResolvedValue({ name: 'Pot of Greed', confident: true }) } },
    );

    expect(response).toEqual({ error: 'IndexedDB is blocked' });
  });
});

describe('open-options', () => {
  it('opens the options page', async () => {
    const deps = makeDeps();
    const response = await handleMessage({ type: 'open-options' }, sender, deps);
    expect(deps.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(response).toEqual({ ok: true });
  });
});

describe('the AI check without the Anthropic permission', () => {
  // The options page asks for the optional api.anthropic.com permission when the AI check is
  // turned on; the privacy disclosures present that grant as the user's consent, so neither AI
  // path may call Anthropic without it (e.g. the user revoked it at chrome://extensions).
  it('ask-ai refuses, without building a client or calling the AI', async () => {
    const deps = makeDeps({ permissions: { hasAnthropic: vi.fn().mockResolvedValue(false) } });
    const response = await handleMessage({ type: 'ask-ai', crop, candidates: [] }, sender, deps);
    expect(response).toEqual({ error: expect.stringMatching(/permission/i) });
    expect(deps.anthropicClient).not.toHaveBeenCalled();
    expect(deps.ai.identify).not.toHaveBeenCalled();
  });

  it('test-ai refuses the same way', async () => {
    const deps = makeDeps({ permissions: { hasAnthropic: vi.fn().mockResolvedValue(false) } });
    const response = await handleMessage({ type: 'test-ai' }, sender, deps);
    expect(response).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(deps.anthropicClient).not.toHaveBeenCalled();
    expect(deps.ai.test).not.toHaveBeenCalled();
  });
});

describe('test-ai', () => {
  it('builds a client from the stored settings and delegates', async () => {
    const settings = { ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' }, debug: { saveCrops: false } };
    const deps = makeDeps({
      ai: { test: vi.fn().mockResolvedValue({ ok: true }) },
      settings: { get: vi.fn().mockResolvedValue(settings) },
    });

    const response = await handleMessage({ type: 'test-ai' }, sender, deps);

    expect(deps.anthropicClient).toHaveBeenCalledWith('k');
    expect(deps.ai.test).toHaveBeenCalledWith(settings, expect.anything());
    expect(response).toEqual({ ok: true });
  });
});

describe('refresh-cards', () => {
  it('reports ok on an update', async () => {
    const deps = makeDeps({ cardStore: { refreshIfChanged: vi.fn().mockResolvedValue('updated') } });
    expect(await handleMessage({ type: 'refresh-cards' }, sender, deps)).toEqual({ ok: true });
  });

  // Final review I2: "Check for updates now" found new cards but never indexed their artwork,
  // so they stayed unmatched until a restart or a separate "Update now".
  it('starts the artwork index update when the card data changed, without waiting for it', async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const deps = makeDeps({ cardStore: { refreshIfChanged: vi.fn().mockResolvedValue('updated') }, indexUpdate: { run } });
    expect(await handleMessage({ type: 'refresh-cards' }, sender, deps)).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    finish();
  });

  it('does not start an index update when nothing changed', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({ cardStore: { refreshIfChanged: vi.fn().mockResolvedValue('unchanged') }, indexUpdate: { run } });
    await handleMessage({ type: 'refresh-cards' }, sender, deps);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports the failure reason when the check fails', async () => {
    const deps = makeDeps({ cardStore: { refreshIfChanged: vi.fn().mockResolvedValue('failed') } });
    expect(await handleMessage({ type: 'refresh-cards' }, sender, deps)).toEqual({
      ok: false,
      error: 'Could not check for card updates.',
    });
  });
});

describe('first-run consent', () => {
  it('grant-consent records the consent', async () => {
    const deps = makeDeps();
    expect(await handleMessage({ type: 'grant-consent' }, sender, deps)).toEqual({ ok: true });
    expect(deps.consent.grant).toHaveBeenCalledTimes(1);
  });

  it('grant-consent reports a failure to save it', async () => {
    const deps = makeDeps({ consent: { grant: vi.fn().mockRejectedValue(new Error('quota')) } });
    expect(await handleMessage({ type: 'grant-consent' }, sender, deps)).toEqual({ ok: false, error: 'quota' });
  });

  it('get-status reports when the user consented, and omits it before', async () => {
    const before = await handleMessage({ type: 'get-status' }, sender, makeDeps());
    expect(before).not.toHaveProperty('consentedAt');
    const after = await handleMessage({ type: 'get-status' }, sender, makeDeps({ consent: { get: vi.fn().mockResolvedValue(1700000000123) } }));
    expect(after).toMatchObject({ consentedAt: 1700000000123 });
  });
});

describe('get-status', () => {
  it('reports the card meta and the active model id', async () => {
    const deps = makeDeps({
      cardStore: {
        getMeta: vi.fn().mockResolvedValue({ dbVersion: '1.0', updatedAt: '2026-01-01T00:00:00.000Z', cardCount: 3 }),
      },
    });

    const response = await handleMessage({ type: 'get-status' }, sender, deps);

    expect(response).toEqual({
      dbVersion: '1.0',
      cardsUpdatedAt: Date.parse('2026-01-01T00:00:00.000Z'),
      cardCount: 3,
      modelId: DEFAULT_MODEL_ID,
      indexDeltaCount: 0,
      indexUpdate: { state: 'idle' },
    });
  });

  it('returns a safe fallback instead of rejecting when the card store throws', async () => {
    const deps = makeDeps({ cardStore: { getMeta: vi.fn().mockRejectedValue(new Error('IndexedDB is blocked')) } });

    const response = await handleMessage({ type: 'get-status' }, sender, deps);

    expect(response).toEqual({ cardCount: 0, modelId: DEFAULT_MODEL_ID });
  });

  it('reports the self-updating index size and state from indexUpdate', async () => {
    const deps = makeDeps({
      indexUpdate: {
        getDeltaCount: vi.fn().mockResolvedValue(42),
        getStatus: vi.fn().mockResolvedValue({ state: 'running', pending: 7 }),
      },
    });

    const response = await handleMessage({ type: 'get-status' }, sender, deps);

    expect(response).toMatchObject({ indexDeltaCount: 42, indexUpdate: { state: 'running', pending: 7 } });
    expect(deps.indexUpdate.getDeltaCount).toHaveBeenCalledWith(DEFAULT_MODEL_ID);
  });

  it('falls back to 0/idle for the index fields, without failing the whole response, when they throw', async () => {
    const deps = makeDeps({
      cardStore: { getMeta: vi.fn().mockResolvedValue({ cardCount: 3 }) },
      indexUpdate: {
        getDeltaCount: vi.fn().mockRejectedValue(new Error('IndexedDB is blocked')),
        getStatus: vi.fn().mockRejectedValue(new Error('storage unavailable')),
      },
    });

    const response = await handleMessage({ type: 'get-status' }, sender, deps);

    expect(response).toEqual({ cardCount: 3, modelId: DEFAULT_MODEL_ID, indexDeltaCount: 0, indexUpdate: { state: 'idle' } });
  });
});

describe('update-index', () => {
  it('starts a run and answers ok:true without waiting for it to finish', async () => {
    let resolveRun!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (resolveRun = resolve)));
    const deps = makeDeps({ indexUpdate: { run } });

    const response = await handleMessage({ type: 'update-index' }, sender, deps);

    expect(response).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    resolveRun(); // let the fire-and-forget run settle so it doesn't leak into other tests
  });

  it('does not throw when the run itself rejects', async () => {
    const deps = makeDeps({ indexUpdate: { run: vi.fn().mockRejectedValue(new Error('offscreen crashed')) } });

    await expect(handleMessage({ type: 'update-index' }, sender, deps)).resolves.toEqual({ ok: true });
  });
});

// The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ false) asks nothing of
// images.ygoprodeck.com: the popover shows the user's own crop, the history keeps a small copy of it for
// the side panel, and no artwork is downloaded (legal-audit.md B2; decisions D2 and D3).
describe('without remote images (the crop build, --no-remote-images)', () => {
  const found: RecognitionResult = {
    candidates: [{ cardId: 1, imageId: 1, score: 0.9 }],
    confident: true,
    faceDown: false,
    modelId: 'm',
    timings: {},
  };
  const recognize = (deps: RouterDeps) =>
    handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps) as Promise<RecognizeResponse>;

  it('get-image answers null without asking the image cache', async () => {
    const deps = makeDeps({ remoteImages: false, imageCache: { getImageDataUrl: vi.fn().mockResolvedValue('data:image/jpeg;base64,x') } });

    expect(await handleMessage({ type: 'get-image', imageId: 5, size: 'full' }, sender, deps)).toEqual({ dataUrl: null });
    expect(deps.imageCache.getImageDataUrl).not.toHaveBeenCalled();
  });

  it('keeps a small thumbnail of the crop with the history entry, for the side panel', async () => {
    const deps = makeDeps({
      remoteImages: false,
      offscreen: { recognize: vi.fn().mockResolvedValue(found) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
    });

    const response = await recognize(deps);

    expect(response.entry?.id).toBe('entry-1');
    expect(deps.thumbnail).toHaveBeenCalledWith(crop.dataUrl);
    await vi.waitFor(() => expect(deps.history.setThumb).toHaveBeenCalledWith('entry-1', 'data:image/jpeg;base64,THUMB'));
  });

  it('answers without waiting for the thumbnail', async () => {
    const deps = makeDeps({
      remoteImages: false,
      thumbnail: vi.fn(() => new Promise<string>(() => {})), // never settles
      offscreen: { recognize: vi.fn().mockResolvedValue(found) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
    });

    expect((await recognize(deps)).entry?.cardId).toBe(1);
  });

  it('still answers, and logs, when the thumbnail fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps({
      remoteImages: false,
      thumbnail: vi.fn().mockRejectedValue(new Error('no OffscreenCanvas')),
      offscreen: { recognize: vi.fn().mockResolvedValue(found) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
    });

    expect((await recognize(deps)).entry?.cardId).toBe(1);
    await vi.waitFor(() => expect(error).toHaveBeenCalled());
    expect(deps.history.setThumb).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('keeps no thumbnail when nothing was recorded', async () => {
    const deps = makeDeps({
      remoteImages: false,
      offscreen: { recognize: vi.fn().mockResolvedValue({ ...found, candidates: [] }) },
    });

    expect((await recognize(deps)).entry).toBeUndefined();
    expect(deps.thumbnail).not.toHaveBeenCalled();
  });

  it('keeps no thumbnail with remote images: the side panel shows the card image instead', async () => {
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(found) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
    });

    await recognize(deps);

    expect(deps.thumbnail).not.toHaveBeenCalled();
  });

  it('update-index refuses: this build downloads no artwork', async () => {
    const deps = makeDeps({ remoteImages: false });

    const response = (await handleMessage({ type: 'update-index' }, sender, deps)) as { ok: boolean; error?: string };

    expect(response.ok).toBe(false);
    expect(response.error).toMatch(/doesn't download/i);
    expect(deps.indexUpdate.run).not.toHaveBeenCalled();
  });

  it('refresh-cards updates the card data but starts no artwork download', async () => {
    const deps = makeDeps({ remoteImages: false, cardStore: { refreshIfChanged: vi.fn().mockResolvedValue('updated') } });

    expect(await handleMessage({ type: 'refresh-cards' }, sender, deps)).toEqual({ ok: true });
    expect(deps.indexUpdate.run).not.toHaveBeenCalled();
  });
});
