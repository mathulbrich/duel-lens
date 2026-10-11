// Card text languages ("Card text language" in Options, Settings.display.cardLanguage): the language pack
// downloaded on demand from YGOPRODeck (src/shared/card-languages.ts), stored in its own IndexedDB database,
// refreshed with the weekly English refresh, and laid over the English cards the background sends for display.
//
// - A pack is, per card id, only the name and text (desc, and the Pendulum card's two parts when given apart).
//   Matching stays on ids: the engine and the card store never see it.
// - One pack at a time: picking another language replaces it, English removes it.
// - Errors never touch what is shown: a failed download or a bad answer keeps the stored pack and the setting
//   (the setting changes only once a new pack is stored), and a card the pack lacks shows in English.
// - Only the router's display answers are translated (recognize, get-cards). The AI check reads the card store
//   itself and keeps working in English; so does matching an AI answer to a card, by English name.
import { cardLanguageUrl, type CardLanguageInfo } from '../shared/card-languages';
import type { CardLanguage, CardRecord } from '../shared/types';
import { remoteDbVersion } from './card-store';
import { getSettings, setSettings } from './settings';

const DB_NAME = 'duel-lens-card-text';
const DB_VERSION = 1;
const TEXT_STORE = 'text';
const META_STORE = 'meta';
const META_KEY = 'pack';

/** A language other than the bundled English: one that has a pack. */
export type PackLanguage = Exclude<CardLanguage, 'en'>;

/** One card's name and text in the pack's language. */
export interface CardText {
  id: number;
  name: string;
  desc: string;
  pendDesc?: string;
  monsterDesc?: string;
}

export interface PackMeta {
  lang: PackLanguage;
  /** How many cards the pack translates. */
  cards: number;
  /** Epoch ms of the download. */
  downloadedAt: number;
  /** YGOPRODeck's database version at the download (checkDBVer.php), when it could be read: the weekly refresh compares it. */
  dbVersion?: string;
}

/**
 * Fewer cards than this, and the answer isn't taken as a pack: YGOPRODeck translates over 9,000 cards in every
 * language it offers (10,887 to 11,769 on 2026-10-09), so a short list is a broken or changed answer, not a pack.
 */
export const MIN_PACK_CARDS = 5000;

/** Why a download failed: no connection (or the request was refused), or an answer that isn't a usable pack. */
export class PackError extends Error {
  constructor(
    readonly kind: 'offline' | 'bad-answer',
    message: string,
  ) {
    super(message);
    this.name = 'PackError';
  }
}

const text = (s: string) => s.replace(/\r\n?/g, '\n').trim();
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * The pack in YGOPRODeck's answer (`{ data: [{ id, name, desc, pend_desc?, monster_desc?, … }] }`): only the
 * name and text of each card. An entry without a usable id, name or text is left out (that card shows in English);
 * a repeated id keeps its first entry. Throws PackError('bad-answer') when there is no card list, or too short a one.
 */
export function parsePack(body: unknown): CardText[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new PackError('bad-answer', 'the answer has no card list');
  const seen = new Set<number>();
  const out: CardText[] = [];
  for (const raw of data as Record<string, unknown>[]) {
    const id = raw?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
    if (!isText(raw.name) || !isText(raw.desc)) continue;
    seen.add(id);
    const entry: CardText = { id, name: text(raw.name), desc: text(raw.desc) };
    if (isText(raw.pend_desc)) entry.pendDesc = text(raw.pend_desc);
    if (isText(raw.monster_desc)) entry.monsterDesc = text(raw.monster_desc);
    out.push(entry);
  }
  if (out.length < MIN_PACK_CARDS) throw new PackError('bad-answer', `only ${out.length} cards in the answer`);
  return out;
}

export interface DownloadOptions {
  fetchFn?: typeof fetch;
  /** The bytes of JSON received so far (after decompression), as they come. */
  onProgress?: (bytes: number) => void;
}

