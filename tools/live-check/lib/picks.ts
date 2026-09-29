// The live check's picks: labelled cards from data/realset/set.json (their frames are crops of real
// YouTube frames, data/debug/frames/<frame>.png), plus cards from the user's own test video judged by
// eye. Each pick knows its video, the moment the frame was captured and the quality it was captured at.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { productionOf } from '../../realset/lib/constants';
import type { AxisBox, RealsetEntry } from '../../realset/lib/types';

const root = path.resolve(import.meta.dirname, '../../..');

export interface Pick {
  id: string;
  production: string;
  videoId: string;
  /** Seconds into the video the frame was captured at (nominal; the run searches around it). */
  t: number;
  /** Search window around `t`, in seconds: the lead's own captures were taken a few seconds after it. */
  search: [number, number];
  /** The quality the frame was captured at (frame height). */
  capturedHeight: number;
  /** The frame image: a crop of the video frame. */
  template: string;
  /** Video px (at capturedHeight) per template px: 1 for native crops. */
  templateScale: number;
  /** Where the template's (0, 0) sits in the video (capturedHeight px), when known. */
  origin?: { x: number; y: number };
  /** The labelled box, in template px. */
  box: AxisBox;
  /** The label; null when the card is judged by eye from the answer. */
  truth: { cardId: number | null; name: string } | null;
  tags: string[];
  /** Also drag a box around it (the fallback path). */
  drag: boolean;
  note?: string;
}

/** The lead's captures (2026-09-28) by frame prefix: video and search window (they were taken 0–8 s after t). */
const VIDEOS: [RegExp, string, [number, number]][] = [
  [/^native-wcq-/, 'O1npzVza_0g', [-1, 9]], // WCQ Stuttgart 2026 recap (UnitedGosus)
  [/^native-wc-/, 'OcVdanpRg5g', [-1, 9]], // World Championship 2026, Day 2
  [/^native-t\d+-/, 'xS4oTSltEfs', [-1, 9]], // Genesys YCS Paris 2026, Day 1
];

/** The picks: about 25 labelled cards over 8 productions (tilted, defence, foil, 720p, close-up), plus the user's video. */
const PICKED: { id: string; drag?: boolean }[] = [
  // YCS Paris 2026 (Genesys stream)
  { id: 'native-t7600-top-d4' }, // upside down
  { id: 'native-t7600-bottom-d1', drag: true }, // near-square box the detector misses offline
  { id: 'native-t10400-mid-d4' }, // sideways
  { id: 'native-t10400-mid-d5' }, // 0.76 offline
  { id: 'native-t14500-mid-d0' }, // tilted 11°
  { id: 'native-t24760-top-d4' }, // sideways
  { id: 'native-t5200-mid-d2' }, // tilted −6°
  // World Championship 2026 (small cards)
  { id: 'native-wc-t7200-top-d1' },
  { id: 'native-wc-t12000-top-d1' },
  // WCQ Stuttgart 2026
  { id: 'native-wcq-t400-bottom-d1' }, // 0.75 offline
  { id: 'native-wcq-t900-top-d0' },
  { id: 'native-wcq-t400-top-d0' },
  // TSC locals
  { id: 'native-tsc-t1201-mid-destrier-def', drag: true }, // defence, tilted, low contrast
  { id: 'native-tsc-t1201-mid-syn-a' }, // "Not sure" offline
  { id: 'native-tsc-t1201-right-fellowship' }, // tilted 9°, overlapped
  { id: 'native-tsc-t800-left-crossout' },
  // Houston regional
  { id: 'native-hgg-t3451-top-faimena-tilted' }, // defence, tilted, foil
  { id: 'native-hgg-t3451-bottom-swordknight' }, // tilted −12°, on a pile
  { id: 'native-hgg720-t2952-mid-magnamhut', drag: true }, // 720p
  { id: 'native-hgg-t2951-mid-apprentice' }, // defence, foil
  // YCS Columbus
  { id: 'native-ycsc-t3601-right-white-dragon' }, // tilted, occluded
  { id: 'native-ycsc-t4301-bottom-ecclesia-def' }, // defence, low in the frame
  // Deck-profile close-up
  { id: 'native-dp-t96-cards-celtic-a', drag: true }, // perspective, foil
  // DarkLaw locals
  { id: 'native-dlaw-t1201-blue-perfume-dancer' }, // defence, perspective
  { id: 'native-dlaw-t601-col-black-chaos' }, // tilted
  { id: 'native-dlaw-t1201-red-mdc-black-chaos' }, // defence, foil
];

