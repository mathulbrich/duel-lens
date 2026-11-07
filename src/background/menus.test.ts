import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_MENU, createActionMenus, setLiveCheckMenu } from './menus';

beforeEach(() => {
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    contextMenus: {
      removeAll: vi.fn((done?: () => void) => done?.()),
      create: vi.fn((_props: unknown, done?: () => void) => done?.()),
      update: vi.fn((_id: string, _props: unknown, done?: () => void) => done?.()),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('createActionMenus', () => {
  it("clears the menu and puts the find-card item and the Live check switch in the toolbar icon's menu", () => {
    createActionMenus(true);
    expect(chrome.contextMenus.removeAll).toHaveBeenCalledTimes(1);
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({ id: 'find-card', title: 'Find a card by name…', contexts: ['action'] }, expect.any(Function));
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({ id: LIVE_MENU, type: 'checkbox', checked: true, title: 'Live check', contexts: ['action'] }, expect.any(Function));
  });
});

describe('setLiveCheckMenu', () => {
  it('ticks the Live check item, and not', () => {
    setLiveCheckMenu(true);
    expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(LIVE_MENU, { checked: true }, expect.any(Function));
    setLiveCheckMenu(false);
    expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(LIVE_MENU, { checked: false }, expect.any(Function));
  });

  it('does not throw when the menu has no such item (before onInstalled made it)', () => {
    vi.mocked(chrome.contextMenus.update).mockImplementation((() => {
      throw new Error('Cannot find menu item');
    }) as never);
    expect(() => setLiveCheckMenu(true)).not.toThrow();
  });
});
