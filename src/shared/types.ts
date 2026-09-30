// Shared data contracts. Every context (background, content, offscreen, side panel,
// options) and the Node tools import from here, so change these only deliberately.

/**
 * One card, trimmed from YGOPRODeck `cardinfo.php?misc=yes` by `trimCard()`, with the Genesys points
 * of `cardinfo.php?format=genesys&misc=yes` merged in by `mergeGenesysPoints()`.
 */
export interface CardRecord {
  /** YGOPRODeck id; equals the printed passcode for almost every card. */
  id: number;
  /** Konami's database id, shared by the official DB, Yugipedia and YGOResources. */
  konamiId?: number;
  name: string;
  /** e.g. "Tuner Monster", "Spell Card", "Link Monster". */
  type: string;
  /** Human-readable type, e.g. "Tuner Effect Monster", "Normal Spell". */
  humanType?: string;
  /**
   * Card frame: "normal" | "effect" | "ritual" | "fusion" | "synchro" | "xyz" | "link" |
   * "spell" | "trap" | "token" | "skill" | "<kind>_pendulum".
   */
  frameType: string;
  /** Monster type line, e.g. ["Zombie", "Tuner", "Effect"]. Absent for Spells/Traps. */
  typeline?: string[];
  /** Full card text; for Pendulums this contains both sections. */
  desc: string;
  pendDesc?: string;
  monsterDesc?: string;
  /** Monster type (e.g. "Zombie"), or Spell/Trap property ("Normal", "Quick-Play", ...). */
  race?: string;
  attribute?: string;
  atk?: number;
  /** Absent for Link monsters. */
  def?: number;
  /** Level, or Rank for Xyz monsters. */
  level?: number;
  linkval?: number;
  linkmarkers?: string[];
  scale?: number;
  archetype?: string;
  banlist?: { tcg?: string; ocg?: string; goat?: string };
  /** What the card costs in the TCG's Genesys format. Present only when above 0: most cards cost nothing. */
  genesysPoints?: number;
  /** Every artwork id for this card; the first is the default artwork. */
  imageIds: number[];
}

/** Special card id used for the card back in the index ("face-down card"). */
export const CARD_BACK_ID = -1;

export interface Candidate {
  cardId: number;
  /** Which artwork matched best (differs from cardId for alternate artworks). */
  imageId: number;
  /** Match strength, higher is better: the embedding matcher's cosine similarity, in [-1, 1]. */
  score: number;
  /** Which recogniser produced this candidate: the embedding matcher, the only one (absent in older results). */
  source?: 'embedding';
}

/** Which recogniser produced a result: the embedding matcher, the only one. */
export type Recognizer = 'embedding';

export type CropSource = 'video' | 'screenshot';

/** The pixels the user framed, cut out by the content script. */
export interface CropPayload {
  /** PNG data URL of the crop (the user's box plus a small margin). */
  dataUrl: string;
  width: number;
  height: number;
  source: CropSource;
  /** Native height of the video the crop came from (for the "raise quality" tip). */
  videoHeight?: number;
  /**
   * The user's box inside this crop, in crop pixels. The crop adds a margin around the box,
   * but the margin is clipped at the edges of the frame, so consumers must use this rather
   * than assuming a fixed margin.
   */
  inner?: { x: number; y: number; w: number; h: number };
  /**
   * Click to scan only: the clicked card's outline, the card detector's 4 corners on the screenshot
   * (DetectedCardBox.pts, in their order), mapped into this crop's pixels. The engine straightens the card
   * from them (click-regression-report.md), or from the card found in the crop when that is plainly the same
   * card boxed another way (engine.ts CLICK_REDETECT, click-stack-report.md). Absent for a box the user drew.
   */
  outline?: [number, number][];
  /**
   * Click to scan with a pointer only: where the card was clicked, in this crop's pixels (mapped as `outline` is).
   * A card the engine finds in the crop replaces the outline only when it holds this point (CLICK_REDETECT): a
   * click on a covered card's art inside the outline of the card lying on it doesn't read the top card. Absent
   * for a box the user drew and for a card picked with the keyboard or by assistive technology. Clamped into the
   * crop (a click on the hit area's rim); the engine drops any point outside it, and the outline's centre decides.
   */
  click?: [number, number];
}

export interface ScanContext {
  pageUrl: string;
  pageTitle: string;
  /** Seconds into the video when the shortcut was pressed, if the crop came from a video. */
  videoTime?: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface RecognitionResult {
  /** Best distinct cards, best first (at most 10). Empty when nothing plausible matched. */
  candidates: Candidate[];
  /** True when the top score and its margin over the next card clear the model's thresholds. */
  confident: boolean;
  /** True when the best match is the card back. */
  faceDown: boolean;
  modelId: string;
  /** Which recogniser produced the candidates (absent in older results: 'embedding'). */
  recognizer?: Recognizer;
  /** Which crop hypothesis produced the top candidate (hypotheses.ts), and how far the selection turns to it. */
  best?: { hypothesis: 'quad' | 'whole' | 'fit' | 'art'; rotation: Rotation };
  /** Milliseconds per stage, e.g. { decode, detect, embed, search, total }. */
  timings: Record<string, number>;
  /** Set when recognition could not run (model or index failed to load, bad input). */
  error?: string;
  /**
   * True when the card read runs off the edge of the picture it was cut from (the video frame, or the
   * screenshot): part of it was never captured. Absent otherwise. With no match, the popover can say so
   * instead of the generic advice (partial-report.md, "UX").
   */
  truncated?: boolean;
  /**
   * True when the answer comes from reading the card again with a simulator's pile-count badge (a big white
   * number over its art) painted out: no other reading matched. Never confident (diag-t950-report.md). Absent
   * otherwise.
   */
  countBadge?: boolean;
  /**
   * True when the answer is a low match, for the popover to label so. Either no reading cleared the model's
   * floor but a face-up card was picked (a click on an outlined card, or the card detector's card in the box):
   * `candidates` are the closest cards, offered as "Not sure" (click-regression-report.md). Or a "Not sure" read
   * from the user's box alone whose first card leads by < 0.07 (engine.ts LOW_MATCH; diag-overframe-report.md).
   * Never confident. Absent otherwise.
   */
  suggested?: boolean;
}

export interface HistoryEntry {
  id: string;
  cardId: number;
  imageId: number;
  score: number;
  confident: boolean;
  /** Epoch ms. */
  at: number;
  pageUrl: string;
  pageTitle: string;
  videoTime?: number;
  source: CropSource;
  /** True when the user picked a different card than the top match. */
  corrected?: boolean;
}

export interface Settings {
  ai: {
    enabled: boolean;
    apiKey: string;
    /** Claude model id; default 'claude-opus-5'. */
    model: string;
  };
  debug: {
    /** Keep the last crops (with the final card) so a real test set can be exported. */
    saveCrops: boolean;
  };
  display: {
    /**
     * How a card's details show in scan mode. 'hover': resting the pointer on an outline (or focusing it)
     * shows a compact preview, and a click still opens the full details. 'click': only a click does.
     */
    reveal: 'hover' | 'click';
  };
}

export const DEFAULT_SETTINGS: Settings = {
  ai: { enabled: false, apiKey: '', model: 'claude-opus-5' },
  debug: { saveCrops: false },
  display: { reveal: 'hover' },
};
