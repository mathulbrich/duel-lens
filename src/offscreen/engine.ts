// Recognition engine (spec §3; real-world addendum): find the card in the crop, cut artwork
// hypotheses from it and from the user's box, embed them, search the index and decide. The card is
// found by the card detector (the one click to scan outlines with; detect-cards.ts), and the one
// the user drew around is straightened by its 4 corners; a clicked card comes with its own outline.
// Without a detector, or when it finds no card there, the hypotheses come from the user's box alone.
// When nothing clears the floor: the rescue path (a card cut by the picture's edge), the count-badge
// reading (a simulator's pile count over the art), then suggestions for a face-up card; never confident.
import type { LoadedIndex } from '../shared/index-format';
import type { DetectedCardBox } from '../shared/messages';
import type { EmbeddingModelSpec } from '../shared/models';
import { resizeRGBA, type RGBAImage } from '../shared/preprocess';
import { decide, mergeCandidates, topKByCard } from '../shared/search';
import { CARD_BACK_ID, type Candidate, type CropPayload, type RecognitionResult, type Rotation } from '../shared/types';
import { CARD_H, CARD_W } from '../shared/card-layout';
import type { CardDetector } from './detect-cards';
import { elapsedMs as ms } from './elapsed';
import { boxCorners, pickBox, PICK_MIN_IOU, signedArea, warpQuad, type Point, type Quad, type Rect, type ScoredBox } from './geometry';
import { buildHypotheses, userBox, type Hypothesis, type HypothesisOptions } from './hypotheses';
import { findBadge, inpaint } from './badge';
import { fillUnseen, frameSides, padSides, sidesReached, warpQuadMasked } from './truncation';

export interface Embedder {
  modelId: string;
  /** One L2-normalised vector per image, in order. */
  embed(images: RGBAImage[]): Promise<Float32Array[]>;
}

export interface EngineDeps {
  embedder: Embedder;
  index: LoadedIndex;
  spec: EmbeddingModelSpec;
  /**
   * The card detector click to scan uses (detect-cards.ts), for every scan: it finds the cards in the
   * crop, pickBox takes the one the user drew around, and its 4 corners straighten it (a keystone
   * quad under a tilted camera too). Optional: without one (a --no-detector build, or a detector that
   * failed to load), the hypotheses come from the user's box alone.
   */
  detector?: CardDetector | null;
  /**
   * The rescue path's settings (RESCUE), or false to leave it out (the engine as it was before it: the
   * tools measure it both ways).
   */
  rescue?: Partial<RescueOptions> | false;
  /** The suggestions' settings (SUGGEST), or false to leave them out (the engine as it was before them). */
  suggest?: Partial<SuggestOptions> | false;
  /** False leaves out the count-badge reading (badge.ts; the engine as it was before it). */
  badge?: false;
}

/** The user's box inside the crop, in crop pixels (CropPayload.inner). */
export type UserBox = NonNullable<CropPayload['inner']>;

/** A clicked card's 4 corners inside the crop, in crop pixels (CropPayload.outline). */
export type Outline = NonNullable<CropPayload['outline']>;

export interface Engine {
  /**
   * `inner` is the user's box inside `img` (crop.inner); without it a 4% margin is assumed. `outline` is a
   * clicked card's 4 corners in `img` (crop.outline): the card is straightened from them, and the crop isn't
   * searched for it again (straightenOutline).
   */
  recognize(img: RGBAImage, inner?: UserBox | null, outline?: Outline | null): Promise<RecognitionResult>;
  /**
   * The warm-up still worth doing: one step running the embedding model once, unless it already
   * ran, so that a scan doesn't pay its first-run cost (the card detector warms up at the shortcut,
   * when the handler runs it for click to scan). Steps never throw. Like a scan, each must run
   * alone on the engine's work queue; the offscreen handler runs them only while no scan is waiting
   * (a waiting scan goes first).
   */
  primeSteps(): (() => Promise<void>)[];
  /** The index currently searched (the bundled index merged with the local delta so far). */
  getIndex(): LoadedIndex;
  /** Swaps the index recognize() searches from the next scan on: the self-updating index's write side. */
  setIndex(index: LoadedIndex): void;
}

/** Crops are shrunk to this long side before detection. */
export const MAX_SIDE = 1600;
/** Candidates kept per hypothesis and after merging. */
const TOP_K = 10;
/**
 * Grayscale standard deviation under which a crop is blank (a DRM black frame, a flat
 * fill). Any model maps such a crop somewhere, often near dark artworks, so it is
 * answered with "nothing found" without embedding.
 */
