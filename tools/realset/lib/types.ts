// Shared shapes for the real-footage test set (tools/realset/**, tools/eval-real.ts).

/**
 * A labelled card's oriented box, in the source frame's own pixel coordinates. Provenance: the boxes on
 * record came from the teacher labeller's detector run (an earlier prototype's detector, since removed;
 * README.md), never from a person.
 */
export interface RotatedBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angleDeg: number;
  /** That detector's confidence, when this box came from a detector run. */
  conf?: number;
  /** Corners, as boxCorners (src/offscreen/geometry.ts) gives them: clockwise from the box's own top-left (frame pixels). */
  pts: [number, number][];
}

export interface AxisBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One of the teacher classifier's guesses (provenance, see RealsetEntry.source). */
export interface TeacherGuess {
  cardId: number | null;
  name: string;
  p: number;
}

export interface RealsetEntry {
  id: string;
  frame: string;
  /** The card's labelled oriented box (see RotatedBox); null on the rows labelled by hand without one (capture-C's, merged 2026-09-29). */
  rotatedBox: RotatedBox | null;
  /** Axis-aligned bounding box of the card, in frame pixels, as a user would draw it. */
  userBox: AxisBox;
  cardId: number | null;
  name: string;
  /**
   * A person checked the label: every 'human' row, and the 15 teacher rows accepted at the first
   * spot check. The teacher rows added later were compared with the artwork too, but keep false.
   */
  verified: boolean;
  /**
   * Provenance, kept as history: 'human' = identified by a person; 'draw2-teacher' = the top-1 of the
   * teacher classifier (the earlier prototype's, since removed; the value keeps its original name), kept
   * after a person compared it with the artwork. Nothing produces new teacher rows any more.
   */
  source: 'draw2-teacher' | 'human';
  /** Set true only when a hand obviously covers part of the card (spot-checked frames only). */
  occluded?: boolean;
  // The teacher's own reading, kept as provenance (history, optional): absent or null on rows a person
  // labelled from scratch (capture-C's), and may disagree with a human-verified cardId.
  /** The teacher's top-1 probability for this crop. */
  teacherProb?: number | null;
  /** The teacher's top-1 / top-2 probability ratio (its accept gate is RATIO_GATE, lib/constants.ts). */
  teacherRatio?: number | null;
  /** The teacher's top 5. */
  teacherTop5?: TeacherGuess[];
}

/**
 * A box around something that is not a face-up card, drawn by hand on a real frame the way a
 * user would box it (data/realset/negatives.json): a deck pile, a sleeved face-down card, a fan
 * of face-down cards, or artwork printed on the mat. No recogniser should be sure of any card there.
 */
export interface NegativeBox {
  id: string;
  /** data/debug/frames/<frame>.png */
  frame: string;
  /** [x, y, w, h] in the frame's own pixels. */
  box: [number, number, number, number];
  /** What the box holds, e.g. "WCQ blue (official)", "Black Rose Dragon art sleeve", "MAT ART: ...". */
  design: string;
  /** The stream the frame comes from, e.g. "YCS Paris 2026 (Genesys) Day 1". */
  source: string;
}
