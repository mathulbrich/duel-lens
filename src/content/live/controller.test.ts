// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE } from './gate';
import type { LiveProgress, LiveSighting } from '../../shared/live';
import type { DetectedCardBox, RecognizeResponse } from '../../shared/messages';
import type { CanvasLike } from '../capture';
import { createLiveController, type LiveController, type LiveView } from './controller';

const ASH = { id: 14558127, imageId: 14558128 };
const OTHER = { id: 23434538, imageId: 23434539 };

/** An upright card centred on (cx, cy) in the 1280x720 frame. */
const card = (cx: number, cy: number, w = 100, h = 140): DetectedCardBox => ({
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
/** Zone 20 (row 2, column 4) holds this card: x 0.52-0.60, y 0.53-0.72 of the video. */
const IN_ZONE_20 = card(720, 450);

const recognized = (who: { id: number; imageId: number }, confident = true): RecognizeResponse =>
  ({
    result: { candidates: [{ cardId: who.id, imageId: who.imageId, score: 0.9 }], confident, faceDown: false, modelId: 'm', timings: {} },
    cards: {},
    aiEnabled: false,
  }) as RecognizeResponse;

interface Rig {
  live: LiveController;
  video: HTMLVideoElement;
  views: LiveView[];
  toast: ReturnType<typeof vi.fn>;
  /** Everything sent, in order. */
  sent: { type: string; [k: string]: unknown }[];
  /** The video's state, as the page would change it. */
  state: { paused: boolean; seeking: boolean; currentSrc: string; currentTime: number };
  /** Brightness (0-255) of each of the 32 zones in the next thumbnail. */
  scene: number[];
  /** Wall clock (ms) the controller sees. */
  clock: { t: number };
  /** How long each detect and each recognize takes on that clock, ms. */
  cost: { ms: number };
  boxes: { current: DetectedCardBox[] };
  reads: { next: () => RecognizeResponse };
  detect: { hold: Promise<void> | null };
  tainted: { on: boolean };
  /** Delivers one video frame to the controller and lets its work finish. */
  tick(now: number, mediaTime: number): Promise<void>;
  count(type: string): number;
  progress(): LiveProgress[];
  sightings(): LiveSighting[];
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function rig(): Rig {
  const state = { paused: false, seeking: false, currentSrc: 'a.mp4', currentTime: 0 };
  const scene = new Array<number>(32).fill(50);
  const clock = { t: 0 };
  const cost = { ms: 0 };
  const boxes = { current: [IN_ZONE_20] };
  const reads = { next: () => recognized(ASH) };
  const detect: Rig['detect'] = { hold: null };
  const tainted = { on: false };
  const sent: Rig['sent'] = [];

  const v = document.createElement('video');
  const def = (name: string, get: () => unknown) => Object.defineProperty(v, name, { get, configurable: true });
  def('paused', () => state.paused);
  def('seeking', () => state.seeking);
  def('ended', () => false);
  def('readyState', () => 4);
  def('videoWidth', () => 1280);
  def('videoHeight', () => 720);
  def('currentSrc', () => state.currentSrc);
  Object.defineProperty(v, 'currentTime', { get: () => state.currentTime, set: (x: number) => void (state.currentTime = x), configurable: true });
  v.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540, toJSON() {} }) as DOMRect;
  let pending: ((now: number, meta: { mediaTime: number }) => void) | null = null;
  (v as unknown as Record<string, unknown>).requestVideoFrameCallback = (cb: typeof pending) => {
    pending = cb;
    return 1;
  };
  (v as unknown as Record<string, unknown>).cancelVideoFrameCallback = () => void (pending = null);
  document.body.append(v);

  const createCanvas = (w: number, h: number): CanvasLike => {
    const canvas: CanvasLike = {
      width: w,
      height: h,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: (_x: number, _y: number, gw: number, gh: number) => {
          if (w === GATE.w && h === GATE.h) {
            const data = new Uint8ClampedArray(gw * gh * 4);
            for (let y = 0; y < gh; y++) {
              for (let x = 0; x < gw; x++) {
                const zone = Math.floor(y / (GATE.h / GATE.rows)) * GATE.cols + Math.floor(x / (GATE.w / GATE.cols));
                data.fill(scene[zone], (y * gw + x) * 4, (y * gw + x) * 4 + 3);
                data[(y * gw + x) * 4 + 3] = 255;
              }
            }
            return { width: gw, height: gh, data };
          }
          if (tainted.on) throw new DOMException('tainted', 'SecurityError');
          return { width: gw, height: gh, data: new Uint8ClampedArray(gw * gh * 4) };
        },
      }),
      toDataURL: (type = 'image/png') => `data:${type};base64,FAKE-${canvas.width}x${canvas.height}`,
    };
    return canvas;
  };

  const views: LiveView[] = [];
  const toast = vi.fn();
  const send = vi.fn(async (msg: { type: string; [k: string]: unknown }) => {
    sent.push(msg);
    if (msg.type === 'live-detect') {
      await detect.hold;
      clock.t += cost.ms;
      return { detection: { boxes: boxes.current, width: 1280, height: 720, ms: 5 } };
    }
    if (msg.type === 'recognize') {
      clock.t += cost.ms;
      return reads.next();
    }
    return { ok: true };
  });
  const live = createLiveController({
    doc: document,
    send: send as never,
    now: () => clock.t,
    createCanvas,
    onView: (view) => views.push(view),
    toast,
  });

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
    tainted,
    async tick(now, mediaTime) {
      const cb = pending;
      pending = null;
      cb?.(now, { mediaTime });
      await flush();
    },
    count: (type) => sent.filter((m) => m.type === type).length,
    progress,
    sightings: () => progress().flatMap((p) => p.sightings),
  };
}

