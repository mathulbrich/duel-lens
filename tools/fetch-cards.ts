// Card data snapshot: YGOPRODeck cardinfo.php?misc=yes → data/raw/cardinfo.json (raw, reused
// while the database version is unchanged) → extension/data/cards.json (trimmed, bundled), with the
// Genesys points of cardinfo.php?format=genesys&misc=yes merged in (the list is kept, compact, in
// data/raw/genesys.json).
//
// Usage: npx tsx tools/fetch-cards.ts [--offline] [--merge-genesys]
//   --offline        skip the network and use data/raw/cardinfo.json, else data/raw/cardinfo.nomisc.json,
//                    and data/raw/genesys.json
//   --merge-genesys  only merge the Genesys points into the existing extension/data/cards.json. Its cards,
//                    ids, dbVersion and layout stay as they are, in step with the committed artwork index
//                    (extension/data/index-*.meta.json), which a new card list would need rebuilt.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mergeGenesysPoints, trimCard, type ApiCard, type GenesysApiCard } from '../src/shared/cards';
import type { CardRecord } from '../src/shared/types';
import { createRateLimiter, politeFetch } from './lib/http';

const API = 'https://db.ygoprodeck.com/api/v7';
const root = path.resolve(import.meta.dirname, '..');
const RAW = path.join(root, 'data/raw/cardinfo.json');
const FALLBACK = path.join(root, 'data/raw/cardinfo.nomisc.json');
const GENESYS_RAW = path.join(root, 'data/raw/genesys.json');
const OUT = path.join(root, 'extension/data/cards.json');

/** data/raw/cardinfo.json: the API response plus the database version it came from. */
interface RawSnapshot {
  dbVersion: string;
  fetchedAt: string;
  data: ApiCard[];
}

/** data/raw/genesys.json: the Genesys list, cut down to what the merge reads (1 MB instead of 25). */
interface GenesysSnapshot {
  fetchedAt: string;
  data: GenesysApiCard[];
}

/** extension/data/cards.json (BundledCards in src/background/card-store.ts). */
interface CardsFile {
  dbVersion: string;
  updatedAt: string;
  cards: CardRecord[];
}

const limit = createRateLimiter(8);

