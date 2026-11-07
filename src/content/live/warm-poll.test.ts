// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarmState } from '../../shared/messages';
import { WARM_POLL, createWarmPoll } from './warm-poll';

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
});
afterEach(() => vi.useRealTimers());

function poll(states: WarmState['done'][]) {
  let i = 0;
  const ask = vi.fn(async (): Promise<WarmState> => ({ done: states[Math.min(i++, states.length - 1)], now: 1 }));
  const onChange = vi.fn();
  return { p: createWarmPoll({ doc: document, ask, onChange }), ask, onChange };
}
const settle = async () => {
  for (let k = 0; k < 4; k++) await Promise.resolve();
};

describe("Live's getting-ready poll", () => {
  it('asks while a run waits, reports each change, and stops once every step is done', async () => {
    const { p, ask, onChange } = poll([{}, { finder: 1 }, { finder: 1, 'finder-run': 2, reader: 3, 'reader-run': 4 }]);
    p.follow(true);
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(WARM_POLL.everyMs);
    await settle();
    expect(p.done).toBe(1);
    vi.advanceTimersByTime(WARM_POLL.everyMs);
    await settle();
    expect(p.done).toBe(4);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([1, 4]);
    vi.advanceTimersByTime(10 * WARM_POLL.everyMs);
    await settle();
    expect(ask).toHaveBeenCalledTimes(3); // all done: no more asking
  });

  it('does not ask while the page is hidden, and asks again when it shows', async () => {
    const { p, ask } = poll([{}]);
    hidden = true;
    p.follow(true);
    vi.advanceTimersByTime(5 * WARM_POLL.everyMs);
    await settle();
    expect(ask).not.toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(ask).toHaveBeenCalledTimes(1);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5 * WARM_POLL.everyMs);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('stops when the run is ready or ends, and starts from nothing for the next one', async () => {
    const { p, ask } = poll([{ finder: 1 }]);
    p.follow(true);
    await settle();
    expect(p.done).toBe(1);
    p.follow(false);
    expect(p.done).toBe(0);
    vi.advanceTimersByTime(5 * WARM_POLL.everyMs);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