const BLANK_STD = 4;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A small, non-blank image for a priming run (the embedder resizes it to the model's input). */
function primeImage(): RGBAImage {
  const size = 32;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([(i * 8) % 256, (i >> 2) % 256, 128, 255], i * 4);
  return { data, width: size, height: size };
}

/** `candidates` marked as the embedding matcher's (every candidate is, now). */
const tagged = (candidates: readonly Candidate[]): Candidate[] => candidates.map((c) => ({ ...c, source: 'embedding' }));

/** Candidate lists without the card back. */
const withoutCardBack = (lists: readonly Candidate[][]): Candidate[][] => lists.map((l) => l.filter((c) => c.cardId !== CARD_BACK_ID));

/**
 * Whether the rescue path's readings (`lists`) give an answer: their best card, the card back aside, clears
 * the rescue floor and leads the next card by the rescue's lead (a near-tie is a guess).
 */
function rescueAnswers(lists: readonly Candidate[][], opts: Pick<RescueOptions, 'floor' | 'lead'>): boolean {
  const [first, second] = mergeCandidates(withoutCardBack(lists), 2);
  return !!first && first.score >= opts.floor && first.score - (second?.score ?? 0) >= opts.lead;
}

function shrinkTo(img: RGBAImage, maxSide: number): RGBAImage {
  const long = Math.max(img.width, img.height);
  if (long <= maxSide) return img;
  const s = maxSide / long;
  return resizeRGBA(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

function isBlank(img: RGBAImage): boolean {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 65536));
  const d = img.data;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += g;
    sumSq += g * g;
    count++;
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean)) < BLANK_STD;
}

/** `inner` scaled from `from`'s pixels to `to`'s (images of the same crop). */
function scaleBox(inner: UserBox | null | undefined, from: RGBAImage, to: RGBAImage): UserBox | null {
  if (!inner) return null;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { x: inner.x * sx, y: inner.y * sy, w: inner.w * sx, h: inner.h * sy };
}

/** `outline`'s points scaled from `from`'s pixels to `to`'s, left as they are when it isn't a list of points (straightenOutline refuses it). */
function scaleOutline(outline: unknown, from: RGBAImage, to: RGBAImage): unknown {
  if (!Array.isArray(outline) || (to.width === from.width && to.height === from.height)) return outline;
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return outline.map((p) => (Array.isArray(p) && p.length === 2 ? [p[0] * sx, p[1] * sy] : p));
}

/** An answer before the model id and timings are added. */
type Answer = Omit<RecognitionResult, 'modelId' | 'timings'>;

/** Which crop hypothesis gave a card its score, and how far the selection turns to it. */
type Best = NonNullable<RecognitionResult['best']>;

/**
 * How a scan straightens the card the detector picked (its outline comes fitted to the image:
 * detectInCrop, refine.ts). Each view is warped to CARD_W×CARD_H and gives its own `quad` hypotheses
 * (upright and turned 180°), a view the same as an earlier one being skipped. With a face-up card
 * picked, these are the only hypotheses; with a face-down pick, or no card, the user's box is read as
 * drawn (hypotheses.ts):
 * - corners: the card's 4 fitted corners (a keystone quad under a tilted camera straightens square);
 * - box: the oriented box through those corners (a rectangle: kinder to a corner the fit misplaced);
 * - grown: that box grown by `grow` about its centre (the fitted outline runs a little inside the
 *   card's edge: about 5% per side against the labels in detector-report.md §4.1).
 * On the real set (120 cards, 70 non-card boxes; a4-report.md) the corners alone give 114 right, 112
 * confident; the three views 116 right, 115 confident, and the best score on 34 cards comes from the
 * grown box. None of them is ever confidently wrong, and none answers confidently on a non-card box.
 */
export const STRAIGHTEN = {
  views: ['corners', 'box', 'grown'] as const,
  grow: 1.08,
};

/**
 * The rescue path (partial-report.md): more readings, ONLY when the normal ones matched nothing (no
 * candidate above the model's floor), of a card that runs off the edge of the picture. Every scan that
 * has an answer today, sure or not, never reaches it; its own answers are never confident: "Not sure",
 * with the alternatives the popover already shows.
 *
 * The normal path straightens a cut card's visible part as if it were the whole card (or, when the
 * detector guesses the rest, fills it black). The rescue pads the crop with the detector's grey past the
 * picture's edges the card reaches, so that the detector, trained on frames padded so with their cards
 * labelled whole when at least half shows, outlines the WHOLE card; it is straightened from the crop, the
 * part outside the picture filled from the picture's border ('edge') or with the seen art's mean colour.
 *
 * Measured on the real set's 120 cards with their frame cut 25/40/55% on each side, the 70 non-card boxes
 * cut and covered the same way, and real cut cards (partial-report.md §3, §5): among the scans that found
 * nothing, it names about 1 cut card in 6 (nearly always the right one, and more than half of those cut
 * by a quarter), and no non-card box gets an answer. Readings of a covered card with part of its art
 * painted over rescued under 1% of covered cards, with wrong answers too: they are left out.
 */
