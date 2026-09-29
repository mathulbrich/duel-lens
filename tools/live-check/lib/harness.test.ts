// The live check's closeOverlay (harness.ts): Escape until the overlay has gone, as a user would (final
// review M8). Since F1, a click on no outline arms a two-click box, and the first Escape only drops its corner.
import { afterEach, describe, expect, it, vi } from 'vitest';

// harness.ts loads Puppeteer (from the E2E harness's own install) at import; closeOverlay needs none of it.
vi.mock('../../../test/e2e/node_modules/puppeteer/lib/puppeteer/puppeteer.js', () => ({ default: {} }));

import { closeOverlay, type Page } from './harness';

/** A page whose overlay goes after `escapes` presses of Escape (Infinity: never), counting the presses. */
function pageClosingAfter(escapes: number, { open = true } = {}) {
  let pressed = 0;
  const page = {
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === 'Escape' && ++pressed >= escapes) open = false;
      }),
    },
    // hostState(): the host element's mirrored state, or null once it has gone.
    evaluate: vi.fn(async () => (open ? { state: 'selecting', card: null, confident: null, cards: '4' } : null)),
  };
  return { page: page as unknown as Page, presses: () => pressed };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('closeOverlay', () => {
  it('presses Escape once when that closes it', async () => {
    const { page, presses } = pageClosingAfter(1);
    expect(await closeOverlay(page)).toBe(true);
    expect(presses()).toBe(1);
  });

  it('presses Escape again when the first only dropped an armed corner, until the host has gone', async () => {
    vi.useFakeTimers();
    const { page, presses } = pageClosingAfter(2);
    const closing = closeOverlay(page);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await closing).toBe(true);
    expect(presses()).toBe(2);
  });

  it('presses nothing when no overlay is open', async () => {
    const { page, presses } = pageClosingAfter(1, { open: false });
    expect(await closeOverlay(page)).toBe(true);
    expect(presses()).toBe(0);
  });

  it('gives up, and says so, after 3 presses that leave it open', async () => {
    vi.useFakeTimers();
    const { page, presses } = pageClosingAfter(Infinity);
    const closing = closeOverlay(page);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await closing).toBe(false);
    expect(presses()).toBe(3);
  });
});
