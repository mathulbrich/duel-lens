// Two rigs that drive a Live controller in unit tests, for controller.regression.test.ts. Test-only: nothing in the
// extension imports this.
// - rig(): the step rig of controller.test.ts. A test hands it each video frame; the detection and the reads it asks
//   for finish within that frame, and they cost wall-clock time only when `cost` says so.
// - sim(): an event-driven page. Frames keep coming (and the gate keeps sampling) while one engine works through its
//   queue of detections and reads, each taking `engine.detectMs` or `engine.readMs` of a single fake clock. It shows
//   what a slow computer does: when each read starts, and how busy the engine is. As in the extension, a request is
//   answered from the frame its cycle grabbed (the cards in it, and `reads.next`'s `frameAt`), not from what the
//   page shows when the engine gets to it.
// Both take the controller's factory, so one scenario can run on any version of it.
import { vi } from 'vitest';
import type { LiveProgress, LiveSighting } from '../../shared/live';
import type { DetectedCardBox, RecognizeResponse } from '../../shared/messages';
import type { CanvasLike } from '../capture';
import type { LiveController, LiveDeps, LiveView } from './controller';
import { liveCrop } from './crop';
import { GATE } from './gate';

export type CreateLive = (deps: LiveDeps) => LiveController;

export const ASH = { id: 14558127, imageId: 14558128 };
export const OTHER = { id: 23434538, imageId: 23434539 };

/** An upright card centred on (cx, cy) in the 1280x720 frame. */
export const card = (cx: number, cy: number, w = 100, h = 140): DetectedCardBox => ({
  cx,
  cy,
  w,
  h,
  angle: 0,
  conf: 0.9,
  kind: 'face-up',
  pts: [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ],
});
/** Zone 20 of the scene (row 2, column 4) holds this card: x 0.52-0.60, y 0.53-0.72 of the video. */
export const IN_ZONE_20 = card(720, 450);

// An unsure read's score moves a little from read to read, as on a playing video (two equal unsure reads end the vote).
let jitter = 0;
/** A read of `who`; confident ones score 0.82 by default, under VOTE.clear: two agreeing reads promote. */
export const recognized = (who: { id: number; imageId: number }, confident = true, score?: number): RecognizeResponse =>
  ({
    result: { candidates: [{ cardId: who.id, imageId: who.imageId, score: score ?? (confident ? 0.82 : 0.6 + (jitter++ % 50) * 0.002) }], confident, faceDown: false, modelId: 'm', timings: {} },
    cards: {},
    aiEnabled: false,
  }) as RecognizeResponse;
/** A read that names nothing: a hand over the card, or no card there. */
export const nothing = (): RecognizeResponse => ({ result: { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }, cards: {}, aiEnabled: false }) as RecognizeResponse;

export const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

/** The page's video: 1280x720, drawn at 960x540 px in the page's corner; its state is the test's. */
function fakeVideo(state: { paused: boolean; seeking: boolean; currentSrc: string }, time: { get(): number; set(x: number): void }) {
  const v = document.createElement('video');
  const def = (name: string, get: () => unknown) => Object.defineProperty(v, name, { get, configurable: true });
  def('paused', () => state.paused);
  def('seeking', () => state.seeking);
  def('ended', () => false);
  def('readyState', () => 4);
  def('videoWidth', () => 1280);
  def('videoHeight', () => 720);
  def('currentSrc', () => state.currentSrc);
  Object.defineProperty(v, 'currentTime', { get: time.get, set: time.set, configurable: true });
  v.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, toJSON() {} }) as DOMRect;
  const frame: { pending: ((now: number, meta: { mediaTime: number }) => void) | null } = { pending: null };
  (v as unknown as Record<string, unknown>).requestVideoFrameCallback = (cb: typeof frame.pending) => {
    frame.pending = cb;
    return 1;
  };
  (v as unknown as Record<string, unknown>).cancelVideoFrameCallback = () => void (frame.pending = null);
  document.body.append(v);
  return { v, frame };
}

/**
 * A canvas factory: the gate's thumbnails show `scene` (8 x 4 regions of one brightness each), every other canvas is
 * black. With `shot`, a canvas drawn from the video holds the frame shown then (`shot()` names it), a canvas drawn from
 * such a canvas holds the same frame, and its dataUrl ends in `#<that name>`: the sim answers a request from the frame
 * it was cut from.
 */
