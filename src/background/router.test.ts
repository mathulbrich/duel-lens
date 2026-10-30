import { beforeEach, describe, expect, it, vi } from 'vitest';
import { altArtworkId } from '../shared/alt-artwork';
import type { RecognizeResponse, ToBackground } from '../shared/messages';
import { DEFAULT_MODEL_ID } from '../shared/models';
import { CARD_BACK_ID, DEFAULT_SETTINGS, type CardRecord, type CropPayload, type RecognitionResult } from '../shared/types';
import { clearNamesCache, handleMessage, type RouterDeps } from './router';

// Module-level cache of card names for "Wrong card?"'s search (review fix 2): fresh for every test.
beforeEach(() => {
  clearNamesCache();
});

function makeDeps(overrides: {
  cardStore?: Partial<RouterDeps['cardStore']>;
  imageCache?: Partial<RouterDeps['imageCache']>;
  cardText?: Partial<RouterDeps['cardText']>;
  history?: Partial<RouterDeps['history']>;
  offscreen?: Partial<RouterDeps['offscreen']>;
  indexUpdate?: Partial<RouterDeps['indexUpdate']>;
  ai?: Partial<RouterDeps['ai']>;
  settings?: Partial<RouterDeps['settings']>;
  crops?: Partial<RouterDeps['crops']>;
  corrections?: Partial<RouterDeps['corrections']>;
  sidePanel?: Partial<RouterDeps['sidePanel']>;
  board?: Partial<RouterDeps['board']>;
  openOptionsPage?: RouterDeps['openOptionsPage'];
  anthropicClient?: RouterDeps['anthropicClient'];
  permissions?: Partial<RouterDeps['permissions']>;
  consent?: Partial<RouterDeps['consent']>;
  remoteImages?: RouterDeps['remoteImages'];
  thumbnail?: RouterDeps['thumbnail'];
  now?: RouterDeps['now'];
  newId?: RouterDeps['newId'];
  report?: RouterDeps['report'];
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
    cardText: { localize: vi.fn(async (cards: Record<number, CardRecord>) => cards), ...overrides.cardText },
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
    report: overrides.report ?? vi.fn(),
    settings: { get: vi.fn().mockResolvedValue(DEFAULT_SETTINGS), ...overrides.settings },
    crops: { save: vi.fn().mockResolvedValue(undefined), relabel: vi.fn().mockResolvedValue(undefined), ...overrides.crops },
    corrections: { stage: vi.fn(), maybeSave: vi.fn().mockResolvedValue(undefined), ...overrides.corrections },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined), ...overrides.sidePanel },
    board: { save: vi.fn().mockResolvedValue(undefined), ...overrides.board },
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
      settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, debug: { saveCrops: true } }) },
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

  // "Wrong card?" (corrections.ts): the crop/top-5/model are remembered for a possible later
  // correction, but only when the setting is on - a crop isn't worth keeping around otherwise.
  it('stages the crop, top-5 and model id for a possible later correction when corrections.save is on', async () => {
    const result: RecognitionResult = {
      candidates: [{ cardId: 1, imageId: 1, score: 0.9 }],
      confident: true,
      faceDown: false,
      modelId: 'dinov2-small-duel-v3b',
      timings: {},
    };
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ 1: card(1, 'A') }) },
      settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, corrections: { save: true } }) },
    });

    await handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps);

    expect(deps.corrections.stage).toHaveBeenCalledWith('entry-1', {
      dataUrl: crop.dataUrl,
      candidates: result.candidates,
      modelId: 'dinov2-small-duel-v3b',
    });
  });

  it('does not stage anything when corrections.save is off', async () => {
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
      settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, corrections: { save: false } }) },
    });

    await handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps);

    expect(deps.corrections.stage).not.toHaveBeenCalled();
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

