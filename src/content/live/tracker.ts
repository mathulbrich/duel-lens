// Live's tracker: follows each detected card from one detection to the next by box overlap, so a card keeps its
// id (and its reads) while it drifts, and a card that is gone for a few detections is forgotten.
import type { DetectedCardBox } from "../../shared/messages";
import type { NormBox } from "./gate";
import type { Read, VoteState } from "./vote";

export const TRACK = {
  matchIou: 0.3,
  missLimit: 3,
  minLongSide: 0.045,
  readsPerCycle: 2,
} as const;

export interface Track {
  id: number;
  box: NormBox;
  /** The latest matched detection, in the video's native pixels. */
  card: DetectedCardBox;
  /** Detections in a row that did not find it. */
  misses: number;
  reads: Read[];
  state: VoteState;
}

export interface Tracker {
  /** Match `boxes` (native video px) to the tracks; returns the tracks matched or created by this call. */
  update(
    boxes: DetectedCardBox[],
    video: { width: number; height: number },
  ): Track[];
  /** Up to `readsPerCycle` tracks seen in the last detection, still voting and allowed by `may`: fewest reads, then largest. */
  toRead(may: (t: Track) => boolean): Track[];
  /** Every track now followed. */
  tracks(): readonly Track[];
  /** Tracks still voting. */
  voting(): number;
  reset(): void;
}

export function iou(a: NormBox, b: NormBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function normBox(
  card: DetectedCardBox,
  video: { width: number; height: number },
): NormBox {
  const xs = card.pts.map((p) => p[0]);
  const ys = card.pts.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x: x / video.width,
    y: y / video.height,
    w: (Math.max(...xs) - x) / video.width,
    h: (Math.max(...ys) - y) / video.height,
  };
}

export function createTracker(): Tracker {
  let tracks: Track[] = [];
  let nextId = 1;

  return {
    update(boxes, video) {
      const fresh = boxes
        .filter(
          (b) =>
            b.kind === "face-up" &&
            Math.max(b.w, b.h) / video.height >= TRACK.minLongSide,
        )
        .map((card) => ({ card, box: normBox(card, video) }));

      const pairs: { ti: number; bi: number; iou: number }[] = [];
      tracks.forEach((t, ti) =>
        fresh.forEach((f, bi) => {
          const v = iou(t.box, f.box);
          if (v >= TRACK.matchIou) pairs.push({ ti, bi, iou: v });
        }),
      );
      pairs.sort((a, b) => b.iou - a.iou);

      const usedTracks = new Set<number>();
      const usedBoxes = new Set<number>();
      const touched: Track[] = [];
      for (const p of pairs) {
        if (usedTracks.has(p.ti) || usedBoxes.has(p.bi)) continue;
        usedTracks.add(p.ti);
        usedBoxes.add(p.bi);
        const t = tracks[p.ti];
        t.box = fresh[p.bi].box;
        t.card = fresh[p.bi].card;
        t.misses = 0;
        touched.push(t);
      }
      tracks.forEach((t, ti) => {
        if (!usedTracks.has(ti)) t.misses += 1;
      });
      fresh.forEach((f, bi) => {
        if (usedBoxes.has(bi)) return;
        const t: Track = {
          id: nextId++,
          box: f.box,
          card: f.card,
          misses: 0,
          reads: [],
          state: "voting",
        };
        tracks.push(t);
        touched.push(t);
      });
      tracks = tracks.filter((t) => t.misses < TRACK.missLimit);
      return touched;
    },

    toRead(may) {
      return tracks
        .filter((t) => t.misses === 0 && t.state === "voting" && may(t))
        .sort(
          (a, b) =>
            a.reads.length - b.reads.length ||
            b.box.w * b.box.h - a.box.w * a.box.h,
        )
        .slice(0, TRACK.readsPerCycle);
    },

    tracks: () => tracks,

    voting: () => tracks.filter((t) => t.state === "voting").length,

    reset() {
      tracks = [];
    },
  };
}
