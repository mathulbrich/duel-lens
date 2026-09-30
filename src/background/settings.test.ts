import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../shared/types';
import { getSettings, isRevealMode, setSettings } from './settings';

function fakeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

/** Puts `value` in storage as the stored settings object, as an older (or newer) version may have left it. */
const store = (value: unknown) => chrome.storage.local.set({ settings: value });

beforeEach(() => {
  vi.stubGlobal('chrome', { storage: { local: fakeStorageArea() } });
});

describe('getSettings', () => {
  it('returns the defaults when nothing is stored', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('fills in missing fields of a partially-stored settings object', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'sk-123', model: DEFAULT_SETTINGS.ai.model } });
    const settings = await getSettings();
    expect(settings.ai).toEqual({ enabled: true, apiKey: 'sk-123', model: DEFAULT_SETTINGS.ai.model });
    expect(settings.debug).toEqual(DEFAULT_SETTINGS.debug);
  });
});

describe('setSettings', () => {
  it('merges a partial patch onto the current settings and persists it', async () => {
    await setSettings({ debug: { saveCrops: true } });
    await setSettings({ ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' } });
    const settings = await getSettings();
    expect(settings).toEqual({
      ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' },
      debug: { saveCrops: true },
      display: { reveal: 'hover' },
    });
  });
});

// "Show card details" (Options): how a card's details show in scan mode. The content script gets it with
// begin-selection (scan.ts), so what is stored must always be a mode this version knows.
describe('display.reveal', () => {
  it("is 'hover' (Hover or click) by default", async () => {
    expect((await getSettings()).display).toEqual({ reveal: 'hover' });
  });

  it("gives settings stored by an older version (no display) the default, keeping the rest", async () => {
    await store({ ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' }, debug: { saveCrops: true } });

    expect(await getSettings()).toEqual({
      ai: { enabled: true, apiKey: 'sk-old', model: 'claude-sonnet-5' },
      debug: { saveCrops: true },
      display: { reveal: 'hover' },
    });
  });

  it("keeps a stored 'click'", async () => {
    await store({ display: { reveal: 'click' } });
    expect((await getSettings()).display.reveal).toBe('click');
  });

  it.each([['always'], ['Hover'], [''], [42], [null], [true], [{ mode: 'click' }]])(
    "reads an unknown stored mode (%j) as 'hover'",
    async (reveal) => {
      await store({ display: { reveal } });
      expect((await getSettings()).display.reveal).toBe('hover');
    },
  );

  it("reads a stored display without a mode as 'hover'", async () => {
    await store({ display: {} });
    expect((await getSettings()).display).toEqual({ reveal: 'hover' });
  });

  it('saves a change of mode alone, and a later change elsewhere keeps it', async () => {
    await setSettings({ ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' } });
    await setSettings({ display: { reveal: 'click' } });
    await setSettings({ debug: { saveCrops: true } });

    expect(await getSettings()).toEqual({
      ai: { enabled: true, apiKey: 'k', model: 'claude-opus-5' },
      debug: { saveCrops: true },
      display: { reveal: 'click' },
    });
  });

  it("never stores an unknown mode: setSettings saves (and answers) 'hover' instead", async () => {
    await setSettings({ display: { reveal: 'click' } });
    const answer = await setSettings({ display: { reveal: 'always' as Settings['display']['reveal'] } });

    expect(answer.display.reveal).toBe('hover');
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({ settings: expect.objectContaining({ display: { reveal: 'hover' } }) });
  });

  it('a later write repairs an unknown stored mode', async () => {
    await store({ display: { reveal: 'always' } });
    await setSettings({ debug: { saveCrops: true } });

    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({ settings: expect.objectContaining({ display: { reveal: 'hover' } }) });
  });
});

describe('isRevealMode', () => {
  it("accepts only 'hover' and 'click'", () => {
    expect(['hover', 'click'].filter(isRevealMode)).toEqual(['hover', 'click']);
    for (const v of ['always', 'HOVER', '', undefined, null, 1, {}]) expect(isRevealMode(v)).toBe(false);
  });
});
