import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportGate } from './gate';
import * as github from './github-app';
import worker, { addressKey, IMAGE_DAYS, type Env } from './index';

const PNG = 'data:image/png;base64,' + btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9));
const ORIGIN = 'chrome-extension://cigbnalidhajeoancmafhnobolodeoei';
const REPORT = {
  v: 1,
  kind: 'no-match',
  image: PNG,
  app: { version: '0.9.4', browser: 'Chrome 141', os: 'Windows', model: 'dinov2-small-duel-v3b' },
};

/** The gate as Cloudflare would run it: one ReportGate over an in-memory storage, reached through its namespace. */
function gateNamespace(dailyCap?: string) {
  const store = new Map<string, unknown>();
  const gate = new ReportGate(
    { storage: { get: async <T>(k: string) => store.get(k) as T | undefined, put: async (entries) => void Object.entries(entries).forEach(([k, v]) => store.set(k, v)) } },
    { DAILY_CAP: dailyCap },
  );
  const fetch = vi.fn((input: string, init?: RequestInit) => gate.fetch(new Request(input, init)));
  return { ns: { idFromName: (name: string) => name, get: () => ({ fetch }) }, store, fetch };
}

function env(allow = true) {
  const kv = new Map<string, { value: Uint8Array | string; metadata: unknown; ttl?: number }>();
  const gate = gateNamespace();
  const e: Env = {
    REPORT_IMAGES: {
      getWithMetadata: async <M>(k: string) => {
        const v = kv.get(k);
        return { value: v && typeof v.value !== 'string' ? (v.value.slice().buffer as ArrayBuffer) : null, metadata: (v?.metadata as M) ?? null };
      },
      put: async (k, value, opts) =>
        void kv.set(k, { value: typeof value === 'string' ? value : new Uint8Array(value as Uint8Array), metadata: opts?.metadata, ttl: opts?.expirationTtl }),
      delete: async (k) => void kv.delete(k),
    },
    REPORT_LIMITER: { limit: vi.fn(async () => ({ success: allow })) },
    REPORT_GATE: gate.ns,
    GITHUB_REPO: 'mathulbrich/duel-lens',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'unused: createIssue is mocked',
  };
  return { e, kv, gate };
}

