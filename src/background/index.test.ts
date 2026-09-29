import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// `./scan` is mocked so importing index.ts (which wires real chrome.* listeners and
// calls startScan from a couple of places) never touches captureVisibleTab et al.;
// that flow already has its own thorough tests in scan.test.ts. This file only checks
// the E2E debug hook the lead asked for: Puppeteer can't press a keyboard shortcut, so
// `duelLensDebug.startScan` gives the E2E test the same entry point `scan-card` uses.
vi.mock('./scan', () => ({ startScan: vi.fn().mockResolvedValue(undefined) }));
// `./router` is mocked for the onMessage tests below, so they can drive handleMessage's
// resolve/reject timing directly without exercising the real card store/offscreen flow
// (already covered by router.test.ts).
vi.mock('./router', () => ({ handleMessage: vi.fn() }));
// `./card-store` is mocked for the onInstalled tests below, so they can check the alarm
// guard without a real IndexedDB (card-store.test.ts already covers ensureSeeded/refreshIfChanged).
vi.mock('./card-store', () => ({
  ensureSeeded: vi.fn().mockResolvedValue(undefined),
  loadBundledCards: vi.fn(),
  refreshIfChanged: vi.fn().mockResolvedValue('unchanged'),
}));
// `./index-update` is mocked for the onInstalled/onStartup/onAlarm tests below, so they can
// check *whether* an index update was triggered without exercising a real run
// (index-update.test.ts already covers runIndexUpdate/runIndexUpdateIfStale themselves).
vi.mock('./index-update', () => ({
  runIndexUpdate: vi.fn().mockResolvedValue(undefined),
  runIndexUpdateIfStale: vi.fn().mockResolvedValue(undefined),
}));
// `./offscreen-client` is mocked for the idle-alarm test below (offscreen-client.test.ts covers
// the close itself).
vi.mock('./offscreen-client', () => ({
  OFFSCREEN_IDLE_ALARM: 'close-idle-offscreen',
  closeOffscreenIfIdle: vi.fn().mockResolvedValue(undefined),
}));

function addListenerSpy() {
  return { addListener: vi.fn() };
}

function fakeChrome() {
  return {
    runtime: {
      id: 'abc',
      onInstalled: addListenerSpy(),
      onStartup: addListenerSpy(),
      onMessage: addListenerSpy(),
      getURL: (p: string) => `chrome-extension://abc/${p}`,
    },
    alarms: { onAlarm: addListenerSpy(), create: vi.fn(), get: vi.fn().mockResolvedValue(undefined) },
    commands: { onCommand: addListenerSpy() },
    action: { onClicked: addListenerSpy() },
    tabs: {
      get: vi.fn().mockResolvedValue({ id: 5, windowId: 1 }),
      query: vi.fn().mockResolvedValue([{ id: 9, windowId: 2 }]),
      create: vi.fn().mockResolvedValue({ id: 12, windowId: 1 }),
    },
    sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
    storage: { local: { setAccessLevel: vi.fn().mockResolvedValue(undefined), set: vi.fn().mockResolvedValue(undefined) } },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('chrome', fakeChrome());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { duelLensDebug?: unknown }).duelLensDebug;
});

