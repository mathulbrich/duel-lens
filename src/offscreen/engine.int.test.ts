// Integration: the real engine (the card detector, hypotheses, search) with the real models on
// onnxruntime-node, through the same embedImages() path the extension uses, and the card detector
// the extension registers (src/offscreen/index.ts). Uses the extension's model (getModel()), or
// DUEL_LENS_MODEL=<id> to compare another one; skips cleanly when the model file, its index, the
// card detector's model, the artworks or the real frames are missing.
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCrop } from '../../tools/realset/lib/crop';
import type { NegativeBox, RealsetEntry } from '../../tools/realset/lib/types';
import { embedImages, type SessionLike, type TensorCtor } from '../shared/embed-core';
import { decodeIndex, type IndexMeta, type LoadedIndex } from '../shared/index-format';
import { getModel, type EmbeddingModelSpec } from '../shared/models';
import type { RGBAImage } from '../shared/preprocess';
import type { RecognitionResult } from '../shared/types';
import type { CardDetector } from './detect-cards';
import { createNodeCardDetector, haveCardDetector } from './detector/node';
import { CARD_DETECTOR } from './detector/spec';
import { createEngine, type Embedder, type Engine } from './engine';

const ROOT = path.resolve(import.meta.dirname, '../..');
const ARTWORKS = path.join(ROOT, 'data/artworks');
const FRAMES = path.join(ROOT, 'data/debug/frames');
const REALSET = path.join(ROOT, 'data/realset');
const MEASURE = path.join(ROOT, 'data/measure');
const DEGRADE = path.join(ROOT, 'tools/lib/degrade.ts');

const files = (spec: EmbeddingModelSpec) => ({
  model: path.join(ROOT, 'extension/models', spec.file),
  bin: path.join(ROOT, 'extension/data', `index-${spec.id}.bin`),
  meta: path.join(ROOT, 'extension/data', `index-${spec.id}.meta.json`),
});
const ready = (spec: EmbeddingModelSpec) => Object.values(files(spec)).every((f) => existsSync(f));
const specs = [getModel(process.env.DUEL_LENS_MODEL || undefined)].filter(ready);
const haveArtworks = existsSync(ARTWORKS) && readdirSync(ARTWORKS).length > 100;

