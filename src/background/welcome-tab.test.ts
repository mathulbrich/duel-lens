import { describe, expect, it, vi } from 'vitest';
import { openWelcome, type WelcomeTabDeps } from './welcome-tab';

const BASE = 'chrome-extension://abc/welcome.html';

function fakeDeps(overrides: Partial<WelcomeTabDeps> = {}): WelcomeTabDeps {
  return {
    welcomeUrl: () => BASE,
    openTabs: vi.fn().mockResolvedValue([]),
    createTab: vi.fn().mockResolvedValue({ id: 11, windowId: 2 }),
    updateTab: vi.fn().mockResolvedValue(undefined),
    focusWindow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const userTab = { id: 7, windowId: 2, index: 4 } as chrome.tabs.Tab;

describe('openWelcome', () => {
  it('opens welcome.html#consent in front, next to the tab the user tried to scan', async () => {
    const deps = fakeDeps();

    await openWelcome({ hash: 'consent', nextTo: userTab }, deps);

    expect(deps.createTab).toHaveBeenCalledWith({ url: `${BASE}#consent`, active: true, windowId: 2, index: 5 });
    expect(deps.focusWindow).toHaveBeenCalledWith(2);
    expect(deps.updateTab).not.toHaveBeenCalled();
  });

  it('brings a welcome page that is already open to the front, at the consent step, instead of opening another', async () => {
    const deps = fakeDeps({ openTabs: vi.fn().mockResolvedValue([{ tabId: 9, windowId: 3, documentUrl: BASE }]) });

    await openWelcome({ hash: 'consent', nextTo: userTab }, deps);

    expect(deps.updateTab).toHaveBeenCalledWith(9, { url: `${BASE}#consent`, active: true });
    expect(deps.focusWindow).toHaveBeenCalledWith(3);
    expect(deps.createTab).not.toHaveBeenCalled();
  });

  it('recognises an open welcome page by its address without the #part', async () => {
    const deps = fakeDeps({
      openTabs: vi.fn().mockResolvedValue([
        { tabId: 4, windowId: 1, documentUrl: 'chrome-extension://abc/options.html' },
        { tabId: 9, windowId: 3, documentUrl: `${BASE}#consent` },
      ]),
    });

    await openWelcome({ hash: 'consent' }, deps);

    expect(deps.updateTab).toHaveBeenCalledWith(9, { url: `${BASE}#consent`, active: true });
  });

  it('opens a tab anyway when the open pages cannot be listed', async () => {
    const deps = fakeDeps({ openTabs: vi.fn().mockRejectedValue(new Error('getContexts is not available')) });

    await openWelcome({ hash: 'consent' }, deps);

    expect(deps.createTab).toHaveBeenCalledWith({ url: `${BASE}#consent`, active: true });
  });

  it('opens the plain welcome page without a #part', async () => {
    const deps = fakeDeps();

    await openWelcome({}, deps);

    expect(deps.createTab).toHaveBeenCalledWith({ url: BASE, active: true });
  });
});
