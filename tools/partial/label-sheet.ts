// Helps label real partly visible cards by eye (partial-report.md §2): for each box, the engine's top
// candidates with no threshold applied (as eval-real --raw reads them), drawn beside the crop as their
// indexed artworks (data/artworks/<imageId>.jpg), one sheet row per box. A candidate is only a lead: the
// label is what the eye confirms against the artwork, a nearby frame or the broadcast's card panel.
//
//   npx tsx tools/partial/label-sheet.ts --in boxes.json --out sheet.png [--k 5]
//   boxes.json: [{ "id": "...", "image": "data/debug/partial/x.png", "box": [x, y, w, h] }, ...]
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createEngine } from '../../src/offscreen/engine';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { CARD_BACK_ID } from '../../src/shared/types';
import { loadRGBA } from '../lib/image';
import { loadCards } from '../realset/lib/cards';
import { buildCrop } from '../realset/lib/crop';
import { writePng } from '../lib/debug-draw';
import { makeRig, ROOT } from './lib/engine';
import { contactSheet } from './sheet';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const items = JSON.parse(readFileSync(path.resolve(ROOT, arg('--in')!), 'utf8')) as { id: string; image: string; box: [number, number, number, number] }[];
  const out = path.resolve(ROOT, arg('--out') ?? 'data/debug/partial/label-sheet.png');
  const k = Number(arg('--k') ?? 5);
  const rig = await makeRig();
  const cards = loadCards();
  const raw = createEngine({
    embedder: rig.embedder,
    index: rig.index,
    spec: { ...rig.spec, thresholds: { score: Infinity, margin: 0, floor: -Infinity } },
    detector: rig.det.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence }),
  });
  const tmp = path.join(path.dirname(out), 'label-tmp');
  await import('node:fs/promises').then((fs) => fs.mkdir(tmp, { recursive: true }));
  const tiles: { label: string; file: string }[] = [];
  const text: string[] = [];
  for (const it of items) {
    const img = await loadRGBA(path.resolve(ROOT, it.image));
    const [x, y, w, h] = it.box;
    const { cropImg, inner } = buildCrop(img, { x, y, w, h });
    const r = await raw.recognize(cropImg, inner);
    const cropFile = path.join(tmp, `${it.id}-crop.png`);
    await writePng(cropImg, cropFile);
    tiles.push({ label: it.id, file: cropFile });
    const top = r.candidates.slice(0, k);
    text.push(`${it.id}: ${top.map((c) => `${c.cardId === CARD_BACK_ID ? 'Card back' : cards.byId.get(c.cardId)?.name} ${c.score.toFixed(3)}`).join(' | ')}`);
    for (const c of top) {
      const file = path.join(ROOT, 'data/artworks', `${c.imageId}.jpg`);
      const name = c.cardId === CARD_BACK_ID ? 'Card back' : (cards.byId.get(c.cardId)?.name ?? String(c.cardId));
      tiles.push({ label: `${c.score.toFixed(3)} ${name}`, file: existsSync(file) ? file : cropFile });
    }
  }
  await contactSheet(tiles, out, 200, k + 1);
  await writeFile(out.replace(/\.png$/, '.txt'), text.join('\n') + '\n');
  console.log(text.join('\n'));
  await rig.release();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