describe('storage access', () => {
  // The settings (the user's Claude API key) and the scan history live in chrome.storage.local,
  // which content scripts, running in page renderers, can read by default.
  it('restricts chrome.storage.local to extension pages and the service worker at start-up', async () => {
    await import('./index');
    const local = (chrome as unknown as { storage: { local: { setAccessLevel: Mock } } }).storage.local;
    await vi.waitFor(() => expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' }));
  });

  it('still starts when this Chrome cannot restrict chrome.storage.local, and says so as an error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    (chrome as unknown as { storage: { local: object } }).storage.local = {};
    await expect(import('./index')).resolves.toBeDefined();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not restrict chrome\.storage\.local/), expect.anything()));
    error.mockRestore();
  });

  // Security review L1: until the restriction is in place, a content script could read the settings
  // (the API key). No message is handled, so no settings read happens, before it is.
  describe('message handling waits for the restriction', () => {
    const CONTENT = { id: 'abc', url: 'https://www.youtube.com/watch?v=x', tab: { id: 5, windowId: 1 } };
    type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean;
    const listenerOf = () => (chrome.runtime.onMessage.addListener as Mock).mock.calls[0][0] as Listener;
    const local = () => (chrome as unknown as { storage: { local: { setAccessLevel: Mock } } }).storage.local;

    it('handles no message until setAccessLevel has resolved', async () => {
      let lock!: () => void;
      local().setAccessLevel.mockReturnValue(new Promise<void>((resolve) => (lock = resolve)));
      const { handleMessage } = await import('./router');
      (handleMessage as Mock).mockResolvedValue({ ok: true });
      await import('./index');
      const sendResponse = vi.fn();

      expect(listenerOf()({ type: 'open-options' }, CONTENT, sendResponse)).toBe(true);
      await new Promise((r) => setTimeout(r, 10));
      expect(handleMessage).not.toHaveBeenCalled();

      lock();
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
      expect(handleMessage).toHaveBeenCalledTimes(1);
    });

    it('still handles messages when setAccessLevel rejects, after logging an error', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      local().setAccessLevel.mockRejectedValue(new Error('not supported'));
      const { handleMessage } = await import('./router');
      (handleMessage as Mock).mockResolvedValue({ ok: true });
      await import('./index');
      const sendResponse = vi.fn();

      listenerOf()({ type: 'open-options' }, CONTENT, sendResponse);

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not restrict chrome\.storage\.local/), expect.any(Error));
      error.mockRestore();
    });

    // "Keep in side panel": sidePanel.open() needs the user gesture its message carries, so once the
    // restriction is in place a message goes to the router at once, not a turn later.
    it('hands a message to the router synchronously once the restriction is in place', async () => {
      const { handleMessage } = await import('./router');
      (handleMessage as Mock).mockResolvedValue({ ok: true });
      await import('./index');
      await vi.waitFor(() => expect(local().setAccessLevel).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0)); // let it settle

      listenerOf()({ type: 'show-in-panel', entryId: 'e1' }, CONTENT, vi.fn());

      expect(handleMessage).toHaveBeenCalledWith({ type: 'show-in-panel', entryId: 'e1' }, CONTENT);
    });
  });
});

describe('duelLensDebug', () => {
  it('exists after the background module loads, and delegates to startScan for an explicit tab id', async () => {
    await import('./index');
    const { startScan } = await import('./scan');

    expect((globalThis as any).duelLensDebug).toBeDefined();
    await (globalThis as any).duelLensDebug.startScan(5);

    expect(chrome.tabs.get).toHaveBeenCalledWith(5);
    expect(startScan).toHaveBeenCalledWith({ id: 5, windowId: 1 });
  });

  it('resolves the active tab when no tab id is given', async () => {
    await import('./index');
    const { startScan } = await import('./scan');

    await (globalThis as any).duelLensDebug.startScan();

    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(startScan).toHaveBeenCalledWith({ id: 9, windowId: 2 });
  });

  // Puppeteer can't click "Agree and start" before every run: without the consent, each E2E scan
  // would open the welcome page instead (scan.ts).
  it('records the first-run consent, as "Agree and start" does', async () => {
    await import('./index');

    await (globalThis as any).duelLensDebug.grantConsent();

    expect(chrome.storage.local.set).toHaveBeenCalledWith({ consentedAt: expect.any(Number) });
  });
});

