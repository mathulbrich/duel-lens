// The harvest's pure logic (tools/overnight/harvest.ts): where the moments fall in a video, card tracks across
// a moment's frames, a track's label from the engine's readings, and which way up each crop is cut.
// No I/O and no models, so tracks.test.ts covers it.
import { polygonIou, signedArea, type Point, type Quad } from '../../../src/offscreen/geometry';
import type { Rotation } from '../../../src/shared/types';

export type Pt = [number, number];
export type Kind = 'face-up' | 'face-down';

/** One detection on one frame: the detector's class, confidence and 4 corners (frame pixels). */
export interface Det {
  kind: Kind;
  conf: number;
  pts: Pt[];
}

export interface Member {
  frame: number;
  /** Index into that frame's detections. */
  det: number;
}

/** The same card over a moment's frames. */
export interface Track {
  id: number;
  kind: Kind;
  members: Member[];
}

const points = (pts: readonly Pt[]): Point[] => pts.map(([x, y]) => ({ x, y }));

/**
 * Tracks over `frames` (each frame's detections, in time order): a detection joins the track of its own kind
 * whose last detection (on an earlier frame; a missed frame is allowed) overlaps it with polygon IoU ≥ `minIoU`,
 * best overlaps first, one detection per track per frame; the rest start new tracks. Kinds never mix: a card
 * set face-down and then flipped face-up in the same zone is two tracks, so a card back never takes the
 * card's label.
 */
export function buildTracks(frames: readonly (readonly Det[])[], minIoU = 0.5): Track[] {
  const tracks: Track[] = [];
  frames.forEach((dets, f) => {
    const pairs: { track: Track; det: number; iou: number }[] = [];
    dets.forEach((det, d) => {
      for (const track of tracks) {
        if (track.kind !== det.kind) continue;
        const last = track.members[track.members.length - 1];
        if (last.frame >= f) continue;
        const iou = polygonIou(points(frames[last.frame][last.det].pts), points(det.pts));
        if (iou >= minIoU) pairs.push({ track, det: d, iou });
      }
    });
    pairs.sort((a, b) => b.iou - a.iou);
    const joined = new Set<Track>();
    const used = new Set<number>();
    for (const p of pairs) {
      if (joined.has(p.track) || used.has(p.det)) continue;
      p.track.members.push({ frame: f, det: p.det });
      joined.add(p.track);
      used.add(p.det);
    }
    dets.forEach((det, d) => {
      if (!used.has(d)) tracks.push({ id: tracks.length, kind: det.kind, members: [{ frame: f, det: d }] });
    });
  });
  return tracks;
}

/** What the labelling needs from one engine reading. */
export interface Reading {
  confident: boolean;
  /** The first candidate's card (CARD_BACK_ID for the card back), null when the engine matched nothing. */
  top: number | null;
}

export type Source = 'confident' | 'propagated' | 'none';

/**
 * A track's label from its members' readings (null: the engine did not read that member): at least 2 readings
 * confident on the same card and none confident on another. Every member then gets that card: 'confident' where
 * its own reading is confident on it, 'propagated' elsewhere (the hard positives). Otherwise no label ('none').
 */
export function labelTrack(readings: readonly (Reading | null | undefined)[]): { cardId: number | null; sources: Source[] } {
  // Array.from, not map: a sparse list's holes (members never read) still get a source.
  const all = Array.from(readings, (r) => r ?? null);
  const sure = all.filter((r): r is Reading => !!r && r.confident && r.top !== null);
  const ids = new Set(sure.map((r) => r.top));
  if (sure.length >= 2 && ids.size === 1) {
    const cardId = sure[0].top!;
    return { cardId, sources: all.map((r) => (r && r.confident && r.top === cardId ? 'confident' : 'propagated')) };
  }
  return { cardId: null, sources: all.map(() => 'none') };
}

// ---------- which way up ----------

