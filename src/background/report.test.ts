import { describe, expect, it, vi } from 'vitest';
import { REPORT_RELAY_URL, type ReportDraft } from '../shared/report';
import { browserOf, REPORT_IMAGE_SIDE, sendReport, type ReportDeps } from './report';

const DRAFT: ReportDraft = {
  kind: 'wrong-card',
  dataUrl: 'data:image/png;base64,CROP',
  shown: { cardId: 14558127, name: 'Ash Blossom & Joyous Spring', score: 0.61, confident: true },
  others: [1, 2, 3, 4, 5].map((i) => ({ cardId: i, name: `Card ${i}`, score: 0.5 - i / 100 })),
  userCard: { cardId: 59438930, name: 'Ghost Ogre & Snow Rabbit' },
  comment: '  glare  ',
  pageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1',
  videoTime: 75.9,
  modelId: 'dinov2-small-duel-v3b',
};

function deps(over: Partial<ReportDeps> = {}) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true, issue: { number: 9, url: 'https://github.com/mathulbrich/duel-lens/issues/9' } }, { status: 201 }),
  );
  const shrink = vi.fn(async (_dataUrl: string, maxSide: number) => `data:image/jpeg;base64,${'A'.repeat(maxSide)}`);
  const d: ReportDeps = { fetch: fetch as unknown as typeof globalThis.fetch, shrink, allowed: async () => true, version: '0.9.4', browser: 'Chrome 141', os: 'Windows', ...over };
  return { d, fetch, shrink };
}

describe('sendReport', () => {
  it('posts the report to the relay: a shrunk JPEG, the cards as ids and names, the YouTube link alone, the version and browser', async () => {
    const { d, fetch, shrink } = deps();
    expect(await sendReport(DRAFT, d)).toEqual({ ok: true, issue: { number: 9, url: 'https://github.com/mathulbrich/duel-lens/issues/9' } });
    expect(shrink).toHaveBeenCalledWith('data:image/png;base64,CROP', REPORT_IMAGE_SIDE, 0.85);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(REPORT_RELAY_URL);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      v: 1,
      kind: 'wrong-card',
      image: `data:image/jpeg;base64,${'A'.repeat(REPORT_IMAGE_SIDE)}`,
      shown: { id: 14558127, name: 'Ash Blossom & Joyous Spring', score: 0.61, confident: true },
      others: [1, 2, 3, 4].map((i) => ({ id: i, name: `Card ${i}`, score: 0.5 - i / 100 })),
      userCard: { id: 59438930, name: 'Ghost Ogre & Snow Rabbit' },
      comment: 'glare',
      video: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', time: 75 },
      app: { version: '0.9.4', browser: 'Chrome 141', os: 'Windows', model: 'dinov2-small-duel-v3b' },
    });
  });

  it('shrinks the picture again when it would pass the relay’s limit', async () => {
    const shrink = vi.fn(async (_d: string, maxSide: number) => `data:image/jpeg;base64,${'A'.repeat(maxSide === REPORT_IMAGE_SIDE ? 300_000 : 1000)}`);
    const { d } = deps({ shrink });
    await sendReport(DRAFT, d);
    expect(shrink.mock.calls.map((c) => c[1])).toEqual([REPORT_IMAGE_SIDE, 320]);
  });

  it('sends nothing without the consent (Firefox), and names the relay’s refusals', async () => {
    const none = deps({ allowed: async () => false });
    expect(await sendReport(DRAFT, none.d)).toEqual({ ok: false, error: 'consent' });
    expect(none.fetch).not.toHaveBeenCalled();
    for (const [status, error, expected] of [
      [429, 'rate-limited', 'rate-limited'],
      [429, 'daily-limit', 'daily-limit'],
      [503, 'paused', 'paused'],
      [502, 'unavailable', 'unavailable'],
      [500, 'something new', 'unavailable'],
    ] as const) {
      const { d } = deps({ fetch: (async () => Response.json({ ok: false, error }, { status })) as unknown as typeof fetch });
      expect(await sendReport(DRAFT, d)).toEqual({ ok: false, error: expected });
    }
    const offline = deps({ fetch: (async () => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch });
    expect(await sendReport(DRAFT, offline.d)).toEqual({ ok: false, error: 'network' });
  });

  it("trusts only a GitHub address as the issue's link", async () => {
    const { d } = deps({ fetch: (async () => Response.json({ ok: true, issue: { number: 1, url: 'https://evil.example/' } }, { status: 201 })) as unknown as typeof fetch });
    expect(await sendReport(DRAFT, d)).toEqual({ ok: false, error: 'unavailable' });
  });
});

describe('browserOf', () => {
  it('names Chrome, Edge, Opera and Firefox, and the OS', () => {
    const chrome = { userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0 Safari/537.36', userAgentData: { brands: [{ brand: 'Chromium', version: '141' }, { brand: 'Google Chrome', version: '141' }], platform: 'Windows' } };
    expect(browserOf(chrome)).toEqual({ browser: 'Chrome 141', os: 'Windows' });
    const edge = { userAgent: 'x', userAgentData: { brands: [{ brand: 'Chromium', version: '140' }, { brand: 'Microsoft Edge', version: '140' }], platform: 'macOS' } };
    expect(browserOf(edge)).toEqual({ browser: 'Edge 140', os: 'macOS' });
    const opera = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/139.0 Safari/537.36 OPR/124.0' };
    expect(browserOf(opera)).toEqual({ browser: 'Opera 124', os: 'Linux' });
    expect(browserOf({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:140.0) Gecko/20100101 Firefox/140.0' })).toEqual({ browser: 'Firefox 140', os: 'macOS' });
  });
});
