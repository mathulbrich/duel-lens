// Adds the card artworks YGOPRODeck lacks to the committed artwork indexes (ALT-ART, the user's decision of 2026-09-30),
// from Konami's card renders that tools/fetch-alt-artworks.ts downloaded into data/alt-artworks/. Only vectors ship.
//
// For every render in scope (tools/lib/alt-artworks.ts planAltArtworks: the artworks printed in the TCG, or --all):
// 1. Cut the art box as tools/fetch-artworks.ts cuts a full card image for data/artworks/derived.json (artBoxFor the
//    card's frame, JPEG q92), and embed it as tools/build-index.ts embeds an artwork. A render that isn't a whole card
//    (not the card's aspect, or too small) can't be cut cleanly: it is skipped and listed.
// 2. Decide by similarity, never by artwork number (YGOPRODeck's image order needn't match Konami's), with the
//    --decide-with model's vectors against its index (tools/lib/alt-artworks.ts coveredArtworks): a Konami artwork is
//    already covered when its cosine to one of its card's YGOPRODeck images is at least --clearly (it IS that image),
//    or when it is the one Konami artwork closest to a YGOPRODeck image, at least --closest (the same image, scanned or
//    framed differently). A YGOPRODeck image is one artwork: the card's other Konami versions of it (a TCG edit, a
//    recolour) are prints YGOPRODeck lacks. The rest are missing, except
//      - the card back (a placeholder, as build-index.ts leaves out);
//      - a duplicate: the missing artworks of one card that are --clearly close to each other, directly or through
//        another (tools/lib/alt-artworks.ts similarityGroups), keep one per group, the lowest artwork number;
//      - a shared artwork: --clearly close to ANOTHER card's YGOPRODeck image (it would only make that card ambiguous).
//    Missing artworks of DIFFERENT cards that are --clearly close to each other (look-alikes) are kept only when
//    LOOKALIKES_KEPT below lists their cards: the run stops on any other group. Keeping just one of a group would make
//    the other cards' prints read as that card, confidently.
// 3. For each --models index: drop the extra artworks a previous run appended, append the missing ones with that model's
//    vectors (synthetic imageIds, src/shared/alt-artwork.ts; provenance source 'konami', konamiId, artwork), and write
//    it. Every existing vector and meta entry stays byte-identical, builtAt and dbVersion too: the hashes printed prove
//    it. Re-running replaces the extras (refresh: fetch-alt-artworks.ts, then this); with nothing new, it changes no
//    byte (altArtworks.addedAt is kept). It prints the extras added and removed against each input index.
// It stops, writing nothing (exit 1), when an artwork in scope has no usable render (never fetched, or not a whole
// card), or when an input index has extras of gap cards outside this run's scope: --allow-missing writes anyway.
//
// Usage: npx tsx tools/add-alt-artworks.ts [--models a,b] [--decide-with M] [--clearly C] [--closest C] [--all]
//          [--dry-run] [--allow-missing] [--in-dir DIR] [--out-dir DIR] [--report FILE]
//   --models      the indexes to extend (default: the default model's)
//   --decide-with whose vectors decide what is covered (default: the default model)
//   --clearly, --closest   the two cosines of the covered rule (default COVER below)
//   --dry-run     decide and report, write no index
//   --allow-missing  write the indexes even without every render (the missing artworks lose their extras)
//   --in-dir      read the indexes from somewhere other than extension/data (e.g. build-index.ts's --out-dir)
//   --out-dir     write them somewhere other than where they were read
//   --report      where the per-artwork decisions go (default data/alt-artworks/report.json)
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { cardBackVector, isPlaceholderArt } from '../src/offscreen/placeholder-art';
import { isAltArtwork } from '../src/shared/alt-artwork';
import { decodeIndex, type IndexEntry, type IndexMeta, type LoadedIndex } from '../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel } from '../src/shared/models';
import { CARD_ASPECT } from '../src/shared/card-layout';
import type { CardRecord } from '../src/shared/types';
import {
  appendAltArtworks,
  coveredArtworks,
  extrasDiff,
  matchOwn,
  planAltArtworks,
  RENDER_FILE,
  similarityGroups,
  stableAddedAt,
  unacceptedGroups,
  unreproducible,
  withoutAltArtworks,
  type AltArtworkRef,
  type ArtworksManifest,
  type CoverRule,
  type ExtraArtwork,
  type IndexFiles,
} from './lib/alt-artworks';
import { artBoxFor, artBoxPixels } from './lib/artworks';
import { loadRGBA } from './lib/image';
import { createNodeEmbedder } from './lib/ort-node';

