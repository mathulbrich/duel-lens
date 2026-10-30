// "Report" (the popover): a card the engine read wrong, wasn't sure of, or couldn't match goes to the Duel Lens issue
// tracker on GitHub through the report relay (relay/, a Cloudflare Worker that opens the issue as the Duel Lens Reports
// GitHub App, so the user needs no account). Only when the user presses Send, after the popover has shown what goes:
// the crop, the cards, the video at that moment, their comment, and the extension's version and browser.
// The relay checks every field again (relay/src/report.ts); these are the extension's own limits.

/** The relay's report endpoint (relay/README.md). */
export const REPORT_RELAY_URL = 'https://duel-lens-reports.mathulbrich.workers.dev/report';

/** Where the reports become issues, for the popover's note. */
export const REPORT_ISSUES_URL = 'https://github.com/mathulbrich/duel-lens/issues';

export const REPORT_COMMENT_MAX = 500;

export type ReportKind = 'no-match' | 'not-sure' | 'wrong-card';

export interface ReportCard {
  cardId: number;
  name: string;
  score?: number;
}

/** What the popover hands the background (message `report-card`); the background adds the image, version and browser. */
export interface ReportDraft {
  kind: ReportKind;
  /** The crop the engine read (CropPayload.dataUrl). */
  dataUrl: string;
  /** The engine's top card, if any, and whether it was sure. */
  shown: (ReportCard & { confident: boolean }) | null;
  /** The engine's other candidates, best first (at most 4). */
  others: ReportCard[];
  /** The candidate the user picked instead of the top card, if they did. */
  userCard: ReportCard | null;
  comment: string;
  /** The page and the video's time under the crop (ScanContext). */
  pageUrl: string;
  videoTime?: number;
  modelId: string;
}

export type ReportError = 'consent' | 'rate-limited' | 'daily-limit' | 'paused' | 'unavailable' | 'invalid' | 'network';

export type ReportCardResponse = { ok: true; issue: { number: number; url: string } } | { ok: false; error: ReportError };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The page as a report names it: a YouTube video as its plain watch link (nothing of the page's other parameters), any
 * other http(s) page without its query or fragment (which can hold anything), anything else not at all. The time goes
 * separately, whole seconds.
 */
export function reportVideo(pageUrl: string, videoTime?: number): { url: string; time: number | null } | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const time = typeof videoTime === 'number' && Number.isFinite(videoTime) && videoTime >= 0 ? Math.floor(videoTime) : null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const id =
    host === 'youtu.be'
      ? u.pathname.slice(1)
      : host === 'youtube.com'
        ? u.pathname === '/watch'
          ? (u.searchParams.get('v') ?? '')
          : (/^\/(?:shorts|live|embed)\/([^/]+)/.exec(u.pathname)?.[1] ?? '')
        : '';
  if (YOUTUBE_ID.test(id)) return { url: `https://www.youtube.com/watch?v=${id}`, time };
  return { url: `${u.origin}${u.pathname}`, time };
}

/** Seconds as h:mm:ss (m:ss under an hour), as the side panel shows a video's time. */
export function reportClock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
