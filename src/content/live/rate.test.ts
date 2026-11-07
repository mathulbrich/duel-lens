import { describe, expect, it } from 'vitest';
import { createRate } from './rate';

describe('rate', () => {
  it('balanced waits cost/0.2, at least 500 ms', () => {
    const r = createRate('balanced');
    expect(r.next(50)).toBe(500);
    expect(r.next(200)).toBe(1000);
  });
  it('never waits more than LIVE.maxIntervalMs', () => expect(createRate('balanced').next(20_000)).toBe(30_000));
  it('light waits cost/0.1, at least 2000 ms', () => expect(createRate('light').next(300)).toBe(3000));
  it('rounds to whole milliseconds', () => expect(createRate('balanced').next(333)).toBe(1665));
  it('slow after 3 cycles in a row above slowAboveMs, cleared by one fast cycle', () => {
    const r = createRate('balanced');
    r.next(500);
    r.next(500);
    expect(r.slow).toBe(false);
    r.next(500);
    expect(r.slow).toBe(true);
    r.next(50);
    expect(r.slow).toBe(false);
  });
  it('setEffort switches the pace and the slow threshold', () => {
    const r = createRate('balanced');
    r.setEffort('light');
    expect(r.next(300)).toBe(3000);
    r.next(300);
    r.next(300);
    expect(r.slow).toBe(false); // 3000 ms is above balanced (2000) but under light (4000)
  });
});
