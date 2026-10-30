// Duel Lens's report relay (a Cloudflare Worker): the extension's Report button posts a card report here, and it
// becomes a GitHub issue in the Duel Lens repository, opened by the Duel Lens Reports GitHub App, so the user needs no
// GitHub account. relay/README.md has the setup and what each limit is for.
// - POST /report: a report (report.ts). Only from an extension (its Origin); at most 2 a minute from one address
//   (IPv6: its /64, counted in each Cloudflare location); its body read up to LIMITS.bodyBytes and checked field by
//   field; then the gate (gate.ts: 6 issues a minute and DAILY_CAP a day in all, paused when GitHub says no). Its
//   image is kept in KV for IMAGE_DAYS and shown in the issue from GET /img/<id>. Answers
//   { ok: true, issue: { number, url } }, or { ok: false, error } with a 4xx/5xx status, always with CORS.
// - GET /img/<id>: a report's image, as the issue shows it.
// Nothing else is answered, and nothing about the request (the IP address included) is kept.
import type { GateAnswer } from './gate';
import { createIssue, GitHubError } from './github-app';
import { InvalidReport, issueOf, LIMITS, parseReport } from './report';

export { ReportGate } from './gate';

/** The parts of Workers KV used here. */
export interface Store {
  getWithMetadata<M>(key: string, type: 'arrayBuffer'): Promise<{ value: ArrayBuffer | null; metadata: M | null }>;
  put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The Workers rate limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The parts of a Durable Object namespace used here (the gate). */
export interface GateNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface Env {
  REPORT_IMAGES: Store;
  /** Per address (wrangler.toml). Without it, or without REPORT_GATE, every report is refused. */
  REPORT_LIMITER?: RateLimiter;
  /** The gate (gate.ts): every issue's place, across all locations. */
  REPORT_GATE?: GateNamespace;
  /** Reports a day (UTC), at most, read by the gate; default DEFAULT_DAILY_CAP. */
  DAILY_CAP?: string;
  /** "owner/name": where the issues go. */
  GITHUB_REPO: string;
  GITHUB_APP_ID: string;
  /** The App's private key (PEM), a Worker secret. */
  GITHUB_APP_PRIVATE_KEY: string;
}

/** How long a report's image is kept (and shown in its issue): long enough to look at every report. */
export const IMAGE_DAYS = 90;

/** Extension pages and service workers: Chrome, Edge and Opera (chrome-extension://), Firefox (moz-extension://). */
const EXTENSION_ORIGIN = /^(chrome|moz)-extension:\/\/[a-z0-9-]{1,64}$/;

const IMAGE_ID = /^[0-9a-f]{32}$/;

function corsHeaders(origin: string | null): Record<string, string> {
  return origin && EXTENSION_ORIGIN.test(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' };
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(origin) },
  });
}

/** The rate limiter's key for an address: an IPv4 address as it is, an IPv6 one by its /64 (one home or phone). */
export function addressKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  // An IPv4 address written as IPv6 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4): the IPv4 address.
  const v4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (v4) return v4[1];
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${full.slice(0, 4).map((h) => h.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** The body as text, refused past `max` bytes without reading further (a Content-Length over it is refused unread). */
async function readCapped(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function report(request: Request, env: Env, origin: string | null): Promise<Response> {
  if (!origin || !EXTENSION_ORIGIN.test(origin)) return json(403, { ok: false, error: 'forbidden' }, origin);
  // Fail closed: without its limits, the relay takes nothing.
  if (!env.REPORT_LIMITER || !env.REPORT_GATE) return json(503, { ok: false, error: 'unavailable' }, origin);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!(await env.REPORT_LIMITER.limit({ key: addressKey(ip) })).success) return json(429, { ok: false, error: 'rate-limited' }, origin);
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) return json(415, { ok: false, error: 'invalid' }, origin);
  const text = await readCapped(request, LIMITS.bodyBytes);
  if (text === null) return json(413, { ok: false, error: 'too-large' }, origin);
  let parsed;
  try {
    parsed = parseReport(JSON.parse(text));
  } catch (e) {
    if (e instanceof InvalidReport || e instanceof SyntaxError) return json(400, { ok: false, error: 'invalid', detail: e.message }, origin);
    throw e;
  }
  // Only a valid report takes an issue's place.
  const gate = env.REPORT_GATE.get(env.REPORT_GATE.idFromName('global'));
  const place = (await (await gate.fetch('https://gate/take', { method: 'POST' })).json()) as GateAnswer;
  if (!place.ok) return json(place.reason === 'paused' ? 503 : 429, { ok: false, error: place.reason }, origin);
  const id = crypto.randomUUID().replace(/-/g, '');
  const key = `img/${id}`;
  await env.REPORT_IMAGES.put(key, parsed.image.bytes, { metadata: { type: parsed.image.type }, expirationTtl: IMAGE_DAYS * 86400 });
  let issue;
  try {
    issue = await createIssue({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, repo: env.GITHUB_REPO }, issueOf(parsed, `${new URL(request.url).origin}/${key}`));
  } catch (e) {
    console.error('could not open the issue', e instanceof Error ? e.message : String(e));
    await env.REPORT_IMAGES.delete(key).catch(() => {});
    // GitHub's content limits: every report waits (gate.ts PAUSE_MS) rather than pushing on.
    if (e instanceof GitHubError && (e.status === 403 || e.status === 429)) await gate.fetch('https://gate/pause', { method: 'POST' }).catch(() => {});
    return json(502, { ok: false, error: 'unavailable' }, origin);
  }
  return json(201, { ok: true, issue }, origin);
}

async function image(id: string, env: Env): Promise<Response> {
  if (!IMAGE_ID.test(id)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await env.REPORT_IMAGES.getWithMetadata<{ type?: string }>(`img/${id}`, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  const type = metadata?.type && /^image\/(png|jpeg|webp)$/.test(metadata.type) ? metadata.type : 'application/octet-stream';
  return new Response(value, {
    headers: {
      'Content-Type': type,
      // A day, so that an image taken down (README.md) is gone from caches soon after.
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    try {
      if (url.pathname === '/report') {
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
        if (request.method === 'POST') return await report(request, env, origin);
        return json(405, { ok: false, error: 'method' }, origin);
      }
      const img = /^\/img\/([^/]+)$/.exec(url.pathname);
      if (img && request.method === 'GET') return await image(img[1], env);
      return new Response('Not found', { status: 404 });
    } catch (e) {
      // KV over its daily writes, or anything unforeseen: an answer the extension can read.
      console.error('relay error', e instanceof Error ? e.message : String(e));
      return json(503, { ok: false, error: 'unavailable' }, origin);
    }
  },
};