export interface RescueOptions {
  /**
   * A card is cut by the picture's edge when one of its corners is this close to a crop side that is the
   * picture's own edge (truncation.frameSides), or past it: a share of the crop's short side, at least 2 px.
   */
  reach: number;
  /** The crop is padded past those edges by this share of its long side, in the detector's padding grey... */
  pad: number;
  padFill: number;
  /** ...and the detector's face-up card there is read in these of its views (STRAIGHTEN; the grown one adds nothing)... */
  views: readonly (typeof STRAIGHTEN.views)[number][];
  /** ...each with the part outside the picture filled these ways. */
  fills: readonly ('edge' | 'art-mean')[];
  /** Rescue readings need a top score this high to give an answer (the normal path's floor is the model's, 0.74)... */
  floor: number;
  /** ...and their first card must lead the next by this much. */
  lead: number;
}

export const RESCUE: RescueOptions = {
  reach: 0.02,
  pad: 1,
  padFill: 114,
  views: ['corners', 'box'],
  fills: ['edge', 'art-mean'],
  floor: 0.72,
  lead: 0.03,
};

/**
 * The count-badge reading (diag-t950-report.md): when no reading clears the model's floor (and the rescue path
 * gives no answer), a face-up card whose straightened views show a simulator's pile-count badge over the art
 * (badge.ts: a big white number at the card's centre) is read again with the badge painted out, upright first,
 * then turned 180° when that isn't sure. Its readings decide alone, with the model's own thresholds; its answer is
 * never confident ("Not sure", flagged `countBadge`) until footage from simulators backs it. On the t950 stream it
 * reads the three failing pile tops right at 0.91–0.96; it runs, at no embedding cost, only on scans with nothing
 * else to show.
 *
 * Suggestions (click-regression-report.md): when no reading clears the model's floor (and the rescue path
 * gives no answer) but the scan picked a FACE-UP card, a card is there that the matcher reads weakly (an
 * unusual print, a colour cast, a small or soft card): its closest cards are offered as "Not sure", marked
 * `suggested`, instead of nothing. Never confident. A face-down pick, or no card found in the box (a sleeve,
 * the mat's art, an empty zone), still reads nothing, and so does a scan whose best reading is the card back.
 * Every scan with an answer today, sure or not, never reaches them.
 */
export interface SuggestOptions {
  /** A suggested card scores at least this (the default model's floor is 0.74)... */
  floor: number;
  /** ...and within this of the first suggestion... */
  margin: number;
  /** ...and at most this many are offered (the popover shows the first and three more). */
  max: number;
  /**
   * The detector's confidence in the face-up card it picked in a dragged box must reach this (false picks on the
   * mat's art or an empty zone come low). A clicked card's outline is the user's own pick: it always counts.
   */
  pickConf: number;
}

/**
 * Calibrated on the default model (click-regression-report.md: the real set, its negatives, the partial study's
 * 5,987 cut and covered scans, the user's cases), replaying the engine's own suggestions() on each scan's list:
 * - floor 0.68: the highest that still shows the user's Debris Dragon by click (5 frames of 6; its best is
 *   0.667–0.697). At 0.70 it shows none of them; at 0.66 wrong lists grow by half again;
 * - pickConf 0.70: every false face-up pick measured on a non-card box (mat art, an empty zone, a sleeved token,
 *   cut or covered) came at 0.614 or less; with it, none of the non-card drags gets a list;
 * - margin 0.08 and max 4: the lists stay short (the popover shows the first and three more).
 */
export const SUGGEST: SuggestOptions = {
  floor: 0.68,
  margin: 0.08,
  max: 4,
  pickConf: 0.7,
};

/**
 * The cards offered for a face-up card no reading matched (SuggestOptions), from the scan's merged
 * candidates: none when the best reading is the card back or scores under the floor.
 */
export function suggestions(merged: readonly Candidate[], opts: Pick<SuggestOptions, 'floor' | 'margin' | 'max'>): Candidate[] {
  const top = merged[0];
  if (!top || top.cardId === CARD_BACK_ID || !(top.score >= opts.floor)) return [];
  return merged.filter((c) => c.cardId !== CARD_BACK_ID && c.score >= opts.floor && c.score >= top.score - opts.margin).slice(0, opts.max);
}

/** The user's card, straightened to CARD_W×CARD_H portrait (upright or upside down), one image per view. */
export interface StraightenedCard {
  /** The detection pickBox took for the user's box. */
  pick: DetectedCardBox;
  /** Each view's corners in the image (the card's top-left, top-right, bottom-right, bottom-left)... */
  quads: Quad[];
  /** ...and the card straightened from them; empty when no view can be straightened (a degenerate quad). */
  cards: RGBAImage[];
  /** Clockwise turn from the selection to the cards (the quad hypotheses' rotations are relative to the card). */
  rotation: Rotation;
}

/** A detection in pickBox's terms: its corners as points, its confidence spelled out. */
const scored = (b: DetectedCardBox): ScoredBox => ({
  cx: b.cx,
  cy: b.cy,
  w: b.w,
  h: b.h,
  angle: b.angle,
  confidence: b.conf,
  corners: b.pts.map(([x, y]) => ({ x, y })) as Quad,
});

