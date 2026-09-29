// Diagnostic script for Duel Lens: runs one still image and one user-drawn box through the
// *real* runtime recognition pipeline (the real detector, hypothesis builder, embedder and
// index — every piece imported from src/, never re-implemented) and dumps each intermediate
// image plus every candidate score, so a bad real-world scan (glowing playmat zones, sleeves,
// sideways/defense cards, upside-down opponent cards) can be inspected step by step instead
// of guessed at from the final "noise-level score, wrong card" result.
//
// Usage:
//   npx tsx tools/debug-scan.ts --image <png|jpg> --box x,y,w,h [--expect <cardId|imageId>]
//     [--out <dir>] [--model <id>] [--recognizer auto|embedding]
//
// It runs the extension's engine (src/offscreen/engine.ts; --recognizer auto, the default, and
// embedding are the same): the embedding matcher, finding the card with the card detector the
// extension registers (extension/models/detector/card-detector.onnx; without it, the user's box
// alone). The detector's view of the crop goes to detections.png: every card it found (face-up green,
// face-down orange, numbered as listed) and the user's box, dashed.
//
// --box is in the *image's own pixel coordinates*, exactly as a user would drag it on screen;
// there is no separate viewport, so no viewport→bitmap mapping is needed (see buildCrop below).
//
// Two pieces of the pipeline are private helpers, not exported, so they are copied verbatim
// with a citation instead of re-implemented differently:
//   - toCropPixels / computeInnerBox  <- src/content/capture.ts (toPixels / innerBox)
//   - shrinkToMaxSide / isBlankCrop   <- src/offscreen/engine.ts (shrinkTo / isBlank)
// Everything else (expandRect, the card detector, straightenPick, buildHypotheses, createEngine, resizeRGBA,
// cropRGBA, rotate90/180, topKByCard, mergeCandidates, decodeIndex, getModel,
// createNodeEmbedder) is imported and called for real.
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { CROP_MARGIN, MAX_CROP_SIDE } from '../src/content/capture';
import { expandRect, type Rect } from '../src/content/geometry';
import { createEngine, hypothesisOptions, MAX_SIDE, straightenPick, type Embedder, type StraightenedCard, type UserBox } from '../src/offscreen/engine';
import { CARD_DETECTOR_FILE, createNodeCardDetector, haveCardDetector } from '../src/offscreen/detector/node';
import { CARD_DETECTOR } from '../src/offscreen/detector/spec';
import { boundsOf, iou, type Quad } from '../src/offscreen/geometry';
import { buildHypotheses, userBox, type Hypothesis } from '../src/offscreen/hypotheses';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../src/shared/index-format';
import { DEFAULT_MODEL_ID, getModel, type EmbeddingModelSpec } from '../src/shared/models';
import { cropRGBA, resizeRGBA, rotate180, rotate90, type RGBAImage } from '../src/shared/preprocess';
import { mergeCandidates, topKByCard } from '../src/shared/search';
import { CARD_BACK_ID, type Candidate, type CardRecord, type Rotation } from '../src/shared/types';
import { loadRGBA } from './lib/image';
import { createNodeEmbedder } from './lib/ort-node';
import { writeOutlinesPng, writePng, writeQuadPng } from './lib/debug-draw';

const root = path.resolve(import.meta.dirname, '..');

// ---------- CLI ----------

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

type RecognizerChoice = 'auto' | 'embedding';

function parseRecognizer(raw: string | undefined): RecognizerChoice {
  const r = raw ?? 'auto';
  if (r !== 'auto' && r !== 'embedding') throw new Error(`--recognizer must be auto or embedding (both the extension's engine), got "${r}"`);
  return r;
}

function parseBox(raw: string | undefined): Rect {
  if (!raw) throw new Error('Missing --box x,y,w,h');
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw new Error(`--box must be "x,y,w,h", got "${raw}"`);
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) throw new Error(`--box width/height must be positive, got ${w}x${h}`);
  return { x, y, w, h };
}

// ---------- private engine arithmetic, copied verbatim (see header citation) ----------

/** src/content/capture.ts lines 168-173 (toPixels): whole source pixels covering `r`. */
function toCropPixels(r: Rect): Rect {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return { x, y, w: Math.max(1, Math.ceil(r.x + r.w) - x), h: Math.max(1, Math.ceil(r.y + r.h) - y) };
}