// UX-2: resting the pointer on an outline (or focusing it) previews the card. That read is a peek
// (`record: false`): the same answer as a click's, but it leaves nothing behind (no history entry, no
// thumbnail, no debug crop, so nothing a correction could name) and never involves the AI. A click
// then records the card with a normal read.
// Private browsing (decision after the Firefox port): a scan from a private (Firefox) or incognito (Chrome) tab
// is read and shown as usual, but nothing of it is kept: no history entry, thumbnail, debug crop or correction.
describe('a scan from a private or incognito tab', () => {
  const found: RecognitionResult = { candidates: [{ cardId: 1, imageId: 1, score: 0.9 }, { cardId: 2, imageId: 2, score: 0.5 }], confident: true, faceDown: false, modelId: 'm', timings: {} };
  const cards = { 1: card(1, 'A'), 2: card(2, 'B') };
  const tab = (incognito: boolean) => ({ tab: { id: 5, windowId: 1, incognito } }) as unknown as chrome.runtime.MessageSender;
  const keepEverything = { ...DEFAULT_SETTINGS, debug: { saveCrops: true }, corrections: { save: true }, ai: { enabled: true, apiKey: 'sk-test', model: 'claude-opus-5' } };
  const depsFor = () =>
    makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(found) },
      cardStore: { getCards: vi.fn().mockResolvedValue(cards) },
      settings: { get: vi.fn().mockResolvedValue(keepEverything) },
      remoteImages: false,
    });
  const scan = (deps: RouterDeps, from: chrome.runtime.MessageSender) =>
    handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't', videoTime: 3 } }, from, deps) as Promise<RecognizeResponse>;

  it("answers what a normal tab's scan answers, without the entry, and keeps nothing", async () => {
    const privateDeps = depsFor();
    const normalDeps = depsFor();

    const priv = await scan(privateDeps, tab(true));
    const normal = await scan(normalDeps, tab(false));
    await new Promise((resolve) => setTimeout(resolve, 0)); // the crop build's thumbnail is made after the answer

    expect(priv.result).toEqual(normal.result);
    expect(priv.cards).toEqual(normal.cards);
    expect(priv.aiEnabled).toBe(true); // Ask AI still works
    expect(normal.entry).toBeDefined();
    expect(priv.entry).toBeUndefined();
    for (const write of [privateDeps.history.addEntry, privateDeps.history.setCurrent, privateDeps.history.setThumb, privateDeps.thumbnail, privateDeps.crops.save, privateDeps.corrections.stage]) {
      expect(write).not.toHaveBeenCalled();
    }
    expect(normalDeps.history.addEntry).toHaveBeenCalled();
    expect(normalDeps.corrections.stage).toHaveBeenCalled();
  });

  it("keeps no board, and doesn't open the side panel for one", async () => {
    const deps = depsFor();
    const board = [{ cardId: 1, imageId: 1, side: 'near', state: 'sure' }];
    for (const msg of [{ type: 'show-board', board: [], reading: true }, { type: 'show-board', board }] as ToBackground[]) {
      expect(await handleMessage(msg, tab(true), deps)).toEqual({ ok: false, error: "Couldn't keep the board for the side panel." });
    }
    expect(deps.board.save).not.toHaveBeenCalled();
    expect(deps.sidePanel.open).not.toHaveBeenCalled();

    expect(await handleMessage({ type: 'show-board', board } as ToBackground, tab(false), deps)).toEqual({ ok: true });
    expect(deps.board.save).toHaveBeenCalledTimes(1);
  });

  it('saves no correction and touches no history entry', async () => {
    const deps = depsFor();
    expect(await handleMessage({ type: 'correct', entryId: 'e1', cardId: 9, imageId: 9 }, tab(true), deps)).toEqual({ ok: true });
    expect(deps.history.updateEntry).not.toHaveBeenCalled();
    expect(deps.crops.relabel).not.toHaveBeenCalled();
    expect(deps.corrections.maybeSave).not.toHaveBeenCalled();

    await handleMessage({ type: 'correct', entryId: 'e1', cardId: 9, imageId: 9 }, tab(false), deps);
    expect(deps.corrections.maybeSave).toHaveBeenCalledWith('e1', 9, 9, true);
  });
});

