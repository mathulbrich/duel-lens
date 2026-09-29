// The partial-card study's samples (partial-report.md), shared by eval-partial.ts and exp-rescue.ts:
// - synth / neg: the real-set cards / non-card boxes with their frame cut on one side (lib/synth.ts);
// - occ / negocc: the same with an occluder pasted over part of them (lib/occlude.ts);
// - real: real partly visible cards and non-cards labelled by hand (data/debug/partial/real.json);
// - realset / realneg: the real set itself, unmodified (data/realset/set.json, negatives.json).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { DetectedCardBox } from '../../../src/shared/messages';
import type { RGBAImage } from '../../../src/shared/preprocess';
import { loadRGBA } from '../../lib/image';
import type { AxisBox, NegativeBox, RealsetEntry } from '../../realset/lib/types';
import { ROOT } from './engine';
import { hashSeed, occlude, outlineOf, type Occluder } from './occlude';
import { boxInWindow, cutFrame, cutWindow, type Side } from './synth';

export type SetName = 'synth' | 'neg' | 'occ' | 'negocc' | 'real' | 'realset' | 'realneg';

/** One thing to scan: a card (with its truth) or a non-card box. */
export interface Sample {
  set: SetName;
  id: string;
  /** The source row (real-set or negatives id, or the real partial id). */
  source: string;
  kind: 'card' | 'neg';
  cardId: number | null;
  name: string;
  /** How it is cut or covered: `${side} ${fraction}`, `${occluder} ${coverage}`, or the real row's own words. */
  cut: string;
  side: Side | Occluder | 'other';
  fraction: number | null;
  /** Loads the frame (cut or covered); null when an occluder couldn't reach its coverage. */
  frame: () => Promise<RGBAImage | null>;
  /** The user's box around the visible card (or the whole card when it is covered), frame pixels. */
  box: AxisBox;
}

/** A real partly visible card or non-card, labelled by hand (data/debug/partial/real.json). */
export interface RealPartial {
  id: string;
  /** Image path relative to the repository root (a whole video frame). */
  image: string;
  /** [x, y, w, h]: the card as a user would box it (image pixels): its visible part when cut, the whole card when covered. */
  box: [number, number, number, number];
  kind: 'card' | 'neg';
  cardId: number | null;
  name: string;
  /** e.g. "edge-top 0.44", "covered hand 0.35". */
  cut: string;
  side?: Side | 'other';
  /** The share of the card that is NOT visible, by eye. */
  fraction?: number;
  /** How the label was made. */
  labelledBy?: string;
  note?: string;
}

const frameCache = new Map<string, Promise<RGBAImage>>();
export function loadFrame(file: string): Promise<RGBAImage> {
  let p = frameCache.get(file);
  if (!p) {
    p = loadRGBA(file);
    frameCache.set(file, p);
    if (frameCache.size > 12) frameCache.delete(frameCache.keys().next().value!);
  }
  return p;
}

function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file).subarray(16, 24);
  return { w: b.readUInt32BE(0), h: b.readUInt32BE(4) };
}

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')) as T;
const frameFile = (frame: string) => path.join(ROOT, 'data/debug/frames', `${frame}.png`);
const negBox = (n: NegativeBox): AxisBox => ({ x: n.box[0], y: n.box[1], w: n.box[2], h: n.box[3] });

export interface SampleOptions {
  sets: readonly SetName[];
  sides: readonly Side[];
  fractions: readonly number[];
  occluders: readonly Occluder[];
  coverages: readonly number[];
  /** Keep every n-th source row (1: all). */
  every?: number;
}

