import { describe, expect, it, vi } from 'vitest';
import { LIVE_COMMAND, createLiveBackground, type LiveBackgroundDeps } from './live';
import { startLog, type LiveLog, type LiveProgress } from '../shared/live';
import { DEFAULT_SETTINGS } from '../shared/types';

const PAGE = { tabId: 7, pageUrl: 'https://video.example/watch', pageTitle: 'A duel' };
const tab = { id: 7, url: PAGE.pageUrl, title: PAGE.pageTitle, windowId: 1 } as chrome.tabs.Tab;
const tab9 = { id: 9, url: 'https://other.example/', title: 'Other', windowId: 1 } as chrome.tabs.Tab;

/** An in-memory log, so the tests read what the background wrote. */
function fakeDeps(overrides: Partial<LiveBackgroundDeps> & { log?: LiveLog | null } = {}) {
  const state = { log: overrides.log ?? null };
  const deps: LiveBackgroundDeps = {
    getLog: vi.fn(async () => state.log),
    setLog: vi.fn(async (log: LiveLog | null) => {
      state.log = log;
    }),
    sendMessageToTab: vi.fn().mockResolvedValue({ ok: true }),
    ping: vi.fn().mockResolvedValue(true),
    injectContentScript: vi.fn().mockResolvedValue(undefined),
    hasConsent: vi.fn().mockResolvedValue(true),
    openConsent: vi.fn().mockResolvedValue(undefined),
    setBadge: vi.fn().mockResolvedValue(undefined),
    setMenuRunning: vi.fn(),
    getSettings: vi.fn().mockResolvedValue(DEFAULT_SETTINGS),
    warmup: vi.fn().mockResolvedValue(undefined),
    now: () => 5000,
    ...overrides,
  };
  delete (deps as { log?: unknown }).log;
  return { deps, state };
}

const running = (over: Partial<LiveLog> = {}): LiveLog => ({ ...startLog(null, PAGE, 1000), status: 'watching', ...over });
const sent = (deps: LiveBackgroundDeps) => vi.mocked(deps.sendMessageToTab).mock.calls.map(([id, m]) => [id, (m as { type: string }).type]);
const progress = (over: Partial<LiveProgress> = {}): LiveProgress => ({ status: 'watching', voting: 0, sightings: [], ...over });

describe('the command', () => {
  it('is live-toggle', () => expect(LIVE_COMMAND).toBe('live-toggle'));
});

describe('start', () => {
  it('without consent opens the welcome page and starts nothing', async () => {
    const { deps } = fakeDeps({ hasConsent: vi.fn().mockResolvedValue(false) });
    const res = await createLiveBackground(deps).start(tab);
    expect(res).toEqual({ ok: false, reason: 'no-consent' });
    expect(deps.openConsent).toHaveBeenCalledWith(tab);
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
    expect(deps.injectContentScript).not.toHaveBeenCalled();
    expect(deps.setLog).not.toHaveBeenCalled();
  });

  it('injects the content script when the ping fails', async () => {
    const { deps } = fakeDeps({ ping: vi.fn().mockResolvedValue(false) });
    const res = await createLiveBackground(deps).start(tab);
    expect(deps.injectContentScript).toHaveBeenCalledWith(7);
    expect(res).toEqual({ ok: true });
  });

  it('answers needs-shortcut when injection is refused', async () => {
    const { deps } = fakeDeps({ ping: vi.fn().mockResolvedValue(false), injectContentScript: vi.fn().mockRejectedValue(new Error('Cannot access')) });
    const res = await createLiveBackground(deps).start(tab);
    expect(res).toEqual({ ok: false, reason: 'needs-shortcut' });
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
    expect(deps.setLog).not.toHaveBeenCalled();
  });

  it('writes a fresh log, the badge and the menu, and sends live-start with the settings', async () => {
    const { deps, state } = fakeDeps({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, live: { effort: 'light', showLabel: false } }),
    });
    const res = await createLiveBackground(deps).start(tab);
    expect(res).toEqual({ ok: true });
    expect(deps.warmup).toHaveBeenCalled();
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-start', effort: 'light', showLabel: false });
    expect(state.log).toEqual(startLog(null, PAGE, 5000));
    expect(deps.setLog).toHaveBeenCalledWith(startLog(null, PAGE, 5000));
    expect(deps.setBadge).toHaveBeenCalledWith(7, true);
    expect(deps.setMenuRunning).toHaveBeenCalledWith(true);
  });

  it('writes nothing when the page refuses (no video), and passes the reason on', async () => {
    const { deps } = fakeDeps({ sendMessageToTab: vi.fn().mockResolvedValue({ ok: false, reason: 'no-video' }) });
    const res = await createLiveBackground(deps).start(tab);
    expect(res).toEqual({ ok: false, reason: 'no-video' });
    expect(deps.setLog).not.toHaveBeenCalled();
    expect(deps.setBadge).not.toHaveBeenCalled();
    expect(deps.setMenuRunning).not.toHaveBeenCalled();
  });

  it('answers needs-shortcut when the tab does not answer live-start', async () => {
    const { deps } = fakeDeps({ sendMessageToTab: vi.fn().mockRejectedValue(new Error('Receiving end does not exist')) });
    expect(await createLiveBackground(deps).start(tab)).toEqual({ ok: false, reason: 'needs-shortcut' });
    expect(deps.setLog).not.toHaveBeenCalled();
  });

  it('keeps what the same tab and page had found', async () => {
    const entry = { cardId: 1, imageId: 1, firstVideoTime: 3, lastVideoTime: 3, appearances: 1 };
    const { deps, state } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user', entries: [entry] }) });
    await createLiveBackground(deps).start(tab);
    expect(state.log?.entries).toEqual([entry]);
    expect(state.log?.status).toBe('starting');
  });

  it('starting on a second tab stops the first with other-tab', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    const res = await createLiveBackground(deps).start(tab9);
    expect(res).toEqual({ ok: true });
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-stop', reason: 'other-tab' });
    expect(sent(deps)).toEqual([[7, 'live-stop'], [9, 'live-start']]);
    expect(state.log?.tabId).toBe(9);
    expect(state.log?.entries).toEqual([]);
  });
});

