// Duel Lens's card detector, runtime-agnostic: give it an onnxruntime session (web or node) and its
// Tensor class. One model run sees a whole screenshot; the same model finds the card inside a
// user's rough box (the drag case) when given the crop with `enlarge`.
//
//   const det = createCardDetector({ session, Tensor });
//   const cards = await det.findCards(screenshot);        // every face-up and face-down card, screenshot px
//   const detector: CardDetector = det.asCardDetector();  // click to scan and scans (src/offscreen/detect-cards.ts)
import type { SessionLike, TensorCtor } from '../../shared/embed-core';
import type { DetectedCardBox } from '../../shared/messages';
import type { RGBAImage } from '../../shared/preprocess';
import type { CardDetector, Schedule } from '../detect-cards';
import { decodeCards, type CardBox } from './decode';
import { boxCorners, type Pt } from './geometry';
import { toModelInput } from './preprocess';
import { refineCard, type Refined } from './refine';
import { CARD_DETECTOR, type CardDetectorSpec, type CardKind } from './spec';

export interface CardDetectorDeps {
  session: SessionLike;
  Tensor: TensorCtor;
  spec?: CardDetectorSpec;
  release?: () => Promise<void>;
}

export interface FindOptions {
  /** Scale the image so its long side is this (default: spec.longSide, shrinking only). */
  longSide?: number;
  /** Also scale small images up to `longSide` (a crop around one card). */
  enlarge?: boolean;
  /** Keep boxes scoring at least this (default spec.minScore). */
  minScore?: number;
  /**
   * Fit every card's outline to the image (refine.ts: the tilt from the gradient orientations, then each
   * side): a few milliseconds per card. The model's own angles mostly snap to 0/90 degrees.
   */
  refine?: boolean;
}

/** A detected card in screenshot pixels: the contract's box plus the detector's class. */
export interface DetectedCard extends DetectedCardBox {
  kind: CardKind;
  /** Both classes' heatmap scores at the card's centre. */
  scores: Record<CardKind, number>;
  /** Set when the outline was fitted to the image: 'quad' (4 sides), 'tilt' (the angle only), 'none' (kept). */
  refined?: Refined['refined'];
}

/** `card` with its outline fitted to `img` (its oriented box recomputed from the fitted corners). */
export function refined(img: RGBAImage, card: DetectedCard): DetectedCard {
  const r = refineCard(img, card);
  if (r.refined === 'none') return { ...card, refined: 'none' };
  const [a, b, c, d] = r.pts;
  const len = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const w = (len(a, b) + len(d, c)) / 2;
  const h = (len(a, d) + len(b, c)) / 2;
  return {
    ...card,
    cx: tenth((a[0] + b[0] + c[0] + d[0]) / 4),
    cy: tenth((a[1] + b[1] + c[1] + d[1]) / 4),
    w: tenth(Math.min(w, h)),
    h: tenth(Math.max(w, h)),
    angle: Math.round(r.angle * 1e4) / 1e4,
    pts: r.pts.map(([x, y]) => [tenth(x), tenth(y)]),
    refined: r.refined,
  };
}

export interface Timings {
  preprocessMs: number;
  runMs: number;
  decodeMs: number;
  refineMs: number;
}

export interface CardDetectorOptions {
  /** Click to scan's outlines: the classes outlined (default face-up only). */
  kinds?: readonly CardKind[];
  /** Outlines (click to scan) and the cards in a scan's crop below this confidence are dropped (default 0: none). */
  minConfidence?: number;
}

export interface OwnCardDetector {
  /** Every card in `img`, strongest first, in `img` pixels. */
  findCards(img: RGBAImage, opts?: FindOptions): Promise<DetectedCard[]>;
  /** The drag case: the cards in a crop around the user's box, the one nearest its centre first, outlines fitted to the image. */
  findInCrop(crop: RGBAImage, opts?: { refine?: boolean }): Promise<DetectedCard[]>;
  /**
   * The CardDetector click to scan and scans share (detect-cards.ts):
   * - detect(): one run per screenshot, through the work queue: the `kinds` outlined (default face-up
   *   only), the model's own outlines;
   * - detectInCrop(): a scan's crop (findInCrop): every card in it, face-up and face-down (each with
   *   its `kind`: the engine prefers a face-up card), outlines fitted to the image (refine.ts).
   * Both keep only detections at `minConfidence` or above, and send the contract's fields alone.
   */
  asCardDetector(opts?: CardDetectorOptions): CardDetector;
  /** Timings of the last run. */
  readonly last: Timings | null;
  release(): Promise<void>;
}

const tenth = (v: number) => Math.round(v * 10) / 10;

/** A detected card as the message contract carries it (DetectedCardBox): no class scores, no fit flag. */
const toBox = ({ cx, cy, w, h, angle, conf, kind, pts }: DetectedCard): DetectedCardBox => ({ cx, cy, w, h, angle, conf, kind, pts });