function canvasFactory(scene: number[], shot?: () => number) {
  const held = new WeakMap<object, number>();
  return (w: number, h: number): CanvasLike => {
    const canvas: CanvasLike = {
      width: w,
      height: h,
      getContext: () => ({
        drawImage: (source: unknown) => {
          if (!shot || (w === GATE.w && h === GATE.h)) return; // the gate's thumbnail is no frame a request is cut from
          const id = source instanceof HTMLVideoElement ? shot() : held.get(source as object);
          if (id !== undefined) held.set(canvas, id);
        },
        getImageData: (_x: number, _y: number, gw: number, gh: number) => {
          if (w === GATE.w && h === GATE.h) {
            const data = new Uint8ClampedArray(gw * gh * 4);
            for (let y = 0; y < gh; y++) {
              for (let x = 0; x < gw; x++) {
                const zone = Math.floor(y / (GATE.h / 4)) * 8 + Math.floor(x / (GATE.w / 8)); // the scene's 8x4 regions
                data.fill(scene[zone], (y * gw + x) * 4, (y * gw + x) * 4 + 3);
                data[(y * gw + x) * 4 + 3] = 255;
              }
            }
            return { width: gw, height: gh, data };
          }
          return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) };
        },
      }),
      toDataURL: (type = 'image/png') => `data:${type};base64,FAKE-${canvas.width}x${canvas.height}${held.has(canvas) ? `#${held.get(canvas)}` : ''}`,
    };
    return canvas;
  };
}

/** A box in the frame's fractions, as the controller's skip list holds it. */
export const normOf = (b: DetectedCardBox) => ({ x: (b.cx - b.w / 2) / 1280, y: (b.cy - b.h / 2) / 720, w: b.w / 1280, h: b.h / 720 });

/** The engine's answer to one live-analyze: the boxes found, and reads of the face-up ones not skipped (the pointed
 *  one first, then the bigger first), up to `max`, within `budgetMs` after the first. */
async function analyze(
  msg: { [k: string]: unknown },
  found: DetectedCardBox[],
  read: (crop: { dataUrl: string }) => Promise<RecognizeResponse>,
  elapsed: () => number,
  bySize: boolean,
  createCanvas: (w: number, h: number) => CanvasLike,
) {
  const skip = (msg.skip as { x: number; y: number; w: number; h: number }[] | undefined) ?? [];
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 0.02 && Math.abs(a.y - b.y) < 0.02;
  let left = Number(msg.max ?? 0);
  const p = msg.pointer as { x: number; y: number } | null | undefined;
  const under = (b: DetectedCardBox) => {
    const n = normOf(b);
    return !!p && p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
  };
  const order = found
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.kind === 'face-up' && !skip.some((k) => near(k, normOf(b))))
    .sort((x, y) => Number(under(y.b)) - Number(under(x.b)) || (bySize ? y.b.w * y.b.h - x.b.w * x.b.h : 0));
  const out: unknown[] = found.map(() => null);
  let tried = 0;
  for (const { i } of order) {
    if (left-- <= 0) break;
    if (msg.budgetMs !== undefined && tried++ > 0 && elapsed() >= Number(msg.budgetMs)) break;
    // The crop a read of this box would send (the same canvas factory), so tests can tell the cards apart.
    const grab = { canvas: createCanvas(1280, 720), currentTime: 0, videoWidth: 1280, videoHeight: 720, contentBox: { x: 0, y: 0, w: 1280, h: 720 }, readable: true };
    const crop = liveCrop(grab as never, found[i], createCanvas as never);
    const answer = (await read(crop)) as { result?: unknown };
    out[i] = answer && 'result' in answer ? answer.result : null;
  }
  return out;
}

export interface Rig {
  live: LiveController;
  video: HTMLVideoElement;
  views: LiveView[];
  toast: ReturnType<typeof vi.fn>;
  /** Everything sent, in order (a live-analyze is recorded as a live-detect and one recognize per read it carried). */
  sent: { type: string; [k: string]: unknown }[];
  /** The video's state, as the page would change it. */
  state: { paused: boolean; seeking: boolean; currentSrc: string; currentTime: number };
  /** Brightness (0-255) of each of 32 regions (8 x 4, row-major) in the next thumbnail; each covers 2x2 of the gate's zones. */
  scene: number[];
  /** Wall clock (ms) the controller sees. */
  clock: { t: number };
  /** How long each detect and each recognize takes on that clock, ms. */
  cost: { ms: number };
  boxes: { current: DetectedCardBox[] };
  reads: { next: () => RecognizeResponse };
  /** While set, a detection's answer waits for it. */
  detect: { hold: Promise<void> | null };
  /** Delivers one video frame to the controller and lets its work finish. */
  tick(now: number, mediaTime: number): Promise<void>;
  count(type: string): number;
  progress(): LiveProgress[];
  sightings(): LiveSighting[];
}

