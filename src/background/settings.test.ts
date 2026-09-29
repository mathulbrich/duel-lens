import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/types';
import { getSettings, setSettings } from './settings';

function fakeStorageArea() {
  let data: Record<string, unknown> = {};
  return {
    get: vi.fn(async (key: string) => ({ [key]: data[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = { ...data, ...items };
    }),
  };
}

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
    });
  });
});
