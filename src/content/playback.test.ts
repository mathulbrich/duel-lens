// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pausePlaying, resume } from './playback';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A video that plays and pauses, at `box` on the page. */
function video(playing: boolean, box = { x: 0, y: 0, w: 640, h: 360 }) {
  const v = document.createElement('video');
  let on = playing;
  Object.defineProperty(v, 'paused', { get: () => !on, configurable: true });
  v.pause = vi.fn(() => {
    on = false;
  });
  v.play = vi.fn(async () => {
    on = true;
  });
  v.getBoundingClientRect = () =>
    ({ x: box.x, y: box.y, left: box.x, top: box.y, width: box.w, height: box.h, right: box.x + box.w, bottom: box.y + box.h, toJSON() {} }) as DOMRect;
  document.body.append(v);
  return v;
}

describe('pausePlaying and resume (live check m1)', () => {
  it('pauses the videos playing on screen, and says which', () => {
    const on = video(true);
    const stopped = video(false);
    const offScreen = video(true, { x: 0, y: 5000, w: 640, h: 360 });
    expect(pausePlaying()).toEqual([on]);
    expect(on.paused).toBe(true);
    expect(stopped.pause).not.toHaveBeenCalled();
    expect(offScreen.pause).not.toHaveBeenCalled();
  });

  it('plays again only the videos it is given that are still paused and on the page', () => {
    const a = video(true);
    const b = video(true);
    const gone = video(true);
    const paused = pausePlaying();
    b.play(); // the user played it already
    gone.remove();
    resume(paused);
    expect(a.play).toHaveBeenCalledTimes(1);
    expect(b.play).toHaveBeenCalledTimes(1); // only the user's own call
    expect(gone.play).not.toHaveBeenCalled();
  });

  it("doesn't throw when the page refuses to play (autoplay rules)", async () => {
    const v = video(true);
    pausePlaying();
    v.play = vi.fn(() => Promise.reject(new DOMException('not allowed', 'NotAllowedError')));
    expect(() => resume([v])).not.toThrow();
    await Promise.resolve();
  });
});