const isQuad = (b: DetectedCardBox) => Array.isArray(b.pts) && b.pts.length === 4 && b.pts.every((p) => p.length === 2 && p.every(Number.isFinite));

const sideLength = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * `q` as the straightened card's top-left, top-right, bottom-right and bottom-left corners: clockwise
 * on screen, starting at a short side (a card is portrait). DetectedCardBox's corners already come so
 * (clockwise from the box's own top-left, w ≤ h); this also takes them in any other order. Starting at
 * the wrong short side gives an upside-down card, which the 180° quad hypothesis reads.
 */
function cardCorners(q: Quad): Quad {
  const [a, b, c, d] = signedArea(q) < 0 ? [q[0], q[3], q[2], q[1]] : q;
  // Its first and third sides are the long ones: start one corner earlier (the card turned 90° clockwise).
  return sideLength(a, b) + sideLength(c, d) > sideLength(b, c) + sideLength(d, a) ? [d, a, b, c] : [a, b, c, d];
}

/** The clockwise turn, in quarter turns, from the selection to the card whose top edge runs from `tl` to `tr`. */
function turnTo(tl: Point, tr: Point): Rotation {
  const quarters = Math.round(-Math.atan2(tr.y - tl.y, tr.x - tl.x) / (Math.PI / 2));
  return ((((quarters % 4) + 4) % 4) * 90) as Rotation;
}

/** `q` cycled (its order kept) so that its first corner is the one nearest `ref`'s first: the same card corners in the same order. */
function alignedTo(q: Quad, ref: Quad): Quad {
  let best = 0;
  let bestD = Infinity;
  for (let s = 0; s < 4; s++) {
    let d = 0;
    for (let k = 0; k < 4; k++) d += sideLength(q[(k + s) % 4], ref[k]);
    if (d < bestD) [best, bestD] = [s, d];
  }
  return [0, 1, 2, 3].map((k) => q[(k + best) % 4]) as Quad;
}

/** `q` grown by `k` about its centroid. */
function grown(q: Quad, k: number): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return q.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k })) as Quad;
}

/** Whether two quads' corners are all within half a pixel (the same view: no second warp). */
const sameQuad = (a: Quad, b: Quad) => a.every((p, k) => sideLength(p, b[k]) < 0.5);

/**
 * The card the user drew around, among a card detector's `boxes` in `img`: the one pickBox takes
 * for `user` (the containment rule: a loose box picks the card it holds, a tight one its card over
 * the neighbours in the margin), straightened in every STRAIGHTEN view. A face-up card is picked
 * first; a face-down detection (a sleeve, a pile, or a face-up card the detector misread) only when
 * no face-up one is picked: the embedding model still decides what it is. Null when no detection
 * counts for the box.
 */
export function straightenPick(img: RGBAImage, boxes: readonly DetectedCardBox[], user: Rect): StraightenedCard | null {
  const views = pickViews(boxes, user);
  if (!views) return null;
  const cards = views.quads.map((q) => warpQuad(img, q, CARD_W, CARD_H)).filter((c): c is RGBAImage => c !== null);
  return { pick: views.pick, quads: views.quads, cards, rotation: views.rotation };
}

/** A pick and its STRAIGHTEN views, not yet straightened (`names[i]` is `quads[i]`'s view). */
type PickViews = Omit<StraightenedCard, 'cards'> & { names: (typeof STRAIGHTEN.views)[number][] };

/** straightenPick's pick and its views, not yet straightened. */
function pickViews(boxes: readonly DetectedCardBox[], user: Rect): PickViews | null {
  const usable = boxes.filter(isQuad);
  const pickOf = (kind: (b: DetectedCardBox) => boolean): DetectedCardBox | null => {
    const candidates = usable.filter(kind);
    const asScored = candidates.map(scored);
    const picked = pickBox(asScored, user, PICK_MIN_IOU);
    return picked && candidates[asScored.indexOf(picked)];
  };
  const pick = pickOf((b) => b.kind !== 'face-down') ?? pickOf((b) => b.kind === 'face-down');
  return pick ? viewsOf(pick) : null;
}

/**
 * How far past the crop a clicked card's outline may reach (crop pixels) and still be its pick. An outline
 * comes inside its crop (the crop is its bounds plus a margin), unless the picture's edge clipped the crop:
 * a card cut by that edge is then found in the crop as for a drag, where the rescue path knows it.
 */
const OUTLINE_SLACK = 1;

/**
 * A clicked card straightened from its outline (CropPayload.outline: the detector's 4 corners on the
 * screenshot, mapped into the crop), in every STRAIGHTEN view, as a pick of the crop's own detections is.
 * Its box is the rectangle with the outline's mean side lengths, turned as its mean top and bottom edges,
 * about its centroid (the outline itself when it is a rectangle, as the detector's outlines are). The crop
 * isn't searched again: cut tight around a small card on a dark mat, the detector can take the artwork and
 * text box for the card (click-regression-report.md). A face-up pick: only face-up cards are outlined.
 * Null when the outline isn't 4 finite corners inside the crop, or no view can be straightened.
 */
