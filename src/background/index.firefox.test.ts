// The Firefox build's background wiring (src/background/index.ts with __DUEL_LENS_FIREFOX__): the scan-mode
// keep-alive (src/shared/keep-alive.ts) and Firefox's missing storage.local.setAccessLevel. index.test.ts
// covers the rest, for Chrome.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { KEEP_ALIVE } from '../shared/keep-alive';

vi.mock('./scan', () => ({ startScan: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./router', () => ({ handleMessage: vi.fn().mockResolvedValue({ ok: true, routed: true }) }));
vi.mock('./panel', () => ({ openPanel: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./card-store', () => ({
  ensureSeeded: vi.fn().mockResolvedValue(undefined),
  loadBundledCards: vi.fn(),
  refreshIfChanged: vi.fn().mockResolvedValue('unchanged'),
}));
vi.mock('./index-update', () => ({ runIndexUpdate: vi.fn(), runIndexUpdateIfStale: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./offscreen-client', () => ({ OFFSCREEN_IDLE_ALARM: 'close-idle-offscreen', closeOffscreenIfIdle: vi.fn() }));
vi.mock('./secure-store', () => ({ migrateLegacyStorage: vi.fn().mockResolvedValue({ copied: [], removed: [] }) }));

const on = () => ({ addListener: vi.fn() });
function fakeChrome(local: Record<string, unknown> = {}) {
  return {
    runtime: { id: 'abc', onInstalled: on(), onStartup: on(), onMessage: on(), getURL: (p: string) => `moz-extension://abc/${p}` },
    alarms: { onAlarm: on(), create: vi.fn(), get: vi.fn().mockResolvedValue(undefined) },
    commands: { onCommand: on() },
    action: { onClicked: on() },
    contextMenus: { onClicked: on(), removeAll: vi.fn((done?: () => void) => done?.()), create: vi.fn() },
    tabs: { create: vi.fn().mockResolvedValue({}) },
    storage: { local: { set: vi.fn().mockResolvedValue(undefined), ...local } },
  };
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | undefined;
async function load(chromeObj = fakeChrome()) {
  vi.stubGlobal('chrome', chromeObj);
  await import('./index');
  const listeners = (chromeObj.runtime.onMessage.addListener as Mock).mock.calls.map(([fn]) => fn as Listener);
  return { chromeObj, listener: listeners[0] };
}
const fromTab = { id: 'abc', url: 'https://www.example.com/watch', tab: { id: 3 } };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('__DUEL_LENS_FIREFOX__', true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { duelLensDebug?: unknown }).duelLensDebug;
});

describe('Firefox: the scan-mode keep-alive', () => {
  it("answers the content script's ping at once, without the router", async () => {
    const { listener } = await load();
    const { handleMessage } = await import('./router');
    const sendResponse = vi.fn();
    expect(listener({ type: KEEP_ALIVE }, fromTab, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("gives another extension's ping no answer", async () => {
    const { listener } = await load();
    const sendResponse = vi.fn();
    listener({ type: KEEP_ALIVE }, { id: 'someone-else', url: 'https://www.example.com/' }, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('is refused in the Chrome build, which never sends one', async () => {
    vi.stubGlobal('__DUEL_LENS_FIREFOX__', false);
    const { listener } = await load(fakeChrome({ setAccessLevel: vi.fn().mockResolvedValue(undefined) }));
    const { handleMessage } = await import('./router');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendResponse = vi.fn();
    listener({ type: KEEP_ALIVE }, fromTab, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
    expect(handleMessage).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Firefox: no storage.local.setAccessLevel', () => {
  it('starts without it, logs no error, and handles messages', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { listener } = await load();
    const { handleMessage } = await import('./router');
    const sendResponse = vi.fn();
    expect(listener({ type: 'get-status' }, { id: 'abc', url: 'moz-extension://abc/options.html' }, sendResponse)).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, routed: true }));
    expect(handleMessage).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('could not restrict'), expect.anything());
    error.mockRestore();
  });
});
