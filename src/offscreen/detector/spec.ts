// Duel Lens's own card detector (tools/train-detector/): a CenterNet-style oriented-box detector on a
// MobileNetV3-Large backbone (timm mobilenetv3_large_100.ra_in1k, Apache-2.0), trained only on
// synthetic duel-stream frames. One run sees a whole screenshot (shrunk so its long side is at most
// `longSide`); it outputs, at stride 4, a centre heatmap per class (face-up card, face-down card or
// pile), its 3×3 max-pool, and per cell the box: centre offset, log width/height, (sin 2θ, cos 2θ),
// and the card's 4 corners (residuals from the box's corners: keystone under a tilted camera).
// The .onnx is kept with the source (.gitignore re-includes it); tools/train-detector/README.md rebuilds it.
// Every build ships it (build.mjs), but a --no-detector one.

export const CARD_DETECTOR = {
  /** Folder under the extension root. */
  dir: 'models/detector',
  file: 'card-detector.onnx',
  inputName: 'image',
  /**
   * heat [1,K,H/4,W/4] (probabilities); box [1,14,H/4,W/4]: dx, dy, log w, log h, sin 2θ, cos 2θ and 8
   * corner residuals (a 6-channel model, without corners, also decodes); peak [1,K,H/4,W/4] (3×3 max-pool of heat).
   */
  outputs: { heat: 'heat', box: 'box', peak: 'peak' },
  stride: 4,
  /** Heatmap channels, in order. */
  classes: ['face-up', 'face-down'] as const,
  /** A screenshot is shrunk (never enlarged) until its long side is at most this... */
  longSide: 1280,
  /** ...then padded right and bottom to a multiple of this (the network's total stride) with `fill`. */
  align: 32,
  /** Padding grey (0–255); the training windows were padded with it too. */
  fill: 114,
  /** Peaks below this score are not decoded. */
  minScore: 0.2,
  /**
   * The extension keeps detections at this confidence or above: click to scan's face-up outlines, and
   * the cards in a scan's crop. On the 17 labelled full-view frames (detector-report.md §4.2) it
   * outlines 112 of 115 face-up cards with no false face-up outline (0.5: 110; 0.7: 106); in scans'
   * crops, 0.3 lets an art-sleeved deck pile through as a face-down card, which the recogniser then
   * read confidently as a card (a4-report.md).
   */
  minConfidence: 0.4,
  /** Of two outlines (either class) overlapping more than this (polygon IoU), the weaker goes. */
  nmsIoU: 0.5,
  maxDetections: 150,
  /**
   * The drag case: a crop around one card is scaled so its long side is this (up or down), which puts
   * a card that fills a loose box at about 150-280 px wide, inside the trained range (26-290 px).
   */
  cropLongSide: 448,
} as const;

export type CardDetectorSpec = typeof CARD_DETECTOR;
export type CardKind = (typeof CARD_DETECTOR.classes)[number];
