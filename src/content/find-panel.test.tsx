// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import { FindPanel } from './find-panel';

beforeEach(() => {
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn(async () => ({ matches: [] })) } });
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1200);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const panel = () => document.querySelector<HTMLElement>('.find-panel')!;

describe('FindPanel', () => {
  it('opens under the bar at the top of the frame, no taller than the room under it', () => {
    render(<FindPanel bar={{ x: 360, y: 12, w: 480, h: 40 }} onPick={() => {}} onClose={() => {}} />);
    expect(panel().dataset.side).toBe('below');
    expect(panel().style.top).toBe('60px');
    expect(panel().style.bottom).toBe('');
    expect(panel().style.maxHeight).toBe('732px');
  });

  it('opens above the bar at the bottom of the frame, so it never runs off the screen', () => {
    render(<FindPanel bar={{ x: 360, y: 748, w: 480, h: 40 }} onPick={() => {}} onClose={() => {}} />);
    expect(panel().dataset.side).toBe('above');
    expect(panel().style.top).toBe('');
    expect(panel().style.bottom).toBe('60px');
    expect(panel().style.maxHeight).toBe('732px');
  });
});
