// Things that are not a face-up card, selected on the real frames the way a user would (deck piles,
// face-down cards in sleeves, empty zones), through the engine exactly like tools/eval-real.ts:
// top candidate, its score, and the engine's decision with the model's calibrated thresholds
// ("nothing" = below the floor, "confident", or "not sure"). Real-set cards are listed for contrast.
// The engine finds the card with the extension's card detector when its model is present.
//
// Usage: npx tsx tools/train/eval-neg.ts [--models a,b] [--thresholds score,margin,floor] [--out FILE]
//   --thresholds  override the spec's thresholds for this run (analysis only)
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createNodeCardDetector, haveCardDetector } from '../../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../../src/offscreen/detector/spec';
import { createEngine } from '../../src/offscreen/engine';
import { decodeIndex, type IndexMeta } from '../../src/shared/index-format';
import { getModel } from '../../src/shared/models';
import { loadRGBA } from '../lib/image';
import { createNodeEmbedder } from '../lib/ort-node';
import { buildCrop } from '../realset/lib/crop';

const root = path.resolve(import.meta.dirname, '../..');
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const NEGATIVES: { frame: string; box: [number, number, number, number]; what: string }[] = [
  { frame: 'native-t7600-bottom', box: [88, 340, 122, 126], what: 'deck pile, WCQ sleeves' },
  { frame: 'native-t7600-bottom', box: [92, 167, 114, 163], what: 'empty zone' },
  { frame: 'native-t7950-top', box: [78, 62, 115, 166], what: 'deck pile, white art sleeves' },
  { frame: 'native-t7950-top', box: [1040, 60, 110, 148], what: 'face-down card, pink sleeve' },
  { frame: 'native-t24760-top', box: [78, 85, 122, 147], what: 'deck pile, purple sleeves' },
  { frame: 'native-t24760-top', box: [1030, 75, 112, 146], what: 'face-down card, WCQ sleeve' },
  { frame: 'native-t24760-top', box: [250, 70, 112, 162], what: 'empty zone' },
];

async function main() {
  const models = (arg('--models') ?? 'dinov2-small-duel,dinov3-small-q4').split(',');
  const set = JSON.parse(readFileSync(path.join(root, 'data/realset/set.json'), 'utf8')) as {
    id: string; frame: string; cardId: number; userBox: { x: number; y: number; w: number; h: number };
  }[];
  const names = new Map<number, string>(
    (JSON.parse(readFileSync(path.join(root, 'extension/data/cards.json'), 'utf8')).cards as { id: number; name: string }[]).map((c) => [c.id, c.name]),
  );
  const frames = new Map<string, Awaited<ReturnType<typeof loadRGBA>>>();
  const frame = async (f: string) => frames.get(f) ?? (frames.set(f, await loadRGBA(path.join(root, 'data/debug/frames', `${f}.png`))), frames.get(f)!);
  const out: Record<string, unknown> = {};
  const detector = haveCardDetector() ? (await createNodeCardDetector()).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence }) : null;
  for (const id of models) {
    const t = arg('--thresholds')?.split(',').map(Number);
    const base0 = getModel(id);
    const spec = t ? { ...base0, thresholds: { score: t[0], margin: t[1], floor: t[2] } } : base0;
    const node = await createNodeEmbedder(spec);
    const base = path.join(root, 'extension/data', `index-${id}`);
    const meta = JSON.parse(await readFile(`${base}.meta.json`, 'utf8')) as IndexMeta;
    const buf = await readFile(`${base}.bin`);
    const index = decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
    const engine = createEngine({ embedder: { modelId: id, embed: node.embed }, index, spec, detector });
    const run = async (f: string, b: { x: number; y: number; w: number; h: number }) => {
      const { cropImg, inner } = buildCrop(await frame(f), b);
      const r = await engine.recognize(cropImg, inner);
      const top = r.candidates[0];
      return { top: top ? names.get(top.cardId) ?? String(top.cardId) : null, topCardId: top?.cardId ?? null, score: top?.score ?? null, confident: r.confident, nothing: r.candidates.length === 0 };
    };
    const neg = [];
    for (const n of NEGATIVES) {
      const [x, y, w, h] = n.box;
      neg.push({ ...n, ...(await run(n.frame, { x, y, w, h })) });
    }
    const pos = [];
    for (const e of set) pos.push({ id: e.id, cardId: e.cardId, ...(await run(e.frame, e.userBox)) });
    await node.release();
    out[id] = { thresholds: spec.thresholds, negatives: neg, positives: pos };
    console.log(`\n${id} (thresholds ${JSON.stringify(spec.thresholds)})`);
    for (const n of neg) {
      const verdict = n.nothing ? 'nothing (below floor)' : n.confident ? 'CONFIDENT' : 'not sure';
      console.log(`  ${n.what.padEnd(30)} ${verdict.padEnd(22)} top ${n.score?.toFixed(3) ?? '-'} ${n.top ?? ''}`);
    }
    const ok = pos.filter((p) => p.topCardId === p.cardId);
    const sc = ok.map((p) => p.score!).sort((a, b) => a - b);
    console.log(`  real cards right: ${ok.length}/${pos.length}, confident ${ok.filter((p) => p.confident).length}; their top scores min ${sc[0]?.toFixed(3)} median ${sc[Math.floor(sc.length / 2)]?.toFixed(3)}`);
  }
  const file = arg('--out') ?? path.join(root, 'data/train/logs/eval-neg.json');
  writeFileSync(file, JSON.stringify(out, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
