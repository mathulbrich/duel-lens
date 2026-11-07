import { describe, expect, it } from "vitest";
import type { DetectedCardBox } from "../../shared/messages";
import { createTracker, iou, TRACK } from "./tracker";

const box = (
  cx: number,
  cy: number,
  kind: "face-up" | "face-down" = "face-up",
  s = 1,
): DetectedCardBox => {
  const hw = 30 * s;
  const hh = 44 * s;
  return {
    cx,
    cy,
    w: hw * 2,
    h: hh * 2,
    angle: 0,
    conf: 0.9,
    kind,
    pts: [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ],
  };
};
const frame = { width: 1280, height: 720 };
const all = () => true;

describe("iou", () => {
  it("is 1 for the same box, 0 for apart, in between for overlap", () => {
    const a = { x: 0, y: 0, w: 0.2, h: 0.2 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
    expect(iou(a, { x: 0.1, y: 0, w: 0.2, h: 0.2 })).toBeCloseTo(1 / 3, 5);
  });
});

describe("tracker", () => {
  it("normalises the box to the video", () => {
    const t = createTracker();
    const [a] = t.update([box(640, 360)], frame);
    expect(a.box.x).toBeCloseTo(610 / 1280, 6);
    expect(a.box.y).toBeCloseTo(316 / 720, 6);
    expect(a.box.w).toBeCloseTo(60 / 1280, 6);
    expect(a.box.h).toBeCloseTo(88 / 720, 6);
    expect(a.state).toBe("voting");
    expect(a.reads).toEqual([]);
  });

  it("keeps one id while a card drifts", () => {
    const t = createTracker();
    const [a] = t.update([box(400, 300)], frame);
    const [b] = t.update([box(410, 304)], frame);
    expect(b.id).toBe(a.id);
    expect(b.card.cx).toBe(410);
  });

  it("gives a far box a new id", () => {
    const t = createTracker();
    const [a] = t.update([box(400, 300)], frame);
    const [b] = t.update([box(900, 300)], frame);
    expect(b.id).not.toBe(a.id);
    expect(t.voting()).toBe(2);
  });

  it("matches each box and track once, best overlap first", () => {
    const t = createTracker();
    const [a] = t.update([box(400, 300)], frame);
    const got = t.update([box(430, 300), box(405, 300)], frame);
    expect(got).toHaveLength(2);
    expect(got.find((x) => x.card.cx === 405)?.id).toBe(a.id);
    expect(got.find((x) => x.card.cx === 430)?.id).not.toBe(a.id);
  });

  it("drops a track after 3 missed frames", () => {
    const t = createTracker();
    t.update([box(400, 300)], frame);
    t.update([], frame);
    t.update([], frame);
    expect(t.voting()).toBe(1);
    t.update([], frame);
    expect(t.voting()).toBe(0);
  });

  it("a hit resets the miss count", () => {
    const t = createTracker();
    const [a] = t.update([box(400, 300)], frame);
    t.update([], frame);
    t.update([], frame);
    const [b] = t.update([box(400, 300)], frame);
    expect(b.id).toBe(a.id);
    expect(b.misses).toBe(0);
    t.update([], frame);
    t.update([], frame);
    expect(t.voting()).toBe(1);
  });

  it("ignores face-down cards and cards under 0.045 of the video height", () => {
    const t = createTracker();
    const small = {
      ...box(100, 100),
      h: 30,
      w: 20,
      pts: [
        [90, 85],
        [110, 85],
        [110, 115],
        [90, 115],
      ] as [number, number][],
    };
    expect(TRACK.minLongSide).toBe(0.045);
    expect(t.update([box(400, 300, "face-down"), small], frame)).toEqual([]);
    expect(t.voting()).toBe(0);
  });

  it("toRead gives at most TRACK.readsPerCycle, unread and larger first", () => {
    expect(TRACK.readsPerCycle).toBe(8);
    const t = createTracker();
    const scales = [1, 1.36, 1.14, 1.25, 1.19, 1.05, 1.3, 1.1, 1.2]; // nine cards, the first the smallest
    const tracks = t.update(scales.map((k, i) => box(100 + i * 120, 300, "face-up", k)), frame);
    const bySize = [...tracks].sort((x, y) => y.box.w * y.box.h - x.box.w * x.box.h);
    const got = t.toRead(all);
    expect(got.map((x) => x.id)).toEqual(bySize.slice(0, 8).map((x) => x.id));
    expect(got.map((x) => x.id)).not.toContain(tracks[0].id);
  });

  it("toRead puts tracks with fewer reads first", () => {
    const t = createTracker();
    const [small, big] = t.update(
      [box(200, 300), box(500, 300, "face-up", 2)],
      frame,
    );
    big.reads.push({ cardId: null, imageId: null, confident: false });
    expect(t.toRead(all).map((x) => x.id)).toEqual([small.id, big.id]);
  });

  it("toRead leaves out tracks `may` refuses and tracks missed in the last detection", () => {
    const t = createTracker();
    const [, big, mid] = t.update(
      [
        box(200, 300),
        box(500, 300, "face-up", 120 / 88),
        box(800, 300, "face-up", 100 / 88),
      ],
      frame,
    );
    const got = t.toRead((x) => x.id !== big.id);
    expect(got).toHaveLength(2);
    expect(got[0].id).toBe(mid.id);
    t.update([], frame);
    expect(t.toRead(all)).toEqual([]);
  });

  it("toRead skips tracks no longer voting", () => {
    const t = createTracker();
    const [a] = t.update([box(400, 300)], frame);
    a.state = "promoted";
    expect(t.toRead(all)).toEqual([]);
    expect(t.voting()).toBe(0);
  });

  it("reset forgets every track", () => {
    const t = createTracker();
    t.update([box(400, 300)], frame);
    t.reset();
    expect(t.voting()).toBe(0);
  });
});