/** Downloads and parses `lang`'s pack. Throws PackError: 'offline' when the request can't be made, else 'bad-answer'. */
export async function downloadPack(lang: PackLanguage, { fetchFn = fetch, onProgress }: DownloadOptions = {}): Promise<CardText[]> {
  let res: Response;
  try {
    res = await fetchFn(cardLanguageUrl(lang));
  } catch (err) {
    throw new PackError('offline', err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) throw new PackError('bad-answer', `HTTP ${res.status}`);
  let body: string;
  try {
    body = await readText(res, onProgress);
  } catch (err) {
    // The connection dropped mid-download.
    throw new PackError('offline', err instanceof Error ? err.message : String(err));
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new PackError('bad-answer', 'the answer is not JSON');
  }
  return parsePack(json);
}

/** The answer's text, reporting progress as it arrives when the body can be streamed. */
async function readText(res: Response, onProgress?: (bytes: number) => void): Promise<string> {
  const reader = onProgress ? res.body?.getReader() : undefined;
  if (!reader) return res.text();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    parts.push(decoder.decode(value, { stream: true }));
    onProgress?.(bytes);
  }
  parts.push(decoder.decode());
  return parts.join('');
}

function requestPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function openTextDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TEXT_STORE)) db.createObjectStore(TEXT_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Stores `texts` as the pack, replacing any other, in one transaction: if it fails, the previous pack stays whole. */
export async function installPack(lang: PackLanguage, texts: CardText[], dbVersion: string | undefined, now = Date.now()): Promise<PackMeta> {
  const meta: PackMeta = { lang, cards: texts.length, downloadedAt: now };
  if (dbVersion) meta.dbVersion = dbVersion;
  const db = await openTextDb();
  try {
    const tx = db.transaction([TEXT_STORE, META_STORE], 'readwrite');
    const store = tx.objectStore(TEXT_STORE);
    store.clear();
    for (const t of texts) store.put(t);
    tx.objectStore(META_STORE).put(meta, META_KEY);
    await txDone(tx);
  } finally {
    db.close();
  }
  return meta;
}

/** The stored pack's description, or undefined when there is none. */
export async function getPackMeta(): Promise<PackMeta | undefined> {
  const db = await openTextDb();
  try {
    return await requestPromise<PackMeta | undefined>(db.transaction(META_STORE, 'readonly').objectStore(META_STORE).get(META_KEY));
  } finally {
    db.close();
  }
}

/** Removes the stored pack (English needs none). */
export async function clearPack(): Promise<void> {
  const db = await openTextDb();
  try {
    const tx = db.transaction([TEXT_STORE, META_STORE], 'readwrite');
    tx.objectStore(TEXT_STORE).clear();
    tx.objectStore(META_STORE).delete(META_KEY);
    await txDone(tx);
  } finally {
    db.close();
  }
}

/** The stored pack's text for `ids`, when the stored pack is `lang`'s; else nothing (those cards show in English). */
export async function getTexts(lang: PackLanguage, ids: number[]): Promise<Map<number, CardText>> {
  const out = new Map<number, CardText>();
  if (!ids.length) return out;
  const db = await openTextDb();
  try {
    const tx = db.transaction([TEXT_STORE, META_STORE], 'readonly');
    const meta = await requestPromise<PackMeta | undefined>(tx.objectStore(META_STORE).get(META_KEY));
    if (meta?.lang !== lang) return out;
    const store = tx.objectStore(TEXT_STORE);
    await Promise.all(
      ids.map(async (id) => {
        const t = await requestPromise<CardText | undefined>(store.get(id));
        if (t) out.set(id, t);
      }),
    );
    return out;
  } finally {
    db.close();
  }
}

/**
 * `card` with its name and text in `lang` from `t`, and `translated` set (the English name for the subtitle); `card`
 * itself when the pack has no text for it (the per-card fallback to English). A Pendulum card the pack gives no
 * separate parts for shows its translated `desc`, which holds both, rather than English parts.
 */
export function localizeCard(card: CardRecord, t: CardText | undefined, lang: PackLanguage): CardRecord {
  if (!t) return card;
  const { pendDesc: _p, monsterDesc: _m, translated: _t, ...rest } = card;
  const out: CardRecord = { ...rest, name: t.name, desc: t.desc, translated: { lang, nameEn: card.name } };
  if (t.pendDesc || t.monsterDesc) {
    if (t.pendDesc) out.pendDesc = t.pendDesc;
    if (t.monsterDesc) out.monsterDesc = t.monsterDesc;
  }
  return out;
}

/**
 * `cards` in `lang` where the stored pack has them (each other card stays English); `cards` itself for English.
 * A card is found by its id, else by one of its artwork ids: a language list can name a card by another artwork
 * than the English list does (Dark Magician is 46986414 in YGOPRODeck's language lists and 46986420 in the
 * English one, whose artworks include 46986414; 14 cards on 2026-10-09, each matching one record only).
 */
export async function localizeCards(cards: Record<number, CardRecord>, lang: CardLanguage): Promise<Record<number, CardRecord>> {
  if (lang === 'en') return cards;
  const records = Object.values(cards);
  const texts = await getTexts(lang, [...new Set(records.flatMap((c) => [c.id, ...c.imageIds]))]);
  if (!texts.size) return cards;
  const out: Record<number, CardRecord> = {};
  for (const card of records) {
    const t = texts.get(card.id) ?? card.imageIds.map((id) => texts.get(id)).find((x) => x !== undefined);
    out[card.id] = localizeCard(card, t, lang);
  }
  return out;
}

/** What setCardLanguage is doing, for the Options page's progress line. */
export type LanguageProgress = { stage: 'downloading'; bytes: number } | { stage: 'saving' };

export interface SetLanguageDeps {
  fetchFn?: typeof fetch;
  onProgress?: (p: LanguageProgress) => void;
}

/**
 * The Options page's "Card text language": English removes the pack; another language downloads its pack (unless
 * the stored one is already that language's), stores it, and only then saves the setting. Throws PackError (or a
 * storage error) with nothing changed: the setting and the stored pack stay as they were. Returns the pack stored.
 */
export async function setCardLanguage(lang: CardLanguageInfo['code'], { fetchFn = fetch, onProgress }: SetLanguageDeps = {}): Promise<PackMeta | undefined> {
  if (lang === 'en') {
    await setSettings({ display: { cardLanguage: 'en' } });
    await clearPack().catch((err) => console.warn('Duel Lens: could not remove the card text pack', err));
    return undefined;
  }
  let meta = await getPackMeta().catch(() => undefined);
  if (meta?.lang !== lang) meta = await downloadAndInstall(lang, fetchFn, onProgress);
  await setSettings({ display: { cardLanguage: lang } });
  return meta;
}

async function downloadAndInstall(lang: PackLanguage, fetchFn: typeof fetch, onProgress?: (p: LanguageProgress) => void): Promise<PackMeta> {
  // The version first: a pack is never older than the version it records (a change mid-download is caught next week).
  const dbVersion = await remoteDbVersion(fetchFn).catch(() => undefined);
  const texts = await downloadPack(lang, { fetchFn, onProgress: onProgress && ((bytes) => onProgress({ stage: 'downloading', bytes })) });
  onProgress?.({ stage: 'saving' });
  return installPack(lang, texts, dbVersion);
}

/**
 * The weekly refresh (background index.ts, after the English one): with English chosen, removes any pack left
 * over; else downloads the chosen language's pack again only when YGOPRODeck's database changed since it was
 * stored (or it is missing). At most one download a week. Never throws; a failure keeps the stored pack.
 */
export async function refreshCardText(fetchFn: typeof fetch = fetch): Promise<'english' | 'unchanged' | 'updated' | 'failed'> {
  try {
    const lang = (await getSettings()).display.cardLanguage;
    if (lang === 'en') {
      if (await getPackMeta()) await clearPack();
      return 'english';
    }
    const meta = await getPackMeta();
    const remote = await remoteDbVersion(fetchFn).catch(() => undefined);
    if (meta && meta.lang === lang) {
      if (!remote) return 'failed';
      if (meta.dbVersion === remote) return 'unchanged';
    }
    const texts = await downloadPack(lang, { fetchFn });
    await installPack(lang, texts, remote);
    return 'updated';
  } catch (err) {
    console.warn('Duel Lens: the card text refresh failed; the stored pack stays', err);
    return 'failed';
  }
}