describe('recognize with record: false (a hover peek)', () => {
  const found: RecognitionResult = {
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
  const context = { pageUrl: 'https://x', pageTitle: 't', videoTime: 12 };
  const read = (deps: RouterDeps, record?: unknown) =>
    handleMessage({ type: 'recognize', crop, context, ...(record === undefined ? {} : { record }) } as ToBackground, sender, deps) as Promise<RecognizeResponse>;
  const depsFor = (result: RecognitionResult, more: Parameters<typeof makeDeps>[0] = {}) =>
    makeDeps({ offscreen: { recognize: vi.fn().mockResolvedValue(result) }, cardStore: { getCards: vi.fn().mockResolvedValue(cards) }, ...more });

  it("answers what a click's read answers, without the history entry, and records nothing", async () => {
    const peekDeps = depsFor(found);
    const clickDeps = depsFor(found);

    const peek = await read(peekDeps, false);
    const click = await read(clickDeps);

    expect(peek.result).toEqual(click.result);
    expect(peek.cards).toEqual(click.cards);
    expect(peek.aiEnabled).toBe(click.aiEnabled);
    expect(click.entry).toBeDefined();
    expect(peek.entry).toBeUndefined();
    expect(peekDeps.offscreen.recognize).toHaveBeenCalledWith(crop);
    expect(peekDeps.history.addEntry).not.toHaveBeenCalled();
    expect(peekDeps.history.setCurrent).not.toHaveBeenCalled();
    expect(peekDeps.history.updateEntry).not.toHaveBeenCalled();
  });

  it('keeps no debug crop, even with "Save crops" on', async () => {
    const deps = depsFor(found, { settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, debug: { saveCrops: true } }) } });

    await read(deps, false);

    expect(deps.crops.save).not.toHaveBeenCalled();
    expect(deps.crops.relabel).not.toHaveBeenCalled();
  });

  it('keeps no picture of the scan in the crop build (--no-remote-images)', async () => {
    const deps = depsFor(found, { remoteImages: false });

    await read(deps, false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(deps.thumbnail).not.toHaveBeenCalled();
    expect(deps.history.setThumb).not.toHaveBeenCalled();
  });

  it('never calls the AI, but still says whether it is on (a click pins the preview from this answer)', async () => {
    const deps = depsFor(
      { ...found, confident: false },
      { settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, ai: { enabled: true, apiKey: 'sk-test', model: 'claude-opus-5' } }) } },
    );

    const peek = await read(deps, false);

    expect(peek.aiEnabled).toBe(true);
    expect(deps.ai.identify).not.toHaveBeenCalled();
    expect(deps.anthropicClient).not.toHaveBeenCalled();
  });

  it('asks for no card image (the preview has none; the full popover asks when a click opens it)', async () => {
    const deps = depsFor(found);

    await read(deps, false);

    expect(deps.imageCache.getImageDataUrl).not.toHaveBeenCalled();
  });

  it('answers a face-down card as the card back, recording nothing', async () => {
    const back: RecognitionResult = { ...found, candidates: [{ cardId: CARD_BACK_ID, imageId: 9001, score: 0.95 }], faceDown: true };
    const deps = depsFor(back);

    const peek = await read(deps, false);

    expect(peek.result).toEqual(back);
    expect(peek.entry).toBeUndefined();
    expect(deps.history.addEntry).not.toHaveBeenCalled();
  });

  it("still says so when the card data isn't loaded", async () => {
    const deps = depsFor(found, { cardStore: { getCards: vi.fn().mockResolvedValue({ 2: card(2, 'B') }) } });

    const peek = await read(deps, false);

    expect(peek.result.error).toBe("Card data isn't loaded. Open Options and check for updates.");
    expect(deps.history.addEntry).not.toHaveBeenCalled();
  });

  it('records with record: true, as without record', async () => {
    const deps = depsFor(found);

    const click = await read(deps, true);

    expect(click.entry).toMatchObject({ id: 'entry-1', cardId: 1, videoTime: 12 });
    expect(deps.history.addEntry).toHaveBeenCalledTimes(1);
    expect(deps.history.setCurrent).toHaveBeenCalledWith('entry-1');
  });

  it('peeks only on an explicit false: any other value is a normal read', async () => {
    for (const record of [0, 'false', null]) {
      const deps = depsFor(found);
      expect((await read(deps, record)).entry).toBeDefined();
      expect(deps.history.addEntry).toHaveBeenCalledTimes(1);
    }
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

  // "Wrong card?" (corrections.ts): every correct asks corrections to (maybe) save one, with the
  // current setting - maybeSave itself decides whether anything was staged and whether this is a
  // real correction (not just re-confirming the top guess).
  it('asks corrections to maybe save, with the resolved image id and the current setting', async () => {
    const deps = makeDeps({ settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, corrections: { save: true } }) } });

    await handleMessage({ type: 'correct', entryId: 'e1', cardId: 9, imageId: 9 }, sender, deps);

    expect(deps.corrections.maybeSave).toHaveBeenCalledWith('e1', 9, 9, true);
  });

  it('passes false to corrections.maybeSave when the setting is off', async () => {
    const deps = makeDeps({ settings: { get: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, corrections: { save: false } }) } });

    await handleMessage({ type: 'correct', entryId: 'e1', cardId: 9, imageId: 9 }, sender, deps);

    expect(deps.corrections.maybeSave).toHaveBeenCalledWith('e1', 9, 9, false);
  });

  it('still reports ok when saving the correction throws', async () => {
    const deps = makeDeps({ corrections: { maybeSave: vi.fn().mockRejectedValue(new Error('IndexedDB is full')) } });

    const response = await handleMessage({ type: 'correct', entryId: 'e1', cardId: 9, imageId: 9 }, sender, deps);

    expect(response).toEqual({ ok: true });
  });
});