/**
 * The covered rule's cosines (dinov2-small-duel-v3b), calibrated on 2026-09-30 over the 691 TCG renders of the 343 gap
 * cards, every pair from 0.60 up checked by eye (.superpowers/sdd/2026-09-28-duel-lens-v1/altart-report.md,
 * "Calibration"): Konami's render cut against YGOPRODeck's crop of the same image reads 0.95-0.998 (393 of 691 at 0.96
 * or more); the card's other Konami versions of an image (TCG edits, recolours) read up to 0.943 against it, so no
 * single threshold separates them. The closest artwork to an image, when not clearly it, is it from 0.865 up (another
 * scan; a Pendulum render, whose blank Pendulum box costs it 0.05-0.2); under 0.85 it is mostly a print YGOPRODeck lacks.
 */
const COVER: CoverRule = { clearly: 0.95, closest: 0.85 };

/**
 * Look-alike extras of DIFFERENT cards (cosine >= COVER.clearly to each other), kept on purpose; each entry lists card
 * ids. A group not covered here stops the run (altart-review.md M3).
 * - Spirit Message "I", "N", "A", "L" and Destiny Board: their TCG prints spell "FINAL", one letter each over one
 *   illustration (YGOPRODeck has the OCG prints, which spell "DEATH"). The five extras read 0.975-0.992 to each other.
 *   All five kept: the engine reads each print "Not sure" with the right card first (27 of 30 readings) and never
 *   confidently wrong. With only one kept, 24 of 30 readings are confidently wrong (the others read as that one); with
 *   none, all 30 are wrong lists, as before (altart-report.md, "Fix round").
 */
const LOOKALIKES_KEPT: number[][] = [[31893528, 67287533, 94772232, 30170981, 94212438]];

const root = path.resolve(import.meta.dirname, '..');
const CARDS = path.join(root, 'extension/data/cards.json');
const MANIFEST = path.join(root, 'data/raw/ygoresources-artworks-manifest.json');
const RENDERS = path.join(root, 'data/alt-artworks');
const CUTS = path.join(RENDERS, 'cut');

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const r3 = (x: number) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

async function readIndex(dir: string, modelId: string): Promise<IndexFiles & { metaText: string }> {
  const base = path.join(dir, `index-${modelId}`);
  const [metaText, bin] = await Promise.all([readFile(`${base}.meta.json`, 'utf8'), readFile(`${base}.bin`)]);
  return { metaText, meta: JSON.parse(metaText) as IndexMeta, bin: new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength) };
}
const loaded = ({ bin, meta }: IndexFiles): LoadedIndex => decodeIndex(bin.slice().buffer, meta);

interface Cut {
  ref: AltArtworkRef;
  file: string;
}

/** The art box of a render, cut as fetch-artworks.ts cuts a full card image; `skip` when the render isn't a whole card. */
async function cutArt(ref: AltArtworkRef, file: string): Promise<{ jpeg: Buffer } | { skip: string }> {
  const { width = 0, height = 0 } = await sharp(file).metadata();
  if (width < 200 || Math.abs(width / height - CARD_ASPECT) > 0.01) return { skip: `not a whole card render (${width}x${height})` };
  const box = artBoxPixels(width, height, artBoxFor(ref.frameType));
  const jpeg = await sharp(file).flatten({ background: '#000' }).extract(box).jpeg({ quality: 92 }).toBuffer();
  return { jpeg };
}

type Decision = 'added' | 'covered' | 'duplicate' | 'shared' | 'card-back';

const VIA = 'ygoresources.com (a mirror of Konami card renders), build time only';

