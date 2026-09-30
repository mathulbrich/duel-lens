// realset2 build: assembles data/realset2/set.json and negatives.json (the realset format,
// tools/realset/README.md, plus realset2's own fields) from the proposals (proposals.jsonl, and
// proposals-extra.jsonl for boxes drawn by hand), the decisions a person made by eye
// (decisions.jsonl; the last line for a proposal wins) and the hand-drawn non-card boxes
// (manual-negatives.json). Only verified labels go in; rejected boxes stay out.
//
//   npx tsx tools/realset2/build.ts [--dry]
//
// Each set row is a RealsetEntry (source 'human', verified true) plus:
//   category  the row's main difficulty, the first that applies of
//             digital > overframe > foil > covered > cut > small > tilted > normal
//   tags      every one that applies (geometry adds tilted / sideways / small / cut, the person the rest)
//   video, t, event   the source video, the moment (s) and the event (data/overnight/videos.json)
// Each negative is a NegativeBox plus category (sleeve, pile, mat-art, zone, hand, overlay, logo, other),
// video and t.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NegativeBox, RealsetEntry } from '../realset/lib/types';

const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'data/realset2');
const dry = process.argv.includes('--dry');

/** Geometry thresholds (frame pixels at 1080p; every realset2 frame is 1920x1080). */
export const SMALL_LONG_SIDE = 90;
export const TILT_MIN_DEG = 10;
export const SIDEWAYS_MIN_DEG = 75;
export const CATEGORY_ORDER = ['digital', 'overframe', 'foil', 'covered', 'cut', 'small', 'tilted', 'normal'] as const;
export type Category = (typeof CATEGORY_ORDER)[number];

interface Box {
  pid: string;
  kind: string;
  conf: number;
  angleDeg: number;
  size: { w: number; h: number };
  pts: [number, number][];
  userBox: { x: number; y: number; w: number; h: number };
  edge: boolean;
}
interface FrameProposals {
  frame: string;
  video: string;
  t: number;
  width: number;
  height: number;
  boxes: Box[];
}
interface Decision {
  pid: string;
  cardId?: number;
  name?: string;
  tags?: string[];
  note?: string;
  how?: string;
  reject?: string;
  negative?: string;
}
interface ManualNegative {
  id: string;
  frame: string;
  box: [number, number, number, number];
  design: string;
  category: string;
}

const jsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

const videos = new Map(
  (JSON.parse(readFileSync(path.join(ROOT, 'data/overnight/videos.json'), 'utf8')) as { videos: { id: string; event: string; split: string }[] }).videos.map((v) => [v.id, v]),
);

/** The detector's angle folded to (-90, 90]: 0 upright (or upside down), ±90 sideways. */
const fold = (deg: number) => {
  let a = ((deg % 180) + 180) % 180;
  if (a > 90) a -= 180;
  return a;
};

export function categoryOf(tags: string[]): Category {
  for (const c of CATEGORY_ORDER) if (c !== 'normal' && tags.includes(c)) return c;
  if (tags.includes('sideways')) return 'tilted';
  return 'normal';
}

function negativeCategory(design: string): string {
  const d = design.toLowerCase();
  const prefix = /^(overlay|hand|logo|zone|mat art|other|pile|sleeve):/.exec(d)?.[1];
  if (prefix) return prefix === 'mat art' ? 'mat-art' : prefix;
  if (/overlay|graphic|banner|scoreboard|lower third|name plate|stream/.test(d)) return 'overlay';
  if (/product box|prize box|phone|score sheet|paper/.test(d)) return 'other';
  if (/\bhand\b|finger|\barm\b/.test(d)) return 'hand';
  if (/pile|deck|stack/.test(d)) return 'pile';
  if (/sleeve|face-down|card back/.test(d)) return 'sleeve';
  if (/zone|empty/.test(d)) return 'zone';
  if (/mat art|printed|artwork/.test(d)) return 'mat-art';
  if (/logo|marker|ycs/.test(d)) return 'logo';
  return 'other';
}

