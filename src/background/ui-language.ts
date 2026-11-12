// The service worker's interface language (Options, "Interface language"; shared/ui-language.ts): loaded at every
// worker start and again when the setting changes. Its own words (the icon's menu and title, its error messages)
// follow it, and the page's script gets the same words from it (live-check-state, ui-language), since that script
// can read neither the settings nor the extension's files.
import { setUiMessages, type UiWords } from '../shared/i18n';
import { loadUiWords } from '../shared/ui-language';

let words: UiWords | null = null;
let ready: Promise<void> = Promise.resolve();
let settled = true;
/** The latest load: an older one that finishes after it changes nothing (a quick German, then French). */
let generation = 0;

/** Speak `choice` from now on ('auto': the browser's language). Settles once the words are in, never rejects.
 *  `choice` may be a promise (the worker's start: the settings are still being read), so readiness starts at once. */
export function loadWorkerUiLanguage(choice: unknown, fetcher?: typeof fetch): Promise<void> {
  const mine = ++generation;
  settled = false;
  const load = Promise.resolve(choice)
    .catch(() => 'auto')
    .then((c) => loadUiWords(c, fetcher))
    .then((w) => {
      if (mine !== generation) return;
      words = w;
      setUiMessages(w);
    })
    .finally(() => {
      if (mine === generation) settled = true;
    });
  ready = load;
  return load;
}

/** Whether the latest load is in (the router answers at once then, keeping a click's gesture). */
export function workerUiSettled(): boolean {
  return settled;
}

/** Settles once the latest load is in, a load started meanwhile included. */
export async function workerUiReady(): Promise<void> {
  let seen: Promise<void>;
  do {
    seen = ready;
    await seen;
  } while (seen !== ready);
}

/** The words the page's script should speak, once the latest load is in: null for the browser's language. */
export async function workerUiWords(): Promise<UiWords | null> {
  await workerUiReady();
  return words;
}