describe('onInstalled', () => {
  function installedListener() {
    return (chrome.runtime.onInstalled.addListener as Mock).mock.calls[0][0] as (details?: { reason: string }) => void | Promise<void>;
  }

  // The welcome page is where the user gives the first-run consent (legal-audit.md B4).
  it('opens the welcome page on a fresh install', async () => {
    await import('./index');
    await installedListener()({ reason: 'install' });

    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome-extension://abc/welcome.html' });
  });

  it('does not open it for an extension update, a Chrome update, or without details', async () => {
    await import('./index');
    await installedListener()({ reason: 'update' });
    await installedListener()({ reason: 'chrome_update' });
    await installedListener()();

    expect(chrome.tabs.create).not.toHaveBeenCalled();
  });

  // Review Important 1 / ledger M8: onInstalled also fires for a plain Chrome update,
  // not just a fresh install; re-creating the alarm unconditionally there resets its
  // weekly timer every time Chrome updates.
  it('creates the weekly refresh alarm when none exists yet', async () => {
    await import('./index');
    await installedListener()();

    expect(chrome.alarms.get).toHaveBeenCalledWith('refresh-cards');
    await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalledWith('refresh-cards', { periodInMinutes: 7 * 24 * 60 }));
  });

  it('does not reset an already-scheduled alarm (onInstalled firing for a Chrome update)', async () => {
    (chrome.alarms.get as Mock).mockResolvedValue({ name: 'refresh-cards' });
    await import('./index');
    await installedListener()();

    await vi.waitFor(() => expect(chrome.alarms.get).toHaveBeenCalled());
    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });

  // The self-updating artwork index's "first run after install" trigger.
  it('triggers a (staleness-gated) index update once seeding succeeds', async () => {
    const { runIndexUpdateIfStale } = await import('./index-update');
    await import('./index');

    await installedListener()();

    await vi.waitFor(() => expect(runIndexUpdateIfStale).toHaveBeenCalledTimes(1));
  });

  it('does not trigger an index update when seeding itself fails', async () => {
    const { ensureSeeded } = await import('./card-store');
    (ensureSeeded as Mock).mockRejectedValueOnce(new Error('quota exceeded'));
    const { runIndexUpdateIfStale } = await import('./index-update');
    await import('./index');

    await installedListener()();

    await vi.waitFor(() => expect(chrome.alarms.get).toHaveBeenCalled()); // let the listener's async work settle
    expect(runIndexUpdateIfStale).not.toHaveBeenCalled();
  });
});

describe('onStartup', () => {
  it('triggers a (staleness-gated) index update, for a long-idle worker catching up', async () => {
    const { runIndexUpdateIfStale } = await import('./index-update');
    await import('./index');
    const listener = (chrome.runtime.onStartup.addListener as Mock).mock.calls[0][0] as () => void;

    listener();

    await vi.waitFor(() => expect(runIndexUpdateIfStale).toHaveBeenCalledTimes(1));
  });
});

describe('onAlarm', () => {
  function alarmListener() {
    return (chrome.alarms.onAlarm.addListener as Mock).mock.calls[0][0] as (alarm: { name: string }) => void;
  }

  it('triggers an (unconditional) index update when the weekly refresh finds new cards', async () => {
    const { refreshIfChanged } = await import('./card-store');
    (refreshIfChanged as Mock).mockResolvedValue('updated');
    const { runIndexUpdate } = await import('./index-update');
    await import('./index');

    alarmListener()({ name: 'refresh-cards' });

    await vi.waitFor(() => expect(runIndexUpdate).toHaveBeenCalledTimes(1));
  });

  it('does not trigger an index update when the refresh finds nothing new', async () => {
    const { refreshIfChanged } = await import('./card-store');
    (refreshIfChanged as Mock).mockResolvedValue('unchanged');
    const { runIndexUpdate } = await import('./index-update');
    await import('./index');

    alarmListener()({ name: 'refresh-cards' });

    await vi.waitFor(() => expect(refreshIfChanged).toHaveBeenCalledTimes(1)); // let the listener's async work settle
    expect(runIndexUpdate).not.toHaveBeenCalled();
  });

  it('does not trigger an index update when the refresh check fails', async () => {
    const { refreshIfChanged } = await import('./card-store');
    (refreshIfChanged as Mock).mockResolvedValue('failed');
    const { runIndexUpdate } = await import('./index-update');
    await import('./index');

    alarmListener()({ name: 'refresh-cards' });

    await vi.waitFor(() => expect(refreshIfChanged).toHaveBeenCalledTimes(1));
    expect(runIndexUpdate).not.toHaveBeenCalled();
  });

  it('ignores alarms other than the weekly refresh', async () => {
    const { refreshIfChanged } = await import('./card-store');
    const { closeOffscreenIfIdle } = await import('./offscreen-client');
    await import('./index');

    alarmListener()({ name: 'something-else' });

    expect(refreshIfChanged).not.toHaveBeenCalled();
    expect(closeOffscreenIfIdle).not.toHaveBeenCalled();
  });

  it('closes the offscreen document, if it is idle, when its idle alarm fires', async () => {
    const { refreshIfChanged } = await import('./card-store');
    const { closeOffscreenIfIdle, OFFSCREEN_IDLE_ALARM } = await import('./offscreen-client');
    await import('./index');

    alarmListener()({ name: OFFSCREEN_IDLE_ALARM });

    expect(closeOffscreenIfIdle).toHaveBeenCalledTimes(1);
    expect(refreshIfChanged).not.toHaveBeenCalled();
  });
});

