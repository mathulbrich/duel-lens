import { describe, expect, it } from 'vitest';
import { PAUSE_MS, PER_MINUTE, ReportGate } from './gate';

function gate(dailyCap?: string) {
  const store = new Map<string, unknown>();
  const g = new ReportGate(
    { storage: { get: async <T>(k: string) => store.get(k) as T | undefined, put: async (entries) => void Object.entries(entries).forEach(([k, v]) => store.set(k, v)) } },
    { DAILY_CAP: dailyCap },
  );
  return { g, store };
}

describe('ReportGate', () => {
  it('lets PER_MINUTE issues through in any 60 seconds, then the next once the oldest is a minute old', async () => {
    const { g } = gate();
    const t0 = Date.parse('2026-10-30T12:00:00Z');
    for (let i = 0; i < PER_MINUTE; i++) expect(await g.take(t0 + i * 1000)).toEqual({ ok: true });
    expect(await g.take(t0 + 30_000)).toEqual({ ok: false, reason: 'busy' });
    expect(await g.take(t0 + 60_001)).toEqual({ ok: true });
  });

  it('stops at the daily cap, and starts again the next day (UTC)', async () => {
    const { g } = gate('2');
    const t0 = Date.parse('2026-10-30T22:00:00Z');
    expect((await g.take(t0)).ok).toBe(true);
    expect((await g.take(t0 + 120_000)).ok).toBe(true);
    expect(await g.take(t0 + 240_000)).toEqual({ ok: false, reason: 'daily-limit' });
    expect((await g.take(Date.parse('2026-10-31T00:00:01Z'))).ok).toBe(true);
  });

  it('a pause holds every report for PAUSE_MS', async () => {
    const { g, store } = gate();
    const res = await g.fetch(new Request('https://gate/pause', { method: 'POST' }));
    expect(await res.json()).toEqual({ ok: true });
    const until = store.get('pausedUntil') as number;
    expect(until - Date.now()).toBeGreaterThan(PAUSE_MS - 5000);
    expect(await g.take(Date.now())).toEqual({ ok: false, reason: 'paused' });
    expect((await g.take(until + 1)).ok).toBe(true);
  });
});
