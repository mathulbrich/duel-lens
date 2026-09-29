// Click to scan's view of a frame, for the partial-card study: every card our detector finds on the whole
// frame (one run, as the offscreen page runs it for the shortcut), outlined and numbered, plus which
// outlines touch or cross the frame's border (a card cut by the picture's edge).
//
//   npx tsx tools/partial/outline-frame.ts <frame.png> [more.png ...] [--out dir] [--min 0.4]
//
// Writes <out>/<frame>-outlines.png (face-up green, face-down orange; a border-touching one in red) and
// prints each detection. Default out: data/debug/partial/outlines/.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createNodeCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { loadRGBA } from '../lib/image';
import { writeOutlinesPng } from '../lib/debug-draw';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--out' && all[i - 1] !== '--min');
  const min = Number(arg('--min') ?? CARD_DETECTOR.minConfidence);
  const out = path.resolve(root, arg('--out') ?? 'data/debug/partial/outlines');
  await mkdir(out, { recursive: true });
  const det = await createNodeCardDetector();
  for (const file of files) {
    const img = await loadRGBA(file);
    const cards = (await det.findCards(img)).filter((c) => c.conf >= min);
    const edge = 4;
    const touches = (pts: [number, number][]) => {
      const sides: string[] = [];
      if (pts.some(([x]) => x <= edge)) sides.push('left');
      if (pts.some(([, y]) => y <= edge)) sides.push('top');
      if (pts.some(([x]) => x >= img.width - edge)) sides.push('right');
      if (pts.some(([, y]) => y >= img.height - edge)) sides.push('bottom');
      return sides;
    };
    console.log(`\n${path.relative(root, file)} ${img.width}x${img.height}: ${cards.length} detections >= ${min}`);
    cards.forEach((c, i) => {
      const t = touches(c.pts);
      const xs = c.pts.map((p) => p[0]);
      const ys = c.pts.map((p) => p[1]);
      console.log(
        `  #${i} ${c.kind} ${c.conf.toFixed(3)} centre (${c.cx.toFixed(0)}, ${c.cy.toFixed(0)}) ${c.w.toFixed(0)}x${c.h.toFixed(0)} ` +
          `angle ${((c.angle * 180) / Math.PI).toFixed(1)}° bounds x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}` +
          (t.length ? `  BORDER ${t.join('+')}` : ''),
      );
    });
    const outlines = cards.map((c, i) => ({
      pts: c.pts,
      label: `#${i}`,
      color: touches(c.pts).length ? '#ff2d55' : c.kind === 'face-down' ? '#ff9f0a' : '#30d158',
    }));
    await writeOutlinesPng(img, outlines, null, path.join(out, `${path.basename(file).replace(/\.[^.]+$/, '')}-outlines.png`));
  }
  await det.release();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