describe('stop', () => {
  it('tells the tab, marks the log stopped with the reason at once, and turns badge and menu off', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    await createLiveBackground(deps).stop('user');
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-stop', reason: 'user' });
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(deps.setBadge).toHaveBeenCalledWith(7, false);
    expect(deps.setMenuRunning).toHaveBeenCalledWith(false);
  });

  it('still stops the log when the tab does not answer', async () => {
    const { deps, state } = fakeDeps({ log: running(), sendMessageToTab: vi.fn().mockRejectedValue(new Error('gone')) });
    await createLiveBackground(deps).stop('user');
    expect(state.log?.status).toBe('stopped');
  });

  it('does nothing when nothing runs', async () => {
    const { deps } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'left' }) });
    await createLiveBackground(deps).stop('user');
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
    expect(deps.setLog).not.toHaveBeenCalled();
  });
});

describe('progress', () => {
  it('from another tab is ignored', async () => {
    const { deps } = fakeDeps({ log: running() });
    await createLiveBackground(deps).progress(9, progress({ sightings: [{ cardId: 1, imageId: 1, videoTime: 4 }] }));
    expect(deps.setLog).not.toHaveBeenCalled();
  });

  it('with no log is ignored', async () => {
    const { deps } = fakeDeps();
    await createLiveBackground(deps).progress(7, progress());
    expect(deps.setLog).not.toHaveBeenCalled();
  });

  it('adds what the tab saw to the log', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    await createLiveBackground(deps).progress(7, progress({ voting: 1, intervalMs: 800, sightings: [{ cardId: 1, imageId: 11, videoTime: 4 }] }));
    expect(state.log).toMatchObject({ status: 'watching', voting: 1, intervalMs: 800 });
    expect(state.log?.entries).toEqual([{ cardId: 1, imageId: 11, firstVideoTime: 4, lastVideoTime: 4, appearances: 1 }]);
    expect(deps.setBadge).not.toHaveBeenCalled();
  });

  it('a stopped progress clears badge and menu but keeps the entries', async () => {
    const entry = { cardId: 1, imageId: 1, firstVideoTime: 3, lastVideoTime: 3, appearances: 1 };
    const { deps, state } = fakeDeps({ log: running({ entries: [entry] }) });
    await createLiveBackground(deps).progress(7, progress({ status: 'stopped', stopReason: 'left' }));
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'left', entries: [entry] });
    expect(deps.setBadge).toHaveBeenCalledWith(7, false);
    expect(deps.setMenuRunning).toHaveBeenCalledWith(false);
  });

  it("the echo of a stop the background asked for changes nothing: the reason stays, and the badge is not touched again", async () => {
    const { deps, state } = fakeDeps({ log: running() });
    const live = createLiveBackground(deps);
    await live.stop('other-tab');
    vi.mocked(deps.setBadge).mockClear();
    vi.mocked(deps.setMenuRunning).mockClear();
    await live.progress(7, progress({ status: 'stopped' }));
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'other-tab' });
    expect(deps.setBadge).not.toHaveBeenCalled();
    expect(deps.setMenuRunning).not.toHaveBeenCalled();
  });
});