function main() {
  const frames = [...jsonl<FrameProposals>(path.join(OUT, 'proposals.jsonl')), ...jsonl<FrameProposals>(path.join(OUT, 'proposals-extra.jsonl'))];
  const byPid = new Map<string, { f: FrameProposals; b: Box }>();
  for (const f of frames) for (const b of f.boxes) byPid.set(b.pid, { f, b });
  const decisions = new Map<string, Decision>();
  for (const d of jsonl<Decision>(path.join(OUT, 'decisions.jsonl'))) decisions.set(d.pid, d);

  const set: (RealsetEntry & Record<string, unknown>)[] = [];
  const negatives: (NegativeBox & Record<string, unknown>)[] = [];
  for (const [pid, d] of decisions) {
    const hit = byPid.get(pid);
    if (!hit) throw new Error(`decision for unknown proposal ${pid}`);
    const { f, b } = hit;
    const video = videos.get(f.video);
    if (!video || !video.split.startsWith('heldout-')) throw new Error(`${pid}: video ${f.video} is not a held-out video`);
    const key = pid.split('#')[1];
    if (d.negative) {
      negatives.push({
        id: `${f.frame}-n${key}`,
        frame: f.frame,
        box: [b.userBox.x, b.userBox.y, b.userBox.w, b.userBox.h],
        design: d.negative,
        source: `${video.event} (YouTube ${f.video}, t=${Math.round(f.t)} s)`,
        category: negativeCategory(d.negative),
        video: f.video,
        t: f.t,
      });
      continue;
    }
    if (d.cardId == null) continue; // rejected: not labelled
    const angle = fold(b.angleDeg);
    const tags = new Set(d.tags ?? []);
    if (Math.abs(angle) >= SIDEWAYS_MIN_DEG) tags.add('sideways');
    else if (Math.abs(angle) >= TILT_MIN_DEG) tags.add('tilted');
    if (Math.max(b.size.w, b.size.h) < SMALL_LONG_SIDE) tags.add('small');
    if (b.edge) tags.add('cut');
    const tagList = [...tags].sort();
    const [cx, cy] = [b.pts.reduce((s, p) => s + p[0], 0) / 4, b.pts.reduce((s, p) => s + p[1], 0) / 4];
    set.push({
      id: `${f.frame}-b${key}`,
      frame: f.frame,
      rotatedBox: b.kind === 'manual' ? null : { cx: Math.round(cx * 10) / 10, cy: Math.round(cy * 10) / 10, w: b.size.w, h: b.size.h, angleDeg: b.angleDeg, conf: b.conf, pts: b.pts },
      userBox: b.userBox,
      cardId: d.cardId,
      name: d.name!,
      verified: true,
      source: 'human',
      ...(tags.has('covered') ? { occluded: true } : {}),
      category: categoryOf(tagList),
      tags: tagList,
      labelledBy: d.how === 'identified' ? 'identified by eye (not the engine\'s first candidate)' : `by eye, the engine's ${d.how}`,
      ...(d.note ? { labelNote: d.note } : {}),
      video: f.video,
      t: f.t,
      event: video.event,
    });
  }
  for (const m of existsSync(path.join(OUT, 'manual-negatives.json')) ? (JSON.parse(readFileSync(path.join(OUT, 'manual-negatives.json'), 'utf8')) as ManualNegative[]) : []) {
    const f = frames.find((x) => x.frame === m.frame);
    const cap = f ?? jsonl<{ frame: string; video: string; t: number }>(path.join(OUT, 'capture.jsonl')).find((x) => x.frame === m.frame);
    if (!cap) throw new Error(`manual negative ${m.id}: unknown frame ${m.frame}`);
    const video = videos.get(cap.video)!;
    if (!video.split.startsWith('heldout-')) throw new Error(`${m.id}: not a held-out video`);
    negatives.push({ id: m.id, frame: m.frame, box: m.box, design: m.design, source: `${video.event} (YouTube ${cap.video}, t=${Math.round(cap.t)} s)`, category: m.category, video: cap.video, t: cap.t });
  }
  set.sort((a, b) => a.id.localeCompare(b.id));
  negatives.sort((a, b) => a.id.localeCompare(b.id));

  const count = <T>(rows: T[], key: (r: T) => string) => rows.reduce<Record<string, number>>((acc, r) => ((acc[key(r)] = (acc[key(r)] ?? 0) + 1), acc), {});
  console.log(`set: ${set.length} cards, ${new Set(set.map((r) => r.frame)).size} frames, ${new Set(set.map((r) => r.cardId)).size} distinct cards`);
  console.log('  by category:', JSON.stringify(count(set, (r) => r.category as string)));
  const tagCounts: Record<string, number> = {};
  for (const r of set) for (const t of r.tags as string[]) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  console.log('  tags:', JSON.stringify(tagCounts));
  console.log('  by event:', JSON.stringify(count(set, (r) => r.event as string)));
  console.log(`negatives: ${negatives.length}`, JSON.stringify(count(negatives, (r) => r.category as string)));
  if (!dry) {
    writeFileSync(path.join(OUT, 'set.json'), JSON.stringify(set, null, 1) + '\n');
    writeFileSync(path.join(OUT, 'negatives.json'), JSON.stringify(negatives, null, 1) + '\n');
    console.log('wrote data/realset2/set.json and negatives.json');
  }
}

main();