const post = (body: unknown, origin: string | null = ORIGIN, type = 'application/json') =>
  new Request('https://reports.example.workers.dev/report', {
    method: 'POST',
    headers: { 'Content-Type': type, 'CF-Connecting-IP': '203.0.113.9', ...(origin ? { Origin: origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('the relay', () => {
  let issues: { title: string; body: string; labels: string[] }[];
  beforeEach(() => {
    issues = [];
    vi.spyOn(github, 'createIssue').mockImplementation(async (_cfg, issue) => (issues.push(issue), { number: 12, url: 'https://github.com/mathulbrich/duel-lens/issues/12' }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('turns a report into an issue that shows its image from the relay, and answers its number', async () => {
    const { e, kv, gate } = env();
    const res = await worker.fetch(post(REPORT), e);
    expect(res.status).toBe(201);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual({ ok: true, issue: { number: 12, url: 'https://github.com/mathulbrich/duel-lens/issues/12' } });
    const key = [...kv.keys()].find((k) => k.startsWith('img/'))!;
    expect(key).toMatch(/^img\/[0-9a-f]{32}$/);
    expect(kv.get(key)!.ttl).toBe(IMAGE_DAYS * 86400);
    expect(issues[0].body).toContain(`(https://reports.example.workers.dev/${key})`);
    expect(e.REPORT_LIMITER!.limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
    expect(gate.store.get('day')).toEqual({ date: new Date().toISOString().slice(0, 10), count: 1 });
    const img = await worker.fetch(new Request(`https://reports.example.workers.dev/${key}`), e);
    expect(img.headers.get('Content-Type')).toBe('image/png');
    expect(img.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(img.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    expect(new Uint8Array(await img.arrayBuffer())[0]).toBe(0x89);
  });

  it('answers only an extension: a web page or a request without an Origin is refused, before anything else', async () => {
    for (const origin of ['https://evil.example', null, 'chrome-extension://x/../y']) {
      const { e, kv } = env();
      const res = await worker.fetch(post(REPORT, origin), e);
      expect(res.status).toBe(403);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(kv.size).toBe(0);
      expect(e.REPORT_LIMITER!.limit).not.toHaveBeenCalled();
    }
    const preflight = await worker.fetch(new Request('https://r.example/report', { method: 'OPTIONS', headers: { Origin: 'moz-extension://0d6f7a2e-1b2c-4d5e-8f90-123456789abc' } }), env().e);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('moz-extension://0d6f7a2e-1b2c-4d5e-8f90-123456789abc');
  });

  it('refuses over the rate limit, a report that is not one, and JSON that does not parse, keeping nothing', async () => {
    const limited = env(false);
    expect((await worker.fetch(post(REPORT), limited.e)).status).toBe(429);
    const { e, kv } = env();
    expect((await worker.fetch(post({ ...REPORT, kind: 'spam' }), e)).status).toBe(400);
    expect((await worker.fetch(post('{not json'), e)).status).toBe(400);
    expect((await worker.fetch(post(REPORT, ORIGIN, 'text/plain'), e)).status).toBe(415);
    expect((await worker.fetch(post('x'.repeat(1_000_001)), e)).status).toBe(413);
    expect((await worker.fetch(post({ ...REPORT, image: 'data:image/png;base64,AAAAA' }), e)).status).toBe(400);
    expect(kv.size).toBe(0);
    expect(issues).toHaveLength(0);
  });

  it('refuses a body whose Content-Length is over the limit without reading it', async () => {
    const req = post(REPORT);
    req.headers.set('Content-Length', '5000000');
    const read = vi.spyOn(req, 'text');
    expect((await worker.fetch(req, env().e)).status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it('fails closed: without its rate limiter or its gate it takes nothing', async () => {
    for (const drop of ['REPORT_LIMITER', 'REPORT_GATE'] as const) {
      const { e, kv } = env();
      delete e[drop];
      expect((await worker.fetch(post(REPORT), e)).status).toBe(503);
      expect(kv.size).toBe(0);
    }
  });

  it('asks the gate only for a valid report, and stops where the gate says', async () => {
    const { e, gate } = env();
    expect((await worker.fetch(post({ ...REPORT, kind: 'spam' }), e)).status).toBe(400);
    expect(gate.fetch).not.toHaveBeenCalled();
    const capped = env();
    capped.e.REPORT_GATE = gateNamespace('1').ns;
    expect((await worker.fetch(post(REPORT), capped.e)).status).toBe(201);
    const res = await worker.fetch(post(REPORT), capped.e);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: 'daily-limit' });
    expect(issues).toHaveLength(1);
  });

  it("pauses every report for an hour when GitHub's limits answer, and only then", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { e, gate } = env();
    vi.mocked(github.createIssue).mockRejectedValueOnce(new github.GitHubError('issue', 500));
    expect((await worker.fetch(post(REPORT), e)).status).toBe(502);
    expect(gate.store.get('pausedUntil')).toBeUndefined();
    vi.mocked(github.createIssue).mockRejectedValueOnce(new github.GitHubError('issue', 403));
    expect((await worker.fetch(post(REPORT), e)).status).toBe(502);
    expect(gate.store.get('pausedUntil')).toBeGreaterThan(Date.now() + 59 * 60_000);
    const res = await worker.fetch(post(REPORT), e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'paused' });
  });

  it('answers a KV failure (its daily writes used up) with an error the extension can read', async () => {
    const { e } = env();
    e.REPORT_IMAGES.put = async () => {
      throw new Error('KV put() limit exceeded for the day');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await worker.fetch(post(REPORT), e);
    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('keys IPv6 addresses by their /64, IPv4 ones as they are', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9');
    expect(addressKey('2001:db8:abcd:12:1:2:3:4')).toBe('2001:db8:abcd:12::/64');
    expect(addressKey('2001:DB8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('2001:db8:abcd:0012::')).toBe('2001:db8:abcd:12::/64');
    expect(addressKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('answers "unavailable" when GitHub fails, keeping no image, and nothing on any other path', async () => {
    vi.mocked(github.createIssue).mockRejectedValueOnce(new Error('GitHub issue: HTTP 403'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { e, kv } = env();
    const res = await worker.fetch(post(REPORT), e);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'unavailable' });
    expect(kv.size).toBe(0);
    expect((await worker.fetch(new Request('https://r.example/'), env().e)).status).toBe(404);
    expect((await worker.fetch(new Request('https://r.example/img/../secret'), env().e)).status).toBe(404);
  });
});