async function main() {
  const all = process.argv.includes('--all');
  const dryRun = process.argv.includes('--dry-run');
  const allowMissing = process.argv.includes('--allow-missing');
  const rule: CoverRule = { clearly: Number(arg('--clearly') ?? COVER.clearly), closest: Number(arg('--closest') ?? COVER.closest) };
  if (!(rule.closest > 0 && rule.closest <= rule.clearly && rule.clearly < 1)) throw new Error(`need 0 < --closest <= --clearly < 1, got ${JSON.stringify(rule)}`);
  const deciderId = getModel(arg('--decide-with') ?? DEFAULT_MODEL_ID).id;
  const modelIds = [...new Set((arg('--models') ?? DEFAULT_MODEL_ID).split(',').filter(Boolean).map((m) => getModel(m).id))];
  const inDir = path.resolve(arg('--in-dir') ?? path.join(root, 'extension/data'));
  const outDir = path.resolve(arg('--out-dir') ?? inDir);
  const reportFile = path.resolve(arg('--report') ?? path.join(RENDERS, 'report.json'));

  const { cards } = JSON.parse(await readFile(CARDS, 'utf8')) as { cards: CardRecord[] };
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as ArtworksManifest;
  const plan = planAltArtworks(cards, manifest, { all });

  // Every index involved, as it is, and without a previous run's extras.
  const needed = [...new Set([deciderId, ...modelIds])];
  const inputs = new Map<string, IndexFiles & { metaText: string }>();
  for (const id of needed) {
    const file = path.join(inDir, `index-${id}.meta.json`);
    if (!existsSync(file)) {
      throw new Error(`${path.relative(root, file)} not found: every --models index and the decider's (${deciderId}) must be in ${path.relative(root, inDir) || '.'} (or pass --decide-with)`);
    }
    inputs.set(id, await readIndex(inDir, id));
  }
  const inputExtras = [...new Map(modelIds.flatMap((id) => inputs.get(id)!.meta.entries.filter((e) => isAltArtwork(e.imageId))).map((e) => [e.imageId, e])).values()];

  const unusable: { ref: AltArtworkRef; reason: string }[] = [];
  const cuts: Cut[] = [];
  const images = [];
  await mkdir(CUTS, { recursive: true });
  for (const ref of plan.refs) {
    const file = path.join(RENDERS, RENDER_FILE(ref.konamiId, ref.artwork));
    if (!existsSync(file)) {
      unusable.push({ ref, reason: `no render ${path.relative(root, file)} (run tools/fetch-alt-artworks.ts${all ? ' --all' : ''})` });
      continue;
    }
    const cut = await cutArt(ref, file);
    if ('skip' in cut) {
      unusable.push({ ref, reason: cut.skip });
      continue;
    }
    const cutFile = path.join(CUTS, `${ref.konamiId}_${ref.artwork}.jpg`);
    await writeFile(cutFile, cut.jpeg);
    cuts.push({ ref, file: cutFile });
    images.push(await loadRGBA(cut.jpeg));
  }
  console.log(
    `${plan.gapCards.length} gap cards; ${plan.refs.length} artworks in scope (${all ? 'all' : 'TCG'}): ${cuts.length} cut, ` +
      `${unusable.length} without a usable render, ${plan.skipped.length} without a clean render; the input indexes have ${inputExtras.length} extras`,
  );
  // A run that can't reproduce every extra must not quietly write fewer (M1).
  const problems = unreproducible(plan, unusable, inputExtras);
  if (problems.length > 0) {
    const list = problems.slice(0, 20).map((p) => `  - ${p}`).join('\n') + (problems.length > 20 ? `\n  … and ${problems.length - 20} more` : '');
    if (!allowMissing) {
      console.error(
        `${problems.length} artwork(s) can't be reproduced by this run:\n${list}\n` +
          'Nothing written. Fetch the missing renders (tools/fetch-alt-artworks.ts, with --all if the index was made with it), ' +
          'or pass --allow-missing to write the indexes without these extras.',
      );
      process.exitCode = 1;
      return;
    }
    console.warn(`--allow-missing: writing without ${problems.length} artwork(s):\n${list}`);
  }

  // Every model's vectors of every cut.
  const vectors = new Map<string, Float32Array[]>();
  const bases = new Map<string, IndexFiles>();
  for (const id of needed) {
    const embedder = await createNodeEmbedder(getModel(id));
    const out: Float32Array[] = [];
    for (let i = 0; i < images.length; i += 32) out.push(...(await embedder.embed(images.slice(i, i + 32))));
    await embedder.release();
    vectors.set(id, out);
    bases.set(id, withoutAltArtworks(inputs.get(id)!));
    console.log(`${id}: embedded ${out.length} cuts; its index has ${inputs.get(id)!.meta.count} entries, ${inputs.get(id)!.meta.count - bases.get(id)!.meta.count} of them extras`);
  }

  // The decision, with the decider's vectors against its own index (every model's scores are reported).
  const indexes = new Map(needed.map((id) => [id, loaded(bases.get(id)!)]));
  const back = cardBackVector(indexes.get(deciderId)!);
  const rows = cuts.map(({ ref, file }, i) => {
    const q = vectors.get(deciderId)![i];
    const scores = Object.fromEntries(needed.map((id) => [id, matchOwn(vectors.get(id)![i], indexes.get(id)!, ref.cardId)]));
    return { ref, file, i, q, scores, decision: 'covered' as Decision, note: '' };
  });
  type Row = (typeof rows)[number];
  // Covered, card by card: the decider's cosine of each of the card's Konami artworks to each of its YGOPRODeck images.
  const byCard = new Map<number, Row[]>();
  for (const row of rows) byCard.set(row.ref.cardId, [...(byCard.get(row.ref.cardId) ?? []), row]);
  for (const cardRows of byCard.values()) {
    const covered = coveredArtworks(cardRows.map((r) => r.scores[deciderId].ownAll), rule);
    cardRows.forEach((r, k) => {
      if (!covered[k]) r.decision = 'added';
      else r.note = `YGOPRODeck image ${r.scores[deciderId].ownImageId}`;
    });
  }
  for (const row of rows) if (row.decision === 'added' && back && isPlaceholderArt(row.q, back)) row.decision = 'card-back';
  // One per group of near-duplicates within a card: the lowest artwork number.
  for (const cardRows of byCard.values()) {
    const missing = cardRows.filter((r) => r.decision === 'added').sort((a, b) => a.ref.artwork - b.ref.artwork);
    for (const group of similarityGroups(missing.map((r) => r.q), rule.clearly)) {
      for (const k of group.slice(1)) {
        missing[k].decision = 'duplicate';
        missing[k].note = `of artwork ${missing[group[0]].ref.artwork}`;
      }
    }
  }
  for (const row of rows) {
    const s = row.scores[deciderId];
    if (row.decision === 'added' && s.other >= rule.clearly) {
      row.decision = 'shared';
      row.note = `with card ${s.otherCardId}`;
    }
  }
  // In plan order (cards.json's, then artwork number): the order the extras are appended in.
  const added = rows.filter((r) => r.decision === 'added');
  // Look-alike extras of different cards (M3): kept only by an explicit decision (LOOKALIKES_KEPT).
  const lookalikes = similarityGroups(added.map((r) => r.q), rule.clearly, (i, j) => added[i].ref.cardId !== added[j].ref.cardId)
    .filter((g) => g.length > 1)
    .map((g) => {
      const members = g.map((k) => added[k]);
      const pairs = members.flatMap((a, x) => members.slice(x + 1).map((b) => a.q.reduce((acc, v, d) => acc + v * b.q[d], 0)));
      return { cardIds: [...new Set(members.map((r) => r.ref.cardId))], members, low: Math.min(...pairs), high: Math.max(...pairs) };
    });
  const unaccepted = unacceptedGroups(lookalikes.map((g) => g.cardIds), LOOKALIKES_KEPT);
  const describe = (g: (typeof lookalikes)[number]) =>
    `${g.members.map((r) => `${r.ref.name} #${r.ref.artwork}`).join(', ')} (cosine ${g.low.toFixed(3)}-${g.high.toFixed(3)} to each other)`;
  for (const g of lookalikes) if (!unaccepted.includes(g.cardIds)) console.log(`look-alike extras kept on purpose (LOOKALIKES_KEPT): ${describe(g)}`);
  const count = (d: Decision) => rows.filter((r) => r.decision === d).length;
  console.log(
    `decided with ${deciderId} (clearly ${rule.clearly}, closest ${rule.closest}): ${count('covered')} covered, ${added.length} to add, ` +
      `${count('duplicate')} duplicates, ${count('shared')} shared with another card, ${count('card-back')} card back, ` +
      `${lookalikes.length} look-alike group(s) across cards`,
  );

  const report = {
    at: new Date().toISOString(),
    scope: all ? 'all' : 'tcg',
    rule,
    decidedBy: deciderId,
    gapCards: plan.gapCards.length,
    rows: rows.map((r) => ({
      cardId: r.ref.cardId,
      name: r.ref.name,
      frameType: r.ref.frameType,
      konamiId: r.ref.konamiId,
      artwork: r.ref.artwork,
      imageId: r.ref.imageId,
      tcg: r.ref.tcg,
      decision: r.decision,
      note: r.note,
      scores: Object.fromEntries(
        Object.entries(r.scores).map(([id, s]) => [
          id,
          { own: r3(s.own), ownImageId: s.ownImageId, ownAll: Object.fromEntries([...s.ownAll].map(([k, v]) => [k, r3(v)])), other: r3(s.other), otherCardId: s.otherCardId },
        ]),
      ),
    })),
    lookalikes: lookalikes.map((g) => ({
      cards: g.members.map((r) => ({ cardId: r.ref.cardId, name: r.ref.name, artwork: r.ref.artwork })),
      cosine: [r3(g.low), r3(g.high)],
      kept: !unaccepted.includes(g.cardIds),
    })),
    unusable: unusable.map(({ ref, reason }) => ({ cardId: ref.cardId, name: ref.name, konamiId: ref.konamiId, artwork: ref.artwork, reason })),
    noCleanRender: plan.skipped,
    indexes: {} as Record<string, unknown>,
  };
  await mkdir(path.dirname(reportFile), { recursive: true });
  if (unaccepted.length > 0) {
    await writeFile(reportFile, JSON.stringify(report, null, 1));
    console.error(
      `${unaccepted.length} group(s) of look-alike extras of different cards:\n` +
        lookalikes.filter((g) => unaccepted.includes(g.cardIds)).map((g) => `  - ${describe(g)}`).join('\n') +
        '\nNothing written. Keeping only one of a group makes the others read as it, confidently. Check them (their prints ' +
        "should read \"Not sure\" with the right card first), then list the group's card ids in LOOKALIKES_KEPT, with why. " +
        `Report: ${path.relative(root, reportFile)}`,
    );
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  for (const id of modelIds) {
    const base = bases.get(id)!;
    const input = inputs.get(id)!;
    const extras: ExtraArtwork[] = added.map((r) => ({
      entry: { imageId: r.ref.imageId, cardId: r.ref.cardId, source: 'konami', konamiId: r.ref.konamiId, artwork: r.ref.artwork },
      vector: vectors.get(id)![r.i],
    }));
    const info = { source: 'konami' as const, via: VIA, covered: rule, decidedBy: deciderId };
    const { bin, metaJson } = appendAltArtworks(base, extras, { ...info, addedAt: stableAddedAt(input, extras, info, now) });
    // The proof: the entries and vector bytes before the extras are the original file's, byte for byte.
    const n = base.meta.count;
    const dim = base.meta.dim;
    const oldBody = input.bin.subarray(20, 20 + n * dim);
    const newBody = bin.subarray(20, 20 + n * dim);
    const oldEntries = JSON.stringify(input.meta.entries.slice(0, n)).slice(0, -1);
    const newMeta = JSON.parse(metaJson) as IndexMeta;
    const newEntries = JSON.stringify(newMeta.entries.slice(0, n)).slice(0, -1);
    const diff = extrasDiff(input.meta.entries, newMeta.entries);
    const unchanged = Buffer.from(bin).equals(Buffer.from(input.bin)) && metaJson === input.metaText;
    const proof = {
      entriesKept: n,
      extras: extras.length,
      vectorsSha256: { before: sha256(oldBody), after: sha256(newBody) },
      entriesSha256: { before: sha256(oldEntries), after: sha256(newEntries) },
      entriesTextInFile: input.metaText.includes(`"entries":${oldEntries}`) && metaJson.includes(`"entries":${oldEntries}`),
      builtAtKept: newMeta.builtAt === input.meta.builtAt,
      dbVersionKept: newMeta.dbVersion === input.meta.dbVersion,
      added: diff.added.map((e) => e.imageId),
      removed: diff.removed.map((e) => e.imageId),
      filesUnchanged: unchanged,
      files: {} as Record<string, string>,
    };
    const same = proof.vectorsSha256.before === proof.vectorsSha256.after && proof.entriesSha256.before === proof.entriesSha256.after;
    if (!same || !proof.entriesTextInFile || !proof.builtAtKept || !proof.dbVersionKept) {
      throw new Error(`${id}: the merged index doesn't keep the original bytes: ${JSON.stringify(proof)}`);
    }
    if (!dryRun) {
      await mkdir(outDir, { recursive: true });
      const out = path.join(outDir, `index-${id}`);
      await writeFile(`${out}.bin`, bin);
      await writeFile(`${out}.meta.json`, metaJson);
      proof.files = { bin: sha256(bin), meta: sha256(metaJson) };
    }
    report.indexes[id] = proof;
    const name = (e: IndexEntry) => `${cards.find((c) => c.id === e.cardId)?.name ?? e.cardId} #${e.artwork} (${e.imageId})`;
    console.log(
      `${id}: ${n} entries kept (vectors sha256 ${proof.vectorsSha256.after.slice(0, 16)}… = before, entries sha256 ` +
        `${proof.entriesSha256.after.slice(0, 16)}… = before) + ${extras.length} extras: ${diff.added.length} added, ${diff.removed.length} removed ` +
        `against the input${unchanged ? ', files byte-identical to it' : ''}` +
        (dryRun ? ' (dry run: not written)' : ` → ${path.relative(root, outDir) || '.'}/index-${id}.*`),
    );
    for (const e of diff.added.slice(0, 30)) console.log(`  + ${name(e)}`);
    for (const e of diff.removed.slice(0, 30)) console.log(`  - ${name(e)}`);
    if (diff.added.length > 30 || diff.removed.length > 30) console.log('  … (every id in the report)');
  }
  await writeFile(reportFile, JSON.stringify(report, null, 1));
  console.log(`report: ${path.relative(root, reportFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