function toScreenshot(b: CardBox, sx: number, sy: number): DetectedCard {
  // Model pixels -> image pixels. sx and sy differ only by rounding (well under a pixel), so the
  // box keeps its angle; the corners are mapped exactly.
  const pts: Pt[] = b.pts.map(([x, y]) => [x / sx, y / sy]);
  const s = (sx + sy) / 2;
  const w = b.w / s;
  const h = b.h / s;
  const cx = b.cx / sx;
  const cy = b.cy / sy;
  return {
    cx: tenth(cx),
    cy: tenth(cy),
    w: tenth(w),
    h: tenth(h),
    angle: Math.round(b.angle * 1e4) / 1e4,
    conf: Math.round(b.conf * 1000) / 1000,
    pts: pts.map(([x, y]) => [tenth(x), tenth(y)]),
    kind: b.kind,
    scores: Object.fromEntries(Object.entries(b.scores).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as Record<CardKind, number>,
  };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createCardDetector(deps: CardDetectorDeps): OwnCardDetector {
  const spec = deps.spec ?? CARD_DETECTOR;
  let last: Timings | null = null;

  async function findCards(img: RGBAImage, opts: FindOptions = {}): Promise<DetectedCard[]> {
    const t0 = now();
    const input = toModelInput(img, { longSide: opts.longSide ?? spec.longSide, align: spec.align, fill: spec.fill, enlarge: opts.enlarge });
    const t1 = now();
    const out = await deps.session.run({ [spec.inputName]: new deps.Tensor('float32', input.data, [1, 3, input.height, input.width]) });
    const t2 = now();
    const heat = out[spec.outputs.heat];
    const box = out[spec.outputs.box];
    const peak = out[spec.outputs.peak];
    if (!heat || !box) throw new Error(`The card detector has no "${spec.outputs.heat}"/"${spec.outputs.box}" output`);
    const [, k, gh, gw] = heat.dims;
    const channels = box.dims[1];
    if (k !== spec.classes.length || (channels !== 6 && channels !== 14) || gh !== input.height / spec.stride || gw !== input.width / spec.stride) {
      throw new Error(`The card detector's outputs [${heat.dims}] / [${box.dims}] don't match its spec`);
    }
    const cards = decodeCards(
      { heat: heat.data, box: box.data, boxChannels: channels, peak: peak?.data ?? null, classes: spec.classes, gh, gw },
      { stride: spec.stride, minScore: opts.minScore ?? spec.minScore, nmsIoU: spec.nmsIoU, maxDetections: spec.maxDetections },
    )
      // a card whose centre falls in the padding is outside the image
      .filter((b) => b.cx < input.contentWidth && b.cy < input.contentHeight)
      .map((b) => toScreenshot(b, input.scaleX, input.scaleY));
    const t3 = now();
    const result = opts.refine ? cards.map((c) => refined(img, c)) : cards;
    last = { preprocessMs: t1 - t0, runMs: t2 - t1, decodeMs: t3 - t2, refineMs: now() - t3 };
    return result;
  }

  async function findInCrop(crop: RGBAImage, opts: { refine?: boolean } = {}): Promise<DetectedCard[]> {
    const cards = await findCards(crop, { longSide: spec.cropLongSide, enlarge: true, refine: opts.refine ?? true });
    const cx = crop.width / 2;
    const cy = crop.height / 2;
    const off = (c: DetectedCard) => Math.hypot(c.cx - cx, c.cy - cy) / Math.max(crop.width, crop.height);
    // the card the box was drawn around: confident and central
    return cards.sort((a, b) => b.conf - off(b) - (a.conf - off(a)));
  }

  return {
    findCards,
    findInCrop,
    asCardDetector(opts = {}) {
      const kinds = opts.kinds ?? ['face-up'];
      const min = opts.minConfidence ?? 0;
      return {
        async detect(img: RGBAImage, schedule?: Schedule) {
          const run = () => findCards(img);
          const cards = await (schedule ? schedule(run) : run());
          return cards.filter((c) => kinds.includes(c.kind) && c.conf >= min).map(toBox);
        },
        async detectInCrop(crop: RGBAImage) {
          return (await findInCrop(crop)).filter((c) => c.conf >= min).map(toBox);
        },
        release: () => release(),
      };
    },
    get last() {
      return last;
    },
    release,
  };

  async function release() {
    await deps.release?.();
  }
}

/** The corners of a DetectedCard-like box (for callers that only kept cx, cy, w, h, angle). */
export function cornersOf(b: { cx: number; cy: number; w: number; h: number; angle: number }): Pt[] {
  return boxCorners(b.cx, b.cy, b.w, b.h, b.angle);
}
