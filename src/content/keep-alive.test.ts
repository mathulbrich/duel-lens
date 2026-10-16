import { afterEach, describe, expect, it, vi } from 'vitest';
import { isKeepAlive, KEEP_ALIVE, KEEP_ALIVE_MS } from '../shared/keep-alive';
import { startKeepAlive } from './keep-alive';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the Firefox keep-alive (scan mode open)', () => {
  it('pings at once, then every 20 s, well inside Firefox’s 30 s idle limit, until stopped', () => {
    vi.useFakeTimers();
    const send = vi.fn().mockResolvedValue({ ok: true });
    const stop = startKeepAlive(send);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(send).toHaveBeenCalledTimes(4);
    expect(KEEP_ALIVE_MS).toBeLessThan(30_000);
    stop();
    vi.advanceTimersByTime(KEEP_ALIVE_MS * 3);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('sends the keep-alive message through chrome.runtime.sendMessage by default', () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const stop = startKeepAlive();
    expect(sendMessage).toHaveBeenCalledWith({ type: KEEP_ALIVE });
    expect(isKeepAlive(sendMessage.mock.calls[0][0])).toBe(true);
    stop();
  });

  it('shrugs off a failed ping (rejected or thrown) and keeps pinging', async () => {
    vi.useFakeTimers();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Could not establish connection'))
      .mockImplementationOnce(() => {
        throw new Error('Extension context invalidated');
      })
      .mockResolvedValue(undefined);
    const stop = startKeepAlive(send, 1000);
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(3);
    stop();
  });

  it('knows its own message, and nothing else (an offscreen message, another type)', () => {
    expect(isKeepAlive({ type: KEEP_ALIVE })).toBe(true);
    expect(isKeepAlive({ type: KEEP_ALIVE, target: 'offscreen' })).toBe(false);
    expect(isKeepAlive({ type: 'scan-crop' })).toBe(false);
    expect(isKeepAlive(null)).toBe(false);
    expect(isKeepAlive('keep-alive')).toBe(false);
  });
});
