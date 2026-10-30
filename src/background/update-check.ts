// For a copy installed by hand only (shared/update.ts): once a day, asks GitHub for the latest release and keeps the
// newer version, if any, for the side panel and Options to show. A store copy (installType 'normal') never asks: its
// store updates it. Options can turn it off ("Tell me when a new version is out"), which also clears the notice.
// The request is a plain GET of a public URL, with no cookie and nothing about the user or their scans; GitHub sees
// the IP address and the browser, as any website would (privacy policy, section 3.5).
import { getSettings } from './settings';
import { installedByHand, isNewer, isVersion, UPDATE_KEY } from '../shared/update';

export const UPDATE_ALARM = 'update-check';
/** GitHub's answer for the latest release: its tag_name is the version ("v0.9.4"). */
export const RELEASES_API = 'https://api.github.com/repos/mathulbrich/duel-lens/releases/latest';
const DAY_MINUTES = 24 * 60;
/** chrome.storage.local: when GitHub was last asked (ms), so a browser restarted often still asks once a day. */
const CHECKED_KEY = 'updateCheckedAt';
/** A little under a day: an alarm that fires a few minutes early still asks. */
const MIN_GAP_MS = 20 * 60 * 60_000;

export interface UpdateCheckDeps {
  installedByHand(): Promise<boolean>;
  enabled(): Promise<boolean>;
  fetch: typeof fetch;
  now(): number;
  version(): string;
}

const defaultDeps: UpdateCheckDeps = {
  installedByHand,
  enabled: async () => (await getSettings()).updates.check,
  // Wrapped: fetch called as a method of this object throws "Illegal invocation" in Chrome.
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  version: () => chrome.runtime.getManifest().version,
};

/** At every worker start: the daily alarm for a copy installed by hand (its first check a minute later); none otherwise. */
export async function scheduleUpdateCheck(deps: Pick<UpdateCheckDeps, 'installedByHand'> = defaultDeps): Promise<void> {
  if (!(await deps.installedByHand())) {
    await chrome.alarms.clear(UPDATE_ALARM);
    await chrome.storage.local.remove(UPDATE_KEY);
    return;
  }
  // Only when none exists, so a worker waking up doesn't push the check back. Firefox drops alarms on a restart:
  // the one made then asks a minute later, unless it asked less than a day ago (runUpdateCheck).
  if (await chrome.alarms.get(UPDATE_ALARM)) return;
  chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: DAY_MINUTES });
}

/** The alarm: asks GitHub, and keeps the newer version or clears the notice. A failed request changes nothing. */
export async function runUpdateCheck(deps: UpdateCheckDeps = defaultDeps): Promise<void> {
  if (!(await deps.installedByHand())) return;
  if (!(await deps.enabled())) {
    await chrome.storage.local.remove(UPDATE_KEY);
    return;
  }
  const last = (await chrome.storage.local.get(CHECKED_KEY))[CHECKED_KEY];
  if (typeof last === 'number' && deps.now() - last < MIN_GAP_MS) return;
  await chrome.storage.local.set({ [CHECKED_KEY]: deps.now() });
  let tag: unknown;
  try {
    const res = await deps.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return;
    tag = ((await res.json()) as { tag_name?: unknown } | null)?.tag_name;
  } catch {
    return; // offline, or GitHub down: the next day's check tries again
  }
  const version = typeof tag === 'string' ? tag.replace(/^v/, '') : '';
  if (!isVersion(version)) return;
  if (isNewer(version, deps.version())) await chrome.storage.local.set({ [UPDATE_KEY]: { version } });
  else await chrome.storage.local.remove(UPDATE_KEY);
}
