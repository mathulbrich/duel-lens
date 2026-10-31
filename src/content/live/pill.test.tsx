// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/preact';
import { trustEvents, untrusted } from '../test-events';
import type { LiveView } from './controller';
import { LivePill } from './pill';

let distrust: () => void;
beforeEach(() => {
  distrust = trustEvents();
});
afterEach(() => {
  cleanup();
  distrust();
});

function videoAt(left: number, top: number): HTMLVideoElement {
  const v = document.createElement('video');
  v.getBoundingClientRect = () => ({ left, top, right: left + 640, bottom: top + 360, width: 640, height: 360, x: left, y: top, toJSON: () => ({}) });
  document.body.append(v);
  return v;
}

const view = (over: Partial<LiveView> = {}): LiveView => ({ running: true, paused: false, count: 6, showLabel: true, video: videoAt(100, 50), cards: [], ...over });

describe('LivePill', () => {
  it('renders the count and LIVE at the video corner', () => {
    const { container } = render(<LivePill view={view()} onStop={() => undefined} />);
    const pill = container.querySelector<HTMLElement>('.live-pill')!;
    expect(pill.style.left).toBe('112px');
    expect(pill.style.top).toBe('62px');
    expect(pill.textContent).toContain('Live');
    expect(pill.textContent).toContain('6');
    expect(pill.querySelector('.live-dot')!.classList.contains('paused')).toBe(false);
  });

  it('follows the video on resize, scroll and fullscreenchange', () => {
    const v = videoAt(100, 50);
    const { container } = render(<LivePill view={view({ video: v })} onStop={() => undefined} />);
    const pill = container.querySelector<HTMLElement>('.live-pill')!;
    for (const [type, target] of [['resize', window], ['scroll', window], ['fullscreenchange', document]] as const) {
      const at = pill.style.left === '112px' ? 300 : 112;
      v.getBoundingClientRect = () => ({ left: at - 12, top: 0, right: 0, bottom: 0, width: 640, height: 360, x: 0, y: 0, toJSON: () => ({}) });
      fireEvent(target, new Event(type));
      expect(pill.style.left, type).toBe(`${at}px`);
    }
  });

  it('follows the video when its box changes without a window event (theater mode, miniplayer)', () => {
    const observed: { cb: () => void; target?: Element; disconnected: boolean }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        entry: { cb: () => void; target?: Element; disconnected: boolean };
        constructor(cb: () => void) {
          this.entry = { cb, disconnected: false };
          observed.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
    try {
      const v = videoAt(100, 50);
      const { container, unmount } = render(<LivePill view={view({ video: v })} onStop={() => undefined} />);
      expect(observed).toHaveLength(1);
      expect(observed[0].target).toBe(v);
      v.getBoundingClientRect = () => ({ left: 400, top: 0, right: 0, bottom: 0, width: 640, height: 360, x: 0, y: 0, toJSON: () => ({}) });
      act(() => observed[0].cb());
      expect(container.querySelector<HTMLElement>('.live-pill')!.style.left).toBe('412px');
      unmount();
      expect(observed[0].disconnected).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renders nothing when the label setting is off, Live is off or there is no video', () => {
    for (const over of [{ showLabel: false }, { running: false }, { video: null }]) {
      const { container, unmount } = render(<LivePill view={view(over)} onStop={() => undefined} />);
      expect(container.querySelector('.live-pill'), JSON.stringify(Object.keys(over))).toBeNull();
      unmount();
    }
  });

  it('the ✕ stops Live only on a trusted click', () => {
    const onStop = vi.fn();
    const { getByRole } = render(<LivePill view={view()} onStop={onStop} />);
    const x = getByRole('button', { name: 'Stop Live' });
    fireEvent(x, untrusted(createEvent.click(x)));
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.click(x);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('"Live N" opens the panel on a trusted click', () => {
    const onOpen = vi.fn();
    const { getByRole } = render(<LivePill view={view()} onStop={() => undefined} onOpen={onOpen} />);
    const open = getByRole('button', { name: /^Live/ });
    expect(open.getAttribute('title')).toBe('Show the cards Live found');
    fireEvent(open, untrusted(createEvent.click(open)));
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a grey dot while paused', () => {
    const { container } = render(<LivePill view={view({ paused: true })} onStop={() => undefined} />);
    expect(container.querySelector('.live-dot')!.classList.contains('paused')).toBe(true);
  });
});
