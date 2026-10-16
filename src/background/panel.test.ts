import { describe, expect, it, vi } from 'vitest';
import { openPanel, type PanelDeps } from './panel';

const BASE = 'chrome-extension://abc/sidepanel.html';

function fakeDeps(overrides: Partial<PanelDeps> = {}): PanelDeps {
  return {
    sidePanelOpen: undefined,
    sidebarOpen: undefined,
    panelUrl: () => BASE,
    openTabs: vi.fn().mockResolvedValue([]),
    createWindow: vi.fn().mockResolvedValue({ id: 11 }),
    focusWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('openPanel', () => {
  describe('with chrome.sidePanel (Chrome, Edge)', () => {
    it('is a straight passthrough, and never looks at the popup fallback', async () => {
      const sidePanelOpen = vi.fn().mockResolvedValue(undefined);
      const deps = fakeDeps({ sidePanelOpen });

      await openPanel({ windowId: 1, tabId: 2 }, deps);

      expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 1, tabId: 2 });
      expect(deps.openTabs).not.toHaveBeenCalled();
      expect(deps.createWindow).not.toHaveBeenCalled();
    });

    it('propagates a rejection (no active user gesture) instead of falling back', async () => {
      const deps = fakeDeps({ sidePanelOpen: vi.fn().mockRejectedValue(new Error('user gesture required')) });

      await expect(openPanel({ windowId: 1, tabId: 2 }, deps)).rejects.toThrow('user gesture required');
      expect(deps.createWindow).not.toHaveBeenCalled();
    });
  });

  describe('without chrome.sidePanel (Opera, as of writing)', () => {
    it('opens a popup window on sidepanel.html, carrying the tab id', async () => {
      const deps = fakeDeps();

      await openPanel({ windowId: 1, tabId: 2 }, deps);

      expect(deps.createWindow).toHaveBeenCalledWith({ url: `${BASE}?tabId=2`, type: 'popup', width: 420, height: 640 });
      expect(deps.focusWindow).toHaveBeenCalledWith(11);
    });

    it('opens the plain page when no tab id is given', async () => {
      const deps = fakeDeps();

      await openPanel({ windowId: 1 }, deps);

      expect(deps.createWindow).toHaveBeenCalledWith({ url: BASE, type: 'popup', width: 420, height: 640 });
    });

    it('reuses and focuses a popup that is already open, instead of opening another', async () => {
      const deps = fakeDeps({ openTabs: vi.fn().mockResolvedValue([{ tabId: 9, windowId: 3, documentUrl: `${BASE}?tabId=2` }]) });

      await openPanel({ windowId: 1, tabId: 2 }, deps);

      expect(deps.focusWindow).toHaveBeenCalledWith(3);
      expect(deps.createWindow).not.toHaveBeenCalled();
    });

    it('recognises an open popup by its address without the ?query part', async () => {
      const deps = fakeDeps({
        openTabs: vi.fn().mockResolvedValue([
          { tabId: 4, windowId: 1, documentUrl: 'chrome-extension://abc/options.html' },
          { tabId: 9, windowId: 3, documentUrl: `${BASE}?tabId=5` },
        ]),
      });

      await openPanel({ windowId: 1, tabId: 2 }, deps);

      expect(deps.focusWindow).toHaveBeenCalledWith(3);
      expect(deps.createWindow).not.toHaveBeenCalled();
    });

    it('opens a popup anyway when the open pages cannot be listed', async () => {
      const deps = fakeDeps({ openTabs: vi.fn().mockRejectedValue(new Error('getContexts is not available')) });

      await openPanel({ windowId: 1, tabId: 2 }, deps);

      expect(deps.createWindow).toHaveBeenCalledWith({ url: `${BASE}?tabId=2`, type: 'popup', width: 420, height: 640 });
    });

    it('does not fail the whole open when focusing the new window throws', async () => {
      const deps = fakeDeps({ focusWindow: vi.fn().mockRejectedValue(new Error('window gone')) });

      await expect(openPanel({ windowId: 1, tabId: 2 }, deps)).resolves.toBeUndefined();
    });

    it('propagates a rejection when the popup window itself cannot be created', async () => {
      const deps = fakeDeps({ createWindow: vi.fn().mockRejectedValue(new Error('popups blocked')) });

      await expect(openPanel({ windowId: 1, tabId: 2 }, deps)).rejects.toThrow('popups blocked');
    });
  });

  describe("with Firefox's sidebar (sidebar_action)", () => {
    it('opens the sidebar, called at once (within the user input), and nothing else', async () => {
      const order: string[] = [];
      const sidebarOpen = vi.fn(() => {
        order.push('sidebar');
        return Promise.resolve();
      });
      const deps = fakeDeps({ sidebarOpen, panelUrl: () => (order.push('url'), BASE) });

      const opened = openPanel({ windowId: 1, tabId: 2 }, deps);
      expect(sidebarOpen).toHaveBeenCalledTimes(1); // synchronously, before openPanel's first await
      await opened;

      expect(order).toEqual(['sidebar']);
      expect(deps.openTabs).not.toHaveBeenCalled();
      expect(deps.createWindow).not.toHaveBeenCalled();
    });

    it('opens the popup window instead when Firefox refuses the sidebar (no user input)', async () => {
      const sidebarOpen = vi.fn().mockRejectedValue(new Error('sidebarAction.open may only be called from a user input handler'));
      const deps = fakeDeps({ sidebarOpen });

      await openPanel({ windowId: 1, tabId: 2 }, deps);

      expect(deps.createWindow).toHaveBeenCalledWith({ url: `${BASE}?tabId=2`, type: 'popup', width: 420, height: 640 });
    });

    it('prefers chrome.sidePanel when a browser has both', async () => {
      const sidePanelOpen = vi.fn().mockResolvedValue(undefined);
      const sidebarOpen = vi.fn().mockResolvedValue(undefined);
      await openPanel({ windowId: 1 }, fakeDeps({ sidePanelOpen, sidebarOpen }));
      expect(sidePanelOpen).toHaveBeenCalled();
      expect(sidebarOpen).not.toHaveBeenCalled();
    });
  });
});
