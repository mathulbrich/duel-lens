// Live: while a video plays, the content script reads frames and the side panel lists the cards it is sure of.
// The names, numbers and the log reducer every context shares. The background keeps the LiveLog in
// chrome.storage.session under LIVE_KEY (a browser restart clears it); the side panel follows it.

/** How hard Live works (Options): 'light' reads less often, for a slow computer. */
export type LiveEffort = 'balanced' | 'light';
export type LiveStatus = 'starting' | 'watching' | 'paused' | 'slow' | 'blocked' | 'stopped';
export type LiveStopReason = 'user' | 'left' | 'blocked' | 'no-video' | 'other-tab';

/** A card the loop is sure of, seen at `videoTime` seconds into the video. */
export interface LiveSighting {
  cardId: number;
  imageId: number;
  videoTime: number;
}

/** What the content script reports after each frame it reads. */
export interface LiveProgress {
  status: LiveStatus;
  stopReason?: LiveStopReason;
  intervalMs?: number;
  /** Cards still being confirmed (seen once, waiting for a second look). */
  voting: number;
  sightings: LiveSighting[];
}

/** Main-thread wall time of each step of the loop on the page, the last 200 of each, ms (Options reports them). */
export interface LiveStats {
  thumbMs: number[];
  encodeMs: number[];
  cropMs: number[];
}

export interface LiveEntry {
  cardId: number;
  imageId: number;
  firstVideoTime: number;
  lastVideoTime: number;
  /** Times it came back on screen after at least LIVE.reappearGapS of video. */
  appearances: number;
}

export interface LiveLog {
  tabId: number;
  /** The content script's page key (a YouTube watch page by its video id): what makes two starts the same page. */
  pageKey: string;
  pageUrl: string;
  pageTitle: string;
  startedAt: number;
  status: LiveStatus;
  stopReason?: LiveStopReason;
  intervalMs?: number;
  voting: number;
  /** Newest first. */
  entries: LiveEntry[];
}

/** The chrome.storage.session key of the LiveLog. */
export const LIVE_KEY = 'live';

/** Per effort: the share of time the loop may spend reading, the share while the pointer moves over the picture
 *  (the cards are read ahead, so the one pointed at next is often known already), its fastest pace, and the pace that
 *  counts as slow. 'light', for a slow computer, reads no harder while the pointer moves. */
export const LIVE_EFFORTS: Record<LiveEffort, { load: number; activeLoad: number; minIntervalMs: number; slowAboveMs: number }> = {
  balanced: { load: 0.2, activeLoad: 0.35, minIntervalMs: 500, slowAboveMs: 2000 },
  light: { load: 0.1, activeLoad: 0.1, minIntervalMs: 2000, slowAboveMs: 4000 },
};

export const LIVE = {
  /** The longest wait between cycles (30 s was tried on the low profile: the first look after the models loaded came
   *  too late for any card of the clip). While the pointer is on a card, HOVER pulls cycles sooner (controller.ts). */
  maxIntervalMs: 8000,
  /** A cycle stops reading once it has run this long (after its first read): a slow computer reads one card a cycle,
   *  the pointed one first, a fast one every card waiting, up to TRACK.readsPerCycle. */
  readBudgetMs: 600,
  /** Consecutive frames slower than the effort's slowAboveMs before the status says 'slow'. */
  slowFrames: 3,
  frameMaxSide: 1280,
  frameQuality: 0.85,
  maxEntries: 200,
  /** Seconds of video a card must be gone before coming back counts as another appearance. */
  reappearGapS: 20,
  /** Seconds ahead of a click that a card's link seeks to. */
  seekLeadS: 3,
  /** A jump of the video clock bigger than this many seconds is a seek, not playback. */
  jumpS: 2,
  badgeText: 'LIVE',
  badgeColor: '#C8322B',
} as const;

const STATUSES: readonly LiveStatus[] = ['starting', 'watching', 'paused', 'slow', 'blocked', 'stopped'];
const STOP_REASONS: readonly LiveStopReason[] = ['user', 'left', 'blocked', 'no-video', 'other-tab'];

export function isLiveEffort(value: unknown): value is LiveEffort {
  return value === 'balanced' || value === 'light';
}

/** A new log for a tab and page; the same tab on the same page (by page key, not URL) keeps what it had found. */
export function startLog(
  prev: LiveLog | null,
  page: { tabId: number; pageKey: string; pageUrl: string; pageTitle: string },
  now: number,
): LiveLog {
  const same = prev !== null && prev.tabId === page.tabId && prev.pageKey === page.pageKey;
  return { ...page, startedAt: now, status: 'starting', voting: 0, entries: same ? prev.entries : [] };
}

/** The log after one report: sightings add new cards at the front and update the known ones; the list is capped. */
export function applyProgress(log: LiveLog, p: LiveProgress): LiveLog {
  let entries = log.entries;
  for (const s of p.sightings) {
    const i = entries.findIndex((e) => e.cardId === s.cardId);
    if (i < 0) {
      const fresh: LiveEntry = {
        cardId: s.cardId,
        imageId: s.imageId,
        firstVideoTime: s.videoTime,
        lastVideoTime: s.videoTime,
        appearances: 1,
      };
      entries = [fresh, ...entries];
      continue;
    }
    const e = entries[i];
    const again = s.videoTime - e.lastVideoTime >= LIVE.reappearGapS;
    const next = {
      ...e,
      lastVideoTime: Math.max(e.lastVideoTime, s.videoTime),
      appearances: e.appearances + (again ? 1 : 0),
    };
    entries = entries.map((x, j) => (j === i ? next : x));
  }
  return {
    ...log,
    status: p.status,
    stopReason: p.stopReason,
    intervalMs: p.intervalMs,
    voting: p.voting,
    entries: entries.slice(0, LIVE.maxEntries),
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isLiveEntry(value: unknown): value is LiveEntry {
  const e = value as Partial<LiveEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    isNum(e.cardId) &&
    isNum(e.imageId) &&
    isNum(e.firstVideoTime) &&
    isNum(e.lastVideoTime) &&
    isNum(e.appearances)
  );
}

/** Whether `value` is a LiveLog as this version writes it (storage.session is ours, but a restart may leave an older shape). */
export function isLiveLog(value: unknown): value is LiveLog {
  const l = value as Partial<LiveLog> | null;
  return (
    typeof l === 'object' &&
    l !== null &&
    isNum(l.tabId) &&
    typeof l.pageKey === 'string' &&
    typeof l.pageUrl === 'string' &&
    typeof l.pageTitle === 'string' &&
    isNum(l.startedAt) &&
    STATUSES.includes(l.status as LiveStatus) &&
    (l.stopReason === undefined || STOP_REASONS.includes(l.stopReason)) &&
    (l.intervalMs === undefined || isNum(l.intervalMs)) &&
    isNum(l.voting) &&
    Array.isArray(l.entries) &&
    l.entries.every(isLiveEntry)
  );
}
