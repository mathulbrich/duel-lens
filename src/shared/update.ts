// "A new version is out", for a copy installed by hand (Load unpacked, from a GitHub release zip): the stores update
// their copies themselves, a manual install never does. The background asks GitHub once a day
// (background/update-check.ts) and keeps the newer version here, in chrome.storage.local; the side panel and Options
// say so, with a link to the release. Nothing about the user goes with the request.

/** chrome.storage.local: the newer version GitHub has ({ version }), when there is one. */
export const UPDATE_KEY = 'updateAvailable';
/** The latest release's page: where the notice links (fixed, never a link GitHub's answer gives). */
export const RELEASES_PAGE = 'https://github.com/mathulbrich/duel-lens/releases/latest';

export interface UpdateNotice {
  version: string;
}

/** A version as Duel Lens's manifests write it: 1 to 4 numbers, dot-separated ("0.9.4"). */
const VERSION = /^\d+(\.\d+){0,3}$/;

export const isVersion = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v);

/** True when `version` is later than `than` ("0.10.0" after "0.9.4"; a missing part counts as 0). */
export function isNewer(version: string, than: string): boolean {
  const a = version.split('.').map(Number);
  const b = than.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The stored notice, while it is still news: none once this copy is that version or later (the user updated). */
export function noticeFor(stored: unknown, current: string): UpdateNotice | null {
  const version = (stored as { version?: unknown } | null | undefined)?.version;
  return isVersion(version) && isNewer(version, current) ? { version } : null;
}

/** True for a copy installed by hand (Load unpacked; Firefox: a temporary add-on), which never updates itself. */
export async function installedByHand(): Promise<boolean> {
  try {
    return (await chrome.management.getSelf()).installType === 'development';
  } catch {
    return false;
  }
}
