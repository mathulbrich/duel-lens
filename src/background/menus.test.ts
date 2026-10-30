import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_MENU, createActionMenus, setLiveMenuRunning } from './menus';

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
  it("clears the menu and puts the find-card and Live items in the toolbar icon's menu", () => {
    createActionMenus();
    expect(chrome.contextMenus.removeAll).toHaveBeenCalledTimes(1);
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({ id: 'find-card', title: 'Find a card by name…', contexts: ['action'] }, expect.any(Function));
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({ id: LIVE_MENU, title: 'Start Live on this tab', contexts: ['action'] }, expect.any(Function));
  });
});

describe('setLiveMenuRunning', () => {
  it('flips the item to Stop Live and back', () => {
    setLiveMenuRunning(true);
    expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(LIVE_MENU, { title: 'Stop Live' }, expect.any(Function));
    setLiveMenuRunning(false);
    expect(chrome.contextMenus.update).toHaveBeenLastCalledWith(LIVE_MENU, { title: 'Start Live on this tab' }, expect.any(Function));
  });

  it('does not throw when the menu has no such item (before onInstalled made it)', () => {
    vi.mocked(chrome.contextMenus.update).mockImplementation((() => {
      throw new Error('Cannot find menu item');
    }) as never);
    expect(() => setLiveMenuRunning(true)).not.toThrow();
  });
});