describe('onMessage', () => {
  /** The content script, in a YouTube tab. */
  const CONTENT = { id: 'abc', url: 'https://www.youtube.com/watch?v=x', tab: { id: 5, windowId: 1 } };
  /** The options page, opened in a tab. */
  const OPTIONS = { id: 'abc', url: 'chrome-extension://abc/options.html', tab: { id: 6, windowId: 1 } };
  /** The side panel (no tab). */
  const PANEL = { id: 'abc', url: 'chrome-extension://abc/sidepanel.html' };

  async function messageListener() {
    await import('./index');
    return (chrome.runtime.onMessage.addListener as Mock).mock.calls[0][0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (r: unknown) => void,
    ) => boolean;
  }

  it('sends the handled response exactly once', async () => {
    const { handleMessage } = await import('./router');
    (handleMessage as Mock).mockResolvedValue({ ok: true });
    const listener = await messageListener();
    const sendResponse = vi.fn();

    const keepOpen = listener({ type: 'open-options' }, CONTENT, sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  // Review: `.then(sendResponse)` throwing (tab closed mid-scan, so the port is gone)
  // used to reject into a `.catch` that called the same throwing sendResponse again,
  // producing an unhandled rejection. It must be attempted at most once, guarded by try/catch.
  it('does not call sendResponse a second time when it throws itself (tab closed mid-scan)', async () => {
    const { handleMessage } = await import('./router');
    (handleMessage as Mock).mockResolvedValue({ ok: true });
    const listener = await messageListener();
    const sendResponse = vi.fn(() => {
      throw new Error('Attempting to use a disconnected port object');
    });

    listener({ type: 'open-options' }, CONTENT, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0)); // let any further .then/.catch settle
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('still answers (once) when handleMessage itself rejects', async () => {
    const { handleMessage } = await import('./router');
    (handleMessage as Mock).mockRejectedValue(new Error('boom'));
    const listener = await messageListener();
    const sendResponse = vi.fn();

    listener({ type: 'recognize' }, CONTENT, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledTimes(1));
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'boom' });
  });

  // Security review M2 and L3: who may send what (src/shared/messages.ts, BACKGROUND_SENDERS).
  describe('senders', () => {
    it('drops a message from another extension: no answer at all, and nothing handled', async () => {
      const { handleMessage } = await import('./router');
      const listener = await messageListener();
      const sendResponse = vi.fn();

      for (const sender of [{ id: 'other', url: 'chrome-extension://other/bg.js' }, { url: 'chrome-extension://abc/options.html' }, {}]) {
        expect(listener({ type: 'recognize' }, sender, sendResponse)).toBe(false);
      }

      await new Promise((r) => setTimeout(r, 10));
      expect(sendResponse).not.toHaveBeenCalled();
      expect(handleMessage).not.toHaveBeenCalled();
    });

    it("refuses a content script the messages meant for Duel Lens's own pages, with a clear error", async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { handleMessage } = await import('./router');
      const listener = await messageListener();

      for (const type of ['grant-consent', 'get-status', 'refresh-cards', 'update-index', 'test-ai', 'self-destruct']) {
        const sendResponse = vi.fn();
        expect(listener({ type }, CONTENT, sendResponse)).toBe(false);
        expect(sendResponse).toHaveBeenCalledWith({
          ok: false,
          error: `Duel Lens accepts "${type}" only from its own pages, not from a content script.`,
        });
      }

      await new Promise((r) => setTimeout(r, 10));
      expect(handleMessage).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('handles the overlay\'s messages from a content script', async () => {
      const { handleMessage } = await import('./router');
      (handleMessage as Mock).mockResolvedValue({ ok: true });
      const listener = await messageListener();

      for (const type of ['recognize', 'get-cards', 'get-image', 'correct', 'show-in-panel', 'ask-ai', 'open-options']) {
        const sendResponse = vi.fn();
        expect(listener({ type }, CONTENT, sendResponse)).toBe(true);
        await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
      }
      expect(handleMessage).toHaveBeenCalledTimes(7);
    });

    it("handles every message from Duel Lens's own pages, a page in a tab included (options, welcome)", async () => {
      const { handleMessage } = await import('./router');
      (handleMessage as Mock).mockResolvedValue({ ok: true });
      const listener = await messageListener();

      for (const [type, sender] of [
        ['grant-consent', { ...OPTIONS, url: 'chrome-extension://abc/welcome.html#consent' }],
        ['get-status', OPTIONS],
        ['test-ai', OPTIONS],
        ['get-cards', PANEL],
      ] as const) {
        const sendResponse = vi.fn();
        expect(listener({ type }, sender, sendResponse)).toBe(true);
        await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
        expect(handleMessage).toHaveBeenLastCalledWith({ type }, sender);
      }
    });

    it('leaves messages for the offscreen document to it, whoever sent them', async () => {
      const { handleMessage } = await import('./router');
      const listener = await messageListener();
      const sendResponse = vi.fn();

      expect(listener({ target: 'offscreen', type: 'recognize' }, CONTENT, sendResponse)).toBe(false);
      expect(listener({ target: 'offscreen', type: 'recognize' }, { id: 'abc', url: 'chrome-extension://abc/background.js' }, sendResponse)).toBe(false);

      expect(sendResponse).not.toHaveBeenCalled();
      expect(handleMessage).not.toHaveBeenCalled();
    });
  });
});

// The crop build (`--no-remote-images`: __DUEL_LENS_REMOTE_IMAGES__ false) downloads no artwork from
// images.ygoprodeck.com: the artwork index is the bundled one only (legal-audit.md B2, decision D3). The
// weekly card data refresh (db.ygoprodeck.com) still runs.
describe('without remote images (the crop build, --no-remote-images)', () => {
  beforeEach(() => {
    vi.stubGlobal('__DUEL_LENS_REMOTE_IMAGES__', false);
  });

  it('seeds the card data on install, but starts no artwork index update', async () => {
    const { ensureSeeded } = await import('./card-store');
    const { runIndexUpdate, runIndexUpdateIfStale } = await import('./index-update');
    await import('./index');
    const installed = (chrome.runtime.onInstalled.addListener as Mock).mock.calls[0][0] as (d: { reason: string }) => void;

    installed({ reason: 'install' });

    await vi.waitFor(() => expect(ensureSeeded).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(chrome.alarms.create).toHaveBeenCalled()); // let the listener's async work settle
    expect(runIndexUpdateIfStale).not.toHaveBeenCalled();
    expect(runIndexUpdate).not.toHaveBeenCalled();
  });

  it('starts no artwork index update when Chrome starts', async () => {
    const { runIndexUpdateIfStale } = await import('./index-update');
    await import('./index');
    const listener = (chrome.runtime.onStartup.addListener as Mock).mock.calls[0][0] as () => void;

    listener();

    await new Promise((r) => setTimeout(r, 0));
    expect(runIndexUpdateIfStale).not.toHaveBeenCalled();
  });

  it('still refreshes the card data weekly, without indexing the new cards\' artwork', async () => {
    const { refreshIfChanged } = await import('./card-store');
    (refreshIfChanged as Mock).mockResolvedValue('updated');
    const { runIndexUpdate } = await import('./index-update');
    await import('./index');
    const alarm = (chrome.alarms.onAlarm.addListener as Mock).mock.calls[0][0] as (a: { name: string }) => void;

    alarm({ name: 'refresh-cards' });

    await vi.waitFor(() => expect(refreshIfChanged).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(runIndexUpdate).not.toHaveBeenCalled();
  });
});
