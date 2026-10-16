// Session history: recognized cards live in the private IndexedDB store (secure-store.ts, decision D-FF2:
// capped, survives browser restarts, and the scripts Duel Lens runs on web pages can't open it in any browser);
// which one is "current" lives in chrome.storage.session (cleared when the browser closes, so a new browser
// session starts with no current card). The crop build (`--no-remote-images`) also keeps a small picture of each
// scan (thumbnail.ts) under its own key, thumb:<entry id>, so the list stays small and the side panel reads one
// picture at a time. IndexedDB has no change events: after each change a chrome.storage.session key
// (HISTORY_CHANGED_KEY) changes, so the side panel's chrome.storage.onChanged listener reads the history again.
// Until migrateLegacyStorage has moved 0.9.2's copy out of chrome.storage.local, the reads fall back on it.
import type { HistoryEntry } from '../shared/types';
import { HISTORY_KEY, prefixRange, request, secureGet, THUMB_PREFIX, withSecureStore } from './secure-store';

const CURRENT_KEY = 'currentEntryId';
/** chrome.storage.session key that changes after every history change (a token, not the data). */
export const HISTORY_CHANGED_KEY = 'historyChanged';
const MAX_HISTORY = 300;
/** Two scans of one card, on one page, this close in video time are one moment of the video. */
const SAME_MOMENT_S = 2;

/** The key of an entry's thumbnail. */
const thumbKey = (entryId: string) => `${THUMB_PREFIX}${entryId}`;

const asHistory = (value: unknown): HistoryEntry[] => (Array.isArray(value) ? (value as HistoryEntry[]) : []);

/** 0.9.2's copy in chrome.storage.local, if migrateLegacyStorage hasn't moved it yet. */
async function legacyHistory(): Promise<HistoryEntry[] | undefined> {
  const stored = (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY];
  return stored === undefined ? undefined : asHistory(stored);
}

/** Lets the side panel know (its chrome.storage.onChanged). Best effort: the change itself is made. */
async function announceChange(): Promise<void> {
  try {
    await chrome.storage.session.set({ [HISTORY_CHANGED_KEY]: crypto.randomUUID() });
  } catch {
    // no chrome.storage.session here: an open side panel shows the change at its next read
  }
}

export async function getHistory(): Promise<HistoryEntry[]> {
  const stored = await secureGet(HISTORY_KEY);
  if (stored !== undefined) return asHistory(stored);
  return (await legacyHistory()) ?? [];
}

/**
 * Changes the history in one transaction (two scans at once can't lose one): `change` gets the list and answers
 * the new one (if any), the entries whose pictures go, and a result. Before the store has a list, it starts
 * from 0.9.2's copy, if any.
 */
async function changeHistory<R>(
  change: (history: HistoryEntry[]) => { history?: HistoryEntry[]; dropped?: HistoryEntry[]; result: R },
): Promise<R> {
  const seed = (await secureGet(HISTORY_KEY)) === undefined ? await legacyHistory() : undefined;
  const out = await withSecureStore('readwrite', async (store) => {
    const stored = await request(store.get(HISTORY_KEY));
    const out = change(stored === undefined ? (seed ?? []) : asHistory(stored));
    if (out.history) store.put(out.history, HISTORY_KEY);
    for (const e of out.dropped ?? []) store.delete(thumbKey(e.id));
    return out;
  });
  if (out.history) await announceChange();
  return out.result;
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
  await changeHistory((history) => {
    const replaced = isRescan(entry, history[0]) ? history.slice(0, 1) : [];
    const all = [entry, ...history.slice(replaced.length)];
    return { history: all.slice(0, MAX_HISTORY), dropped: [...replaced, ...all.slice(MAX_HISTORY)], result: undefined };
  });
}

export async function updateEntry(id: string, patch: Partial<HistoryEntry>): Promise<HistoryEntry | undefined> {
  return changeHistory((history) => {
    let updated: HistoryEntry | undefined;
    const next = history.map((e) => {
      if (e.id !== id) return e;
      updated = { ...e, ...patch };
      return updated;
    });
    return { history: updated ? next : undefined, result: updated };
  });
}

/** Keeps a small picture (a JPEG data URL) of the scan behind entry `id`, if the entry is still there. */
export async function setThumb(id: string, dataUrl: string): Promise<void> {
  const kept = await withSecureStore('readwrite', async (store) => {
    if (!asHistory(await request(store.get(HISTORY_KEY))).some((e) => e.id === id)) return false; // cleared or dropped meanwhile
    store.put(dataUrl, thumbKey(id));
    return true;
  });
  if (kept) await announceChange();
}

export async function getThumb(id: string): Promise<string | undefined> {
  const thumb = (await secureGet(thumbKey(id))) ?? (await chrome.storage.local.get(thumbKey(id)))[thumbKey(id)];
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

/**
 * Used by the side panel's "Clear history" button (it imports this directly): the pictures go too, and so
 * does 0.9.2's copy in chrome.storage.local if it's still there (the move at start-up failed, or hasn't run).
 */
export async function clearHistory(): Promise<void> {
  await withSecureStore('readwrite', (store) => {
    store.put([], HISTORY_KEY);
    store.delete(prefixRange(THUMB_PREFIX));
  });
  const legacy = Object.keys((await chrome.storage.local.get(null)) ?? {}).filter((k) => k === HISTORY_KEY || k.startsWith(THUMB_PREFIX));
  if (legacy.length > 0) await chrome.storage.local.remove(legacy);
  await chrome.storage.session.remove(CURRENT_KEY);
  await announceChange();
}
