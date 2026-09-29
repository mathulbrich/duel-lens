// Polite HTTP for the Node data tools: an identifying User-Agent, a shared rate limiter,
// and retries with exponential backoff for rate-limit (429) and server (5xx) errors.

export const USER_AGENT = 'DuelLens/0.1 (personal project)';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PoliteFetchOptions {
  /** Extra attempts after the first one for 429, 5xx and network errors. Default 3. */
  retries?: number;
  /** Wait before the first retry; doubles on each further retry. Default 1000 ms. */
  backoffMs?: number;
  /** Awaited before every attempt (see createRateLimiter). */
  limiter?: () => Promise<void>;
  /** Abort an attempt that takes longer than this. Default 60 s. */
  timeoutMs?: number;
  init?: RequestInit;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike;
}

const MAX_RETRY_AFTER_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const retryable = (status: number) => status === 429 || status >= 500;

function retryAfterMs(res: Response): number {
  const v = res.headers.get('retry-after');
  if (!v) return 0;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, secs * 1000));
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, at - Date.now())) : 0;
}

/**
 * fetch() with the Duel Lens User-Agent that retries 429/5xx responses and network errors.
 * After the last retry it returns the final response (check `res.ok`) or rethrows the
 * final network error. Other statuses (e.g. 404) are returned at once.
 */
export async function politeFetch(url: string, opts: PoliteFetchOptions = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 1000;
  const doFetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const headers = new Headers(opts.init?.headers);
  headers.set('User-Agent', USER_AGENT);
  for (let attempt = 0; ; attempt++) {
    await opts.limiter?.();
    const wait = backoff * 2 ** attempt;
    try {
      const res = await doFetch(url, {
        ...opts.init,
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      });
      if (!retryable(res.status) || attempt >= retries) return res;
      await res.body?.cancel().catch(() => {});
      await sleep(Math.max(wait, retryAfterMs(res)));
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(wait);
    }
  }
}

/**
 * Returns a function to await before each request so that, across all callers sharing it,
 * requests start at most `perSecond` times per second (evenly spaced, no bursts).
 * The first call resolves immediately.
 */
export function createRateLimiter(perSecond: number): () => Promise<void> {
  if (!(perSecond > 0)) throw new Error(`Rate must be positive, got ${perSecond}`);
  const interval = 1000 / perSecond;
  let next = -Infinity;
  return () => {
    const now = Date.now();
    const slot = Math.max(now, next);
    next = slot + interval;
    const wait = slot - now;
    return wait > 0 ? sleep(wait) : Promise.resolve();
  };
}
