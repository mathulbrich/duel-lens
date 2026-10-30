import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { runUpdateCheck, scheduleUpdateCheck, UPDATE_ALARM, RELEASES_API, type UpdateCheckDeps } from './update-check';

let local: Record<string, unknown>;

beforeEach(() => {
  local = {};
  vi.stubGlobal('chrome', {
    alarms: { get: vi.fn().mockResolvedValue(undefined), create: vi.fn(), clear: vi.fn().mockResolvedValue(true) },
    storage: {
      local: {
        get: vi.fn(async (k: string) => (k in local ? { [k]: local[k] } : {})),
        set: vi.fn(async (o: Record<string, unknown>) => void Object.assign(local, o)),
        remove: vi.fn(async (k: string) => void delete local[k]),
      },
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

const answer = (body: unknown, ok = true) => vi.fn().mockResolvedValue({ ok, json: async () => body }) as unknown as Mock & typeof fetch;

function deps(over: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  return {
    installedByHand: async () => true,
    enabled: async () => true,
    fetch: answer({ tag_name: 'v0.9.4' }),
    now: () => 100 * 86_400_000,
    version: () => '0.9.3',
    ...over,
  };
}

describe('scheduleUpdateCheck', () => {
  it('sets a daily alarm, a minute from now, for a copy installed by hand that has none', async () => {
    await scheduleUpdateCheck(deps());
    expect(chrome.alarms.create).toHaveBeenCalledWith(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  });

  it('keeps an alarm that exists (a worker waking up does not push the check back)', async () => {
    (chrome.alarms.get as Mock).mockResolvedValue({ name: UPDATE_ALARM });
    await scheduleUpdateCheck(deps());
    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });

  it('never checks a store copy, and clears what an earlier manual install left', async () => {
    local.updateAvailable = { version: '0.9.4' };
    await scheduleUpdateCheck(deps({ installedByHand: async () => false }));
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(UPDATE_ALARM);
    expect(local.updateAvailable).toBeUndefined();
  });
});

describe('runUpdateCheck', () => {
  it("asks GitHub's latest release, with no cookie, and keeps a newer version", async () => {
    const d = deps();
    await runUpdateCheck(d);
    expect(d.fetch).toHaveBeenCalledWith(RELEASES_API, expect.objectContaining({ credentials: 'omit' }));
    expect(local.updateAvailable).toEqual({ version: '0.9.4' });
  });

  it('clears the notice once this copy is the latest', async () => {
    local.updateAvailable = { version: '0.9.4' };
    await runUpdateCheck(deps({ version: () => '0.9.4' }));
    expect(local.updateAvailable).toBeUndefined();
  });

  it('asks at most once in 20 hours, however often the browser restarts', async () => {
    const d = deps();
    await runUpdateCheck(d);
    await runUpdateCheck({ ...d, now: () => 100 * 86_400_000 + 19 * 3_600_000 });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    await runUpdateCheck({ ...d, now: () => 100 * 86_400_000 + 21 * 3_600_000 });
    expect(d.fetch).toHaveBeenCalledTimes(2);
  });

  it('asks nothing when turned off in Options, and clears the notice', async () => {
    local.updateAvailable = { version: '0.9.4' };
    const d = deps({ enabled: async () => false });
    await runUpdateCheck(d);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(local.updateAvailable).toBeUndefined();
  });

  it('changes nothing when GitHub fails or answers something that is not a version', async () => {
    local.updateAvailable = { version: '0.9.4' };
    await runUpdateCheck(deps({ fetch: answer({}, false) }));
    local.updateCheckedAt = 0;
    await runUpdateCheck(deps({ fetch: vi.fn().mockRejectedValue(new TypeError('offline')) as unknown as typeof fetch }));
    local.updateCheckedAt = 0;
    await runUpdateCheck(deps({ fetch: answer({ tag_name: 'nightly' }) }));
    expect(local.updateAvailable).toEqual({ version: '0.9.4' });
  });
});
