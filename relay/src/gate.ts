// The relay's one true ceiling on issues: a single Durable Object (wrangler.toml REPORT_GATE, the instance named
// "global") that every report passes through once it is valid, just before its issue is opened. Being one object, its
// counts hold across all of Cloudflare's locations, which the rate limiting binding's don't (they count per location).
// - at most PER_MINUTE issues in any 60 seconds, and DAILY_CAP a day (UTC);
// - paused for PAUSE_MS whenever GitHub answers 403 or 429 (its content limits), so the App never keeps pushing.
// A Durable Object handles one event at a time and its storage calls are atomic with it, so read-then-write is safe.

export const PER_MINUTE = 6;
export const DEFAULT_DAILY_CAP = 100;
export const PAUSE_MS = 60 * 60_000;

/** The part of DurableObjectState used here. */
export interface GateState {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put(entries: Record<string, unknown>): Promise<void>;
  };
}

export type GateAnswer = { ok: true } | { ok: false; reason: 'paused' | 'busy' | 'daily-limit' };

export class ReportGate {
  constructor(
    private readonly state: GateState,
    private readonly env: { DAILY_CAP?: string } = {},
  ) {}

  /** POST /take: takes one issue's place, or says why not. POST /pause: GitHub said no, stop for PAUSE_MS. */
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/take') return Response.json(await this.take(Date.now()));
    if (path === '/pause') {
      await this.state.storage.put({ pausedUntil: Date.now() + PAUSE_MS });
      return Response.json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  }

  async take(now: number): Promise<GateAnswer> {
    const s = this.state.storage;
    if (((await s.get<number>('pausedUntil')) ?? 0) > now) return { ok: false, reason: 'paused' };
    const recent = ((await s.get<number[]>('recent')) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= PER_MINUTE) return { ok: false, reason: 'busy' };
    const today = new Date(now).toISOString().slice(0, 10);
    const day = (await s.get<{ date: string; count: number }>('day')) ?? { date: today, count: 0 };
    const count = day.date === today ? day.count : 0;
    const cap = Number(this.env.DAILY_CAP) > 0 ? Number(this.env.DAILY_CAP) : DEFAULT_DAILY_CAP;
    if (count >= cap) return { ok: false, reason: 'daily-limit' };
    await s.put({ recent: [...recent, now], day: { date: today, count: count + 1 } });
    return { ok: true };
  }
}
