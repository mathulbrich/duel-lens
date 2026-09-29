// Click to scan's card detector interface: every card on a whole screenshot, and the cards in a
// scan's crop. One registered detector serves both: ours (src/offscreen/detector/: one run per
// screenshot, the card's 4 corners and a face-up/face-down class), which src/offscreen/index.ts
// registers through loaders.ts. The offscreen handler runs detect() for click to scan (handler.ts:
// detect-cards) and the engine runs detectInCrop() on every scan's crop (engine.ts). The tiled scheme
// click-D first validated with a stand-in model now lives with the offline tools
// (tools/lib/tiled-detector.ts).
import type { DetectedCardBox } from '../shared/messages';
import type { RGBAImage } from '../shared/preprocess';

/**
 * Runs one model run on the offscreen document's work queue: one run at a time, never alongside a
 * scan's, and a scan waiting goes first (handler.ts).
 */
export type Schedule = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * What click to scan and scans need from a card detector: one registered detector serves both (the
 * offscreen handler for click to scan, the engine for a scan's crop).
 */
export interface CardDetector {
  /**
   * Every card on `img` (a whole screenshot, as captured), one outline per card, strongest first,
   * in `img` pixels. Every model run goes through `schedule` (the work queue); without one, the
   * runs go one after another. Rejects when a run fails.
   */
  detect(img: RGBAImage, schedule?: Schedule): Promise<DetectedCardBox[]>;
  /**
   * Optional, for scans: the cards in `crop`, a crop around the box the user drew or the card they
   * clicked (their card plus a margin, so the card fills most of it), in `crop` pixels, each with its
   * `kind` when the detector tells face-up and face-down apart. The engine runs it inside a scan's own
   * turn on the work queue, so it takes no schedule. A detector that sees screenshots at their own
   * scale should look at the crop so that the card has a broadcast card's size. Without it, the
   * engine calls detect() on the crop.
   */
  detectInCrop?(crop: RGBAImage): Promise<DetectedCardBox[]>;
  /** Frees the model. */
  release?(): Promise<void>;
}