/** src/content/capture.ts lines 158-166 (innerBox): the user's box inside the crop, in crop pixels. */
function computeInnerBox(box: Rect, px: Rect, scale: number, outW: number, outH: number): UserBox {
  const clip = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const x0 = clip((box.x - px.x) * scale, outW);
  const y0 = clip((box.y - px.y) * scale, outH);
  const x1 = clip((box.x + box.w - px.x) * scale, outW);
  const y1 = clip((box.y + box.h - px.y) * scale, outH);
  return { x: r3(x0), y: r3(y0), w: r3(x1 - x0), h: r3(y1 - y0) };
}

/** src/offscreen/engine.ts lines 44-49 (shrinkTo): shrink so the long side is at most `maxSide`. */
function shrinkToMaxSide(img: RGBAImage, maxSide: number): RGBAImage {
  const long = Math.max(img.width, img.height);
  if (long <= maxSide) return img;
  const s = maxSide / long;
  return resizeRGBA(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)));
}

/** src/offscreen/engine.ts lines 42, 51-67 (BLANK_STD, isBlank): grayscale std below 4 = blank. */
function isBlankCrop(img: RGBAImage): boolean {
  const n = img.width * img.height;
  const step = Math.max(1, Math.floor(n / 65536));
  const d = img.data;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let p = 0; p < n; p += step) {
    const i = p * 4;
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    sum += g;
    sumSq += g * g;
    count++;
  }
  const mean = sum / count;
  return Math.sqrt(Math.max(0, sumSq / count - mean * mean)) < 4;
}

// ---------- crop building (mirrors cropSelection's screenshot branch, capture.ts lines 199-227) ----------
//
// cropSelection maps a *viewport* rect onto a screenshot bitmap first (viewportToBitmap), then
// adds the margin and clamps. Here --box is already given in the image's own pixel coordinates
// (the task's contract), which is exactly what that mapping would produce with a 1:1 scale, so
// that step is skipped and `box` below is used directly, as `viewportToBitmap`'s result would be.

interface CropBuild {
  cropImg: RGBAImage;
  box: Rect;
  region: Rect;
  px: Rect;
  outW: number;
  outH: number;
  inner: UserBox;
}

function buildCrop(image: RGBAImage, box: Rect): CropBuild {
  const region = expandRect(box, CROP_MARGIN, { x: 0, y: 0, w: image.width, h: image.height });
  const px = toCropPixels(region);
  const scale = Math.min(1, MAX_CROP_SIDE / Math.max(px.w, px.h));
  const outW = Math.max(1, Math.round(px.w * scale));
  const outH = Math.max(1, Math.round(px.h * scale));
  const cropped = cropRGBA(image, px.x, px.y, px.w, px.h);
  const cropImg = outW === cropped.width && outH === cropped.height ? cropped : resizeRGBA(cropped, outW, outH);
  const inner = computeInnerBox(box, px, scale, outW, outH);
  return { cropImg, box, region, px, outW, outH, inner };
}

// ---------- cards.json ----------

interface CardsFile {
  dbVersion: string;
  updatedAt: string;
  cards: CardRecord[];
}

async function loadCards(): Promise<CardRecord[]> {
  const data = JSON.parse(await readFile(path.join(root, 'extension/data/cards.json'), 'utf8')) as CardsFile;
  return data.cards;
}

function nameOf(cards: CardRecord[], cardId: number): string {
  if (cardId === CARD_BACK_ID) return 'Card back';
  return cards.find((c) => c.id === cardId)?.name ?? `(unknown card ${cardId})`;
}

/** Resolve --expect as a cardId, or (for fixtures named by artwork) an imageId of that card. */
function resolveExpect(raw: string, cards: CardRecord[]): { cardId: number; name: string; via: string } {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--expect must be a number, got "${raw}"`);
  const byId = cards.find((c) => c.id === n);
  if (byId) return { cardId: byId.id, name: byId.name, via: `cardId ${n}` };
  const byImage = cards.find((c) => c.imageIds.includes(n));
  if (byImage) return { cardId: byImage.id, name: byImage.name, via: `imageId ${n}` };
  throw new Error(`--expect ${n} matches no card's id or imageIds in cards.json`);
}