export function makeSamples(o: SampleOptions): Sample[] {
  const every = o.every ?? 1;
  const entries = readJson<RealsetEntry[]>('data/realset/set.json').filter((_, i) => i % every === 0);
  const negatives = readJson<NegativeBox[]>('data/realset/negatives.json').filter((_, i) => i % every === 0);
  const out: Sample[] = [];
  const cut = (set: 'synth' | 'neg', source: string, frame: string, card: AxisBox, truth: Pick<Sample, 'kind' | 'cardId' | 'name'>) => {
    const file = frameFile(frame);
    const size = pngSize(file);
    for (const side of o.sides)
      for (const fraction of o.fractions) {
        const win = cutWindow(size.w, size.h, card, side, fraction);
        const box = win && boxInWindow(card, win);
        if (!win || !box) continue;
        out.push({ set, id: `${source}|${side}|${fraction}`, source, ...truth, cut: `${side} ${fraction}`, side, fraction, frame: () => loadFrame(file).then((f) => cutFrame(f, win)), box });
      }
  };
  const cover = (set: 'occ' | 'negocc', source: string, frame: string, box: AxisBox, pts: [number, number][] | null, truth: Pick<Sample, 'kind' | 'cardId' | 'name'>) => {
    const file = frameFile(frame);
    for (const kind of o.occluders)
      for (const cov of o.coverages) {
        const id = `${source}|${kind}|${cov}`;
        out.push({
          set,
          id,
          source,
          ...truth,
          cut: `${kind} ${cov}`,
          side: kind,
          fraction: cov,
          frame: async () => occlude(await loadFrame(file), outlineOf(box, pts), kind, cov, hashSeed(id))?.frame ?? null,
          box,
        });
      }
  };
  for (const e of entries) {
    const truth = { kind: 'card' as const, cardId: e.cardId, name: e.name };
    if (o.sets.includes('synth')) cut('synth', e.id, e.frame, e.userBox, truth);
    if (o.sets.includes('occ')) cover('occ', e.id, e.frame, e.userBox, e.rotatedBox?.pts ?? null, truth);
    if (o.sets.includes('realset'))
      out.push({ set: 'realset', id: e.id, source: e.id, ...truth, cut: 'whole', side: 'other', fraction: 0, frame: () => loadFrame(frameFile(e.frame)), box: e.userBox });
  }
  for (const n of negatives) {
    const truth = { kind: 'neg' as const, cardId: null, name: n.design };
    if (o.sets.includes('neg')) cut('neg', n.id, n.frame, negBox(n), truth);
    if (o.sets.includes('negocc')) cover('negocc', n.id, n.frame, negBox(n), null, truth);
    if (o.sets.includes('realneg'))
      out.push({ set: 'realneg', id: n.id, source: n.id, ...truth, cut: 'whole', side: 'other', fraction: 0, frame: () => loadFrame(frameFile(n.frame)), box: negBox(n) });
  }
  const realFile = path.join(ROOT, 'data/debug/partial/real.json');
  if (o.sets.includes('real') && existsSync(realFile)) {
    for (const r of readJson<RealPartial[]>('data/debug/partial/real.json')) {
      out.push({
        set: 'real',
        id: r.id,
        source: r.id,
        kind: r.kind,
        cardId: r.cardId,
        name: r.name,
        cut: r.cut,
        side: r.side ?? 'other',
        fraction: r.fraction ?? null,
        frame: () => loadFrame(path.join(ROOT, r.image)),
        box: { x: r.box[0], y: r.box[1], w: r.box[2], h: r.box[3] },
      });
    }
  }
  return out;
}

/** Whether (x, y) is inside the convex polygon `pts` (either winding). */
function inside(pts: [number, number][], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const z = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (z === 0) continue;
    if (sign === 0) sign = Math.sign(z);
    else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

const polyArea = (pts: [number, number][]) => Math.abs(pts.reduce((s, [x, y], i) => s + x * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * y, 0) / 2);

/**
 * Click to scan on a sample: the face-up outline (from the whole-frame detection) under the box's centre,
 * the smallest when several are, and the box the content script then crops (the outline's bounds); null
 * when there is no outline under the click.
 */
export function clickBox(outlines: readonly DetectedCardBox[], box: AxisBox): { outline: [number, number][]; box: AxisBox } | null {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const hits = outlines.filter((o) => o.kind !== 'face-down' && inside(o.pts, cx, cy)).sort((a, b) => polyArea(a.pts) - polyArea(b.pts));
  if (hits.length === 0) return null;
  const pts = hits[0].pts;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { outline: pts, box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } };
}