/** The step rig (controller.test.ts's): frames only when the test delivers them. */
export function rig(create: CreateLive): Rig {
  const state = { paused: false, seeking: false, currentSrc: 'a.mp4', currentTime: 0 };
  const scene = new Array<number>(32).fill(50);
  const clock = { t: 0 };
  const cost = { ms: 0 };
  const boxes = { current: [IN_ZONE_20] };
  const reads = { next: () => recognized(ASH) };
  const detect: Rig['detect'] = { hold: null };
  const sent: Rig['sent'] = [];
  const listed = new Set<number>();
  const { v, frame } = fakeVideo(state, { get: () => state.currentTime, set: (x) => void (state.currentTime = x) });
  const createCanvas = canvasFactory(scene);

  const views: LiveView[] = [];
  const toast = vi.fn();
  const send = vi.fn(async (msg: { type: string; [k: string]: unknown }) => {
    if (msg.type === 'live-analyze') {
      sent.push({ ...msg, type: 'live-detect' });
      await detect.hold;
      clock.t += cost.ms;
      const t0 = clock.t - cost.ms; // the request's start: before the detection's cost
      const found = boxes.current;
      const out = await analyze(msg, found, async (crop) => {
        sent.push({ type: 'recognize', crop });
        clock.t += cost.ms;
        return reads.next();
      }, () => clock.t - t0, false, createCanvas);
      return { detection: { boxes: found, width: 1280, height: 720, ms: 5 }, reads: out };
    }
    sent.push(msg);
    if (msg.type === 'recognize') {
      clock.t += cost.ms;
      return reads.next();
    }
    if (msg.type === 'live-progress') {
      // The background answers the list's entry count.
      for (const x of (msg.progress as LiveProgress).sightings) listed.add(x.cardId);
      return { ok: true, count: listed.size };
    }
    return { ok: true };
  });
  const live = create({ doc: document, send: send as never, now: () => clock.t, createCanvas, onView: (view) => views.push(view), toast });

  const progress = () => sent.filter((m) => m.type === 'live-progress').map((m) => m.progress as LiveProgress);
  return {
    live,
    video: v,
    views,
    toast,
    sent,
    state,
    scene,
    clock,
    cost,
    boxes,
    reads,
    detect,
    async tick(now, mediaTime) {
      const cb = frame.pending;
      frame.pending = null;
      cb?.(now, { mediaTime });
      await flush();
    },
    count: (type) => sent.filter((m) => m.type === type).length,
    progress,
    sightings: () => progress().flatMap((p) => p.sightings),
  };
}

export interface Sim {
  live: LiveController;
  video: HTMLVideoElement;
  views: LiveView[];
  /** Everything sent, stamped with the clock (a live-analyze is recorded as a live-detect and a recognize per read). */
  sent: { type: string; at: number; [k: string]: unknown }[];
  state: { paused: boolean };
  scene: number[];
  clock: { readonly t: number };
  /** The engine: each job's cost, its time spent working, when it is free, and every job it ran. */
  engine: { detectMs: number; readMs: number; busyMs: number; freeAt: number; log: { kind: 'detect' | 'read'; start: number; end: number; crop?: string }[] };
  boxes: { current: DetectedCardBox[] };
  /** The answer for a read of the crop `dataUrl` (FAKE-WxH: cards of different sizes tell apart, urlOf), cut from the
   *  frame shown at `frameAt` (when the cycle grabbed the picture, which may be well before the answer comes). */
  reads: { next: (dataUrl: string, frameAt: number) => RecognizeResponse };
  /** Runs frames every `frameMs` (and the engine's jobs as they end) until `end`; `each(t)` before each frame. */
  run(end: number, each?: (t: number) => void, frameMs?: number): Promise<void>;
  progress(): LiveProgress[];
  sightings(): LiveSighting[];
  /** The pointer on the middle of `c`. */
  pointAt(c: DetectedCardBox): void;
}

