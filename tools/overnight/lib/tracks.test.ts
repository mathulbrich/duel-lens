import { describe, expect, it } from 'vitest';
import { CARD_BACK_ID } from '../../../src/shared/types';
import { buildTracks, cardCorners, labelTrack, momentTimes, nextClock, orient, quadOf, readUpsideDown, spreadOrder, trackUp, upOf, type Det, type Pt } from './tracks';

/** An upright card's corners (tl, tr, br, bl) at (x, y), 60×86. */
const card = (x: number, y: number, kind: Det['kind'] = 'face-up'): Det => ({
  kind,
  conf: 0.9,
  pts: [
    [x, y],
    [x + 60, y],
    [x + 60, y + 86],
    [x, y + 86],
  ],
});

describe('buildTracks', () => {
  it('follows a card across frames, lets it miss one, and starts new tracks for new cards', () => {
    const frames = [[card(0, 0), card(200, 0)], [card(2, 1)], [card(3, 1), card(200, 0)], [card(500, 500)]];
    const tracks = buildTracks(frames);
    expect(tracks.map((t) => t.members)).toEqual([
      [
        { frame: 0, det: 0 },
        { frame: 1, det: 0 },
        { frame: 2, det: 0 },
      ],
      [
        { frame: 0, det: 1 },
        { frame: 2, det: 1 },
      ],
      [{ frame: 3, det: 0 }],
    ]);
  });

  it('never joins a face-down detection to a face-up track (a set card flipped in place)', () => {
    const tracks = buildTracks([[card(0, 0, 'face-down')], [card(0, 0, 'face-up')]]);
    expect(tracks.map((t) => [t.kind, t.members.length])).toEqual([
      ['face-down', 1],
      ['face-up', 1],
    ]);
  });

  it('needs IoU ≥ 0.5', () => {
    expect(buildTracks([[card(0, 0)], [card(30, 0)]])).toHaveLength(2); // IoU 1/3
    expect(buildTracks([[card(0, 0)], [card(10, 0)]])).toHaveLength(1); // IoU 5/7
  });
});

describe('labelTrack', () => {
  const sure = (top: number) => ({ confident: true, top });
  const unsure = (top: number | null) => ({ confident: false, top });

  it('labels a track read confidently twice as the same card and propagates it', () => {
    expect(labelTrack([sure(7), unsure(9), sure(7), null, unsure(null)])).toEqual({
      cardId: 7,
      sources: ['confident', 'propagated', 'confident', 'propagated', 'propagated'],
    });
  });

  it('refuses one confident reading, and any confident disagreement', () => {
    expect(labelTrack([sure(7), unsure(7), unsure(7)]).cardId).toBeNull();
    expect(labelTrack([sure(7), sure(7), sure(8)])).toEqual({ cardId: null, sources: ['none', 'none', 'none'] });
  });

  it('gives members never read a source too (a sparse list)', () => {
    const sparse: ({ confident: boolean; top: number } | undefined)[] = new Array(4);
    sparse[0] = sure(3);
    sparse[3] = sure(3);
    expect(labelTrack(sparse).sources).toEqual(['confident', 'propagated', 'propagated', 'confident']);
    expect(labelTrack(new Array(3)).sources).toEqual(['none', 'none', 'none']);
  });

  it('labels the card back like any card', () => {
    expect(labelTrack([sure(CARD_BACK_ID), sure(CARD_BACK_ID)]).cardId).toBe(CARD_BACK_ID);
  });
});

describe('orientation', () => {
  const sideways: Pt[] = [
    [0, 0],
    [86, 0],
    [86, 60],
    [0, 60],
  ];

  it('orders corners from a short side, as the engine does', () => {
    const q = cardCorners(quadOf(sideways));
    expect(Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y)).toBeCloseTo(60);
  });

  it('reads upside down from the best hypothesis', () => {
    const q = cardCorners(quadOf(card(0, 0).pts)); // upright: turnTo = 0
    expect(readUpsideDown(q, { hypothesis: 'quad', rotation: 0 })).toBe(false);
    expect(readUpsideDown(q, { hypothesis: 'quad', rotation: 180 })).toBe(true);
    expect(readUpsideDown(q, { hypothesis: 'whole', rotation: 180 })).toBeNull();
    expect(readUpsideDown(q, undefined)).toBeNull();
  });

  it('turns every member to the track’s up', () => {
    const q = cardCorners(quadOf(card(0, 0).pts));
    const down = { x: -upOf(q).x, y: -upOf(q).y };
    const up = trackUp([{ up: down, weight: 0.9 }]);
    expect(orient(q, up)[0]).toEqual(q[2]);
    expect(orient(q, null)).toEqual(q);
  });
});

describe('moments', () => {
  it('spreads k moments over 5–95% of the video, the same on every run', () => {
    const ts = momentTimes('abc', 36000, 60);
    expect(ts).toHaveLength(60);
    expect(ts).toEqual(momentTimes('abc', 36000, 60));
    expect(Math.min(...ts)).toBeGreaterThanOrEqual(0.05 * 36000);
    expect(Math.max(...ts)).toBeLessThanOrEqual(0.95 * 36000);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  });

  it('visits moments in a spread order', () => {
    expect(spreadOrder(8)).toEqual([0, 4, 2, 6, 1, 5, 3, 7]);
    expect([...spreadOrder(13)].sort((a, b) => a - b)).toEqual(Array.from({ length: 13 }, (_, i) => i));
  });

  it('finds the next HH:MM', () => {
    const now = new Date(2026, 8, 30, 1, 0);
    expect(nextClock('04:30', now).getTime()).toBe(new Date(2026, 8, 30, 4, 30).getTime());
    expect(nextClock('00:30', now).getTime()).toBe(new Date(2026, 9, 1, 0, 30).getTime());
    expect(() => nextClock('4pm', now)).toThrow();
  });
});
