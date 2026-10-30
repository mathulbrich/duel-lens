import { describe, expect, it } from 'vitest';
import { reportClock, reportVideo } from './report';

describe('reportVideo', () => {
  it('names a YouTube video by its plain watch link, whatever form the page has', () => {
    const watch = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', time: 75 };
    expect(reportVideo('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1&index=3&pp=abc', 75.9)).toEqual(watch);
    expect(reportVideo('https://youtu.be/dQw4w9WgXcQ?si=share', 75)).toEqual(watch);
    expect(reportVideo('https://m.youtube.com/watch?v=dQw4w9WgXcQ', 75)).toEqual(watch);
    expect(reportVideo('https://www.youtube.com/live/dQw4w9WgXcQ?feature=x', 75)).toEqual(watch);
    expect(reportVideo('https://www.youtube.com/shorts/dQw4w9WgXcQ', undefined)).toEqual({ url: watch.url, time: null });
  });

  it("names any other page without its query or fragment, and a non-web page not at all", () => {
    expect(reportVideo('https://www.twitch.tv/videos/123?t=1h2m&token=secret#x', 10)).toEqual({ url: 'https://www.twitch.tv/videos/123', time: 10 });
    expect(reportVideo('https://www.youtube.com/results?search_query=ash', undefined)).toEqual({ url: 'https://www.youtube.com/results', time: null });
    expect(reportVideo('file:///Users/me/video.html', 5)).toBeNull();
    expect(reportVideo('not a url', 5)).toBeNull();
    expect(reportVideo('https://example.com/', -3)).toEqual({ url: 'https://example.com/', time: null });
  });
});

describe('reportClock', () => {
  it('writes h:mm:ss, or m:ss under an hour', () => {
    expect(reportClock(3735)).toBe('1:02:15');
    expect(reportClock(42)).toBe('0:42');
  });
});
