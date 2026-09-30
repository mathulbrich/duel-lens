// realset2 reference sheet: official card images of the given cards (or of every card whose name
// matches --name), side by side with their ids, to identify a card by eye among an archetype's members.
//
//   npx tsx tools/realset2/refsheet.ts --out <file.jpg> (--cards id,id | --name <regex>) [--h 300] [--cols 6]
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { allCards, artOf, cardById, fullCardOf } from './lib/refs';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const out = arg('--out');
  if (!out) throw new Error('--out <file.jpg>');
  const H = Number(arg('--h') ?? 300);
  const cols = Number(arg('--cols') ?? 6);
  let ids = (arg('--cards') ?? '').split(',').filter(Boolean).map(Number);
  if (arg('--name')) {
    const re = new RegExp(arg('--name')!, 'i');
    ids = [...ids, ...allCards.filter((c) => re.test(c.name)).map((c) => c.id)];
  }
  ids = ids.slice(0, 48);
  const W = Math.round((H * 421) / 614);
  const layers: OverlayOptions[] = [];
  for (const [i, id] of ids.entries()) {
    const ref = (await fullCardOf(id, H > 400 ? 'large' : 'small')) ?? artOf(id);
    const x = (i % cols) * (W + 8);
    const y = Math.floor(i / cols) * (H + 26);
    if (ref) layers.push({ input: await sharp(ref).resize(W, H, { fit: 'fill' }).png().toBuffer(), left: x, top: y + 22 });
    const label = `${id} ${cardById.get(id)?.name ?? '?'}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 34);
    layers.push({ input: Buffer.from(`<svg width="${W}" height="22"><text x="1" y="16" font-family="Helvetica" font-size="13" fill="#ffd400">${label}</text></svg>`), left: x, top: y });
  }
  const rows = Math.ceil(ids.length / cols);
  await sharp({ create: { width: Math.min(ids.length, cols) * (W + 8), height: rows * (H + 26), channels: 3, background: '#111111' } })
    .composite(layers)
    .jpeg({ quality: 88 })
    .toFile(out);
  console.log(`${ids.length} cards -> ${path.basename(out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
