// "Report" (src/shared/report.ts): the popover's draft sent to the report relay, which opens it as a GitHub issue.
// The crop goes as a JPEG of at most REPORT_IMAGE_SIDE pixels (smaller again if it would pass the relay's 200 KB), with
// the extension's version, the browser and the OS. Firefox first needs the user's consent to the data the report holds
// (its optional data-collection permissions, asked in Options: reportPermissions); Chrome has none to ask.
import { reportPermissions } from '../shared/hosts';
import { REPORT_COMMENT_MAX, REPORT_RELAY_URL, reportVideo, type ReportCardResponse, type ReportDraft, type ReportError } from '../shared/report';
import { makeThumbnail } from './thumbnail';

export const REPORT_IMAGE_SIDE = 512;
/** Under the relay's 200 KB, with room for its data URL's base64. */
const REPORT_IMAGE_BYTES = 140 * 1024;
const REPORT_TIMEOUT_MS = 20_000;

export interface ReportDeps {
  fetch: typeof fetch;
  /** The crop as a JPEG data URL at most `maxSide` pixels on its longer side. */
  shrink: (dataUrl: string, maxSide: number, quality: number) => Promise<string>;
  /** Firefox: whether the user allowed the report's data (Options). */
  allowed: () => Promise<boolean>;
  version: string;
  /** "Chrome 141", "Firefox 140"... */
  browser: string;
  os: string;
}

/** The browser and OS, as the report names them: from the user-agent data where there is some, else the user agent. */
export function browserOf(nav: { userAgent: string; userAgentData?: { brands?: { brand: string; version: string }[]; platform?: string } }): { browser: string; os: string } {
  const ua = nav.userAgent;
  const brands = nav.userAgentData?.brands ?? [];
  const pick = (name: string) => brands.find((b) => b.brand === name);
  const brand = pick('Opera') ?? pick('Microsoft Edge') ?? pick('Google Chrome') ?? pick('Chromium');
  const firefox = /Firefox\/(\d+)/.exec(ua);
  const browser = firefox
    ? `Firefox ${firefox[1]}`
    : brand
      ? `${brand.brand.replace('Google ', '').replace('Microsoft ', '')} ${brand.version}`
      : /OPR\/(\d+)/.test(ua)
        ? `Opera ${/OPR\/(\d+)/.exec(ua)![1]}`
        : `Chromium ${/Chrome\/(\d+)/.exec(ua)?.[1] ?? '?'}`;
  const platform = nav.userAgentData?.platform || ua;
  const os = /Windows/i.test(platform) ? 'Windows' : /Mac/i.test(platform) ? 'macOS' : /CrOS|Chrome OS/i.test(platform) ? 'ChromeOS' : /Android/i.test(platform) ? 'Android' : /Linux/i.test(platform) ? 'Linux' : 'other';
  return { browser, os };
}

function defaultDeps(): ReportDeps {
  const { browser, os } = browserOf(navigator as Parameters<typeof browserOf>[0]);
  return {
    fetch: (...args) => fetch(...args),
    shrink: (dataUrl, maxSide, quality) => makeThumbnail(dataUrl, undefined, { maxSide, quality }),
    allowed: async () => (__DUEL_LENS_FIREFOX__ ? chrome.permissions.contains(reportPermissions()) : true),
    version: chrome.runtime.getManifest().version,
    browser,
    os,
  };
}

const ERRORS: readonly ReportError[] = ['rate-limited', 'daily-limit', 'paused', 'unavailable', 'invalid'];

/** Sends the report; never throws. */
export async function sendReport(draft: ReportDraft, deps: ReportDeps = defaultDeps()): Promise<ReportCardResponse> {
  if (!(await deps.allowed().catch(() => false))) return { ok: false, error: 'consent' };
  let image: string;
  try {
    image = await deps.shrink(draft.dataUrl, REPORT_IMAGE_SIDE, 0.85);
    if ((image.length * 3) / 4 > REPORT_IMAGE_BYTES) image = await deps.shrink(draft.dataUrl, 320, 0.7);
  } catch {
    return { ok: false, error: 'invalid' };
  }
  const card = (c: { cardId: number; name: string; score?: number }) => ({ id: c.cardId, name: c.name, ...(c.score !== undefined ? { score: c.score } : {}) });
  const body = {
    v: 1,
    kind: draft.kind,
    image,
    shown: draft.shown ? { ...card(draft.shown), confident: draft.shown.confident } : null,
    others: draft.others.slice(0, 4).map(card),
    userCard: draft.userCard ? card(draft.userCard) : null,
    comment: draft.comment.trim().slice(0, REPORT_COMMENT_MAX),
    video: reportVideo(draft.pageUrl, draft.videoTime),
    app: { version: deps.version, browser: deps.browser, os: deps.os, model: draft.modelId },
  };
  let res: Response;
  try {
    res = await deps.fetch(REPORT_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: 'network' };
  }
  const answer = (await res.json().catch(() => null)) as { ok?: boolean; issue?: { number?: unknown; url?: unknown }; error?: unknown } | null;
  const issue = answer?.issue;
  if (res.ok && answer?.ok && typeof issue?.number === 'number' && typeof issue.url === 'string' && issue.url.startsWith('https://github.com/')) {
    return { ok: true, issue: { number: issue.number, url: issue.url } };
  }
  const error = ERRORS.find((e) => e === answer?.error);
  return { ok: false, error: error ?? 'unavailable' };
}
