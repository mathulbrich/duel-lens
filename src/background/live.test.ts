import { describe, expect, it, vi } from 'vitest';
import { LIVE_COMMAND, createLiveBackground, type LiveBackgroundDeps } from './live';
import { startLog, type LiveLog, type LiveProgress } from '../shared/live';
import { DEFAULT_SETTINGS } from '../shared/types';

const PAGE = { tabId: 7, pageKey: 'page:watch', pageUrl: 'https://video.example/watch', pageTitle: 'A duel' };
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
    sendMessageToTab: vi.fn().mockResolvedValue({ ok: true, pageKey: PAGE.pageKey }),
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
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-start', effort: 'light', showLabel: false, reveal: 'full' });
    expect(state.log).toEqual(startLog(null, PAGE, 5000));
    expect(deps.setLog).toHaveBeenCalledWith(startLog(null, PAGE, 5000));
    expect(deps.setBadge).toHaveBeenCalledWith(7, true);
    expect(deps.setMenuRunning).toHaveBeenCalledWith(true);
  });

  it('keeps no log when the page refuses (no video), and passes the reason on', async () => {
    const { deps, state } = fakeDeps({ sendMessageToTab: vi.fn().mockResolvedValue({ ok: false, reason: 'no-video' }) });
    const res = await createLiveBackground(deps).start(tab);
    expect(res).toEqual({ ok: false, reason: 'no-video' });
    expect(state.log).toBeNull();
    expect(deps.setBadge).not.toHaveBeenCalled();
    expect(deps.setMenuRunning).not.toHaveBeenCalled();
  });

  it('a refused restart on the tab that was running stops its log with the reason and turns the badge off', async () => {
    const { deps, state } = fakeDeps({ log: running(), sendMessageToTab: vi.fn().mockResolvedValue({ ok: false, reason: 'no-video' }) });
    expect(await createLiveBackground(deps).start(tab)).toEqual({ ok: false, reason: 'no-video' });
    expect(state.log).toMatchObject({ tabId: 7, status: 'stopped', stopReason: 'no-video' });
    expect(deps.setBadge).toHaveBeenCalledWith(7, false);
    expect(deps.setMenuRunning).toHaveBeenCalledWith(false);
  });

  it('a restart that throws on the tab that was running stops its log too', async () => {
    const { deps, state } = fakeDeps({ log: running(), sendMessageToTab: vi.fn().mockRejectedValue(new Error('gone')) });
    await createLiveBackground(deps).start(tab);
    expect(state.log).toMatchObject({ tabId: 7, status: 'stopped', stopReason: 'left' });
    expect(deps.setBadge).toHaveBeenCalledWith(7, false);
  });

  it('answers needs-shortcut when the tab does not answer live-start', async () => {
    const { deps, state } = fakeDeps({ sendMessageToTab: vi.fn().mockRejectedValue(new Error('Receiving end does not exist')) });
    expect(await createLiveBackground(deps).start(tab)).toEqual({ ok: false, reason: 'needs-shortcut' });
    expect(state.log).toBeNull();
  });

  it('keeps what the same tab and page had found', async () => {
    const entry = { cardId: 1, imageId: 1, firstVideoTime: 3, lastVideoTime: 3, appearances: 1 };
    const { deps, state } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user', entries: [entry] }) });
    await createLiveBackground(deps).start(tab);
    expect(state.log?.entries).toEqual([entry]);
    expect(state.log?.status).toBe('starting');
  });

  it('starting on a second tab stops the first with other-tab, once the second has started, and keeps the new log', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    const res = await createLiveBackground(deps).start(tab9);
    expect(res).toEqual({ ok: true });
    expect(sent(deps)).toEqual([[9, 'live-start'], [7, 'live-stop']]);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-stop', reason: 'other-tab' });
    expect(deps.setBadge).toHaveBeenCalledWith(7, false);
    expect(deps.setBadge).toHaveBeenCalledWith(9, true);
    expect(state.log).toMatchObject({ tabId: 9, status: 'starting', entries: [] });
  });

  it('a refused start leaves the other tab running and its log restored', async () => {
    const prev = running();
    const { deps, state } = fakeDeps({ log: prev, sendMessageToTab: vi.fn().mockResolvedValue({ ok: false, reason: 'blocked' }) });
    const res = await createLiveBackground(deps).start(tab9);
    expect(res).toEqual({ ok: false, reason: 'blocked' });
    expect(sent(deps)).toEqual([[9, 'live-start']]);
    expect(state.log).toEqual(prev);
    expect(deps.setBadge).not.toHaveBeenCalled();
  });

  it('removes the log again when a first start is refused or throws', async () => {
    const refused = fakeDeps({ sendMessageToTab: vi.fn().mockResolvedValue({ ok: false, reason: 'no-video' }) });
    await createLiveBackground(refused.deps).start(tab);
    expect(refused.state.log).toBeNull();
    const thrown = fakeDeps({ sendMessageToTab: vi.fn().mockRejectedValue(new Error('gone')) });
    await createLiveBackground(thrown.deps).start(tab);
    expect(thrown.state.log).toBeNull();
  });

  it('a stopped report that arrives while the start is being answered ends the session: the log is stopped and the badge ends off', async () => {
    const { deps, state } = fakeDeps();
    const live = createLiveBackground(deps);
    let early: Promise<unknown> | undefined;
    vi.mocked(deps.sendMessageToTab).mockImplementation(async () => {
      // The page reports without waiting for the answer; the report queues behind the start.
      early = live.progress(7, progress({ status: 'stopped', stopReason: 'no-video' }));
      return { ok: true, pageKey: PAGE.pageKey };
    });
    await live.start(tab);
    await early;
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'no-video' });
    expect(vi.mocked(deps.setBadge).mock.calls.at(-1)).toEqual([7, false]);
  });

  it('keeps the list when the page key is the same although the URL differs (a different &t= on the same video)', async () => {
    const entry = { cardId: 1, imageId: 1, firstVideoTime: 3, lastVideoTime: 3, appearances: 1 };
    const { deps, state } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user', entries: [entry] }) });
    await createLiveBackground(deps).start({ ...tab, url: `${PAGE.pageUrl}&t=90s` });
    expect(state.log?.entries).toEqual([entry]);
    expect(state.log?.pageUrl).toBe(`${PAGE.pageUrl}&t=90s`);
  });

  it('starts the list afresh when the page answers with another page key', async () => {
    const entry = { cardId: 1, imageId: 1, firstVideoTime: 3, lastVideoTime: 3, appearances: 1 };
    const { deps, state } = fakeDeps({
      log: running({ status: 'stopped', stopReason: 'user', entries: [entry] }),
      sendMessageToTab: vi.fn().mockResolvedValue({ ok: true, pageKey: 'page:other' }),
    });
    await createLiveBackground(deps).start(tab);
    expect(state.log).toMatchObject({ pageKey: 'page:other', entries: [] });
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

  it('from a content script on another tab does nothing; on the live tab it stops', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    const live = createLiveBackground(deps);
    await live.stop('user', 9);
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
    expect(state.log?.status).toBe('watching');
    await live.stop('user', 7);
    expect(state.log).toMatchObject({ status: 'stopped', stopReason: 'user' });
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
    const count = await createLiveBackground(deps).progress(7, progress({ voting: 1, intervalMs: 800, sightings: [{ cardId: 1, imageId: 11, videoTime: 4 }] }));
    expect(count).toBe(1);
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

describe('serialising', () => {
  it('two progress reports at once keep both sightings (no read-modify-write interleaving)', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    // A slow read: without the chain both calls would read the same empty log.
    vi.mocked(deps.getLog).mockImplementation(async () => {
      const snapshot = state.log;
      await new Promise((r) => setTimeout(r, 5));
      return snapshot;
    });
    const live = createLiveBackground(deps);
    const [a, b] = await Promise.all([
      live.progress(7, progress({ sightings: [{ cardId: 1, imageId: 1, videoTime: 2 }] })),
      live.progress(7, progress({ sightings: [{ cardId: 2, imageId: 2, videoTime: 3 }] })),
    ]);
    expect(state.log?.entries.map((e) => e.cardId).sort()).toEqual([1, 2]);
    expect([a, b]).toEqual([1, 2]);
  });

  it('a failing operation does not stop the ones queued behind it', async () => {
    const { deps, state } = fakeDeps({ log: running() });
    vi.mocked(deps.getLog).mockRejectedValueOnce(new Error('storage'));
    const live = createLiveBackground(deps);
    const failed = live.progress(7, progress());
    const ok = live.progress(7, progress({ sightings: [{ cardId: 1, imageId: 1, videoTime: 2 }] }));
    await expect(failed).rejects.toThrow('storage');
    await expect(ok).resolves.toBe(1);
    expect(state.log?.entries).toHaveLength(1);
  });
});

describe('seek', () => {
  it('relays the time to the live tab', async () => {
    const { deps } = fakeDeps({ log: running() });
    await createLiveBackground(deps).seek(42);
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-seek', videoTime: 42 });
  });

  it('still relays it after Live stopped (the list keeps its times), but not once the tab left the page', async () => {
    const stopped = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user' }) });
    await createLiveBackground(stopped.deps).seek(42);
    expect(stopped.deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-seek', videoTime: 42 });
    const left = fakeDeps({ log: running({ status: 'stopped', stopReason: 'left' }) });
    await createLiveBackground(left.deps).seek(42);
    expect(left.deps.sendMessageToTab).not.toHaveBeenCalled();
  });

  it('does nothing without a log', async () => {
    const { deps } = fakeDeps();
    await createLiveBackground(deps).seek(42);
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
  });
});

describe('showCard', () => {
  it('forwards the card to the live tab and answers its reply', async () => {
    const { deps } = fakeDeps({ log: running(), sendMessageToTab: vi.fn().mockResolvedValue({ shown: true }) });
    expect(await createLiveBackground(deps).showCard(14558127, 14558128)).toEqual({ shown: true });
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-show-card', cardId: 14558127, imageId: 14558128 });
  });

  it('answers shown: false when Live has stopped, without telling the tab', async () => {
    const { deps } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user' }) });
    expect(await createLiveBackground(deps).showCard(1, 2)).toEqual({ shown: false });
    expect(deps.sendMessageToTab).not.toHaveBeenCalled();
  });

  it('answers shown: false with no log, a failed send, or a tab that says no', async () => {
    const none = fakeDeps();
    expect(await createLiveBackground(none.deps).showCard(1, 2)).toEqual({ shown: false });
    const failing = fakeDeps({ log: running(), sendMessageToTab: vi.fn().mockRejectedValue(new Error('gone')) });
    expect(await createLiveBackground(failing.deps).showCard(1, 2)).toEqual({ shown: false });
    const no = fakeDeps({ log: running(), sendMessageToTab: vi.fn().mockResolvedValue({ shown: false }) });
    expect(await createLiveBackground(no.deps).showCard(1, 2)).toEqual({ shown: false });
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
    await createLiveBackground(deps).settingsChanged({ effort: 'light', showLabel: false, check: false }, 'full');
    expect(deps.sendMessageToTab).toHaveBeenCalledWith(7, { type: 'live-settings', effort: 'light', showLabel: false, reveal: 'full' });
  });

  it('sends nothing when Live is not running', async () => {
    const { deps } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user' }) });
    await createLiveBackground(deps).settingsChanged({ effort: 'light', showLabel: false, check: false });
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

describe('toggleAnywhere (the toolbar menu)', () => {
  it('stops the session that runs on another tab instead of starting here', async () => {
    const { deps, state } = fakeDeps({ log: running() }); // Live runs on tab 7
    await createLiveBackground(deps).toggleAnywhere(tab9);
    expect(state.log).toMatchObject({ tabId: 7, status: 'stopped', stopReason: 'user' });
    expect(sent(deps)).toEqual([[7, 'live-stop']]);
  });

  it('starts on the clicked tab when nothing runs, a stopped log included', async () => {
    const { deps, state } = fakeDeps({ log: running({ status: 'stopped', stopReason: 'user' }) });
    await createLiveBackground(deps).toggleAnywhere(tab9);
    expect(state.log).toMatchObject({ tabId: 9, status: 'starting' });
  });
});
