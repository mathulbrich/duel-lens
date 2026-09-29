// Click to scan's first scheme, now for offline tools only: a screenshot cut into square tiles of its
// short side, a model run per tile, and the boxes merged into one outline per card, in screenshot
// pixels. click-D validated it with a stand-in model, the earlier prototype's detector (since removed;
// click-D-report.md); the detector agent compared our own detector through it (tools/train-detector/
// evaluate.ts --path tiles). The extension doesn't use it: our detector sees a whole screenshot in one
// run, which keeps each card's 4 corners and the face-down class the tiles drop (A4, a4-report.md;
// src/offscreen/detector/). Evidence with the stand-in on 7 hand-labelled broadcast frames (1456×819,
// their 2× upscales as Retina captures, 480p/360p re-encodes):
//   whole frame, 1 run:             45/52 face-up cards and featured panels, 0 false outlines
//   two squares of the height, 2:   48/52, 0 false outlines at ≥ 0.6 (mat art at 0.56 below)
//   plus the whole frame, 3:        48/52, 3 more deck piles
//   six 640-px tiles at 1×, 6:      49/52, 3–5 false outlines (the mat's card-shaped art at 0.93)
import type { CardDetector, Schedule } from '../../src/offscreen/detect-cards';
import type { OwnCardDetector } from '../../src/offscreen/detector/detector';
import { CARD_DETECTOR, type CardKind } from '../../src/offscreen/detector/spec';
import { boundsOf, boxCorners, insideShare, iou, PICK, type Quad, type Rect } from '../../src/offscreen/geometry';
import type { DetectedCardBox } from '../../src/shared/messages';
import { cropRGBA, type RGBAImage } from '../../src/shared/preprocess';

/** A card a detector model found: an oriented box, in pixels of the image the model ran on. */
export interface OrientedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Radians, clockwise on screen (y points down): the w×h box turned this much about its centre. */
  angle: number;
  /** 0–1. */
  confidence: number;
}

/** A card detector model that sees one tile of a screenshot at a time (a fixed input size). */
export interface TileModel {
  /** Every card in `tile`, in the tile's pixels, any confidence (the search thresholds them). */
  detectTile(tile: RGBAImage): Promise<OrientedBox[]>;
  release?(): Promise<void>;
}

export const CARD_SEARCH = {
  /**
   * Tiles are squares of the screenshot's short side, spread along its long side, each overlapping
   * the next by at least this share of a tile: a card cut by one tile's edge is whole in its
   * neighbour (on 16:9, two tiles overlapping by 22%, 182 px at 1456×819).
   */
  minOverlap: 0.2,
  /** A screenshot at most this much wider than tall (or taller than wide) is one tile, letterboxed. */
  singleTileAspect: 1.25,
  /**
   * Outlines below this confidence are dropped. Calibrated on the stand-in model: face-up cards and
   * featured panels at least 0.90 (0.75 on a 360p stream), false outlines (the mat's card-shaped
   * art, a sliver of a sleeve) at most 0.56 (0.62 at 360p). Model-specific: tools/train-detector/
   * evaluate.ts --path tiles runs our detector through the tiles with its own threshold.
   */
  minConfidence: 0.7,
  /** Of two outlines whose axis-aligned bounds overlap more than this (IoU), the weaker goes. */
  nmsIoU: 0.5,
  /** An outline at least this much inside a larger one is part of that card (its art box), not a card. */
  partOfCard: PICK.partOf,
  /** An outline a tile edge cuts that is at least this much inside a whole one is that card, cut. */
  cutInside: 0.5,
  /** Within this share of a tile's side of an edge shared with another tile, an outline is cut by it. */
  edgeMargin: 0.01,
};

export type CardSearch = typeof CARD_SEARCH;

/** A detection in screenshot pixels, portrait (w ≤ h), and whether an edge its tile shares with another cuts it. */
export interface FoundBox extends OrientedBox {
  corners: Quad;
  cut: boolean;
}

/** The tiles to run the model on, in screenshot pixels, along the long side. */
export function planTiles(width: number, height: number, search: CardSearch = CARD_SEARCH): Rect[] {
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (long <= short * search.singleTileAspect) return [{ x: 0, y: 0, w: width, h: height }];
  const n = Math.ceil((long - search.minOverlap * short) / ((1 - search.minOverlap) * short) - 1e-9);
  const step = (long - short) / (n - 1);
  return Array.from({ length: n }, (_, i) => {
    const at = Math.round(i * step);
    return width >= height ? { x: at, y: 0, w: short, h: short } : { x: 0, y: at, w: short, h: short };
  });
}