async function getJson<T>(url: string): Promise<T> {
  const res = await politeFetch(url, { limiter: limit, timeoutMs: 300_000 });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

function checkCards(data: unknown, from: string): ApiCard[] {
  if (!Array.isArray(data) || data.length < 1000) throw new Error(`${from}: expected a card list, got ${typeof data}`);
  return data as ApiCard[];
}

/** A Genesys list in which no card has points has changed shape: merging it would wipe every card's points. */
function checkGenesys(data: unknown, from: string): GenesysApiCard[] {
  const cards = checkCards(data, from);
  if (!cards.some((c) => (c.misc_info?.[0]?.genesys_points ?? 0) > 0)) throw new Error(`${from}: no card has Genesys points`);
  return cards;
}

async function readRaw(): Promise<RawSnapshot | undefined> {
  if (!existsSync(RAW)) return undefined;
  const raw = JSON.parse(await readFile(RAW, 'utf8')) as RawSnapshot;
  checkCards(raw.data, RAW);
  return raw;
}

async function online(): Promise<RawSnapshot> {
  const [ver] = await getJson<{ database_version: string; last_update: string }[]>(`${API}/checkDBVer.php`);
  const dbVersion = String(ver?.database_version ?? '');
  if (!dbVersion) throw new Error('checkDBVer.php returned no database_version');
  const cached = await readRaw().catch(() => undefined);
  if (cached?.dbVersion === dbVersion) {
    console.log(`database ${dbVersion}: reusing ${path.relative(root, RAW)}`);
    return cached;
  }
  console.log(`database ${dbVersion}: downloading cardinfo.php?misc=yes …`);
  const body = await getJson<{ data: unknown }>(`${API}/cardinfo.php?misc=yes`);
  const snap: RawSnapshot = { dbVersion, fetchedAt: new Date().toISOString(), data: checkCards(body.data, 'cardinfo.php') };
  await mkdir(path.dirname(RAW), { recursive: true });
  await writeFile(RAW, JSON.stringify(snap));
  return snap;
}

async function offline(): Promise<RawSnapshot> {
  const cached = await readRaw();
  if (cached) {
    console.log(`offline: using ${path.relative(root, RAW)} (database ${cached.dbVersion})`);
    return cached;
  }
  const body = JSON.parse(await readFile(FALLBACK, 'utf8')) as { data: unknown };
  console.log(`offline: using ${path.relative(root, FALLBACK)} (no misc info, so no konamiId)`);
  return { dbVersion: 'unknown', fetchedAt: new Date().toISOString(), data: checkCards(body.data, FALLBACK) };
}

/** The Genesys list: downloaded (and kept), or offline, or if the download fails, the one kept last. */
async function genesysList(useNetwork: boolean): Promise<GenesysSnapshot> {
  if (useNetwork) {
    try {
      console.log('downloading cardinfo.php?format=genesys&misc=yes …');
      const body = await getJson<{ data: unknown }>(`${API}/cardinfo.php?format=genesys&misc=yes`);
      const data = checkGenesys(body.data, 'cardinfo.php?format=genesys').map(({ id, name, misc_info }) => ({
        id,
        name,
        misc_info: [{ genesys_points: misc_info?.[0]?.genesys_points }],
      }));
      const snap: GenesysSnapshot = { fetchedAt: new Date().toISOString(), data };
      await mkdir(path.dirname(GENESYS_RAW), { recursive: true });
      await writeFile(GENESYS_RAW, JSON.stringify(snap));
      return snap;
    } catch (err) {
      console.warn(`Genesys list: download failed (${(err as Error).message}); falling back to local data`);
    }
  }
  const snap = JSON.parse(await readFile(GENESYS_RAW, 'utf8')) as GenesysSnapshot;
  checkGenesys(snap.data, GENESYS_RAW);
  console.log(`using ${path.relative(root, GENESYS_RAW)} (fetched ${snap.fetchedAt})`);
  return snap;
}

/** `cards` with the Genesys list's points, reporting how many have points and which pointed cards matched none. */
function withGenesysPoints(cards: CardRecord[], genesys: GenesysSnapshot): CardRecord[] {
  const { cards: merged, withPoints, unmatched } = mergeGenesysPoints(cards, genesys.data);
  console.log(
    `Genesys points (list of ${genesys.fetchedAt}): ${withPoints} cards have points; ` +
      `${unmatched.length} Genesys cards with points match no card${unmatched.length ? ':' : ''}`,
  );
  for (const u of unmatched) console.log(`  ${u.id} ${u.name}: ${u.points} points`);
  return merged;
}

/** `value` as JSON laid out like `text`: minified, or indented the same way, with its final newline if it had one. */
function sameLayout(text: string, value: unknown): string {
  const indent = /^\{\r?\n([ \t]+)/.exec(text)?.[1];
  return JSON.stringify(value, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

/** --merge-genesys: the points into the existing cards.json, which otherwise stays as it is. */
async function mergeGenesysOnly(useNetwork: boolean) {
  const text = await readFile(OUT, 'utf8');
  const file = JSON.parse(text) as CardsFile;
  const cards = withGenesysPoints(file.cards, await genesysList(useNetwork));
  const json = sameLayout(text, { ...file, cards });
  await writeFile(OUT, json);
  console.log(
    `wrote ${path.relative(root, OUT)}: the same ${cards.length} cards (database ${file.dbVersion}, of ${file.updatedAt}), ` +
      `${(Buffer.byteLength(json) / 1e6).toFixed(2)} MB`,
  );
}

async function main() {
  const useNetwork = !process.argv.includes('--offline');
  if (process.argv.includes('--merge-genesys')) return mergeGenesysOnly(useNetwork);
  let snap: RawSnapshot;
  if (!useNetwork) snap = await offline();
  else {
    try {
      snap = await online();
    } catch (err) {
      console.warn(`network failed (${(err as Error).message}); falling back to local data`);
      snap = await offline();
    }
  }
  let cards = snap.data.map(trimCard).sort((a, b) => a.id - b.id);
  try {
    cards = withGenesysPoints(cards, await genesysList(useNetwork));
  } catch (err) {
    console.warn(`WARNING: no Genesys list (${(err as Error).message}), so no card has Genesys points`);
  }
  const json = JSON.stringify({ dbVersion: snap.dbVersion, updatedAt: snap.fetchedAt, cards });
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, json);
  const withKonami = cards.filter((c) => c.konamiId !== undefined).length;
  console.log(
    `wrote ${path.relative(root, OUT)}: ${cards.length} cards (${withKonami} with konamiId), ` +
      `${(Buffer.byteLength(json) / 1e6).toFixed(2)} MB, database ${snap.dbVersion}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
