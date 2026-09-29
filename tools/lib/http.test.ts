import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter, politeFetch, USER_AGENT, type FetchLike } from './http';

describe('createRateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lets the first call through immediately', async () => {
    const limit = createRateLimiter(4);
    let done = false;
    void limit().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('spaces 8 awaited calls at 4 per second over at least 1.5 s', async () => {
    const limit = createRateLimiter(4);
    const t0 = Date.now();
    let finished = 0;
    let endedAt = 0;
    const run = (async () => {
      for (let i = 0; i < 8; i++) {
        await limit();
        finished++;
      }
      endedAt = Date.now();
    })();
    await vi.advanceTimersByTimeAsync(1400);
    expect(finished).toBeLessThan(8);
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(finished).toBe(8);
    expect(endedAt - t0).toBeGreaterThanOrEqual(1500);
    expect(endedAt - t0).toBeLessThan(2000);
  });

  it('shares one budget between concurrent callers', async () => {
    const limit = createRateLimiter(4);
    const t0 = Date.now();
    const times: number[] = [];
    const all = Promise.all(Array.from({ length: 8 }, () => limit().then(() => times.push(Date.now() - t0))));
    await vi.advanceTimersByTimeAsync(2000);
    await all;
    expect(times).toHaveLength(8);
    expect(Math.max(...times)).toBeGreaterThanOrEqual(1500);
    // Never more than 4 starts inside any 1 s window.
    for (const t of times) expect(times.filter((u) => u >= t && u < t + 1000).length).toBeLessThanOrEqual(4);
  });
});

const respond = (status: number, headers?: Record<string, string>) => new Response('body', { status, headers });

describe('politeFetch', () => {
  afterEach(() => vi.useRealTimers());

  it('sends the Duel Lens User-Agent', async () => {
    const fake = vi.fn<FetchLike>(async () => respond(200));
    const res = await politeFetch('https://example.test/a', { fetch: fake });
    expect(res.status).toBe(200);
    expect(USER_AGENT).toBe('DuelLens/0.1 (personal project)');
    const headers = new Headers(fake.mock.calls[0][1]?.headers);
    expect(headers.get('user-agent')).toBe('DuelLens/0.1 (personal project)');
  });

  it('retries 429 and 5xx responses with doubling backoff', async () => {
    vi.useFakeTimers();
    const statuses = [429, 503, 200];
    const fake = vi.fn<FetchLike>(async () => respond(statuses.shift()!));
    const p = politeFetch('https://example.test/a', { fetch: fake, retries: 3, backoffMs: 100 });
    await vi.advanceTimersByTimeAsync(99);
    expect(fake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(fake).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const res = await p;
    expect(res.status).toBe(200);
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it('gives up after `retries` retries and returns the last response', async () => {
    const fake = vi.fn<FetchLike>(async () => respond(500));
    const res = await politeFetch('https://example.test/a', { fetch: fake, retries: 2, backoffMs: 1 });
    expect(res.status).toBe(500);
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it('does not retry other client errors', async () => {
    const fake = vi.fn<FetchLike>(async () => respond(404));
    const res = await politeFetch('https://example.test/a', { fetch: fake, retries: 3, backoffMs: 1 });
    expect(res.status).toBe(404);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('retries network errors and rethrows the last one', async () => {
    const fake = vi.fn<FetchLike>(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(politeFetch('https://example.test/a', { fetch: fake, retries: 2, backoffMs: 1 })).rejects.toThrow(
      /fetch failed/,
    );
    expect(fake).toHaveBeenCalledTimes(3);
  });

  it('honours Retry-After when it asks for a longer wait', async () => {
    vi.useFakeTimers();
    const statuses = [429, 200];
    const fake = vi.fn<FetchLike>(async () => {
      const s = statuses.shift()!;
      return respond(s, s === 429 ? { 'Retry-After': '2' } : undefined);
    });
    const p = politeFetch('https://example.test/a', { fetch: fake, retries: 1, backoffMs: 100 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).status).toBe(200);
  });

  it('waits for the rate limiter before every attempt', async () => {
    const limiter = vi.fn(async () => {});
    const statuses = [503, 200];
    const fake = vi.fn<FetchLike>(async () => respond(statuses.shift()!));
    await politeFetch('https://example.test/a', { fetch: fake, retries: 1, backoffMs: 1, limiter });
    expect(limiter).toHaveBeenCalledTimes(2);
  });
});
