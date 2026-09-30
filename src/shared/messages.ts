// Message protocol between extension contexts (chrome.runtime / chrome.tabs messaging).
// Every request has a `type`; every response type is fixed by `ResponseFor<M>`.
import type {
  CardRecord,
  Candidate,
  CropPayload,
  HistoryEntry,
  RecognitionResult,
  ScanContext,
} from './types';

// ---------- content script → background ----------
export type ToBackground =
  /**
   * `record: false` is a hover preview: read the card, but record nothing (no history entry, so the
   * response has no `entry`; no correction; never the AI). Absent or true: a normal read.
   * A peek also keeps no thumbnail or debug crop, and fetches no card image. The rest of its answer
   * (`result`, `cards`, `aiEnabled`) is what a normal read of the same crop answers, so a click can
   * pin the previewed card from it, then record it with a normal read. Only an explicit `false` peeks.
   */
  | { type: 'recognize'; crop: CropPayload; context: ScanContext; record?: boolean }
  | { type: 'get-cards'; ids: number[] }
  | { type: 'get-image'; imageId: number; size: 'full' | 'small' }
  | { type: 'correct'; entryId: string; cardId: number; imageId: number }
  | { type: 'show-in-panel'; entryId: string }
  | { type: 'ask-ai'; crop: CropPayload; candidates: Candidate[] }
  | { type: 'open-options' }
  // from the options page / side panel:
  | { type: 'test-ai' }
  | { type: 'refresh-cards' }
  /** Download and embed artworks for any cards the index doesn't cover yet. */
  | { type: 'update-index' }
  | { type: 'get-status' }
  /**
   * From the welcome page: the user agreed to how Duel Lens works (the first-run consent the
   * Chrome Web Store requires before the first scan). Until then, the shortcut opens the welcome
   * page instead of scanning.
   */
  | { type: 'grant-consent' };

export interface StatusResponse {
  /** YGOPRODeck database_version of the stored card data. */
  dbVersion?: string;
  /** Epoch ms of the last successful card-data update. */
  cardsUpdatedAt?: number;
  cardCount: number;
  modelId: string;
  /** Number of artworks in the loaded index, if known. */
  indexCount?: number;
  /** Artworks embedded on this computer after install (the self-updating delta index). */
  indexDeltaCount?: number;
  /** Epoch ms when the user gave the first-run consent; absent until they do (scans are blocked). */
  consentedAt?: number;
  /** State of the self-updating index. */
  indexUpdate?: {
    state: 'idle' | 'running' | 'failed';
    /** Artworks still to download and embed in the current run. */
    pending?: number;
    /** Epoch ms of the last completed run. */
    lastRun?: number;
    error?: string;
  };
}

export interface RecognizeResponse {
  result: RecognitionResult;
  /** Card records for every candidate in `result.candidates`, keyed by card id. */
  cards: Record<number, CardRecord>;
  /** The history entry recorded for this scan (absent when nothing matched, and for a peek: `record: false`). */
  entry?: HistoryEntry;
  /**
   * Whether the opt-in AI check is on (setting enabled and a key saved). The content script
   * uses this instead of reading settings, so the API key never reaches page renderers.
   */
  aiEnabled: boolean;
}
export interface GetCardsResponse {
  cards: Record<number, CardRecord>;
}
export interface GetImageResponse {
  /** JPEG data URL, or null if the image could not be fetched. */
  dataUrl: string | null;
}
export interface OkResponse {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  error?: string;
}
export interface AskAiResponse {
  /** Card the AI identified, matched against the local card data. */
  cardId?: number;
  imageId?: number;
  /** The AI's raw answer (card name), for display. */
  answer?: string;
  /** The AI's own confidence flag; the popover should say "AI isn't sure" when false. */
  confident?: boolean;
  error?: string;
}

export type ResponseFor<M extends ToBackground> = M extends { type: 'recognize' }
  ? RecognizeResponse
  : M extends { type: 'get-cards' }
    ? GetCardsResponse
    : M extends { type: 'get-image' }
      ? GetImageResponse
      : M extends { type: 'ask-ai' }
        ? AskAiResponse
        : M extends { type: 'get-status' }
          ? StatusResponse
          : OkResponse;

// Only the background service worker answers ToBackground messages. Other extension
// pages (side panel, options, offscreen) also receive runtime messages: they must
// ignore anything not addressed to them and must not call sendResponse for it.