const OPTS = { effort: 'balanced', showLabel: true } as const;
let r: Rig;

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.com/watch?v=a');
  r = rig();
});
afterEach(() => {
  r.live.stop('user');
  vi.useRealTimers();
  document.body.innerHTML = '';
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
});

/** Moves one zone (alternating bright and dark) on every sample; call with the sample number. */
const wiggle = (zone: number, n: number) => (r.scene[zone] = n % 2 ? 0 : 150);

describe('start', () => {
  it('answers no-video when the page has no usable video', async () => {
    document.body.innerHTML = '';
    expect(await r.live.start(OPTS)).toEqual({ ok: false, reason: 'no-video' });
  });

  it('shows the label while running and hides it while a scan session is open', async () => {
    await r.live.start(OPTS);
    expect(r.views.at(-1)).toMatchObject({ running: true, showLabel: true, video: r.video });
    r.live.setScanOpen(true);
    expect(r.views.at(-1)).toMatchObject({ running: true, showLabel: false });
    r.live.setScanOpen(false);
    expect(r.views.at(-1)).toMatchObject({ running: true, showLabel: true });
  });
});

describe('the loop', () => {
  it('promotes a card after two confident reads and reports it once', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.sightings()).toEqual([]);
    await r.tick(500, 10.5);
    expect(r.sightings()).toEqual([{ cardId: ASH.id, imageId: ASH.imageId, videoTime: 10.5 }]);
    expect(r.views.at(-1)?.count).toBe(1);
    await r.tick(1000, 11);
    await r.tick(1500, 11.5);
    expect(r.sightings()).toHaveLength(1);
    expect(r.progress().filter((p) => p.sightings.length)).toHaveLength(1);
    expect(r.progress()[0]).toMatchObject({ status: 'watching', sightings: [] });
    expect(r.count('recognize')).toBe(2); // promoted: not read again
  });

  it('reads recognize with record false and the page context', async () => {
    document.title = 'Duel replay';
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.sent.find((m) => m.type === 'recognize')).toMatchObject({
      record: false,
      context: { pageUrl: 'https://example.com/watch?v=a', pageTitle: 'Duel replay', videoTime: 10 },
    });
  });

  it('runs the detector when a zone settles, not while it moves', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.count('live-detect')).toBe(1);
    for (let i = 1; i <= 10; i++) {
      wiggle(0, i);
      await r.tick(i * 200, 10 + i * 0.2);
    }
    expect(r.count('live-detect')).toBe(1);
    await r.tick(2200, 12.2); // still: 1 quiet sample
    expect(r.count('live-detect')).toBe(1);
    await r.tick(2400, 12.4); // 2 quiet samples: settled
    expect(r.count('live-detect')).toBe(2);
  });

  it('reads a voting card again from its last box without the detector', async () => {
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect([r.count('live-detect'), r.count('recognize')]).toEqual([1, 1]);
    await r.tick(500, 10.5);
    expect([r.count('live-detect'), r.count('recognize')]).toEqual([1, 2]);
  });

  it('does not read a card while its zones move, but does on the 10 s refresh', async () => {
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    for (let i = 1; i < 50; i++) {
      wiggle(20, i);
      await r.tick(i * 200, 10 + i * 0.2);
    }
    expect([r.count('live-detect'), r.count('recognize')]).toEqual([1, 1]);
    wiggle(20, 50);
    await r.tick(10_000, 20);
    expect([r.count('live-detect'), r.count('recognize')]).toEqual([2, 2]);
  });

  it('reads a card lying still while another zone keeps moving', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    wiggle(0, 1);
    await r.tick(600, 10.6);
    expect(r.sightings().map((s) => s.cardId)).toEqual([ASH.id]);
  });

  it("takes the read frame's mediaTime as the video time", async () => {
    await r.live.start(OPTS);
    r.state.currentTime = 61.9;
    await r.tick(0, 60.7);
    await r.tick(500, 61.2);
    expect(r.sightings()).toEqual([{ cardId: ASH.id, imageId: ASH.imageId, videoTime: 61.2 }]);
  });

  it.each<[string, () => void, number]>([
    ['a seek', () => void r.video.dispatchEvent(new Event('seeking')), 10.5],
    ['a new source', () => void (r.state.currentSrc = 'b.mp4'), 10.5],
    ['a media-time jump', () => undefined, 60],
  ])('drops every track on %s', async (_name, cause, media) => {
    await r.live.start(OPTS);
    await r.tick(0, 10); // track 1: one confident read
    cause();
    await r.tick(600, media); // the cut: every zone moves
    await r.tick(800, media + 0.2);
    await r.tick(1000, media + 0.4); // settled: detected again, a new track
    expect(r.count('live-detect')).toBe(2);
    expect(r.sightings()).toEqual([]); // the old track's read is gone: the new one has a single read
    await r.tick(1600, media + 1);
    expect(r.sightings().map((x) => x.cardId)).toEqual([ASH.id]);
  });

  it('drops all tracks on a scene cut', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.scene.fill(255); // the whole picture changes: mean diff 205
    await r.tick(600, 10.6);
    r.scene.fill(30);
    await r.tick(800, 10.8);
    await r.tick(1000, 11);
    await r.tick(1200, 11.2);
    expect(r.count('live-detect')).toBe(2);
    expect(r.sightings()).toEqual([]);
  });

  it('never sends a second frame while one is in flight', async () => {
    let release!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (release = resolve));
    await r.live.start(OPTS);
    await r.tick(0, 10);
    for (let i = 1; i <= 5; i++) {
      wiggle(0, i);
      await r.tick(i * 2000, 10 + i * 2);
    }
    expect(r.count('live-detect')).toBe(1);
    expect(r.count('recognize')).toBe(0);
    release();
    await flush();
    expect(r.count('recognize')).toBe(1);
  });

  it('waits the rate interval between cycles', async () => {
    r.cost.ms = 100;
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10); // detect 100 ms + read 100 ms = 200 ms: wait 1000 ms
    expect(r.count('recognize')).toBe(1);
    for (const at of [200, 400, 600, 800, 999]) await r.tick(at, 10 + at / 1000);
    expect(r.count('recognize')).toBe(1);
    await r.tick(1000, 11);
    expect(r.count('recognize')).toBe(2);
    expect(r.progress()[0].intervalMs).toBe(1000);
  });

  it('query reports the step timings', async () => {
    await r.live.start(OPTS);
    expect(r.live.query().stats).toEqual({ thumbMs: [], encodeMs: [], cropMs: [] });
    await r.tick(0, 10);
    const q = r.live.query();
    expect(q.running).toBe(true);
    expect(q.pageKey).toBe('https://example.com/watch?v=a');
    expect(q.stats.thumbMs.length).toBeGreaterThan(0);
    expect(q.stats.encodeMs.length).toBeGreaterThan(0);
    expect(q.stats.cropMs.length).toBeGreaterThan(0);
  });
});

