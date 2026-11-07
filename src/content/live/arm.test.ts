// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARM, createLiveArm, type LiveArmDeps } from './arm';

let clock = 0;
let video: HTMLVideoElement;
beforeEach(() => {
  clock = 1000;
  video = document.createElement('video');
  document.body.append(video);
  Object.defineProperty(video, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  Object.defineProperty(video, 'videoWidth', { value: 1280, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 720, configurable: true });
  video.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => video.remove());

function arm(over: Partial<LiveArmDeps> = {}) {
  const start = vi.fn(over.start ?? (async () => true));
  const a = createLiveArm({ doc: document, now: () => clock, running: () => false, ...over, start });
  return { a, start };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
const rest = (a: ReturnType<typeof arm>['a'], x = 100, y = 100) => {
  a.pointer(x, y);
  clock += ARM.dwellMs;
  vi.advanceTimersByTime(ARM.dwellMs);
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Live check arming', () => {
  it('starts Live on a playing video the pointer rests on for ARM.dwellMs, not before, not beside it, and not while off', async () => {
    const { a, start } = arm();
    rest(a);
    expect(start).not.toHaveBeenCalled(); // off
    a.setOn(true);
    rest(a, 900, 600); // beside the video
    expect(start).not.toHaveBeenCalled();
    a.pointer(100, 100);
    vi.advanceTimersByTime(ARM.dwellMs - 1);
    expect(start).not.toHaveBeenCalled(); // not rested long enough yet
    vi.advanceTimersByTime(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(a.video).toBe(video); // the one Live reads
    await flush();
  });

  it('a page with a video of ARM size asks for the warm-up once: when switched on, or at the first pointer move after', () => {
    const warm = vi.fn();
    const { a } = arm({ warm });
    a.pointer(100, 100);
    expect(warm).not.toHaveBeenCalled(); // off
    a.setOn(true);
    expect(warm).toHaveBeenCalledTimes(1);
    clock += ARM.checkMs;
    a.pointer(120, 100);
    a.setOn(false);
    a.setOn(true);
    expect(warm).toHaveBeenCalledTimes(1); // once for this page
  });

  it('a page whose videos are all smaller than ARM (feed previews) asks for no warm-up, until a big one comes', () => {
    video.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180, toJSON: () => ({}) }) as DOMRect;
    const warm = vi.fn();
    const { a } = arm({ warm });
    a.setOn(true);
    a.pointer(100, 100);
    expect(warm).not.toHaveBeenCalled();
    video.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) }) as DOMRect;
    clock += ARM.checkMs;
    a.pointer(110, 100);
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it('a pointer that leaves the video before the rest ends starts nothing', () => {
    const { a, start } = arm();
    a.setOn(true);
    a.pointer(100, 100);
    clock += ARM.checkMs;
    a.pointer(900, 600);
    vi.advanceTimersByTime(ARM.dwellMs);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not start over a paused video, a small one (a feed preview), nor while Live runs', () => {
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    const paused = arm();
    paused.a.setOn(true);
    rest(paused.a);
    expect(paused.start).not.toHaveBeenCalled();
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    video.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 360, bottom: 200, width: 360, height: 200, toJSON: () => ({}) }) as DOMRect;
    const small = arm();
    small.a.setOn(true);
    rest(small.a);
    expect(small.start).not.toHaveBeenCalled();
    video.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 360, width: 640, height: 360, toJSON: () => ({}) }) as DOMRect;
    const running = arm({ running: () => true });
    running.a.setOn(true);
    rest(running.a);
    expect(running.start).not.toHaveBeenCalled();
  });

  it('waits ARM.retryMs after a refused start', async () => {
    const { a, start } = arm({ start: vi.fn().mockResolvedValue(false) });
    a.setOn(true);
    rest(a);
    await flush();
    clock += ARM.checkMs;
    rest(a, 101, 101);
    expect(start).toHaveBeenCalledTimes(1); // refused: not again so soon
    clock += ARM.retryMs;
    rest(a, 102, 102);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stopped here by the user: no start again on this page until it is switched on afresh', async () => {
    const { a, start } = arm();
    a.setOn(true);
    a.stoppedHere();
    rest(a);
    expect(start).not.toHaveBeenCalled();
    a.setOn(false);
    a.setOn(true);
    clock += ARM.checkMs;
    rest(a);
    expect(start).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('leaving the page (gone) or hiding it during the rest starts nothing', () => {
    const { a, start } = arm();
    a.setOn(true);
    a.pointer(100, 100);
    a.gone();
    vi.advanceTimersByTime(ARM.dwellMs);
    expect(start).not.toHaveBeenCalled();
    clock += ARM.checkMs;
    a.pointer(110, 100);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    vi.advanceTimersByTime(ARM.dwellMs);
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    expect(start).not.toHaveBeenCalled();
  });
});