export function straightenOutline(img: RGBAImage, outline: unknown): StraightenedCard | null {
  if (!Array.isArray(outline) || outline.length !== 4) return null;
  const inside = (v: unknown, size: number) => typeof v === 'number' && Number.isFinite(v) && v >= -OUTLINE_SLACK && v <= size + OUTLINE_SLACK;
  if (!outline.every((p) => Array.isArray(p) && p.length === 2 && inside(p[0], img.width) && inside(p[1], img.height))) return null;
  const pts = (outline as [number, number][]).map(([x, y]): [number, number] => [x, y]);
  const [a, b, c, d] = pts;
  const length = (p: [number, number], q: [number, number]) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  let w = (length(a, b) + length(d, c)) / 2;
  let h = (length(a, d) + length(b, c)) / 2;
  let angle = Math.atan2(b[1] - a[1] + (c[1] - d[1]), b[0] - a[0] + (c[0] - d[0]));
  if (w > h) [w, h, angle] = [h, w, angle + Math.PI / 2];
  const pick: DetectedCardBox = {
    cx: (a[0] + b[0] + c[0] + d[0]) / 4,
    cy: (a[1] + b[1] + c[1] + d[1]) / 4,
    w,
    h,
    angle,
    conf: 1, // the user picked it
    kind: 'face-up',
    pts,
  };
  if (!(Math.abs(signedArea(scored(pick).corners)) >= 1) || !(w >= 1)) return null;
  const views = viewsOf(pick);
  const cards = views.quads.map((q) => warpQuad(img, q, CARD_W, CARD_H)).filter((card): card is RGBAImage => card !== null);
  return cards.length > 0 ? { pick, quads: views.quads, cards, rotation: views.rotation } : null;
}

/** `pick`'s STRAIGHTEN views: its corners, its oriented box, and that box grown (the same view once). */
function viewsOf(pick: DetectedCardBox): PickViews {
  const corners = cardCorners(scored(pick).corners);
  const box = alignedTo(cardCorners(boxCorners(pick.cx, pick.cy, pick.w, pick.h, pick.angle)), corners);
  const quads: Quad[] = [];
  const names: (typeof STRAIGHTEN.views)[number][] = [];
  for (const view of STRAIGHTEN.views) {
    const q = view === 'corners' ? corners : view === 'box' ? box : grown(box, STRAIGHTEN.grow);
    if (!quads.some((v) => sameQuad(v, q))) {
      quads.push(q);
      names.push(view);
    }
  }
  return { pick, quads, names, rotation: turnTo(corners[0], corners[1]) };
}

/**
 * Which of the user's box's own readings join the straightened card's (`found`: straightenPick's card,
 * null when none; `looked`: the card detector answered for this crop). With a face-up card, none: the
 * box's crops read that card less well and only add competing scores. A face-down pick (a sleeve, a
 * pile, or a face-up card the detector misread) is read with the box as drawn, and the embedding model
 * decides. With no card, the box as drawn; once the detector has looked and found no card there, a
 * card-shaped box is read as a whole card only (not as the artwork alone: a sleeve's or the mat's art).
 */
export function hypothesisOptions(found: StraightenedCard | null, looked: boolean): HypothesisOptions {
  return { userBoxWithCard: found?.pick.kind === 'face-down', artOfCardShapedBox: !looked };
}

/** Throws unless `index` holds `spec`'s vectors. */
function checkIndex(index: LoadedIndex, spec: EmbeddingModelSpec): void {
  if (index.meta.modelId !== spec.id) {
    throw new Error(`The index was built for model "${index.meta.modelId}", not "${spec.id}"`);
  }
  if (index.meta.dim !== spec.dim) {
    throw new Error(`The index has ${index.meta.dim}-dimensional vectors; model "${spec.id}" makes ${spec.dim}`);
  }
}