/** The event-driven page. Its clock is the fake timers' Date.now(): call vi.useFakeTimers() before making one. */
export function sim(create: CreateLive): Sim {
  const state = { paused: false, seeking: false, currentSrc: 'a.mp4' };
  const scene = new Array<number>(32).fill(50);
  const base = Date.now(); // Date.now() moves with vi.advanceTimersByTime, also inside timer callbacks
  const now = () => Date.now() - base;
  const clock = { get t() { return now(); } };
  const boxes = { current: [] as DetectedCardBox[] };
  const reads: Sim['reads'] = { next: () => { throw new Error('no answer set'); } };
  const sent: Sim['sent'] = [];
  const listed = new Set<number>();
  const engine: Sim['engine'] = { detectMs: 0, readMs: 0, busyMs: 0, freeAt: 0, log: [] };
  const jobs: { at: number; resolve: () => void }[] = [];
  const work = (ms: number, kind: 'detect' | 'read', crop?: string) =>
    new Promise<void>((resolve) => {
      const start = Math.max(engine.freeAt, clock.t);
      engine.freeAt = start + ms;
      engine.busyMs += ms;
      engine.log.push({ kind, start, end: start + ms, crop });
      jobs.push({ at: start + ms, resolve });
    });
  const { v, frame } = fakeVideo(state, { get: () => clock.t / 1000, set: () => undefined });
  /** Every frame the controller grabbed: when, and the cards in it. */
  const shots: { at: number; boxes: DetectedCardBox[] }[] = [];
  const createCanvas = canvasFactory(scene, () => shots.push({ at: clock.t, boxes: boxes.current }) - 1);
  /** The frame a dataUrl was cut from, and the dataUrl without its frame's name. */
  const shotOf = (dataUrl: string) => {
    const m = /#(\d+)$/.exec(dataUrl);
    if (!m) throw new Error(`a request from no grabbed frame: ${dataUrl}`);
    return { url: dataUrl.slice(0, m.index), ...shots[Number(m[1])] };
  };

  const views: LiveView[] = [];
  const send = vi.fn(async (msg: { type: string; [k: string]: unknown }) => {
    if (msg.type === 'live-analyze') {
      sent.push({ ...msg, type: 'live-detect', at: clock.t });
      const t0 = clock.t;
      // The engine finds the cards of the frame sent, and reads them from it: what the page shows meanwhile changes nothing.
      const shot = shotOf(msg.dataUrl as string);
      await work(engine.detectMs, 'detect');
      const out = await analyze(msg, shot.boxes, async (crop) => {
        sent.push({ type: 'recognize', crop, at: clock.t, inDetection: true });
        await work(engine.readMs, 'read', crop.dataUrl);
        return reads.next(crop.dataUrl, shot.at);
      }, () => clock.t - t0, true, createCanvas);
      return { detection: { boxes: shot.boxes, width: 1280, height: 720, ms: engine.detectMs }, reads: out };
    }
    sent.push({ ...msg, at: clock.t });
    if (msg.type === 'recognize') {
      const shot = shotOf((msg.crop as { dataUrl: string }).dataUrl); // cut from the frame its cycle grabbed
      await work(engine.readMs, 'read', shot.url);
      return reads.next(shot.url, shot.at);
    }
    if (msg.type === 'live-progress') {
      for (const x of (msg.progress as LiveProgress).sightings) listed.add(x.cardId);
      return { ok: true, count: listed.size };
    }
    return { ok: true };
  });
  const live = create({ doc: document, send: send as never, now, createCanvas, onView: (view) => views.push(view), toast: vi.fn() });

  let nextFrame = 0;
  const progress = () => sent.filter((m) => m.type === 'live-progress').map((m) => m.progress as LiveProgress);
  const advance = async (t: number) => {
    if (t > now()) vi.advanceTimersByTime(t - now());
    await flush();
  };
  return {
    live,
    video: v,
    views,
    sent,
    state,
    scene,
    clock,
    engine,
    boxes,
    reads,
    async run(end, each, frameMs = 50) {
      for (;;) {
        jobs.sort((a, b) => a.at - b.at);
        const job = jobs[0];
        const t = Math.min(nextFrame, job ? job.at : Infinity);
        if (t > end) {
          await advance(end);
          return;
        }
        if (job && job.at <= nextFrame) {
          await advance(job.at);
          jobs.shift();
          job.resolve();
          await flush();
          continue;
        }
        await advance(nextFrame);
        each?.(nextFrame);
        const cb = frame.pending;
        frame.pending = null;
        cb?.(nextFrame, { mediaTime: nextFrame / 1000 });
        await flush();
        nextFrame += frameMs;
      }
    },
    progress,
    sightings: () => progress().flatMap((p) => p.sightings),
    pointAt(c) {
      live.pointer((c.cx / 1280) * 960, (c.cy / 720) * 540);
    },
  };
}

/** The crop a read of `box` sends (its dataUrl names its size): which card the sim's engine read. */
export function urlOf(box: DetectedCardBox): string {
  const blank = (w: number, h: number) => {
    const c = {
      width: w,
      height: h,
      getContext: () => ({ drawImage() {}, getImageData: (_x: number, _y: number, gw: number, gh: number) => ({ width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) }) }),
      toDataURL: (type = 'image/png') => `data:${type};base64,FAKE-${c.width}x${c.height}`,
    };
    return c;
  };
  const grab = { canvas: blank(1280, 720), currentTime: 0, videoWidth: 1280, videoHeight: 720, contentBox: { x: 0, y: 0, w: 1280, h: 720 }, readable: true };
  return liveCrop(grab as never, box, blank as never).dataUrl;
}