/** `boxes` a model found in `tile` (tile pixels) in the width×height screenshot's pixels, portrait. */
export function fromTile(boxes: readonly OrientedBox[], tile: Rect, width: number, height: number, search: CardSearch = CARD_SEARCH): FoundBox[] {
  const margin = search.edgeMargin * Math.max(tile.w, tile.h);
  return boxes.map((b) => {
    const landscape = b.w > b.h;
    const [w, h] = landscape ? [b.h, b.w] : [b.w, b.h];
    const angle = landscape ? b.angle + Math.PI / 2 : b.angle;
    const cx = b.cx + tile.x;
    const cy = b.cy + tile.y;
    const corners = boxCorners(cx, cy, w, h, angle);
    const r = boundsOf(corners);
    const cut =
      (tile.x > 0 && r.x < tile.x + margin) ||
      (tile.y > 0 && r.y < tile.y + margin) ||
      (tile.x + tile.w < width && r.x + r.w > tile.x + tile.w - margin) ||
      (tile.y + tile.h < height && r.y + r.h > tile.y + tile.h - margin);
    return { cx, cy, w, h, angle, confidence: b.confidence, corners, cut };
  });
}

const tenth = (v: number) => Math.round(v * 10) / 10;

function toDetected(b: FoundBox): DetectedCardBox {
  return {
    cx: tenth(b.cx),
    cy: tenth(b.cy),
    w: tenth(b.w),
    h: tenth(b.h),
    angle: Math.round(b.angle * 1e4) / 1e4,
    conf: Math.round(b.confidence * 1000) / 1000,
    pts: b.corners.map((p) => [tenth(p.x), tenth(p.y)]),
  };
}

/**
 * One outline per card, strongest first: the confident detections of every tile, without the parts
 * of a larger card, the duplicates of a card two tiles both saw, or a tile edge's cut of a card its
 * neighbour saw whole.
 */
export function mergeCards(boxes: readonly FoundBox[], search: CardSearch = CARD_SEARCH): DetectedCardBox[] {
  const sure = boxes.filter((b) => b.confidence >= search.minConfidence).map((box) => ({ box, r: boundsOf(box.corners) }));
  const area = (r: Rect) => r.w * r.h;
  // A part is inside a larger outline without being the same card seen twice (that's a duplicate).
  const partOf = (r: Rect, o: Rect) => area(o) > area(r) && insideShare(r, o) >= search.partOfCard && iou(r, o) <= search.nmsIoU;
  const cards = sure
    .filter(({ r }) => !sure.some((o) => partOf(r, o.r)))
    .sort((a, b) => Number(a.box.cut) - Number(b.box.cut) || b.box.confidence - a.box.confidence);
  const kept: typeof cards = [];
  for (const c of cards) {
    const duplicate = kept.some((k) => iou(k.r, c.r) > search.nmsIoU || (c.box.cut && !k.box.cut && insideShare(c.r, k.r) >= search.cutInside));
    if (!duplicate) kept.push(c);
  }
  return kept.sort((a, b) => b.box.confidence - a.box.confidence).map((c) => toDetected(c.box));
}

/** Runs one after another, for callers without a work queue (Node tools). */
function serial(): Schedule {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>) => {
    const next = tail.then(run);
    tail = next.catch(() => {});
    return next;
  };
}

/**
 * A CardDetector from a model that sees one tile at a time: the screenshot cut into planTiles'
 * tiles, the model run on each and the boxes merged. The threshold and tiling can be the model's
 * own. Every tile is scheduled before any answers, so their runs queue together (ahead of the
 * engine's priming); each tile is cut from the screenshot only when its run starts. A drag's crop
 * (detectInCrop) is one tile, whatever its shape: the model resizes or letterboxes it whole, like a
 * near-square screenshot.
 */
export function tiledCardDetector(model: TileModel, overrides: Partial<CardSearch> = {}): CardDetector {
  const search: CardSearch = { ...CARD_SEARCH, ...overrides };
  return {
    async detect(img, schedule = serial()) {
      const tiles = planTiles(img.width, img.height, search);
      const found = await Promise.all(
        tiles.map((t) => schedule(() => model.detectTile(cropRGBA(img, t.x, t.y, t.w, t.h))).then((boxes) => fromTile(boxes, t, img.width, img.height, search))),
      );
      return mergeCards(found.flat(), search);
    },
    async detectInCrop(crop) {
      const whole = { x: 0, y: 0, w: crop.width, h: crop.height };
      return mergeCards(fromTile(await model.detectTile(crop), whole, crop.width, crop.height, search), search);
    },
    release: async () => model.release?.(),
  };
}

/**
 * Our card detector as a TileModel (a tile is a square of the screenshot's short side): each tile is
 * shrunk by the factor the whole 16:9 screenshot would get (its long side to CARD_DETECTOR.longSide),
 * so cards keep their trained size. Only the `kinds` given (default face-up), and the corners are
 * the box's own (fromTile recomputes them).
 */
export function tileModelOf(det: OwnCardDetector, opts: { kinds?: readonly CardKind[] } = {}): TileModel {
  const kinds = opts.kinds ?? ['face-up'];
  return {
    async detectTile(tile: RGBAImage): Promise<OrientedBox[]> {
      const side = Math.max(tile.width, tile.height);
      const cards = await det.findCards(tile, { longSide: Math.min(side, Math.round((CARD_DETECTOR.longSide * 9) / 16)) });
      return cards.filter((c) => kinds.includes(c.kind)).map((c) => ({ cx: c.cx, cy: c.cy, w: c.w, h: c.h, angle: c.angle, confidence: c.conf }));
    },
    release: () => det.release(),
  };
}