/** The user's own test video (not in set.json): YCS Paris 2026 Day 1, t=26191. Boxes in the full-view frame's px. */
const USER_VIDEO = 'bBbjafm1u2Q';
const USER_FV = 'data/debug/fullview/fv-ycsm-t26191.png'; // 1456x819: the 1920x1080 frame at 0.7583
const USER_PICKS: Pick[] = [
  {
    id: 'user-t26191-synchro-overtake',
    box: { x: 457, y: 598, w: 91, h: 119 },
    truth: { cardId: null, name: 'Synchro Overtake' },
    tags: ['tilted', 'S/T zone', 'the user report'],
    drag: true,
    note: "the user's failure case: tilted in a S/T zone; the stream's card panel shows it",
  },
  { id: 'user-t26191-top-monster', box: { x: 336, y: 181, w: 83, h: 113 }, truth: null, tags: ['upside down'], drag: false },
  { id: 'user-t26191-bottom-monster', box: { x: 448, y: 458, w: 83, h: 113 }, truth: null, tags: [], drag: false },
  { id: 'user-t26191-gy', box: { x: 1058, y: 456, w: 89, h: 115 }, truth: null, tags: ['GY'], drag: false },
].map((p) => ({
  ...p,
  production: 'YCS Paris 2026 (main stream, the user video)',
  videoId: USER_VIDEO,
  t: 26191,
  search: [-1, 4] as [number, number],
  capturedHeight: 1080,
  template: path.join(root, USER_FV),
  templateScale: 1920 / 1456,
  origin: { x: 0, y: 0 },
}));

function fromEntry(e: RealsetEntry & { video?: { url: string; t: number }; nativeOrigin?: [number, number]; tags?: string[] }, drag: boolean): Pick {
  let videoId: string | undefined;
  let t: number | undefined;
  let search: [number, number] = [-1, 3];
  if (e.video) {
    videoId = new URL(e.video.url).searchParams.get('v') ?? undefined;
    t = e.video.t;
  } else {
    for (const [re, id, win] of VIDEOS) {
      if (re.test(e.frame)) {
        videoId = id;
        search = win;
        t = Number(/-t(\d+)-/.exec(e.frame)?.[1]);
        break;
      }
    }
  }
  if (!videoId || !Number.isFinite(t)) throw new Error(`no video known for ${e.id} (${e.frame})`);
  const tags = [...(e.tags ?? [])];
  if (e.rotatedBox && !tags.some((x) => x.startsWith('orient'))) tags.push(`angle ${Math.round(e.rotatedBox.angleDeg)}°`);
  return {
    id: e.id,
    production: productionOf(e.frame),
    videoId,
    t: t!,
    search,
    capturedHeight: e.frame.startsWith('native-hgg720-') ? 720 : 1080,
    template: path.join(root, 'data/debug/frames', `${e.frame}.png`),
    templateScale: 1,
    ...(e.nativeOrigin ? { origin: { x: e.nativeOrigin[0], y: e.nativeOrigin[1] } } : {}),
    box: e.userBox,
    truth: { cardId: e.cardId, name: e.name },
    tags,
    drag,
  };
}

export function loadPicks(): Pick[] {
  const set = JSON.parse(readFileSync(path.join(root, 'data/realset/set.json'), 'utf8')) as RealsetEntry[];
  const byId = new Map(set.map((e) => [e.id, e]));
  const picks = PICKED.map(({ id, drag }) => {
    const e = byId.get(id);
    if (!e) throw new Error(`${id} is not in data/realset/set.json`);
    return fromEntry(e as never, drag ?? false);
  });
  return [...USER_PICKS, ...picks];
}

/** The offline results for a pick: eval-real (drag crop) and --real --click, when their files exist. */
export function offlineResults(): Map<string, { eval: string | null; click: string | null }> {
  const out = new Map<string, { eval: string | null; click: string | null }>();
  const read = (f: string) => {
    try {
      return JSON.parse(readFileSync(path.join(root, f), 'utf8'));
    } catch {
      return null;
    }
  };
  const evalRes = read('data/realset/results-engine-dinov2-small-duel.json');
  const set = new Map((JSON.parse(readFileSync(path.join(root, 'data/realset/set.json'), 'utf8')) as RealsetEntry[]).map((e) => [e.id, e]));
  for (const r of evalRes?.rows ?? []) {
    const top = r.candidates?.[0];
    const right = top && top.cardId === set.get(r.id)?.cardId;
    const v = !top ? 'nothing' : `${right ? 'right' : 'wrong'} ${r.confident ? 'confident' : 'not sure'} ${top.score.toFixed(3)}`;
    out.set(r.id, { eval: v, click: null });
  }
  const click = read('test/e2e/out/real-click-results.json');
  for (const r of click?.rows ?? []) {
    const o = out.get(r.id) ?? { eval: null, click: null };
    o.click = `${r.outcome}${r.ok ? ' (right)' : r.kind === 'card' ? ' (miss)' : ''}`;
    out.set(r.id, o);
  }
  return out;
}