describe('search-cards', () => {
  it('matches the query against the local card names, best first, with each result\'s default image id', async () => {
    const deps = makeDeps({
      cardStore: {
        getAllNames: vi.fn().mockResolvedValue([
          { id: 55144522, name: 'Pot of Greed' },
          { id: 98645731, name: 'Pot of Desires' },
          { id: 53129443, name: 'Dark Hole' },
        ]),
        getCards: vi.fn().mockResolvedValue({ 55144522: card(55144522, 'Pot of Greed'), 98645731: card(98645731, 'Pot of Desires') }),
      },
    });

    const response = (await handleMessage({ type: 'search-cards', query: 'pot of greed' }, sender, deps)) as { matches: { cardId: number }[] };

    // The exact (normalised) match leads; "Dark Hole" (no card record in this fixture) is dropped.
    expect(response.matches[0]).toEqual({ cardId: 55144522, name: 'Pot of Greed', imageId: 55144522 });
    expect(response.matches.map((m) => m.cardId)).not.toContain(53129443);
  });

  it('returns no matches for a blank query, without reading the card store at all', async () => {
    const deps = makeDeps();

    const response = await handleMessage({ type: 'search-cards', query: '   ' }, sender, deps);

    expect(response).toEqual({ matches: [] });
    expect(deps.cardStore.getAllNames).not.toHaveBeenCalled();
  });

  it('returns no matches instead of rejecting when the card store throws', async () => {
    const deps = makeDeps({ cardStore: { getAllNames: vi.fn().mockRejectedValue(new Error('IndexedDB is gone')) } });

    const response = await handleMessage({ type: 'search-cards', query: 'dark hole' }, sender, deps);

    expect(response).toEqual({ matches: [] });
  });

  // Review fix 2: an unbounded query would scale a Levenshtein fallback's cost with its length;
  // 60 characters is far past any real card name, so anything beyond that is simply dropped.
  it('caps the query length before matching, instead of scaling the match cost with it', async () => {
    const longName = 'a'.repeat(60);
    const deps = makeDeps({
      cardStore: {
        getAllNames: vi.fn().mockResolvedValue([{ id: 1, name: longName }, { id: 2, name: 'Pot of Greed' }]),
        getCards: vi.fn().mockResolvedValue({ 1: card(1, longName), 2: card(2, 'Pot of Greed') }),
      },
    });

    // Only the first 60 characters of this 5000-character query should ever reach the matcher - if
    // they didn't, this wouldn't be a token-prefix match (a 60-char name can't start with a longer
    // query token) and would fall to a weak fuzzy score instead of leading the results.
    const response = (await handleMessage({ type: 'search-cards', query: longName + 'b'.repeat(5000) }, sender, deps)) as {
      matches: { cardId: number }[];
    };

    expect(response.matches[0]).toEqual({ cardId: 1, name: longName, imageId: 1 });
  });

  // Review fix 2: don't reload all ~14.6k card names from IndexedDB on every keystroke's search -
  // keep them in memory, and only re-check cheaply (getMeta) whether the card database changed.
  it('loads the card names once and reuses them for later searches with the same card database', async () => {
    const getAllNames = vi.fn().mockResolvedValue([{ id: 1, name: 'Pot of Greed' }]);
    const getMeta = vi.fn().mockResolvedValue({ cardCount: 1, dbVersion: 'v1' });
    const deps = makeDeps({ cardStore: { getAllNames, getMeta, getCards: vi.fn().mockResolvedValue({ 1: card(1, 'Pot of Greed') }) } });

    await handleMessage({ type: 'search-cards', query: 'pot' }, sender, deps);
    await handleMessage({ type: 'search-cards', query: 'greed' }, sender, deps);

    expect(getAllNames).toHaveBeenCalledTimes(1);
    expect(getMeta.mock.calls.length).toBeGreaterThanOrEqual(2); // cheap enough to check every time
  });

  it('reloads the names once the card database version changes', async () => {
    const getAllNames = vi.fn().mockResolvedValue([{ id: 1, name: 'Pot of Greed' }]);
    const getMeta = vi.fn().mockResolvedValueOnce({ cardCount: 1, dbVersion: 'v1' }).mockResolvedValueOnce({ cardCount: 2, dbVersion: 'v2' });
    const deps = makeDeps({ cardStore: { getAllNames, getMeta, getCards: vi.fn().mockResolvedValue({ 1: card(1, 'Pot of Greed') }) } });

    await handleMessage({ type: 'search-cards', query: 'pot' }, sender, deps);
    await handleMessage({ type: 'search-cards', query: 'pot' }, sender, deps);

    expect(getAllNames).toHaveBeenCalledTimes(2);
  });
});

