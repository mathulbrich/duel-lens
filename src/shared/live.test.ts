import { describe, expect, it } from 'vitest';
import { LIVE, applyProgress, isLiveEffort, isLiveLog, startLog } from './live';

const page = { tabId: 7, pageKey: 'yt:abc', pageUrl: 'https://www.youtube.com/watch?v=abc', pageTitle: 'Finals' };

describe('startLog', () => {
  it('keeps entries for the same tab and page, and starts afresh for another page', () => {
    const a = applyProgress(startLog(null, page, 1), {
      status: 'watching',
      voting: 0,
      sightings: [{ cardId: 1, imageId: 10, videoTime: 5 }],
    });
    expect(startLog(a, page, 2).entries).toHaveLength(1);
    expect(startLog(a, { ...page, pageKey: 'yt:xyz', pageUrl: 'https://www.youtube.com/watch?v=xyz' }, 2).entries).toEqual([]);
    // A different &t= on the same video is the same page key: the list stays.
    expect(startLog(a, { ...page, pageUrl: 'https://www.youtube.com/watch?v=abc&t=90s' }, 2).entries).toHaveLength(1);
    expect(startLog(a, { ...page, tabId: 8 }, 2).entries).toEqual([]);
    expect(startLog(a, page, 2)).toMatchObject({ status: 'starting', startedAt: 2, voting: 0 });
  });
});

describe('applyProgress', () => {
  it('lists a new card first and counts a reappearance only after 20 s of video', () => {
    let log = startLog(null, page, 1);
    log = applyProgress(log, { status: 'watching', voting: 1, sightings: [{ cardId: 1, imageId: 10, videoTime: 5 }] });
    log = applyProgress(log, {
      status: 'watching',
      voting: 0,
      sightings: [
        { cardId: 2, imageId: 20, videoTime: 9 },
        { cardId: 1, imageId: 10, videoTime: 24 },
      ],
    });
    expect(log.entries.map((e) => e.cardId)).toEqual([2, 1]);
    expect(log.entries[1]).toMatchObject({ firstVideoTime: 5, lastVideoTime: 24, appearances: 1 });
    log = applyProgress(log, { status: 'watching', voting: 0, sightings: [{ cardId: 1, imageId: 10, videoTime: 45 }] });
    expect(log.entries[1]).toMatchObject({ lastVideoTime: 45, appearances: 2 });
  });

  it('caps the list at 200, dropping the oldest', () => {
    let log = startLog(null, page, 1);
    for (let i = 0; i <= LIVE.maxEntries; i++) {
      log = applyProgress(log, { status: 'watching', voting: 0, sightings: [{ cardId: i, imageId: i, videoTime: i }] });
    }
    expect(log.entries).toHaveLength(LIVE.maxEntries);
    expect(log.entries.some((e) => e.cardId === 0)).toBe(false);
    expect(log.entries[0].cardId).toBe(LIVE.maxEntries);
  });

  it('copies status, stopReason, intervalMs and voting', () => {
    const log = applyProgress(startLog(null, page, 1), {
      status: 'stopped',
      stopReason: 'left',
      intervalMs: 3000,
      voting: 2,
      sightings: [],
    });
    expect(log).toMatchObject({ status: 'stopped', stopReason: 'left', intervalMs: 3000, voting: 2 });
  });

  it('keeps the latest time when a sighting is older than the entry', () => {
    let log = applyProgress(startLog(null, page, 1), {
      status: 'watching',
      voting: 0,
      sightings: [{ cardId: 1, imageId: 10, videoTime: 50 }],
    });
    log = applyProgress(log, { status: 'watching', voting: 0, sightings: [{ cardId: 1, imageId: 10, videoTime: 30 }] });
    expect(log.entries[0]).toMatchObject({ lastVideoTime: 50, appearances: 1 });
  });
});

describe('isLiveLog', () => {
  it('rejects malformed values', () => {
    expect(isLiveLog({ tabId: 'x' })).toBe(false);
    expect(isLiveLog(null)).toBe(false);
    expect(isLiveLog({ ...startLog(null, page, 1), entries: [{ cardId: 'x' }] })).toBe(false);
    expect(isLiveLog({ ...startLog(null, page, 1), status: 'nope' })).toBe(false);
    expect(isLiveLog({ ...startLog(null, page, 1), pageKey: undefined })).toBe(false);
    expect(isLiveLog(startLog(null, page, 1))).toBe(true);
  });
});

describe('isLiveEffort', () => {
  it('knows the three speeds', () => {
    expect(isLiveEffort('balanced')).toBe(true);
    expect(isLiveEffort('light')).toBe(true);
    expect(isLiveEffort('best')).toBe(true);
    expect(isLiveEffort('turbo')).toBe(false);
  });
});
