// Contact sheets for checking harvest labels by eye (overnight-plan.md P3): each saved crop next to the
// YGOPRODeck artwork (data/artworks/<imageId>.jpg) of its label, or of the engine's first candidate when the
// crop has no label, with the card's name, the label's source and the engine's decision. Crops only: no
// frames exist to show.
//
//   npx tsx tools/overnight/sheet.ts --video <id> [--source confident|propagated|none|any] [--kind face-up|face-down|any]
//       [--n 24] [--cols 6] [--seed 1] [--per-track] [--out data/overnight/sheets/<video>-<source>-<kind>.jpg]
//
// --per-track: at most one crop per track (a track's frames are near copies), for estimating label precision per card.
//
// Prints the sheet's rows as text too (cell number, file, label, top candidates), for the verdicts.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadCards } from '../realset/lib/cards';
import { CARD_BACK_ID } from '../../src/shared/types';
import { seeded } from './lib/tracks';

const ROOT = path.resolve(import.meta.dirname, '../..');

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

interface Line {
  moment: number;
  track: number;
  file: string;
  kind: string;
  cardId: number | null;
  name: string | null;
  source: string;
  decision: string;
  top5: { cardId: number; score: number }[];
  px: [number, number];
}

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function main() {
  const video = arg('--video');
  if (!video) throw new Error('--video <id> is required');
  const source = arg('--source') ?? 'any';
  const kind = arg('--kind') ?? 'any';
  const n = Number(arg('--n') ?? 24);
  const cols = Number(arg('--cols') ?? 6);
  const rand = seeded(`${video}:${source}:${kind}:${arg('--seed') ?? '1'}`);
  const out = arg('--out') ?? path.join(ROOT, 'data/overnight/sheets', `${video}-${source}-${kind}.jpg`);
  const lines = readFileSync(path.join(ROOT, 'data/overnight/labels', `${video}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line)
    .filter((l) => (source === 'any' || l.source === source) && (kind === 'any' || l.kind === kind));
  // A random sample (seeded), shown in file order.
  const seen = new Set<string>();
  const picked = lines
    .map((l) => ({ l, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .filter(({ l }) => {
      if (!process.argv.includes('--per-track')) return true;
      const key = `${l.moment}:${l.track}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, n)
    .map((x) => x.l)
    .sort((a, b) => a.file.localeCompare(b.file));
  if (picked.length === 0) throw new Error('no crops match');

  const cards = loadCards();
  const CW = 176;
  const CH = 256;
  const CAP = 34;
  const cellW = 2 * CW + 6;
  const cellH = CH + CAP;
  const rows = Math.ceil(picked.length / cols);
  const composites: { input: string | Buffer; left: number; top: number }[] = [];
  for (const [i, l] of picked.entries()) {
    const x = (i % cols) * (cellW + 8);
    const y = Math.floor(i / cols) * (cellH + 8);
    composites.push({ input: path.join(ROOT, l.file), left: x, top: y });
    const refId = l.cardId ?? l.top5[0]?.cardId ?? null;
    const card = refId !== null && refId !== CARD_BACK_ID ? cards.byId.get(refId) : undefined;
    const art = card?.imageIds.map((id) => path.join(ROOT, 'data/artworks', `${id}.jpg`)).find(existsSync);
    const ref = art ?? (refId === CARD_BACK_ID ? path.join(ROOT, 'data/card-back.jpg') : undefined);
    if (ref && existsSync(ref)) {
      composites.push({ input: await sharp(ref).resize(CW, CH, { fit: 'contain', background: '#222' }).toBuffer(), left: x + CW + 6, top: y });
    }
    const name = refId === CARD_BACK_ID ? 'Card back' : (card?.name ?? (refId === null ? '(nothing)' : `#${refId}`));
    const score = l.top5.find((c) => c.cardId === refId)?.score;
    const colour = l.source === 'confident' ? '#7CFC00' : l.source === 'propagated' ? '#FFD700' : '#FF8C69';
    const text =
      `<svg width="${cellW}" height="${CAP}"><rect width="100%" height="100%" fill="#111"/>` +
      `<text x="3" y="13" font-family="Helvetica" font-size="12" fill="#fff">${i + 1}. ${esc(name.slice(0, 40))}</text>` +
      `<text x="3" y="29" font-family="Helvetica" font-size="11" fill="${colour}">${l.cardId === null ? 'top-1 ' : ''}${esc(l.source)} · ${esc(l.decision)}${score !== undefined ? ` · ${score.toFixed(3)}` : ''} · ${l.kind} ${l.px[0]}px</text></svg>`;
    composites.push({ input: Buffer.from(text), left: x, top: y + CH });
    const alts = l.top5
      .slice(0, 3)
      .map((c) => `${c.cardId === CARD_BACK_ID ? 'Card back' : (cards.byId.get(c.cardId)?.name ?? c.cardId)} ${c.score.toFixed(3)}`)
      .join(' | ');
    console.log(`${i + 1}\t${l.file}\t${l.cardId === null ? '-' : `${l.name} (${l.cardId})`}\t${l.source}\t${l.decision}\t${alts}`);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  await sharp({ create: { width: cols * (cellW + 8), height: rows * (cellH + 8), channels: 3, background: '#000' } })
    .composite(composites)
    .jpeg({ quality: 85 })
    .toFile(out);
  console.log(`wrote ${path.relative(ROOT, out)} (${picked.length} of ${lines.length} crops)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
