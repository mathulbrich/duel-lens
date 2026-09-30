// Downloads Konami's card renders of the artworks YGOPRODeck may lack (ALT-ART) into data/alt-artworks/, once, for
// tools/add-alt-artworks.ts. Build time only: the renders stay local (data/ is gitignored) and never ship; only their
// vectors do.
//
// Which cards: those whose Konami artworks (ygoresources' manifest, data/raw/ygoresources-artworks-manifest.json;
// Rush Duel prints aside) outnumber their YGOPRODeck images. Which artwork is missing is decided later by similarity,
// so every artwork in scope of such a card is fetched (tools/lib/alt-artworks.ts planAltArtworks):
//   default: the artworks printed in the TCG (the manifest's bestTCG);   --all: every artwork.
// The renders are Konami's clean Neuron renders (256x372), never the watermarked "SAMPLE" database copies. The English
// one first; the art is the same in every language, so when the English host fails (its DNS sometimes does) or has
// no render, the Japanese render of the SAME artwork.
//
// Polite: one request at a time, at most 1 per second (retries included), an identifying User-Agent, retries with
// backoff on 429/5xx; it stops after 5 failures in a row. Files already there (> 1 KB) are skipped, so a re-run
// resumes. data/alt-artworks/fetched.json records where each render came from, what was skipped and what failed.
//
// Usage: npx tsx tools/fetch-alt-artworks.ts [--all] [--limit N] [--dry-run]
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { CardRecord } from '../src/shared/types';
import { planAltArtworks, RENDER_FILE, type AltArtworkRef, type ArtworksManifest } from './lib/alt-artworks';
import { createRateLimiter, politeFetch } from './lib/http';

const root = path.resolve(import.meta.dirname, '..');
const CARDS = path.join(root, 'extension/data/cards.json');
const MANIFEST = path.join(root, 'data/raw/ygoresources-artworks-manifest.json');
const OUT_DIR = path.join(root, 'data/alt-artworks');
const RECORD = path.join(OUT_DIR, 'fetched.json');
const RATE = 1;
const MIN_BYTES = 1024;
const MAX_FAILURES_IN_A_ROW = 5;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const all = process.argv.includes('--all');
const dryRun = process.argv.includes('--dry-run');

const renderPath = (a: AltArtworkRef) => path.join(OUT_DIR, RENDER_FILE(a.konamiId, a.artwork));
const have = (file: string) => existsSync(file) && statSync(file).size > MIN_BYTES;
const hostOf = (url: string) => new URL(url).host;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** A failure to reach the host at all (DNS, connection), as opposed to an answer. */
const unreachable = (err: unknown) => !(err instanceof HttpError) && !(err instanceof BadImage);
class BadImage extends Error {}

async function getPng(url: string, limiter: () => Promise<void>): Promise<Buffer> {
  // Retries (429, 5xx, network errors) wait for the same 1-per-second limiter, so they never burst.
  const res = await politeFetch(url, { limiter, retries: 2, backoffMs: 5000, timeoutMs: 30_000 });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new HttpError(res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length <= MIN_BYTES) throw new BadImage(`too small (${buf.length} bytes)`);
  const meta = await sharp(buf)
    .metadata()
    .catch(() => null);
  if (!meta?.width || !meta.height) throw new BadImage(`not an image (${res.headers.get('content-type')})`);
  return buf;
}

async function main() {
  const { cards } = JSON.parse(await readFile(CARDS, 'utf8')) as { cards: CardRecord[] };
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as ArtworksManifest;
  const plan = planAltArtworks(cards, manifest, { all });
  let refs = plan.refs;
  const limit = Number(arg('--limit') ?? 0);
  if (limit > 0) refs = refs.slice(0, limit);
  const todo = refs.filter((a) => !have(renderPath(a)));
  console.log(
    `${plan.gapCards.length} cards have more Konami artworks than YGOPRODeck images; scope ${all ? 'every artwork' : 'artworks printed in the TCG'}: ` +
      `${refs.length} renders (${refs.length - todo.length} already here, ${todo.length} to fetch at most ${RATE}/s), ` +
      `${plan.skipped.length} with no clean render`,
  );
  if (dryRun) return;
  await mkdir(OUT_DIR, { recursive: true });

  const limiter = createRateLimiter(RATE);
  const record: { konamiId: number; artwork: number; cardId: number; file: string; url: string }[] = [];
  const failures: { konamiId: number; artwork: number; cardId: number; error: string }[] = [];
  const down = new Set<string>();
  let inARow = 0;
  const t0 = Date.now();
  for (const [n, a] of todo.entries()) {
    let saved: string | undefined;
    const errors: string[] = [];
    for (const url of a.urls) {
      if (down.has(hostOf(url))) continue;
      try {
        const buf = await getPng(url, limiter);
        const file = renderPath(a);
        await writeFile(`${file}.part`, buf);
        await rename(`${file}.part`, file);
        saved = url;
        break;
      } catch (err) {
        errors.push(`${hostOf(url)}: ${(err as Error).message}`);
        // A host that can't be reached (its DNS fails) is left alone for the rest of the run: the next render comes from
        // the other language's host (the same artwork).
        if (unreachable(err)) {
          down.add(hostOf(url));
          console.warn(`${hostOf(url)} unreachable (${(err as Error).message}): using the other language's render of the same artwork from now on`);
        }
      }
    }
    if (saved) {
      inARow = 0;
      record.push({ konamiId: a.konamiId, artwork: a.artwork, cardId: a.cardId, file: path.relative(root, renderPath(a)), url: saved });
    } else {
      inARow++;
      failures.push({ konamiId: a.konamiId, artwork: a.artwork, cardId: a.cardId, error: errors.join('; ') || 'every host unreachable' });
      console.warn(`failed ${a.name} artwork ${a.artwork} (Konami ${a.konamiId}): ${errors.join('; ')}`);
      if (inARow >= MAX_FAILURES_IN_A_ROW) {
        console.error(`${inARow} failures in a row: stopping (re-run to resume; files already fetched are kept)`);
        break;
      }
    }
    if ((n + 1) % 50 === 0) console.log(`${n + 1}/${todo.length} · ${((Date.now() - t0) / 1000).toFixed(0)} s · ${failures.length} failed`);
  }

  const previous = existsSync(RECORD) ? (JSON.parse(await readFile(RECORD, 'utf8')) as { renders?: typeof record }) : {};
  const renders = [...(previous.renders ?? []).filter((r) => !record.some((x) => x.file === r.file)), ...record].filter((r) =>
    have(path.join(root, r.file)),
  );
  await writeFile(
    RECORD,
    JSON.stringify({ fetchedAt: new Date().toISOString(), scope: all ? 'all' : 'tcg', renders, skipped: plan.skipped, failures }, null, 1),
  );
  const present = refs.filter((a) => have(renderPath(a))).length;
  console.log(
    `done: ${present}/${refs.length} renders in ${path.relative(root, OUT_DIR)} (${record.length} fetched now, ${failures.length} failed), ` +
      `${((Date.now() - t0) / 1000).toFixed(0)} s; record ${path.relative(root, RECORD)}`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