// ---------- who may send what (security review M2 and L3) ----------
/**
 * Who sent a runtime message, from what the browser vouches for (`sender.id`, `sender.url`):
 * - 'foreign': not Duel Lens (another extension, or no extension id). Never handled.
 * - 'extension-page': Duel Lens's own pages and service worker, whose URL is under the extension's
 *   base URL (the side panel, options, welcome and legal pages, the offscreen document). The options
 *   and welcome pages opened in a tab DO have `sender.tab`, so this goes by URL, never by tab.
 * - 'content-script': anything else with our id: the content script, inside a web page (its URL is
 *   the page's), and a sender without a URL.
 */
export type SenderKind = 'foreign' | 'extension-page' | 'content-script';

/** This extension, as senderKind sees it: `chrome.runtime.id` and `chrome.runtime.getURL('')`. */
export interface ExtensionIdentity {
  id: string;
  /** chrome-extension://<id>/ */
  baseUrl: string;
}

export function senderKind(sender: chrome.runtime.MessageSender | undefined, self: ExtensionIdentity): SenderKind {
  if (!self.id || sender?.id !== self.id) return 'foreign';
  const base = self.baseUrl.endsWith('/') ? self.baseUrl : `${self.baseUrl}/`;
  return base !== '/' && typeof sender.url === 'string' && sender.url.startsWith(base) ? 'extension-page' : 'content-script';
}

/**
 * Who may send each ToBackground message. Content scripts run inside web pages, so they may send
 * only what the in-page overlay needs (src/content); the rest is for Duel Lens's own pages. Typed
 * by the message union: a new message type doesn't compile until it picks a side here.
 */
export const BACKGROUND_SENDERS: Readonly<Record<ToBackground['type'], 'content-scripts-too' | 'extension-pages-only'>> = {
  // The in-page overlay; Duel Lens's own pages may send these too (the side panel reads cards and images).
  recognize: 'content-scripts-too',
  'get-cards': 'content-scripts-too',
  'get-image': 'content-scripts-too',
  correct: 'content-scripts-too',
  'show-in-panel': 'content-scripts-too',
  'ask-ai': 'content-scripts-too',
  'open-options': 'content-scripts-too',
  // Duel Lens's own pages only (options, welcome).
  'test-ai': 'extension-pages-only',
  'refresh-cards': 'extension-pages-only',
  'update-index': 'extension-pages-only',
  'get-status': 'extension-pages-only',
  'grant-consent': 'extension-pages-only',
};

/**
 * Whether the background handles a message of this type from this kind of sender: every type from
 * Duel Lens's own pages; from a content script only the types BACKGROUND_SENDERS allows it (an
 * unknown type is refused); nothing from another extension.
 */
export function backgroundAccepts(type: unknown, from: SenderKind): boolean {
  if (from === 'extension-page') return true;
  if (from !== 'content-script' || typeof type !== 'string' || !Object.hasOwn(BACKGROUND_SENDERS, type)) return false;
  return BACKGROUND_SENDERS[type as ToBackground['type']] === 'content-scripts-too';
}

// ---------- background → content script ----------
export type ToContent =
  | {
      type: 'begin-selection';
      /** PNG data URL from captureVisibleTab, taken when the shortcut was pressed. */
      screenshot: string;
      capturedAt: number;
      /** How card details show (Settings.display.reveal). Absent: 'click'. */
      reveal?: 'hover' | 'click';
    }
  | { type: 'show-error'; message: string }
  /**
   * Click to scan: the cards the detector found on the screenshot of `begin-selection` (matched by
   * `capturedAt`), sent when detection finishes. It may arrive after the user already started a
   * drag, and also BEFORE `begin-selection` itself (both are sent right after the capture), so the
   * content script keeps an early one until the matching selection starts.
   * Empty, with `error`, when the build has no card detector (a --no-detector build) or it failed:
   * dragging still works.
   */
  | { type: 'cards-detected'; capturedAt: number; detection: CardDetection }
  /**
   * Sent before every capture: hide any Duel Lens UI (popover, toasts) so it isn't captured,
   * then answer `{ ok: true }` once the page has repainted without it (two animation frames).
   * While scan mode is open, the shortcut (or the toolbar icon) closes it instead: the content
   * script answers `{ ok: true, closed: true }` and no capture follows (PrepareCaptureReply).
   * Answer `closed` at once (nothing is captured, so there is no repaint to wait for): the background
   * waits at most 300 ms, and then captures (scan.ts). Only `closed === true` stops the scan.
   */
  | { type: 'prepare-capture' }
  | { type: 'ping' };