describe('seek', () => {
  it('relays the time to the live tab', async () => {
    const { deps } = fakeDeps({ log: running() });
    await createLiveBackground(deps).seek(42);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-seek', videoTime: 42 });
  });

  it('does nothing without a log', async () => {
    const { deps } = fakeDeps();
    await createLiveBackground(deps).seek(42);
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
  });
});

describe('tabUpdated', () => {
  const query = (reply: unknown) => vi.fn(async (_id: number, m: unknown) => {
    if ((m as { type: string }).type === 'live-query') {
      if (reply instanceof Error) throw reply;
      return reply;
    }
    return { ok: true };
  });

  it('complete with no running Live in the page marks the log left', async () => {
    const { deps, state } = fakeDeps({ log: running(), sendMessageToTab: query({ running: false, pageKey: 'k', stats: {} }) });
    await createLiveBackground(deps).tabUpdated(7, { status: 'complete' });
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'left' });
    expect(deps.setBadge).toHaveBeenCalledWith(7, false);
    expect(deps.setMenuRunning).toHaveBeenCalledWith(false);
  });

  it('complete with no answer from the page (a reload dropped the content script) marks it left', async () => {
    const { deps, state } = fakeDeps({ log: running(), sendMessageToTab: query(new Error('Receiving end does not exist')) });
    await createLiveBackground(deps).tabUpdated(7, { status: 'complete' });
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'left' });
  });

  it('complete with Live still running in the page changes nothing', async () => {
    const { deps } = fakeDeps({ log: running(), sendMessageToTab: query({ running: true, pageKey: 'k', stats: {} }) });
    await createLiveBackground(deps).tabUpdated(7, { status: 'complete' });
    expect(deps.setLog).not.toHaveBeenCalled();
  });

  it('ignores loading, other tabs and a log that already stopped', async () => {
    const { deps } = fakeDeps({ log: running() });
    const live = createLiveBackground(deps);
    await live.tabUpdated(7, { status: 'loading' });
    await live.tabUpdated(9, { status: 'complete' });
    await live.tabUpdated(7, {});
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
    const stopped = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user' }) });
    await createLiveBackground(stopped.deps).tabUpdated(7, { status: 'complete' });
    expect(stopped.deps.sendMessageToTab).not.toHaveBeenCalled();
  });
});

describe('tabRemoved', () => {
  it('clears the log of the closed tab, and the badge and menu', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    await createLiveBackground(deps).tabRemoved(7);
    expect(state.log).toBeNull();
    expect(deps.setMenuRunning).toHaveBeenCalledWith(false);
  });

  it('leaves the log of another tab', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    await createLiveBackground(deps).tabRemoved(9);
    expect(state.log).not.toBeNull();
    expect(deps.setLog).not.toHaveBeenCalled();
  });
});

describe('settingsChanged', () => {
  it('forwards live-settings to the running tab', async () => {
    const { deps } = fakeDeps({ log: running() });
    await createLiveBackground(deps).settingsChanged({ effort: 'light', showLabel: false });
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-settings', effort: 'light', showLabel: false });
  });

  it('sends nothing when Live is not running', async () => {
    const { deps } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user' }) });
    await createLiveBackground(deps).settingsChanged({ effort: 'light', showLabel: false });
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
  });
});

describe('toggle', () => {
  it('stops a running session on the same tab', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    await createLiveBackground(deps).toggle(tab);
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'user' });
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-stop', reason: 'user' });
  });

  it('starts on a tab that is not running, and on another tab while one runs', async () => {
    const idle = fakeDeps();
    await createLiveBackground(idle.deps).toggle(tab);
    expect(idle.state.log?.status).toBe('starting');
    const other = fakeDeps({ log: running() });
    await createLiveBackground(other.deps).toggle(tab9);
    expect(other.state.log?.tabId).toBe(9);
  });

  it('does nothing for a tab without an id', async () => {
    const { deps } = fakeDeps();
    await createLiveBackground(deps).toggle({} as chrome.tabs.Tab);
    expect(deps.hasConsent).not.toHaveBeenCalled();
  });
});
