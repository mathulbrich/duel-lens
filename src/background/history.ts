// Session history: recognized cards live in chrome.storage.local (capped, survives
// browser restarts); which one is "current" lives in chrome.storage.session (cleared
// when Chrome closes, so a new browser session starts with no current card).
// The crop build (`--no-remote-images`) also keeps a small picture of each scan (thumbnail.ts) under
// its own key, thumb:<entry id>, so the list stays small and the side panel reads one picture at a time.
import type { HistoryEntry } from '../shared/types';

const HISTORY_KEY = 'history';
const CURRENT_KEY = 'currentEntryId';
const MAX_HISTORY = 300;
const THUMB_PREFIX = 'thumb:';
/** Two scans of one card, on one page, this close in video time are one moment of the video. */
const SAME_MOMENT_S = 2;

/** The chrome.storage.local key of an entry's thumbnail. */
const thumbKey = (entryId: string) => `${THUMB_PREFIX}${entryId}`;

export async function getHistory(): Promise<HistoryEntry[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history = stored[HISTORY_KEY];
  return Array.isArray(history) ? (history as HistoryEntry[]) : [];
}

/** A rescan of the previous entry: the same card, on the same page, at the same moment of the video. */
function isRescan(entry: HistoryEntry, previous: HistoryEntry | undefined): boolean {
  return (
    previous !== undefined &&
    previous.cardId === entry.cardId &&
    previous.pageUrl === entry.pageUrl &&
    entry.videoTime !== undefined &&
    previous.videoTime !== undefined &&
    Math.abs(entry.videoTime - previous.videoTime) <= SAME_MOMENT_S
  );
}

/**
 * Adds a new entry at the front (newest first), dropping the oldest past 300, and their thumbnails.
 * A rescan of the newest entry (isRescan: one paused card scanned again and again) replaces it, so the
 * list keeps one row for it, with the newest scan's time, and its id (the one the caller hands out).
 */
export async function addEntry(entry: HistoryEntry): Promise<void> {
  const history = await getHistory();
  const replaced = isRescan(entry, history[0]) ? history.slice(0, 1) : [];
  const all = [entry, ...history.slice(replaced.length)];
  await chrome.storage.local.set({ [HISTORY_KEY]: all.slice(0, MAX_HISTORY) });
  const dropped = [...replaced, ...all.slice(MAX_HISTORY)];
  if (dropped.length > 0) await chrome.storage.local.remove(dropped.map((e) => thumbKey(e.id)));
}

export async function updateEntry(id: string, patch: Partial<HistoryEntry>): Promise<HistoryEntry | undefined> {
  const history = await getHistory();
  let updated: HistoryEntry | undefined;
  const next = history.map((e) => {
    if (e.id !== id) return e;
    updated = { ...e, ...patch };
    return updated;
  });
  if (updated) await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return updated;
}

/** Keeps a small picture (a JPEG data URL) of the scan behind entry `id`, if the entry is still there. */
export async function setThumb(id: string, dataUrl: string): Promise<void> {
  if (!(await getHistory()).some((e) => e.id === id)) return; // cleared or dropped meanwhile
  await chrome.storage.local.set({ [thumbKey(id)]: dataUrl });
}

export async function getThumb(id: string): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(thumbKey(id));
  const thumb = stored[thumbKey(id)];
  return typeof thumb === 'string' ? thumb : undefined;
}

export async function setCurrent(id: string): Promise<void> {
  await chrome.storage.session.set({ [CURRENT_KEY]: id });
}

export async function getCurrentId(): Promise<string | undefined> {
  const stored = await chrome.storage.session.get(CURRENT_KEY);
  const id = stored[CURRENT_KEY];
  return typeof id === 'string' ? id : undefined;
}

/** Used by the side panel's "Clear history" button (it imports this directly): the pictures go too. */
export async function clearHistory(): Promise<void> {
  const everything = await chrome.storage.local.get(null);
  const thumbs = Object.keys(everything ?? {}).filter((k) => k.startsWith(THUMB_PREFIX));
  await chrome.storage.local.set({ [HISTORY_KEY]: [] });
  if (thumbs.length > 0) await chrome.storage.local.remove(thumbs);
  await chrome.storage.session.remove(CURRENT_KEY);
}