async function load(input: string | Buffer): Promise<RGBAImage> {
  const { data, info } = await sharp(input).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

/** The card detector the extension registers (src/offscreen/index.ts), on onnxruntime-node. */
const loadDetector = async (): Promise<CardDetector> => (await createNodeCardDetector()).asCardDetector({ minConfidence: CARD_DETECTOR.minConfidence });

describe.skipIf(specs.length === 0 || !haveArtworks)('engine with a real model', () => {
  describe.each(specs)('$id', (spec) => {
    let index: LoadedIndex;
    let session: ort.InferenceSession;
    let embedder: Embedder;
    /** The extension's card detector when its model is here; without it the engine matches the box as drawn. */
    let detector: CardDetector | null;

    beforeAll(async () => {
      const f = files(spec);
      const meta = JSON.parse(await readFile(f.meta, 'utf8')) as IndexMeta;
      const bin = await readFile(f.bin);
      index = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
      session = await ort.InferenceSession.create(f.model, { graphOptimizationLevel: 'all' });
      const runner = session as unknown as SessionLike;
      embedder = { modelId: spec.id, embed: (images) => embedImages(runner, ort.Tensor as unknown as TensorCtor, spec, images) };
      detector = haveCardDetector() ? await loadDetector() : null;
    }, 120_000);

    afterAll(async () => {
      await session?.release();
      await detector?.release?.();
    });

    it.skipIf(!existsSync(DEGRADE))('finds video-degraded artworks in the top 5 at least 80% of the time', async () => {
      const { degrade } = (await import(/* @vite-ignore */ DEGRADE)) as {
        degrade(img: RGBAImage, level: 'video', seed: number): Promise<RGBAImage>;
      };
      const engine = createEngine({ embedder, index, spec, detector });
      // 20 real cards spread over the index, skipping the card back.
      const pool = index.meta.entries.filter((e) => e.cardId >= 0 && existsSync(path.join(ARTWORKS, `${e.imageId}.jpg`)));
      const sample = Array.from({ length: 20 }, (_, i) => pool[Math.floor(((i + 0.5) * pool.length) / 20)]);
      let top1 = 0;
      let top5 = 0;
      const totals: number[] = [];
      const embeds: number[] = [];
      for (const [i, entry] of sample.entries()) {
        const img = await degrade(await load(path.join(ARTWORKS, `${entry.imageId}.jpg`)), 'video', 1000 + i);
        const res = await engine.recognize(img);
        expect(res.error).toBeUndefined();
        const rank = res.candidates.findIndex((c) => c.cardId === entry.cardId);
        if (rank === 0) top1++;
        if (rank >= 0 && rank < 5) top5++;
        totals.push(res.timings.total);
        embeds.push(res.timings.embed ?? 0);
      }
      console.log(
        `[engine.int] ${spec.id}: video artworks top-1 ${top1}/20, top-5 ${top5}/20; ` +
          `median total ${median(totals)} ms, embed ${median(embeds)} ms`,
      );
      expect(top5 / 20).toBeGreaterThanOrEqual(0.8);
    }, 300_000);

    it.skipIf(!existsSync(MEASURE))('recognises whole cards photographed on a mat', async () => {
      const ids = readdirSync(MEASURE)
        .filter((f) => f.endsWith('-full.jpg'))
        .map((f) => Number.parseInt(f, 10))
        .filter((id) => index.meta.entries.some((e) => e.imageId === id));
      if (ids.length === 0) return;
      const engine = createEngine({ embedder, index, spec, detector });
      const rows: string[] = [];
      let top5 = 0;
      for (const [i, id] of ids.entries()) {
        const cardId = index.meta.entries.find((e) => e.imageId === id)!.cardId;
        const angle = [4, -6, 180, 93][i % 4];
        const card = await sharp(path.join(MEASURE, `${id}-full.jpg`))
          .resize(180, 262, { fit: 'fill' })
          .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png()
          .toBuffer();
        const m = await sharp(card).metadata();
        const scene = await sharp({ create: { width: m.width! + 90, height: m.height! + 70, channels: 3, background: { r: 25, g: 70, b: 45 } } })
          .composite([{ input: card, left: 45, top: 35 }])
          .blur(0.8)
          .jpeg({ quality: 45 })
          .toBuffer();
        const res = await engine.recognize(await load(scene));
        const rank = res.candidates.findIndex((c) => c.cardId === cardId);
        if (rank >= 0 && rank < 5) top5++;
        rows.push(`${id}@${angle}°: rank ${rank} via ${res.best?.hypothesis}/${res.best?.rotation} (${res.timings.total} ms)`);
      }
      console.log(`[engine.int] ${spec.id}: whole cards top-5 ${top5}/${ids.length}\n  ${rows.join('\n  ')}`);
      expect(top5).toBeGreaterThanOrEqual(Math.ceil(ids.length * 0.6));
    }, 300_000);
  });
});

// The engine on real duel footage (data/realset, local only like all of data/), through the crop the
// content script sends: the user's box plus a 4% margin, and crop.inner (tools/realset/lib/crop.ts),
// with the card detector finding the card in it, as the extension does (a4-report.md). The bars:
// 116/120 today (9 productions), 115 of them confident, 0 confident wrong, and no confident card on
// any of the 70 non-card boxes; and a loose box 3-4x a card names the card its tight box names.
describe.skipIf(specs.length === 0 || !existsSync(FRAMES) || !haveCardDetector())('engine on real duel footage (data/realset)', () => {
  const spec = specs[0];
  let engine: Engine;
  let session: ort.InferenceSession;
  let detector: CardDetector;

  beforeAll(async () => {
    const f = files(spec);
    const meta = JSON.parse(await readFile(f.meta, 'utf8')) as IndexMeta;
    const bin = await readFile(f.bin);
    const index = decodeIndex(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
    session = await ort.InferenceSession.create(f.model, { graphOptimizationLevel: 'all' });
    const runner = session as unknown as SessionLike;
    const embedder: Embedder = { modelId: spec.id, embed: (images) => embedImages(runner, ort.Tensor as unknown as TensorCtor, spec, images) };
    detector = await loadDetector();
    engine = createEngine({ embedder, index, spec, detector });
  }, 120_000);

  afterAll(async () => {
    await session?.release();
    await detector?.release?.();
  });

  const frames = new Map<string, Promise<RGBAImage>>();
  const frame = (name: string) => {
    let f = frames.get(name);
    if (!f) frames.set(name, (f = load(path.join(FRAMES, `${name}.png`))));
    return f;
  };
  async function scan(frameName: string, box: { x: number; y: number; w: number; h: number }): Promise<RecognitionResult> {
    const { cropImg, inner } = buildCrop(await frame(frameName), box);
    return engine.recognize(cropImg, inner);
  }
  const describeLine = (r: RecognitionResult) =>
    `${r.candidates.length === 0 ? 'nothing' : r.confident ? 'confident' : 'not sure'}, top ${r.candidates[0]?.cardId ?? '-'}, ${r.timings.total} ms`;

  const setFile = path.join(REALSET, 'set.json');
  it.skipIf(!existsSync(setFile))('matches the real set (116/120 today, 115 confident), never confidently wrong', async () => {
    const set = JSON.parse(await readFile(setFile, 'utf8')) as RealsetEntry[];
    let top1 = 0;
    let confidentRight = 0;
    let confidentWrong = 0;
    const misses: string[] = [];
    for (const e of set) {
      const res = await scan(e.frame, e.userBox);
      expect(res.error).toBeUndefined();
      const ok = res.candidates[0]?.cardId === e.cardId;
      if (ok) top1++;
      if (res.confident && ok) confidentRight++;
      if (res.confident && !ok) confidentWrong++;
      if (!ok) misses.push(`${e.id} (${e.name}): ${describeLine(res)}`);
    }
    console.log(`[engine.int] real set: top-1 ${top1}/${set.length}, confident ${confidentRight}\n  misses: ${misses.join('\n          ')}`);
    expect(set.length).toBeGreaterThanOrEqual(120);
    expect(top1 / set.length).toBeGreaterThanOrEqual(115 / 120);
    expect(confidentRight / set.length).toBeGreaterThanOrEqual(112 / 120);
    expect(confidentWrong).toBe(0);
  }, 300_000);

  // A loose drag: a box drawn several times larger than a card, around it, must name the same card as
  // a tight box. On the 7 full-screen frames (data/debug/fullview, hand labels in truth.json), the
  // face-up mat cards named confidently from their tight box keep that answer from a 3x and a 4x box
  // (pickBox's containment rule picks the card the box holds; click-D-report.md §3).
  const fullview = path.join(ROOT, 'data/debug/fullview');
  const truthFile = path.join(fullview, 'truth.json');
  it.skipIf(!existsSync(truthFile))('names the same card from a loose box drawn 3-4x larger around it (fullview frames)', async () => {
    const truth = JSON.parse(await readFile(truthFile, 'utf8')) as Record<string, { box: number[]; kind: string }[] | string>;
    let sure = 0;
    const kept: Record<3 | 4, number> = { 3: 0, 4: 0 };
    const lost: string[] = [];
    for (const [name, labels] of Object.entries(truth)) {
      if (typeof labels === 'string') continue; // the format note
      const img = await load(path.join(fullview, name));
      for (const { box, kind } of labels) {
        if (kind !== 'card') continue;
        const [x, y, w, h] = box;
        /** k× the card's box around its centre, clipped to the frame as a drag is. */
        const around = (k: number) => {
          const x0 = Math.max(0, x + w / 2 - (k * w) / 2);
          const y0 = Math.max(0, y + h / 2 - (k * h) / 2);
          return { x: x0, y: y0, w: Math.min(img.width, x + w / 2 + (k * w) / 2) - x0, h: Math.min(img.height, y + h / 2 + (k * h) / 2) - y0 };
        };
        const read = (k: number) => {
          const { cropImg, inner } = buildCrop(img, around(k));
          return engine.recognize(cropImg, inner);
        };
        const tight = await read(1);
        if (!tight.confident) continue;
        sure++;
        for (const k of [3, 4] as const) {
          const res = await read(k);
          if (res.confident && res.candidates[0]?.cardId === tight.candidates[0].cardId) kept[k]++;
          else lost.push(`${name} ${box.join(',')} at ${k}x: ${describeLine(res)} (tight: ${tight.candidates[0].cardId})`);
        }
      }
    }
    console.log(`[engine.int] loose boxes: ${sure} cards named confidently from a tight box; kept at 3x ${kept[3]}, at 4x ${kept[4]}\n  ${lost.join('\n  ')}`);
    expect(sure).toBeGreaterThanOrEqual(25);
    expect(kept[3] / sure).toBeGreaterThanOrEqual(0.95);
    expect(kept[4] / sure).toBeGreaterThanOrEqual(0.9);
  }, 300_000);

  const excludedFile = path.join(REALSET, 'excluded.json');
  it.skipIf(!existsSync(excludedFile))('never claims a confident card for a sleeved deck pile', async () => {
    const piles = (JSON.parse(await readFile(excludedFile, 'utf8')) as RealsetEntry[]).filter((e) => /Miracle Fusion/.test(e.name));
    expect(piles.length).toBeGreaterThan(0);
    for (const p of piles) {
      const res = await scan(p.frame, p.userBox);
      console.log(`[engine.int] deck pile ${p.id}: ${describeLine(res)}`);
      expect(res.confident).toBe(false);
    }
  }, 300_000);

  const negativesFile = path.join(REALSET, 'negatives.json');
  it.skipIf(!existsSync(negativesFile))('never answers confidently on a real non-card box: a pile, a sleeve or mat art (negatives.json)', async () => {
    const negatives = JSON.parse(await readFile(negativesFile, 'utf8')) as NegativeBox[];
    let confident = 0;
    const rows: string[] = [];
    for (const n of negatives) {
      const res = await scan(n.frame, { x: n.box[0], y: n.box[1], w: n.box[2], h: n.box[3] });
      if (res.confident) confident++;
      rows.push(`${res.confident ? 'CONFIDENT' : 'ok       '} ${n.id.padEnd(28)} ${n.design.padEnd(32)} ${describeLine(res)}`);
    }
    console.log(`[engine.int] negatives: confident ${confident}/${negatives.length}\n  ${rows.join('\n  ')}`);
    expect(confident).toBe(0);
  }, 300_000);
});
