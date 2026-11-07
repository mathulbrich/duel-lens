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
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Live check arming', () => {
  it('starts Live once the pointer is over a playing video, not before, and not while off', async () => {
    const { a, start } = arm();
    a.pointer(100, 100);
    expect(start).not.toHaveBeenCalled(); // off
    a.setOn(true);
    a.pointer(900, 600); // beside the video
    clock += ARM.checkMs;
    a.pointer(100, 100);
    expect(start).toHaveBeenCalledTimes(1);
    await flush();
  });

  it('does not start over a paused video, nor while Live runs', () => {
    Object.defineProperty(video, 'paused', { value: true, configurable: true });
    const { a, start } = arm();
    a.setOn(true);
    a.pointer(100, 100);
    expect(start).not.toHaveBeenCalled();
    const running = arm({ running: () => true });
    Object.defineProperty(video, 'paused', { value: false, configurable: true });
    running.a.setOn(true);
    running.a.pointer(100, 100);
    expect(running.start).not.toHaveBeenCalled();
  });

  it('checks the pointer at most every ARM.checkMs, and waits ARM.retryMs after a refused start', async () => {
    const { a, start } = arm({ start: vi.fn().mockResolvedValue(false) });
    a.setOn(true);
    a.pointer(100, 100);
    await flush();
    clock += ARM.checkMs;
    a.pointer(100, 100);
    expect(start).toHaveBeenCalledTimes(1); // refused: not again so soon
    clock += ARM.retryMs;
    a.pointer(100, 100);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('stopped here by the user: no start again on this page until it is switched on afresh', async () => {
    const { a, start } = arm();
    a.setOn(true);
    a.stoppedHere();
    a.pointer(100, 100);
    expect(start).not.toHaveBeenCalled();
    a.setOn(false);
    a.setOn(true);
    clock += ARM.checkMs;
    a.pointer(100, 100);
    expect(start).toHaveBeenCalledTimes(1);
    await flush();
  });
});
