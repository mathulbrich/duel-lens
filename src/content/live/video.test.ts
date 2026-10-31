// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { pageKey, pickLiveVideo } from './video';

afterEach(() => {
  document.body.innerHTML = '';
});

/** A video of `w` x `h` CSS px at `at`, playing or not, with `readyState` frames decoded. */
function video(w: number, h: number, o: { playing?: boolean; readyState?: number; at?: [number, number] } = {}) {
  const [x, y] = o.at ?? [0, 0];
  const v = document.createElement('video');
  Object.defineProperty(v, 'paused', { get: () => !o.playing, configurable: true });
  Object.defineProperty(v, 'readyState', { get: () => o.readyState ?? 4, configurable: true });
  v.getBoundingClientRect = () => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} }) as DOMRect;
  document.body.append(v);
  return v;
}

describe('pickLiveVideo', () => {
  it('prefers the largest visible playing video', () => {
    const main = video(640, 360, { playing: true });
    video(1280, 720, { playing: false });
    video(200, 112, { playing: true });
    expect(pickLiveVideo(document)).toBe(main);
  });

  it('takes the largest when every video is paused', () => {
    video(640, 360);
    const big = video(900, 500);
    video(200, 112);
    expect(pickLiveVideo(document)).toBe(big);
  });

  it('skips videos without metadata or off screen', () => {
    video(640, 360, { readyState: 0 });
    video(640, 360, { playing: true, at: [0, 5000] });
    video(640, 360, { playing: true, at: [-700, 0] });
    expect(pickLiveVideo(document)).toBeNull();
    const ok = video(300, 200, { readyState: 2 });
    expect(pickLiveVideo(document)).toBe(ok);
  });

  it('takes a video still buffering after a seek (metadata, no decoded frame yet)', () => {
    const buffering = video(640, 360, { playing: true, readyState: 1 });
    expect(pickLiveVideo(document)).toBe(buffering);
  });

  it('takes a decoded video over a larger, playing one still buffering', () => {
    video(1280, 720, { playing: true, readyState: 1 });
    const decoded = video(400, 225, { readyState: 4 });
    expect(pickLiveVideo(document)).toBe(decoded);
  });

  it('is null on a page without videos', () => {
    expect(pickLiveVideo(document)).toBeNull();
  });
});

describe('pageKey', () => {
  it('keys YouTube by v and drops hashes elsewhere', () => {
    expect(pageKey('https://www.youtube.com/watch?v=abc&t=30s')).toBe('yt:abc');
    expect(pageKey('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1');
  });

  it('keys a YouTube page that is not a watch page by its URL, and survives junk', () => {
    expect(pageKey('https://www.youtube.com/results?v=abc#x')).toBe('https://www.youtube.com/results?v=abc');
    expect(pageKey('not a url')).toBe('not a url');
  });
});
