import { describe, expect, it, vi } from 'vitest';
import { applyLiveCheck, setLiveCheck, type LiveCheckDeps } from './live-check';

function deps(over: Partial<LiveCheckDeps> = {}): LiveCheckDeps {
  return {
    requestSites: vi.fn().mockResolvedValue(true),
    hasSites: vi.fn().mockResolvedValue(true),
    hasConsent: vi.fn().mockResolvedValue(true),
    openConsent: vi.fn().mockResolvedValue(undefined),
    saveCheck: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(undefined),
    injectOpenTabs: vi.fn().mockResolvedValue(undefined),
    tellOpenTabs: vi.fn().mockResolvedValue(undefined),
    stopLive: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('setLiveCheck (a click on the switch)', () => {
  it('turning on asks for every site before anything is awaited, then saves it on', async () => {
    const d = deps();
    const done = setLiveCheck(true, d);
    expect(d.requestSites).toHaveBeenCalledTimes(1); // synchronously: the click's gesture is still there
    expect(await done).toEqual({ on: true });
    expect(d.saveCheck).toHaveBeenCalledWith(true);
  });

  it('a refused permission leaves it off, saving nothing', async () => {
    const d = deps({ requestSites: vi.fn().mockResolvedValue(false) });
    expect(await setLiveCheck(true, d)).toEqual({ on: false, reason: 'no-permission' });
    expect(d.saveCheck).not.toHaveBeenCalled();
  });

  it('without the consent, its page opens and the switch stays off', async () => {
    const d = deps({ hasConsent: vi.fn().mockResolvedValue(false) });
    expect(await setLiveCheck(true, d)).toEqual({ on: false, reason: 'no-consent' });
    expect(d.openConsent).toHaveBeenCalledTimes(1);
    expect(d.saveCheck).not.toHaveBeenCalled();
  });

  it('turning off asks for nothing and saves it off', async () => {
    const d = deps();
    expect(await setLiveCheck(false, d)).toEqual({ on: false });
    expect(d.requestSites).not.toHaveBeenCalled();
    expect(d.saveCheck).toHaveBeenCalledWith(false);
  });
});

describe('applyLiveCheck (the browser follows the setting)', () => {
  it('on: registers the script, injects it into the open tabs and arms them', async () => {
    const d = deps();
    await applyLiveCheck(true, d);
    expect(d.register).toHaveBeenCalled();
    expect(d.injectOpenTabs).toHaveBeenCalled();
    expect(d.tellOpenTabs).toHaveBeenCalledWith({ type: 'live-check', on: true });
    expect(d.unregister).not.toHaveBeenCalled();
  });

  it('off: unregisters, stops Live and disarms every tab', async () => {
    const d = deps();
    await applyLiveCheck(false, d);
    expect(d.unregister).toHaveBeenCalled();
    expect(d.stopLive).toHaveBeenCalled();
    expect(d.tellOpenTabs).toHaveBeenCalledWith({ type: 'live-check', on: false });
    expect(d.saveCheck).not.toHaveBeenCalled();
  });

  it('on without every site (removed in the browser): reads as off and is saved so', async () => {
    const d = deps({ hasSites: vi.fn().mockResolvedValue(false) });
    await applyLiveCheck(true, d);
    expect(d.register).not.toHaveBeenCalled();
    expect(d.saveCheck).toHaveBeenCalledWith(false);
    expect(d.unregister).toHaveBeenCalled();
  });
});