const sideLength = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * src/offscreen/engine.ts cardCorners (private; copied verbatim): `q` as the straightened card's top-left,
 * top-right, bottom-right and bottom-left corners, clockwise on screen, starting at a short side. Starting at
 * the wrong short side gives an upside-down card (the engine's 180° quad hypothesis reads it).
 */
export function cardCorners(q: Quad): Quad {
  const [a, b, c, d] = signedArea(q) < 0 ? [q[0], q[3], q[2], q[1]] : q;
  return sideLength(a, b) + sideLength(c, d) > sideLength(b, c) + sideLength(d, a) ? [d, a, b, c] : [a, b, c, d];
}

/** src/offscreen/engine.ts turnTo (private; copied verbatim): the clockwise turn from the selection to the card whose top edge runs tl → tr. */
export function turnTo(tl: Point, tr: Point): Rotation {
  const quarters = Math.round(-Math.atan2(tr.y - tl.y, tr.x - tl.x) / (Math.PI / 2));
  return ((((quarters % 4) + 4) % 4) * 90) as Rotation;
}

export const quadOf = (pts: readonly Pt[]): Quad => points(pts) as Quad;

/** The same outline read the other way up (the card turned 180°). */
export const flipped = (q: Quad): Quad => [q[2], q[3], q[0], q[1]];

/** Card corners (tl, tr, br, bl): the card's "up", from its bottom edge's midpoint to its top edge's, unit length. */
export function upOf(q: Quad): Point {
  const x = (q[0].x + q[1].x - q[2].x - q[3].x) / 2;
  const y = (q[0].y + q[1].y - q[2].y - q[3].y) / 2;
  const n = Math.hypot(x, y) || 1;
  return { x: x / n, y: y / n };
}

/**
 * Whether the engine read the card cut from `corners` (cardCorners order) upside down: its best hypothesis's
 * turn from the selection (RecognitionResult.best.rotation) minus the card's own turn is 180° (the 180° quad
 * hypothesis won). Null when the reading has no best hypothesis or it isn't a straightened card's.
 */
export function readUpsideDown(corners: Quad, best: { hypothesis: string; rotation: number } | undefined | null): boolean | null {
  if (!best || best.hypothesis !== 'quad') return null;
  const turn = (((best.rotation - turnTo(corners[0], corners[1])) % 360) + 360) % 360;
  return turn === 180 ? true : turn === 0 ? false : null;
}

/** One member's evidence for which way is up: the card's up as its reading says it, weighted (by its score). */
export interface UpVote {
  up: Point;
  weight: number;
}

/** The weighted mean up of `votes`, or null without any. */
export function trackUp(votes: readonly UpVote[]): Point | null {
  let x = 0;
  let y = 0;
  for (const v of votes) {
    x += v.up.x * v.weight;
    y += v.up.y * v.weight;
  }
  return votes.length > 0 && Math.hypot(x, y) > 1e-9 ? { x, y } : null;
}

/** `corners` (cardCorners order) turned, if needed, so the card's up agrees with `up`; unchanged without one. */
export function orient(corners: Quad, up: Point | null): Quad {
  if (!up) return corners;
  const u = upOf(corners);
  return u.x * up.x + u.y * up.y >= 0 ? corners : flipped(corners);
}

/** `q` grown by `k` about its centroid (engine.ts grown). */
export function grownQuad(q: Quad, k: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k })) as Quad;
}

// ---------- moments ----------

/** A small seeded PRNG (mulberry32) over a string's FNV-1a hash: the same moments on every run. */
export function seeded(key: string): () => number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `k` moments (whole seconds) spread evenly from 5% to 95% of `durationS`, each jittered within ±40% of the
 * spacing, seeded by the video and k: the same list on every run, so a resumed run skips the ones done.
 */
export function momentTimes(videoId: string, durationS: number, k: number): number[] {
  const rand = seeded(`${videoId}:${k}`);
  const step = (0.9 * durationS) / k;
  const out: number[] = [];
  for (let m = 0; m < k; m++) out.push(Math.max(0, Math.round(0.05 * durationS + step * (m + 0.5) + (rand() - 0.5) * 0.8 * step)));
  return out;
}

/** Base-2 radical inverse of i (0.5, 0.25, 0.75, ...). */
function radicalInverse(i: number): number {
  let r = 0;
  let f = 0.5;
  for (let n = i; n > 0; n >>= 1, f /= 2) if (n & 1) r += f;
  return r;
}

/**
 * The order to visit n moments in so that any prefix is spread over the whole video (0, n/2, n/4, 3n/4, ...):
 * a run stopped early still covers every part of it.
 */
export function spreadOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i).sort((a, b) => radicalInverse(a) - radicalInverse(b));
}

/** The next time the local clock reads `hhmm` ("HH:MM"), after `now`. */
export function nextClock(hhmm: string, now = new Date()): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`--until needs HH:MM (24-hour), got "${hhmm}"`);
  const at = new Date(now);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}