/** The content script's answer to `prepare-capture`. */
export interface PrepareCaptureReply {
  ok: true;
  /** Scan mode was open, and this shortcut press closed it: don't capture. */
  closed?: true;
}

// ---------- background → offscreen document ----------
export type ToOffscreen =
  | { target: 'offscreen'; type: 'recognize'; crop: CropPayload }
  | { target: 'offscreen'; type: 'warmup' }
  /** Click to scan: find every card on a whole screenshot (PNG data URL from captureVisibleTab). */
  | { target: 'offscreen'; type: 'detect-cards'; dataUrl: string };

/** One card the detector found, in the screenshot's own pixels. */
export interface DetectedCardBox {
  /** Centre, size and rotation of the card's oriented box (w ≤ h; angle in radians, clockwise on screen). */
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
  /** The detector's confidence, 0–1. */
  conf: number;
  /**
   * Face-up card, or face-down (a sleeve back, a pile, the card back), when the detector tells them
   * apart (ours does). Informational: it misreads a few cards either way (2 face-up read as face-down
   * on 115 real cards), so it's never used as an answer by itself. Click to scan outlines face-up
   * cards only; a scan's crop prefers a face-up card and straightens a face-down one only when no
   * face-up one is there.
   */
  kind?: 'face-up' | 'face-down';
  /** The box's four corners (screenshot pixels), for drawing the outline. */
  pts: [number, number][];
}

/** `CardDetection.error` when the build has no card detector: click to scan then stays drag-only. */
export const NO_CARD_DETECTOR = 'no card detector in this build';

export interface CardDetection {
  /** Cards found, best first. Empty when none were found or detection couldn't run (see `error`). */
  boxes: DetectedCardBox[];
  /** Size of the screenshot the boxes refer to, in pixels. */
  width: number;
  height: number;
  ms: number;
  /** Why detection couldn't run (no detector in this build, a model error). */
  error?: string;
}

export interface OffscreenDetectCardsResponse {
  detection: CardDetection;
}

export interface OffscreenRecognizeResponse {
  result: RecognitionResult;
}

// ---------- background → offscreen: self-updating index ----------
// Kept separate from ToOffscreen until the offscreen handler is wired for them.
export type ToOffscreenIndex =
  /** Which of these artwork ids are in neither the bundled index nor the local delta? */
  | { target: 'offscreen'; type: 'index-missing'; imageIds: number[] }
  /** Embed these artwork crops with the current model and add them to the local delta index. */
  | {
      target: 'offscreen';
      type: 'embed-artworks';
      items: { imageId: number; cardId: number; dataUrl: string }[];
    };

export interface OffscreenIndexMissingResponse {
  modelId: string;
  missing: number[];
  /** Set when the offscreen document couldn't check (its index or the local delta can't be read); `missing` is then empty. */
  error?: string;
}
export interface OffscreenEmbedArtworksResponse {
  modelId: string;
  added: number;
  failed: { imageId: number; error: string }[];
  /** Set when nothing could be embedded (the embedding model or the card back can't be loaded); every item is then in `failed`. */
  error?: string;
  /** Artworks that are still YGOPRODeck's card-back placeholder (art not uploaded yet): not indexed. Present only when there are any. */
  placeholders?: number[];
}

export function isToOffscreenIndex(msg: unknown): msg is ToOffscreenIndex {
  const m = msg as { target?: unknown; type?: unknown } | null;
  return !!m && m.target === 'offscreen' && (m.type === 'index-missing' || m.type === 'embed-artworks');
}

// ---------- helpers ----------
/** Typed wrapper around chrome.runtime.sendMessage for messages to the background. */
export function sendToBackground<M extends ToBackground>(msg: M): Promise<ResponseFor<M>> {
  return chrome.runtime.sendMessage(msg) as Promise<ResponseFor<M>>;
}

export function isToOffscreen(msg: unknown): msg is ToOffscreen {
  return typeof msg === 'object' && msg !== null && (msg as { target?: unknown }).target === 'offscreen';
}