// ---------- index ----------

async function loadIndexFromDisk(spec: EmbeddingModelSpec): Promise<LoadedIndex> {
  const base = path.join(root, 'extension/data', `index-${spec.id}`);
  let meta: IndexMeta;
  let buf: Buffer;
  try {
    [meta, buf] = await Promise.all([
      readFile(`${base}.meta.json`, 'utf8').then((s) => JSON.parse(s) as IndexMeta),
      readFile(`${base}.bin`),
    ]);
  } catch (e) {
    throw new Error(`Could not load ${base}.bin/.meta.json (run "npm run data:index -- --models ${spec.id}"?): ${(e as Error).message}`);
  }
  return decodeIndex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta);
}

// ---------- formatting ----------

const f3 = (n: number) => n.toFixed(3);
const f1 = (n: number) => n.toFixed(1);
const rectStr = (r: Rect) => `(${f1(r.x)}, ${f1(r.y)}, ${f1(r.w)}×${f1(r.h)})`;
const hypLabel = (h: { id: string; rotation: number }) => `${h.id}@${h.rotation}`;

function candCell(cards: CardRecord[], c?: Candidate): string {
  if (!c) return '–';
  return `${nameOf(cards, c.cardId)} ${f3(c.score)}`;
}

// ---------- main ----------

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      [
        'Usage:',
        '  npx tsx tools/debug-scan.ts --image <png|jpg> --box x,y,w,h [--expect <cardId|imageId>]',
        '    [--out <dir>] [--model <id>] [--recognizer auto|embedding]',
        '',
        'Runs the extension\'s engine (auto and embedding are the same): the embedding matcher, finding the card',
        'with the card detector. The detector\'s view of the crop goes to detections.png.',
      ].join('\n'),
    );
    return;
  }
  const imagePath = arg('--image');
  if (!imagePath) throw new Error('Missing --image <png|jpg>');
  const box = parseBox(arg('--box'));
  const expectArg = arg('--expect');
  const modelId = arg('--model') ?? DEFAULT_MODEL_ID;
  const spec = getModel(modelId);
  const recognizer = parseRecognizer(arg('--recognizer'));

  const base = path.basename(imagePath).replace(/\.[^./]+$/, '');
  const outDir = arg('--out') ?? path.join(root, 'data/debug', `${base}-${Math.round(box.x)}_${Math.round(box.y)}`);
  await mkdir(outDir, { recursive: true });

  console.error(`[debug-scan] loading ${imagePath}`);
  const image = await loadRGBA(imagePath);

  console.error(`[debug-scan] building crop (box ${rectStr(box)} + ${CROP_MARGIN * 100}% margin)`);
  const { cropImg, region, px, inner } = buildCrop(image, box);
  await writePng(cropImg, path.join(outDir, 'crop.png'));

  console.error(`[debug-scan] loading model "${spec.id}" and its index`);
  const [node, index, cards, detector] = await Promise.all([
    createNodeEmbedder(spec),
    loadIndexFromDisk(spec),
    loadCards(),
    // The card detector the extension registers (src/offscreen/index.ts), when its model is here.
    haveCardDetector() ? createNodeCardDetector().then((d) => d.asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence })) : null,
  ]);
  const embedder: Embedder = { modelId: spec.id, embed: node.embed };
  const engine = createEngine({ embedder, index, spec, detector });
  const expect = expectArg ? resolveExpect(expectArg, cards) : null;

  const out: string[] = [];
  out.push(`### debug-scan: ${path.relative(root, imagePath)} · box ${rectStr(box)} · model ${spec.id} · recognizer ${recognizer}`, '');
  out.push(`- image: ${image.width}×${image.height}, output: \`${path.relative(root, outDir)}/\``);
  out.push(`- crop: region ${rectStr(region)} → pixels ${rectStr(px)} → crop ${cropImg.width}×${cropImg.height}, inner ${rectStr(inner)}`);
  if (expect) out.push(`- expect: **${expect.name}** (cardId ${expect.cardId}, matched via ${expect.via})`);

  // ---- mirror the engine's own steps (order and size clamping), to expose intermediates ----
  // (engine.ts recognize(): shrink to MAX_SIDE -> blank check -> detect -> shrink to
  // hypothesisMax -> scale the user's box the same way -> buildHypotheses.)
  const shrunk = shrinkToMaxSide(cropImg, MAX_SIDE);
  const blank = isBlankCrop(shrunk);
  out.push(`- blank check (grayscale std < 4): ${blank ? '**blank — engine returns "nothing" without detecting or embedding**' : 'not blank'}`);

  let hyps: Hypothesis[] = [];
  let hypVectors: Float32Array[] = [];
  let hypFullRanks: Candidate[][] = [];

  if (!blank) {
    out.push('', '#### Embedding matcher', '');
    // As engine.ts: the card detector's cards in the crop, the one straightenPick takes for the user's box.
    const sxS = shrunk.width / cropImg.width;
    const syS = shrunk.height / cropImg.height;
    const userInShrunk = userBox(shrunk, { x: inner.x * sxS, y: inner.y * syS, w: inner.w * sxS, h: inner.h * syS });
    let found: StraightenedCard | null = null;
    let looked = false;
    if (!detector) {
      out.push(`- card detector: none (${path.relative(root, CARD_DETECTOR_FILE)} is missing): the user's box alone, as a --no-detector build`);
    } else {
      try {
        const boxes = await detector.detectInCrop!(shrunk);
        looked = true;
        out.push(
          `- card detector: ${boxes.length} card(s) at confidence >= ${CARD_DETECTOR.minConfidence} in the ${shrunk.width}×${shrunk.height} crop, ` +
            `user box ${rectStr(userInShrunk)} → \`detections.png\``,
        );
        boxes.forEach((b, i) => {
          const bounds = boundsOf(b.pts.map(([x, y]) => ({ x, y })) as Quad);
          out.push(
            `  - #${i}: ${b.kind ?? 'card'} ${f3(b.conf)}, centre (${f1(b.cx)}, ${f1(b.cy)}), ${f1(b.w)}×${f1(b.h)}, ` +
              `angle ${f1((b.angle * 180) / Math.PI)}°, IoU with the user box ${f3(iou(bounds, userInShrunk))}`,
          );
        });
        const outlines = boxes.map((b, i) => ({ pts: b.pts, label: `#${i} ${f3(b.conf)}`, color: b.kind === 'face-down' ? '#ff9f0a' : '#30d158' }));
        await writeOutlinesPng(shrunk, outlines, userInShrunk, path.join(outDir, 'detections.png'));
        found = straightenPick(shrunk, boxes, userInShrunk);
      } catch (e) {
        out.push(`- card detector: **threw** ${(e as Error).message}`);
      }
    }
    if (found) {
      for (const [i, q] of found.quads.entries()) await writeQuadPng(shrunk, q.map((p) => [p.x, p.y] as [number, number]), path.join(outDir, `quad-${i}.png`));
      for (const [i, c] of found.cards.entries()) await writePng(c, path.join(outDir, `card-${i}.png`));
      out.push(
        `- picked: ${found.pick.kind ?? 'card'} ${f3(found.pick.conf)}, turned ${found.rotation}° from the selection; ${found.quads.length} view(s) ` +
          `(corners, box, grown; the same view once) → \`quad-N.png\`, \`card-N.png\``,
      );
    } else if (looked) {
      out.push("- picked: no card for the user's box (a card-shaped box is then read as a whole card only)");
    }
    if (found && found.cards.length === 0) found = null; // a pick no view can straighten: as the engine, no card
    const card: RGBAImage[] | null = found?.cards ?? null;

    const hypothesisMax = 3 * spec.inputSize; // engine.ts line 80
    const source = shrinkToMaxSide(shrunk, hypothesisMax);
    const sx = source.width / cropImg.width;
    const sy = source.height / cropImg.height;
    const scaledInner = { x: inner.x * sx, y: inner.y * sy, w: inner.w * sx, h: inner.h * sy };
    hyps = buildHypotheses(source, card, scaledInner, hypothesisOptions(found, looked));

    console.error(`[debug-scan] embedding ${hyps.length} hypothesis image(s)`);
    // One file per hypothesis: the straightened card's views share an id and a rotation, so they are numbered.
    const seen = new Map<string, number>();
    for (const h of hyps) {
      const key = `${h.id}-${h.rotation}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      await writePng(h.image, path.join(outDir, `hyp-${key}${n ? `-${n}` : ''}.png`));
    }
    hypVectors = await embedder.embed(hyps.map((h) => h.image));
    hypFullRanks = hypVectors.map((v) => topKByCard(v, index, index.meta.count)); // full ranking, one entry per card
  }

  // ---- the real engine, called exactly as the offscreen handler calls it ----
  console.error('[debug-scan] running engine.recognize()');
  const result = await engine.recognize(cropImg, inner);

  out.push('', '#### Result (engine.recognize)', '');
  out.push(
    `recognizer **${result.recognizer ?? '–'}** · confident **${result.confident}** · faceDown **${result.faceDown}** · best **${result.best ? `${result.best.hypothesis}@${result.best.rotation}` : '–'}**` +
      (result.error ? ` · error: ${result.error}` : ''),
  );
  out.push(`timings (ms): ${Object.entries(result.timings).map(([k, v]) => `${k}=${f1(v)}`).join(' ')}`, '');
  if (result.candidates.length === 0) {
    out.push('_no candidates (below the model\'s floor)_');
  } else {
    out.push('| # | card | cardId | imageId | score |', '|--:|---|--:|--:|--:|');
    result.candidates.slice(0, 10).forEach((c, i) => {
      out.push(`| ${i + 1} | ${nameOf(cards, c.cardId)} | ${c.cardId} | ${c.imageId} | ${f3(c.score)} |`);
    });
  }

  // ---- per-hypothesis breakdown ----
  if (hyps.length > 0) {
    out.push('', '#### Per-hypothesis top 5', '');
    out.push('| hypothesis | 1st | 2nd | 3rd | 4th | 5th |', '|---|---|---|---|---|---|');
    hyps.forEach((h, i) => {
      const top5 = hypFullRanks[i].slice(0, 5);
      out.push(`| ${hypLabel(h)} | ${[0, 1, 2, 3, 4].map((k) => candCell(cards, top5[k])).join(' | ')} |`);
    });

    if (expect) {
      out.push('', `#### "${expect.name}" (cardId ${expect.cardId}) rank per hypothesis`, '');
      out.push('| hypothesis | rank | score |', '|---|--:|--:|');
      hyps.forEach((h, i) => {
        const idx = hypFullRanks[i].findIndex((c) => c.cardId === expect.cardId);
        out.push(`| ${hypLabel(h)} | ${idx < 0 ? '> ' + (index.meta.count - 1) : idx} | ${idx < 0 ? '–' : f3(hypFullRanks[i][idx].score)} |`);
      });
      const mergedFull = mergeCandidates(hypFullRanks, index.meta.count);
      const mi = mergedFull.findIndex((c) => c.cardId === expect.cardId);
      out.push(
        `| merged, all hypotheses (diagnostic; the real engine may stop after stage 1) | ${mi < 0 ? '(not found)' : mi} | ${mi < 0 ? '–' : f3(mergedFull[mi].score)} |`,
      );
    }
  }

  // ---- baseline: the plain user box, no margin, no detection ----
  console.error('[debug-scan] embedding the plain user box baseline');
  const rawBox = cropRGBA(image, box.x, box.y, box.w, box.h);
  const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
  const turn = (img: RGBAImage, r: Rotation): RGBAImage =>
    r === 0 ? img : r === 180 ? rotate180(img) : rotate90(img, r === 90 ? 'cw' : 'ccw'); // matches hypotheses.ts's cropRotated convention
  const squares = ROTATIONS.map((r) => resizeRGBA(turn(rawBox, r), spec.inputSize, spec.inputSize));
  const baselineVectors = await embedder.embed(squares);
  const baselineRanks = baselineVectors.map((v) => topKByCard(v, index, 5));

  out.push('', '#### Baseline: plain user box (no margin, no detection), square-resized', '');
  out.push('| rotation | 1st | 2nd | 3rd | 4th | 5th |', '|--:|---|---|---|---|---|');
  ROTATIONS.forEach((r, i) => {
    out.push(`| ${r}° | ${[0, 1, 2, 3, 4].map((k) => candCell(cards, baselineRanks[i][k])).join(' | ')} |`);
  });

  console.log(out.join('\n'));
  await detector?.release?.();
  await node.release();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
