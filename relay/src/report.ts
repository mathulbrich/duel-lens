// A card report as the extension sends it (src/background/report.ts), checked field by field, and the GitHub issue
// made from it. Everything a user typed or a page named is untrusted: each text is cut to its limit, kept on one line
// where one line is meant, and escaped so that it can't format the issue, mention anyone (@name), link another issue
// (#123, owner/repo#1, GH-1, a github.com address), render math ($…$) or hide a link behind other words. Invisible and
// bidirectional characters are dropped. A YouTube video is written as its own canonical link; any other address only as
// code, which GitHub never links (security review of the relay, 2026-10-29).

export const REPORT_KINDS = ['no-match', 'not-sure', 'wrong-card'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export interface ReportCard {
  id: number;
  name: string;
  score?: number;
}

export interface Report {
  kind: ReportKind;
  /** The crop the engine read (PNG, JPEG or WebP), already decoded from its data URL. */
  image: { bytes: Uint8Array; type: 'image/png' | 'image/jpeg' | 'image/webp' };
  /** The card the popover showed, if any, and whether it was sure. */
  shown: (ReportCard & { confident: boolean }) | null;
  /** The engine's other candidates, best first. */
  others: ReportCard[];
  /** The card the user says it is ("Wrong card?"), if they picked one. */
  userCard: ReportCard | null;
  comment: string;
  /** The page's video at the scan's moment (a YouTube link with its time), or the page's address without its query. */
  video: { url: string; time: number | null } | null;
  app: { version: string; browser: string; os: string; model: string };
}

export const LIMITS = {
  /** The whole request body. */
  bodyBytes: 1_000_000,
  /** The decoded image. */
  imageBytes: 200 * 1024,
  comment: 500,
  name: 120,
  url: 400,
  others: 5,
  appField: 60,
} as const;

export class InvalidReport extends Error {}

const fail = (why: string): never => {
  throw new InvalidReport(why);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Zero-width and bidirectional formatting characters: they hide or reorder what a reader sees. */
const INVISIBLE = /[\u00ad\u034f\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\u3164\ufeff]/g;

/** One line of untrusted text: control characters and line breaks become spaces, runs of spaces one, cut to `max`. */
export function oneLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return v.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Several lines of untrusted text (the comment): control characters out, at most 10 lines, cut to `max`. */
export function lines(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v
    .replace(INVISIBLE, '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''))
    .slice(0, 10)
    .join('\n')
    .trim()
    .slice(0, max);
}

/**
 * Untrusted text as Markdown that shows exactly those characters: every Markdown, HTML and math character escaped.
 * GitHub finds mentions and references in the rendered text, where escapes are gone, so a zero-width space also
 * follows each "@", "#", "/" and "-": "@name", "#1", "GH-1", "owner/repo#1" and "github.com/…" link nothing. GitHub
 * renders math between dollar signs even escaped, so "$" becomes the full-width "＄", which it leaves alone.
 */
export function escapeText(s: string): string {
  return s
    .replace(/[\\`*_{}[\]()<>#+\-.!|~=:"'&@/]/g, (c) => `\\${c}${'@#/-'.includes(c) ? '\u200b' : ''}`)
    .replace(/\$/g, '\uff04');
}

/** A title's untrusted text: titles show no Markdown, but GitHub links references in them. */
export function inertTitle(s: string): string {
  return s.replace(/[@#/-]/g, (c) => `${c}\u200b`);
}

/** YouTube's video ids. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video's address for the issue: a YouTube video as its canonical link (built from its id, so it holds nothing
 * else), any other address as code, which GitHub doesn't link or render (backticks, pipes and backslashes encoded).
 */
export function videoLink(url: string, time: number | null): string {
  const u = new URL(url);
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const id = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' && u.pathname === '/watch' ? (u.searchParams.get('v') ?? '') : '';
  if (YOUTUBE_ID.test(id)) return `https://www.youtube.com/watch?v=${id}${time !== null ? `&t=${time}s` : ''}`;
  return `\`${url.replace(/[`|\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}\``;
}

/** An http(s) address, normalised, or null. Credentials in it are refused. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > LIMITS.url) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u.href;
}

function card(v: unknown, withScore: boolean): ReportCard | null {
  if (!isObject(v)) return null;
  const id = v.id;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null;
  const name = oneLine(v.name, LIMITS.name);
  if (!name) return null;
  const score = v.score;
  if (withScore && typeof score === 'number' && Number.isFinite(score)) return { id, name, score: Math.round(score * 1000) / 1000 };
  return { id, name };
}

const IMAGE_TYPES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;

/** The image's data URL decoded, refused unless its bytes are the PNG, JPEG or WebP it says it is. */
export function decodeImage(v: unknown): Report['image'] {
  if (typeof v !== 'string') return fail('image: not a data URL');
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return fail('image: not a PNG, JPEG or WebP data URL');
  if ((m[2].length * 3) / 4 > LIMITS.imageBytes + 3) return fail('image: too large');
  let bin: string;
  try {
    bin = atob(m[2]);
  } catch {
    return fail('image: not base64');
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length > LIMITS.imageBytes) return fail('image: too large');
  const kind = m[1] as keyof typeof IMAGE_TYPES;
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  const ok =
    kind === 'png'
      ? starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : kind === 'jpeg'
        ? starts([0xff, 0xd8, 0xff])
        : starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8);
  if (!ok) return fail(`image: not a ${kind.toUpperCase()} file`);
  return { bytes, type: IMAGE_TYPES[kind] };
}

/** A request body as a Report, or InvalidReport saying what is wrong. */
export function parseReport(body: unknown): Report {
  if (!isObject(body) || body.v !== 1) return fail('not a version 1 report');
  const kind = body.kind;
  if (typeof kind !== 'string' || !(REPORT_KINDS as readonly string[]).includes(kind)) return fail('kind: unknown');
  const shownCard = body.shown == null ? null : card(body.shown, true);
  if (body.shown != null && !shownCard) return fail('shown: not a card');
  const shown = shownCard && isObject(body.shown) ? { ...shownCard, confident: body.shown.confident === true } : null;
  if (kind !== 'no-match' && !shown) return fail(`${kind}: no card shown`);
  if (body.others !== undefined && !Array.isArray(body.others)) return fail('others: not a list');
  const others = ((body.others as unknown[] | undefined) ?? []).slice(0, LIMITS.others).map((c) => card(c, true));
  if (others.some((c) => c === null)) return fail('others: not a card');
  const userCard = body.userCard == null ? null : card(body.userCard, false);
  if (body.userCard != null && !userCard) return fail('userCard: not a card');
  let video: Report['video'] = null;
  if (body.video != null) {
    if (!isObject(body.video)) return fail('video: not an object');
    const url = safeUrl(body.video.url);
    if (!url) return fail('video: not an http(s) address');
    const time = body.video.time;
    video = { url, time: typeof time === 'number' && Number.isFinite(time) && time >= 0 && time < 1e7 ? Math.floor(time) : null };
  }
  if (!isObject(body.app)) return fail('app: missing');
  const app = {
    version: oneLine(body.app.version, LIMITS.appField),
    browser: oneLine(body.app.browser, LIMITS.appField),
    os: oneLine(body.app.os, LIMITS.appField),
    model: oneLine(body.app.model, LIMITS.appField),
  };
  if (!/^\d+(\.\d+){1,3}$/.test(app.version)) return fail('app.version: not a version number');
  return {
    kind: kind as ReportKind,
    image: decodeImage(body.image),
    shown,
    others: others as ReportCard[],
    userCard,
    comment: lines(body.comment, LIMITS.comment),
    video,
    app,
  };
}

/** Seconds as h:mm:ss (m:ss under an hour), as the side panel shows a video's time. */
export function clock(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const KIND_TITLE: Record<ReportKind, string> = { 'no-match': "couldn't match", 'not-sure': 'not sure', 'wrong-card': 'wrong card' };

const cardLine = (c: ReportCard) => `${escapeText(c.name)} (${c.id}${c.score !== undefined ? `, ${c.score.toFixed(3)}` : ''})`;

/** The issue's title and Markdown body; `imageUrl` is where the relay serves the report's image. */
export function issueOf(r: Report, imageUrl: string): { title: string; body: string; labels: string[] } {
  const shownName = r.shown ? `: ${r.shown.name}` : '';
  // Cut after inertTitle, whose zero-width spaces count too: GitHub refuses a title over 256 characters.
  const title = inertTitle(oneLine(`Card report (${KIND_TITLE[r.kind]})${shownName}`, 200)).slice(0, 250);
  const rows: string[] = [];
  rows.push(`| | |`, `|---|---|`);
  rows.push(`| **Report** | ${KIND_TITLE[r.kind]} |`);
  if (r.shown) rows.push(`| **Shown** | ${cardLine(r.shown)}${r.shown.confident ? '' : ', not sure'} |`);
  if (r.others.length) rows.push(`| **Other candidates** | ${r.others.map(cardLine).join('<br>')} |`);
  if (r.userCard) rows.push(`| **The user says it is** | ${cardLine(r.userCard)} |`);
  if (r.video) rows.push(`| **Video** | ${videoLink(r.video.url, r.video.time)}${r.video.time !== null ? ` (at ${clock(r.video.time)})` : ''} |`);
  rows.push(`| **Duel Lens** | ${escapeText(`${r.app.version} · ${r.app.browser}${r.app.os ? ` · ${r.app.os}` : ''} · ${r.app.model}`)} |`);
  const body = [
    `![The crop Duel Lens read](${imageUrl})`,
    '',
    ...rows,
    ...(r.comment ? ['', '**Comment:**', '', ...r.comment.split('\n').map((l) => `> ${escapeText(l)}`)] : []),
    '',
    '<sub>Sent from the Duel Lens extension\'s Report button. The image and the video link are what the user agreed to send.</sub>',
  ].join('\n');
  return { title, body, labels: ['card-report', r.kind] };
}