describe('pausing and stopping', () => {
  it('pauses with the video and the page', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const before = r.sent.length;

    r.state.paused = true;
    r.video.dispatchEvent(new Event('pause'));
    await flush();
    expect(r.progress().at(-1)).toMatchObject({ status: 'paused', sightings: [] });
    expect(r.views.at(-1)?.paused).toBe(true);
    const after = r.sent.length;
    expect(after).toBe(before + 1);
    for (let i = 1; i < 5; i++) await r.tick(i * 2000, 10);
    expect(r.sent.length).toBe(after);

    r.state.paused = false;
    r.video.dispatchEvent(new Event('play'));
    await flush();
    expect(r.progress().at(-1)).toMatchObject({ status: 'watching' });

    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(r.progress().at(-1)).toMatchObject({ status: 'paused' });
    const hiddenAt = r.sent.length;
    await r.tick(20_000, 30);
    expect(r.sent.length).toBe(hiddenAt);
  });

  it('compares nothing on the first sample after a pause', async () => {
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.state.paused = true;
    r.video.dispatchEvent(new Event('pause'));
    r.scene.fill(200); // the picture changed while paused: against the old one that would be a cut (diff 150)
    r.state.paused = false;
    r.video.dispatchEvent(new Event('play'));
    await r.tick(5000, 10);
    expect(r.count('recognize')).toBe(2); // the track survived and was read
    expect(r.count('live-detect')).toBe(1);
  });

  it('stops as blocked on an unreadable frame', async () => {
    r.tainted.on = true;
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.progress().at(-1)).toMatchObject({ status: 'stopped', stopReason: 'blocked' });
    expect(r.toast).toHaveBeenCalledWith(expect.stringContaining('blocks screenshots'));
    expect(r.live.query().running).toBe(false);
    expect(r.count('live-detect')).toBe(0);
  });

  it("stops when the page's video changes", async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.com/watch?v=other');
    await r.tick(500, 10.5);
    expect(r.progress().at(-1)).toMatchObject({ status: 'stopped', stopReason: 'left' });
    expect(r.views.at(-1)?.running).toBe(false);
  });

  it('reads nothing while a scan session is open, and compares nothing after it', async () => {
    await r.live.start(OPTS);
    r.live.setScanOpen(true);
    await r.tick(0, 10);
    await r.tick(2000, 12);
    expect(r.sent).toEqual([]);
    r.live.setScanOpen(false);
    await r.tick(4000, 14);
    expect(r.count('live-detect')).toBe(1);
  });

  it('seek sets the video 3 s before the given time', async () => {
    await r.live.start(OPTS);
    r.live.seek(60);
    expect(r.video.currentTime).toBe(57);
    r.live.seek(1);
    expect(r.video.currentTime).toBe(0);
  });

  it('stop reports the reason once and ends the loop', async () => {
    await r.live.start(OPTS);
    r.live.stop('other-tab');
    r.live.stop('user');
    expect(r.progress()).toEqual([{ status: 'stopped', stopReason: 'other-tab', voting: 0, sightings: [] }]);
    await r.tick(0, 10);
    expect(r.sent).toHaveLength(1);
  });
});