describe('a match on an artwork YGOPRODeck lacks (a synthetic imageId, src/shared/alt-artwork.ts)', () => {
  const artemis: CardRecord = { ...card(34755994, 'Artemis, the Magistus Moon Maiden'), konamiId: 15619 };
  const ash: CardRecord = { ...card(14558127, 'Ash Blossom & Joyous Spring'), konamiId: 12950, imageIds: [14558127, 14558128] };
  const cards = { 34755994: artemis, 14558127: ash };
  const scan = (result: RecognitionResult, deps: RouterDeps) =>
    handleMessage({ type: 'recognize', crop, context: { pageUrl: 'https://x', pageTitle: 't' } }, sender, deps) as Promise<RecognizeResponse>;

  it("answers and records the card's own first YGOPRODeck image, never the synthetic id", async () => {
    const result: RecognitionResult = {
      candidates: [
        { cardId: 34755994, imageId: altArtworkId(15619, 2), score: 0.91 },
        { cardId: 14558127, imageId: 14558128, score: 0.6 },
      ],
      confident: true,
      faceDown: false,
      modelId: 'm',
      timings: {},
    };
    const deps = makeDeps({ offscreen: { recognize: vi.fn().mockResolvedValue(result) }, cardStore: { getCards: vi.fn().mockResolvedValue(cards) } });

    const response = await scan(result, deps);

    // the popover's card view reads candidates[0]; a YGOPRODeck alternate (14558128) stays as it is
    expect(response.result.candidates).toEqual([
      { cardId: 34755994, imageId: 34755994, score: 0.91 },
      { cardId: 14558127, imageId: 14558128, score: 0.6 },
    ]);
    // the history entry, which the side panel shows
    expect(response.entry).toMatchObject({ cardId: 34755994, imageId: 34755994 });
    expect(deps.history.addEntry).toHaveBeenCalledWith(expect.objectContaining({ cardId: 34755994, imageId: 34755994 }));
    expect(result.candidates[0].imageId).toBe(altArtworkId(15619, 2)); // the engine's own result isn't changed
  });

  it('maps every card of a "Low match" or "Not sure" list', async () => {
    const result: RecognitionResult = {
      candidates: [
        { cardId: 14558127, imageId: altArtworkId(12950, 3), score: 0.71 },
        { cardId: 34755994, imageId: altArtworkId(15619, 2), score: 0.69 },
      ],
      confident: false,
      faceDown: false,
      suggested: true,
      modelId: 'm',
      timings: {},
    };
    const deps = makeDeps({ offscreen: { recognize: vi.fn().mockResolvedValue(result) }, cardStore: { getCards: vi.fn().mockResolvedValue(cards) } });

    const response = await scan(result, deps);

    expect(response.result.candidates.map((c) => c.imageId)).toEqual([14558127, 34755994]);
    expect(response.result.suggested).toBe(true);
    expect(response.entry).toMatchObject({ cardId: 14558127, imageId: 14558127, confident: false });
  });

  it("a correction naming a synthetic id records the card's image", async () => {
    const deps = makeDeps({ cardStore: { getCards: vi.fn().mockResolvedValue({ 34755994: artemis }) } });

    const response = await handleMessage({ type: 'correct', entryId: 'e1', cardId: 34755994, imageId: altArtworkId(15619, 2) }, sender, deps);

    expect(deps.history.updateEntry).toHaveBeenCalledWith('e1', { cardId: 34755994, imageId: 34755994, corrected: true });
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

describe('show-board', () => {
  const near = { cardId: 14558127, imageId: 14558127, side: 'near', state: 'sure' } as const;
  const far = { cardId: 46986414, imageId: 46986416, side: 'far', state: 'low' } as const;
  /** The card store has every card asked for, unless told otherwise. */
  const boardDeps = (o: Parameters<typeof makeDeps>[0] = {}) =>
    makeDeps({
      ...o,
      cardStore: {
        getCards: vi.fn(async (ids: number[]) => Object.fromEntries(ids.map((id) => [id, card(id, `Card ${id}`)]))),
        ...o.cardStore,
      },
    });

  it('opens the side panel in the sender tab/window, then keeps the board for it (with when it came)', async () => {
    const order: string[] = [];
    const deps = boardDeps({
      sidePanel: { open: vi.fn(async () => void order.push('open')) },
      board: { save: vi.fn(async () => void order.push('save')) },
    });
    const response = await handleMessage({ type: 'show-board', board: [near, far] }, { tab: { windowId: 1, id: 2 } } as chrome.runtime.MessageSender, deps);
    expect(response).toEqual({ ok: true });
    expect(deps.sidePanel.open).toHaveBeenCalledWith({ windowId: 1, tabId: 2 });
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [near, far], at: 1700000000000 });
    // sidePanel.open() first: an await before it can use up the user gesture.
    expect(order).toEqual(['open', 'save']);
  });

  it('records nothing: no history entry, no current card (a board is a peek)', async () => {
    const deps = boardDeps();
    await handleMessage({ type: 'show-board', board: [near] }, sender, deps);
    expect(deps.history.addEntry).not.toHaveBeenCalled();
    expect(deps.history.setCurrent).not.toHaveBeenCalled();
    expect(deps.crops.save).not.toHaveBeenCalled();
  });

  it('keeps the board and says how to open the panel when it cannot open (no user gesture left)', async () => {
    const deps = boardDeps({ sidePanel: { open: vi.fn().mockRejectedValue(new Error('user gesture required')) } });
    const response = await handleMessage({ type: 'show-board', board: [near] }, sender, deps);
    expect(response).toEqual({ ok: false, error: 'The board is ready: press Alt+Shift+U to open the side panel' });
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [near], at: 1700000000000 });
  });

  it('says so when the board cannot be kept', async () => {
    const deps = boardDeps({ board: { save: vi.fn().mockRejectedValue(new Error('quota')) } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handleMessage({ type: 'show-board', board: [near] }, sender, deps);
    expect(response).toEqual({ ok: false, error: "Couldn't keep the board for the side panel." });
  });

  it.each([
    ['not a list', { cards: [near] }],
    ['a card with a fractional id', [{ ...near, cardId: 1.5 }]],
    ['a card with a string id', [{ ...near, imageId: '14558127' }]],
    ['an unknown side', [{ ...near, side: 'left' }]],
    ['an unknown state', [{ ...near, state: 'certain' }]],
    ['a null card', [null]],
    ['more cards than any board holds (60)', Array.from({ length: 61 }, () => near)],
  ])('refuses a board that is %s, without opening the panel or keeping anything', async (_, board) => {
    const deps = boardDeps();
    const response = await handleMessage({ type: 'show-board', board } as unknown as ToBackground, sender, deps);
    expect(response).toEqual({ ok: false, error: 'That board could not be read.' });
    expect(deps.sidePanel.open).not.toHaveBeenCalled();
    expect(deps.board.save).not.toHaveBeenCalled();
  });

  it('keeps only the fields a board card has', async () => {
    const deps = boardDeps();
    await handleMessage({ type: 'show-board', board: [{ ...near, name: '<img onerror>', extra: 1 }] } as unknown as ToBackground, sender, deps);
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [near], at: 1700000000000 });
  });

  // The key press's message: the panel opens while the user's gesture lasts, and says "Reading the board…".
  it('opens the panel for the press\'s empty board and keeps it marked as being read', async () => {
    const deps = boardDeps();
    const response = await handleMessage({ type: 'show-board', board: [], reading: true }, { tab: { windowId: 1, id: 2 } } as chrome.runtime.MessageSender, deps);
    expect(response).toEqual({ ok: true });
    expect(deps.sidePanel.open).toHaveBeenCalledWith({ windowId: 1, tabId: 2 });
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [], at: 1700000000000, reading: true });
  });

  it.each([
    ['cards with it', { type: 'show-board', board: [near], reading: true }],
    ['a flag that is not true', { type: 'show-board', board: [], reading: 'yes' }],
  ])('refuses a "reading" board with %s', async (_, msg) => {
    const deps = boardDeps();
    expect(await handleMessage(msg as unknown as ToBackground, sender, deps)).toEqual({ ok: false, error: 'That board could not be read.' });
    expect(deps.sidePanel.open).not.toHaveBeenCalled();
    expect(deps.board.save).not.toHaveBeenCalled();
  });

  // Review B2: the panel would say "Loading…" for good for a card the card data lacks.
  it('drops cards the card data does not have, checking each id once', async () => {
    const getCards = vi.fn(async (ids: number[]): Promise<Record<number, CardRecord>> => (ids.includes(near.cardId) ? { [near.cardId]: card(near.cardId, 'Ash Blossom') } : {}));
    const deps = boardDeps({ cardStore: { getCards } });
    expect(await handleMessage({ type: 'show-board', board: [near, far, near] }, sender, deps)).toEqual({ ok: true });
    expect(getCards).toHaveBeenCalledTimes(1);
    expect(getCards.mock.calls[0][0].sort()).toEqual([near.cardId, far.cardId].sort());
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [near, near], at: 1700000000000 });
  });

  it('keeps the board unchecked when the card data cannot be read (the panel says "Unknown card" then)', async () => {
    const deps = boardDeps({ cardStore: { getCards: vi.fn().mockRejectedValue(new Error('idb closed')) } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await handleMessage({ type: 'show-board', board: [near, far] }, sender, deps)).toEqual({ ok: true });
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [near, far], at: 1700000000000 });
  });

  it('opens the panel before checking the card ids (the gesture would be gone after)', async () => {
    const order: string[] = [];
    const deps = boardDeps({
      sidePanel: { open: vi.fn(async () => void order.push('open')) },
      cardStore: { getCards: vi.fn(async () => (order.push('check'), { [near.cardId]: card(near.cardId, 'Ash Blossom') })) },
    });
    await handleMessage({ type: 'show-board', board: [near] }, sender, deps);
    expect(order).toEqual(['open', 'check']);
  });

  it('keeps an empty board (the panel then says no card was read)', async () => {
    const deps = boardDeps();
    expect(await handleMessage({ type: 'show-board', board: [] }, sender, deps)).toEqual({ ok: true });
    expect(deps.board.save).toHaveBeenCalledWith({ cards: [], at: 1700000000000 });
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

describe('card text language (TEXT-LANG)', () => {
  const french = { ...DEFAULT_SETTINGS, display: { ...DEFAULT_SETTINGS.display, cardLanguage: 'fr' as const } };
  const pot = card(55144522, 'Pot of Greed');
  const potFr: CardRecord = { ...pot, name: 'Pot de Cupidité', translated: { lang: 'fr', nameEn: 'Pot of Greed' } };
  const result: RecognitionResult = { candidates: [{ cardId: pot.id, imageId: pot.id, score: 0.9 }], confident: true, faceDown: false, modelId: 'm', timings: {} };
  const localize = () => vi.fn(async (cards: Record<number, CardRecord>) => (cards[pot.id] ? { ...cards, [pot.id]: potFr } : cards));

  it('sends recognize and get-cards answers in the chosen language, recording history by id', async () => {
    const deps = makeDeps({
      offscreen: { recognize: vi.fn().mockResolvedValue(result) },
      cardStore: { getCards: vi.fn().mockResolvedValue({ [pot.id]: pot }) },
      settings: { get: vi.fn().mockResolvedValue(french) },
      cardText: { localize: localize() },
    });
    const recognized = (await handleMessage({ type: 'recognize', crop, context: { pageUrl: 'u', pageTitle: 't' } }, sender, deps)) as RecognizeResponse;
    expect(recognized.cards[pot.id]).toEqual(potFr);
    expect(deps.cardText.localize).toHaveBeenCalledWith({ [pot.id]: pot }, 'fr');
    expect(deps.history.addEntry).toHaveBeenCalledWith(expect.objectContaining({ cardId: pot.id }));

    const got = await handleMessage({ type: 'get-cards', ids: [pot.id] }, sender, deps);
    expect(got).toEqual({ cards: { [pot.id]: potFr } });
  });

  it("doesn't touch the cards for English", async () => {
    const deps = makeDeps({ cardStore: { getCards: vi.fn().mockResolvedValue({ [pot.id]: pot }) } });
    expect(await handleMessage({ type: 'get-cards', ids: [pot.id] }, sender, deps)).toEqual({ cards: { [pot.id]: pot } });
    expect(deps.cardText.localize).not.toHaveBeenCalled();
  });

  it("shows English when the pack can't be read", async () => {
    const deps = makeDeps({
      cardStore: { getCards: vi.fn().mockResolvedValue({ [pot.id]: pot }) },
      settings: { get: vi.fn().mockResolvedValue(french) },
      cardText: { localize: vi.fn().mockRejectedValue(new Error('IndexedDB is blocked')) },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await handleMessage({ type: 'get-cards', ids: [pot.id] }, sender, deps)).toEqual({ cards: { [pot.id]: pot } });
  });

  it('keeps Ask AI in English: the candidate names it sends and the name it matches', async () => {
    const deps = makeDeps({
      cardStore: {
        getCards: vi.fn().mockResolvedValue({ [pot.id]: pot }),
        getAllNames: vi.fn().mockResolvedValue([{ id: pot.id, name: 'Pot of Greed' }]),
      },
      settings: { get: vi.fn().mockResolvedValue(french) },
      cardText: { localize: localize() },
      ai: { identify: vi.fn().mockResolvedValue({ name: 'Pot of Greed', confident: true }) },
    });
    const response = await handleMessage({ type: 'ask-ai', crop, candidates: [{ cardId: pot.id, imageId: pot.id, score: 0.4 }] }, sender, deps);
    expect(deps.ai.identify).toHaveBeenCalledWith(crop, ['Pot of Greed'], french, expect.anything());
    expect(response).toEqual({ cardId: pot.id, imageId: pot.id, answer: 'Pot of Greed', confident: true });
    expect(deps.cardText.localize).not.toHaveBeenCalled();
  });
});