export function createEngine(deps: EngineDeps): Engine {
  const { embedder, spec } = deps;
  let index = deps.index;
  const detector = deps.detector ?? null;
  const rescue: RescueOptions | null = deps.rescue === false ? null : { ...RESCUE, ...deps.rescue };
  const suggest: SuggestOptions | null = deps.suggest === false ? null : { ...SUGGEST, ...deps.suggest };
  const badge = deps.badge !== false;
  checkIndex(index, spec);
  if (embedder.modelId !== spec.id) throw new Error(`The embedder runs model "${embedder.modelId}", not "${spec.id}"`);
  // Hypothesis crops only need to be comfortably larger than the model's input.
  const hypothesisMax = 3 * spec.inputSize;

  /** Whether the embedding model has run at least once (priming skips it then). */
  let warm = false;

  async function embed(images: RGBAImage[]): Promise<Float32Array[]> {
    const vectors = await embedder.embed(images);
    warm = true;
    return vectors;
  }

  /**
   * The card to read: a clicked card from its outline (straightenOutline; the detector already looked, on
   * the screenshot), else the card the user drew around, from the card detector's detections in the crop
   * (straightenPick). `found` is null when there is no detector, it picks no card for the box, the pick
   * can't be straightened, or it fails; `looked` says whether the detector answered (without failing).
   */
  async function findCard(
    img: RGBAImage,
    user: Rect,
    outline: unknown,
    timings: Record<string, number>,
  ): Promise<{ found: StraightenedCard | null; looked: boolean; clicked?: boolean }> {
    let t = performance.now();
    if (outline != null) {
      const picked = straightenOutline(img, outline);
      if (picked) {
        timings.straighten = ms(t);
        return { found: picked, looked: true, clicked: true };
      }
    }
    if (!detector) return { found: null, looked: false };
    t = performance.now();
    let boxes: DetectedCardBox[];
    try {
      // The scan holds the work queue, so the detector's runs go straight on, unscheduled.
      boxes = await (detector.detectInCrop ? detector.detectInCrop(img) : detector.detect(img));
    } catch (e) {
      console.warn("[DuelLens] the card detector failed on this crop; matching the user's box as drawn", e);
      return { found: null, looked: false };
    } finally {
      timings.cardDetect = ms(t);
    }
    if (!Array.isArray(boxes)) return { found: null, looked: false };
    t = performance.now();
    const found = straightenPick(img, boxes, user);
    if (found) timings.straighten = ms(t);
    return { found: found && found.cards.length > 0 ? found : null, looked: true };
  }

  /**
   * The rescue path's readings (RESCUE) of a card in `img` the normal readings matched to nothing, each with
   * the clockwise turn from the selection to its card, and whether the card runs off the picture's edge.
   * The whole card is read upright first, and turned 180° only when that gives no answer.
   */
  async function rescueReadings(
    img: RGBAImage,
    source: RGBAImage,
    innerImg: UserBox | null,
    user: Rect,
    found: StraightenedCard | null,
    opts: RescueOptions,
  ): Promise<{ hyps: Hypothesis[]; lists: Candidate[][]; turns: Rotation[]; truncated: boolean }> {
    const out = { hyps: [] as Hypothesis[], lists: [] as Candidate[][], turns: [] as Rotation[], truncated: false };
    // The picture edges the card (or, with no card, the user's box) reaches: none, no rescue.
    const sides = frameSides(img.width, img.height, innerImg);
    if (sides.length === 0 || !detector) return out;
    const tol = Math.max(2, opts.reach * Math.min(img.width, img.height));
    const userQuad: Point[] = [
      { x: user.x, y: user.y },
      { x: user.x + user.w, y: user.y },
      { x: user.x + user.w, y: user.y + user.h },
      { x: user.x, y: user.y + user.h },
    ];
    const reached = sidesReached(found?.quads[0] ?? userQuad, img.width, img.height, sides, tol);
    if (reached.length === 0) return out;
    if (found && found.pick.kind !== 'face-down') out.truncated = true;
    // The crop padded past those edges: the detector's face-up card there, whole.
    const padded = padSides(img, reached, opts.pad * Math.max(img.width, img.height), opts.padFill);
    let boxes: DetectedCardBox[];
    try {
      boxes = await (detector.detectInCrop ? detector.detectInCrop(padded.image) : detector.detect(padded.image));
    } catch (e) {
      console.warn('[DuelLens] the card detector failed on the padded crop', e);
      return out;
    }
    if (!Array.isArray(boxes)) return out;
    const views = pickViews(
      boxes.filter((b) => b.kind !== 'face-down'),
      { x: user.x + padded.dx, y: user.y + padded.dy, w: user.w, h: user.h },
    );
    if (!views) return out;
    out.truncated = true;
    // Straightened from the crop itself, the part outside the picture filled.
    const cards: RGBAImage[] = [];
    for (const fill of opts.fills) {
      views.quads.forEach((q, i) => {
        if (!opts.views.includes(views.names[i])) return;
        const w = warpQuadMasked(img, q.map((p) => ({ x: p.x - padded.dx, y: p.y - padded.dy })) as Quad, CARD_W, CARD_H, fill === 'edge' ? 'edge' : 'black');
        if (w) cards.push(fill === 'edge' ? w.image : fillUnseen(w, 'art-mean'));
      });
    }
    const hyps = buildHypotheses(source, cards, null, { userBoxWithCard: false });
    for (const stage of [hyps.filter((h) => h.rotation !== 180), hyps.filter((h) => h.rotation === 180)]) {
      if (stage.length === 0) continue;
      const vectors = await embed(stage.map((h) => h.image));
      if (vectors.length !== stage.length) throw new Error(`The embedder returned ${vectors.length} vectors for ${stage.length} images`);
      out.hyps.push(...stage);
      out.lists.push(...vectors.map((v) => topKByCard(v, index, TOP_K)));
      out.turns.push(...stage.map(() => views.rotation));
      if (rescueAnswers(out.lists, opts)) break;
    }
    return out;
  }

  /**
   * The count-badge readings (badge.ts) of the picked card's straightened views: each view with a badge, painted
   * out, cut as the quad hypotheses are, upright first and turned 180° only when those aren't sure. Null when no
   * view shows a badge (nothing is embedded then).
   */
  async function badgeReadings(source: RGBAImage, found: StraightenedCard): Promise<{ hyps: Hypothesis[]; lists: Candidate[][]; turns: Rotation[] } | null> {
    const masked: RGBAImage[] = [];
    for (const card of found.cards) {
      const b = findBadge(card);
      if (b) masked.push(inpaint(card, b.mask));
    }
    if (masked.length === 0) return null;
    const out = { hyps: [] as Hypothesis[], lists: [] as Candidate[][], turns: [] as Rotation[] };
    const hyps = buildHypotheses(source, masked, null, { userBoxWithCard: false });
    for (const stage of [hyps.filter((h) => h.rotation !== 180), hyps.filter((h) => h.rotation === 180)]) {
      if (stage.length === 0) continue;
      const vectors = await embed(stage.map((h) => h.image));
      if (vectors.length !== stage.length) throw new Error(`The embedder returned ${vectors.length} vectors for ${stage.length} images`);
      out.hyps.push(...stage);
      // A face-up card's readings: never the card back.
      out.lists.push(...vectors.map((v) => topKByCard(v, index, TOP_K).filter((c) => c.cardId !== CARD_BACK_ID)));
      out.turns.push(...stage.map(() => found.rotation));
      if (decide(mergeCandidates(out.lists, TOP_K), spec.thresholds).confident) break;
    }
    return out;
  }

  /**
   * The embedding matcher on `img` (the crop, shrunk to MAX_SIDE): its answer (null when nothing clears the
   * floor), and whether the rescue path found the card running off the picture's edge.
   */
  async function matchEmbedding(
    img: RGBAImage,
    input: RGBAImage,
    inner: UserBox | null | undefined,
    outline: unknown,
    timings: Record<string, number>,
  ): Promise<{ answer: Answer | null; truncated: boolean }> {
    const innerImg = scaleBox(inner, input, img);
    const user = userBox(img, innerImg);
    const { found, looked, clicked } = await findCard(img, user, scaleOutline(outline, input, img), timings);
    // Clockwise turn from the selection to the found card (quad rotations are relative to the card).
    const cardRotation: Rotation = found?.rotation ?? 0;

    let t = performance.now();
    const source = shrinkTo(img, hypothesisMax);
    const hypotheses = buildHypotheses(source, found?.cards ?? null, scaleBox(inner, input, source), hypothesisOptions(found, looked));
    timings.crop = ms(t);

    // Two stages: try the upright reading first (0°, plus 90°/270° for a sideways/defense
    // selection, as before) and only pay for the 180° (upside-down) hypotheses when stage 1
    // isn't confident. Upright crops are the common case, and merging in the 180°
    // hypotheses unconditionally both doubles the embedding work and costs a little
    // accuracy on them (stream A's benchmark).
    const stage1 = hypotheses.filter((h) => h.rotation !== 180);
    const stage2 = hypotheses.filter((h) => h.rotation === 180);
    const embedHypotheses = async (hs: Hypothesis[]): Promise<Float32Array[]> => {
      const vectors = await embed(hs.map((h) => h.image));
      if (vectors.length !== hs.length) throw new Error(`The embedder returned ${vectors.length} vectors for ${hs.length} images`);
      return vectors;
    };

    t = performance.now();
    const vectors = await embedHypotheses(stage1);
    timings.embed = ms(t);

    t = performance.now();
    let hyps = stage1;
    let lists = vectors.map((v) => topKByCard(v, index, TOP_K));
    let merged = mergeCandidates(lists, TOP_K);
    let decision = decide(merged, spec.thresholds);
    timings.search = ms(t);

    timings.stage2 = 0;
    // A clicked card lying sideways: its outline comes from the whole screenshot, where the detector's angle wraps
    // at ±90° and either short side can come out as the card's top. Its first reading, when sure only by the second
    // rule (under the main score), is read turned 180° too before it answers (a synthetic covered card was read
    // wrong otherwise). Upright cards, and drags, keep the stages as they were.
    const sideways = clicked && (cardRotation === 90 || cardRotation === 270);
    const sure = sideways ? decide(merged, { ...spec.thresholds, second: undefined }).confident : decision.confident;
    if (!sure && stage2.length > 0) {
      t = performance.now();
      const vectors2 = await embedHypotheses(stage2);
      hyps = [...stage1, ...stage2];
      lists = [...lists, ...vectors2.map((v) => topKByCard(v, index, TOP_K))];
      merged = mergeCandidates(lists, TOP_K);
      decision = decide(merged, spec.thresholds);
      timings.stage2 = ms(t);
    }
    // Clockwise turn from the selection to each hypothesis's card (quad rotations are relative to it).
    let turns: Rotation[] = hyps.map((h) => (h.id === 'quad' ? cardRotation : 0));
    let truncated = false;
    let rescued = false;
    let badged = false;
    let suggested = false;
    if (decision.nothing) {
      // Nothing above the model's floor: the rescue path, when the detector looked at the crop.
      if (rescue && looked) {
        t = performance.now();
        const more = await rescueReadings(img, source, innerImg, user, found, rescue);
        timings.rescue = ms(t);
        truncated = more.truncated;
        // An answer only when the rescue's own readings clear its floor, and made of them alone: the normal
        // readings, all under the model's floor, never head it. It reads a face-up card: never the card back.
        if (rescueAnswers(more.lists, rescue)) {
          hyps = more.hyps;
          lists = withoutCardBack(more.lists);
          turns = more.turns;
          merged = mergeCandidates(lists, TOP_K);
          decision = decide(merged, { ...spec.thresholds, floor: rescue.floor });
          rescued = true;
        }
      }
      const faceUp = !!found && found.pick.kind !== 'face-down';
      if (!rescued && badge && faceUp) {
        // A simulator's count badge over the art: read again with it painted out, on those readings alone.
        t = performance.now();
        const more = await badgeReadings(source, found!);
        timings.badge = ms(t);
        const mergedBadge = more ? mergeCandidates(more.lists, TOP_K) : [];
        const decided = decide(mergedBadge, spec.thresholds);
        if (more && !decided.nothing) {
          hyps = more.hyps;
          lists = more.lists;
          turns = more.turns;
          merged = mergedBadge;
          decision = decided;
          badged = true;
        }
      }
      if (!rescued && !badged) {
        // Still nothing, but a face-up card was picked (a click, or the detector's card in the box): its
        // closest cards, as suggestions (SUGGEST), from the normal readings.
        const offered = suggest && faceUp && found!.pick.conf >= suggest.pickConf ? suggestions(merged, suggest) : [];
        if (offered.length === 0) return { answer: null, truncated };
        merged = offered;
        suggested = true;
      }
    }

    /** The hypothesis that gave `cardId` its best score. */
    const bestFor = (cardId: number): Best => {
      let winner = 0;
      let winnerScore = -Infinity;
      lists.forEach((list, i) => {
        const hit = list.find((c) => c.cardId === cardId);
        if (hit && hit.score > winnerScore) {
          winnerScore = hit.score;
          winner = i;
        }
      });
      const h = hyps[winner];
      return { hypothesis: h.id, rotation: ((h.rotation + turns[winner]) % 360) as Rotation };
    };
    const top = merged[0];
    const faceDown = top.cardId === CARD_BACK_ID;
    return {
      answer: {
        // The card back is an answer only when it wins; as an alternative it is noise.
        candidates: tagged(faceDown ? merged : merged.filter((c) => c.cardId !== CARD_BACK_ID)),
        // A rescue answer, a count-badge reading's or suggestions are never confident: "Not sure", with the alternatives.
        confident: decision.confident && !rescued && !badged && !suggested,
        faceDown,
        recognizer: 'embedding',
        best: bestFor(top.cardId),
        ...(badged ? { countBadge: true } : {}),
        ...(suggested ? { suggested: true } : {}),
      },
      truncated,
    };
  }

  async function recognize(input: RGBAImage, inner?: UserBox | null, outline?: Outline | null): Promise<RecognitionResult> {
    const start = performance.now();
    const timings: Record<string, number> = {};
    const result = (r: Answer): RecognitionResult => ({
      ...r,
      modelId: spec.id,
      timings: { ...timings, total: ms(start) },
    });
    const nothing = () => result({ candidates: [], confident: false, faceDown: false });
    try {
      if (!(input.width >= 1 && input.height >= 1) || input.data.length < input.width * input.height * 4) {
        throw new Error(`The crop is empty or malformed (${input.width}×${input.height})`);
      }
      const img = shrinkTo(input, MAX_SIDE);
      if (isBlank(img)) return nothing();
      const { answer, truncated } = await matchEmbedding(img, input, inner, outline, timings);
      // `truncated` is only ever known on the rescue path, so every other answer stays as it was.
      const cut = truncated ? { truncated: true } : {};
      return answer ? result({ ...answer, ...cut }) : result({ candidates: [], confident: false, faceDown: false, ...cut });
    } catch (e) {
      return { ...nothing(), error: errorText(e) };
    }
  }

  function primeSteps(): (() => Promise<void>)[] {
    if (warm) return [];
    return [
      async () => {
        if (warm) return; // a scan ran it meanwhile
        try {
          await embed([primeImage()]);
        } catch (e) {
          console.debug(`[DuelLens] priming failed: ${errorText(e)}`, e);
        }
      },
    ];
  }

  return {
    recognize,
    primeSteps,
    getIndex: () => index,
    setIndex: (next) => {
      checkIndex(next, spec);
      index = next;
    },
  };
}
