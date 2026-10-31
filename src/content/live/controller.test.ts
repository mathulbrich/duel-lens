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
  /** Every canvas made, as "WxH". */
  canvases: string[];
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
  const listed = new Set<number>();

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

  const canvases: string[] = [];
  const createCanvas = (w: number, h: number): CanvasLike => {
    canvases.push(`${w}x${h}`);
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
    if (msg.type === 'live-progress') {
      // The background answers the list's entry count.
      for (const x of (msg.progress as LiveProgress).sightings) listed.add(x.cardId);
      return { ok: true, count: listed.size };
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
    canvases,
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

describe('anchorFor', () => {
  it("returns the settled track's box in viewport pixels", async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.sightings()).toHaveLength(1);
    // Card 100x140 centred on (720, 450) of 1280x720, shown in a 960x540 video at (0, 0): scaled by 0.75.
    expect(r.live.anchorFor(ASH.id)).toEqual({ x: 502.5, y: 285, w: 75, h: 105 });
  });

  it("falls back to the video's top-right corner, 12 px in", async () => {
    await r.live.start(OPTS);
    r.video.getBoundingClientRect = () => ({ x: 100, y: 50, left: 100, top: 50, width: 640, height: 360, right: 740, bottom: 410, toJSON() {} }) as DOMRect;
    expect(r.live.anchorFor(OTHER.id)).toEqual({ x: 728, y: 62, w: 1, h: 1 });
  });

  it('keeps the loop reading and promoting while the card box is open', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    r.live.anchorFor(ASH.id); // what opening the box asks of the loop: nothing else
    r.boxes.current = [IN_ZONE_20, card(300, 200)];
    r.reads.next = () => recognized(OTHER);
    await r.tick(10_600, 20.6); // the 10 s refresh finds the second card
    await r.tick(11_100, 21.1);
    await r.tick(11_600, 21.6);
    expect(r.sightings().map((s) => s.cardId)).toEqual([ASH.id, OTHER.id]);
    expect(r.views.every((v) => v.showLabel)).toBe(true); // no scan session was opened
  });
});

describe('LiveView.cards', () => {
  it('lists voting and promoted tracks seen in the last detection; no cardId while voting', async () => {
    await r.live.start(OPTS);
    expect(r.views.at(-1)?.cards).toEqual([]);
    await r.tick(0, 10); // one confident read: still voting
    const voting = r.views.at(-1)!.cards;
    expect(voting).toEqual([{ trackId: expect.any(Number), state: 'voting', box: { x: 670 / 1280, y: 380 / 720, w: 100 / 1280, h: 140 / 720 } }]);
    expect(voting[0]).not.toHaveProperty('cardId');
    await r.tick(500, 10.5); // two: promoted
    expect(r.views.at(-1)?.cards).toEqual([{ trackId: voting[0].trackId, state: 'promoted', cardId: ASH.id, imageId: ASH.imageId, box: voting[0].box }]);
  });

  it('leaves out a rejected track', async () => {
    r.reads.next = () => ({ result: { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }, cards: {}, aiEnabled: false }) as RecognizeResponse;
    await r.live.start(OPTS);
    for (let i = 0; i < 6; i++) await r.tick(i * 500, 10 + i * 0.5);
    expect(r.views.at(-1)?.cards).toEqual([]);
  });

  it('drops a card the last detection did not find', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)?.cards).toHaveLength(1);
    r.boxes.current = [];
    r.scene[20] = 200; // the card leaves: its zone moves, then settles
    await r.tick(700, 10.7);
    await r.tick(900, 10.9);
    await r.tick(1100, 11.1);
    await r.tick(1300, 11.3);
    expect(r.count('live-detect')).toBeGreaterThan(1);
    expect(r.views.at(-1)?.cards).toEqual([]);
  });

  it('is empty while a scan is open or the label is off', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)?.cards).toHaveLength(1);
    r.live.setScanOpen(true);
    expect(r.views.at(-1)?.cards).toEqual([]);
    r.live.setScanOpen(false);
    expect(r.views.at(-1)?.cards).toHaveLength(1);
    r.live.setSettings({ effort: 'balanced', showLabel: false });
    expect(r.views.at(-1)?.cards).toEqual([]);
  });

  it('is empty once Live has stopped', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.live.stop('user');
    expect(r.views.at(-1)?.cards).toEqual([]);
  });

  it('a scene cut clears the outlines', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)?.cards).toHaveLength(1);
    r.scene.fill(255);
    await r.tick(700, 10.7);
    expect(r.views.at(-1)?.cards).toEqual([]);
  });
});

describe('a card replaced on its spot', () => {
  /** The card's zone (20) moves for a sample, then holds still until it settles. */
  async function moveAndSettle(from: number) {
    r.scene[20] = r.scene[20] === 200 ? 50 : 200;
    for (const dt of [0, 200, 400]) await r.tick(from + dt, 10 + (from + dt) / 1000); // the last: settled: detects, resets the track and reads once
  }
  const nothing = () => ({ result: { candidates: [], confident: false, faceDown: false, modelId: 'm', timings: {} }, cards: {}, aiEnabled: false }) as RecognizeResponse;

  it('reads a promoted card again once its zones moved and settled; the outline is dashed until confirmed', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.count('recognize')).toBe(2);
    await moveAndSettle(1000);
    expect(r.count('recognize')).toBe(3);
    const cards = r.views.at(-1)!.cards;
    expect(cards).toHaveLength(1);
    expect(cards[0].state).toBe('voting');
    expect(cards[0]).not.toHaveProperty('cardId');
    await r.tick(2500, 12.5);
    expect(r.count('recognize')).toBe(4);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
  });

  it('lists the new card, and the old name is gone from the track', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    r.reads.next = () => recognized(OTHER);
    await moveAndSettle(1000);
    expect(r.views.at(-1)!.cards.every((c) => c.cardId !== ASH.id)).toBe(true);
    await r.tick(2500, 12.5);
    expect(r.views.at(-1)!.cards).toEqual([expect.objectContaining({ state: 'promoted', cardId: OTHER.id, imageId: OTHER.imageId })]);
    expect(r.sightings().map((x) => x.cardId)).toEqual([ASH.id, OTHER.id]);
  });

  it('promoted again as the same card is no new sighting; as another card it is one', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    for (let t = 1000; t < 30000; t += 1000) await r.tick(t, 10 + t / 1000); // 30 s of a still table
    await moveAndSettle(30000); // a hand passes
    for (const t of [32500, 33000, 34000]) await r.tick(t, 10 + t / 1000);
    expect(r.views.at(-1)!.cards[0]).toMatchObject({ state: 'promoted', cardId: ASH.id });
    expect(r.sightings().map((x) => x.cardId)).toEqual([ASH.id]);
    r.reads.next = () => recognized(OTHER);
    for (let t = 33500; t < 60000; t += 1000) await r.tick(t, 10 + t / 1000);
    await moveAndSettle(60000);
    await r.tick(62500, 72.5);
    expect(r.sightings().map((x) => x.cardId)).toEqual([ASH.id, OTHER.id]);
  });

  it('a voting track drops its old votes when its zones moved and settled', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10); // one vote for ASH
    r.reads.next = () => recognized(OTHER);
    await moveAndSettle(1000);
    await r.tick(2500, 12.5);
    expect(r.sightings().map((x) => x.cardId)).toEqual([OTHER.id]);
  });

  it('motion elsewhere does not reset it', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    r.scene[0] = 200;
    await r.tick(1000, 11);
    await r.tick(1200, 11.2);
    await r.tick(1400, 11.4);
    await r.tick(2500, 12.5);
    expect(r.count('recognize')).toBe(2);
    expect(r.views.at(-1)!.cards[0].state).toBe('promoted');
  });

  it('reads a rejected track again after its zones moved and settled', async () => {
    r.reads.next = nothing;
    await r.live.start(OPTS);
    for (let i = 0; i < 6; i++) await r.tick(i * 500, 10 + i * 0.5);
    expect(r.count('recognize')).toBe(4);
    r.reads.next = () => recognized(OTHER);
    await moveAndSettle(4000);
    expect(r.count('recognize')).toBe(5);
    await r.tick(5500, 15.5);
    expect(r.views.at(-1)!.cards).toEqual([expect.objectContaining({ state: 'promoted', cardId: OTHER.id })]);
  });
});

describe('a player error and a removed video', () => {
  const setProps = (v: HTMLVideoElement, props: Record<string, unknown>) => {
    for (const [k, val] of Object.entries(props)) Object.defineProperty(v, k, { get: () => val, configurable: true });
  };
  const lastStatus = () => r.progress().at(-1)?.status;

  it('emptied: reports paused, drops the outlines and reads nothing; a loaded frame resumes with a new detect', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)!.cards).toHaveLength(1);
    const detects = r.count('live-detect');
    const reads = r.count('recognize');
    setProps(r.video, { videoWidth: 0, videoHeight: 0, readyState: 0 });
    r.video.dispatchEvent(new Event('emptied'));
    await flush();
    expect(lastStatus()).toBe('paused');
    expect(r.views.at(-1)).toMatchObject({ running: true, cards: [] });
    for (let i = 1; i <= 5; i++) await r.tick(1000 + i * 2000, 10.5 + 1 + i * 2);
    expect(r.count('live-detect')).toBe(detects);
    expect(r.count('recognize')).toBe(reads);
    setProps(r.video, { videoWidth: 1280, videoHeight: 720, readyState: 4 });
    r.video.dispatchEvent(new Event('loadeddata'));
    await flush();
    expect(lastStatus()).toBe('watching');
    await r.tick(12000, 22.5);
    expect(r.count('live-detect')).toBe(detects + 1);
  });

  it('an error event with a still-sized video also stops reading until a frame loads', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.video.dispatchEvent(new Event('error'));
    await flush();
    expect(lastStatus()).toBe('paused');
    expect(r.views.at(-1)!.cards).toEqual([]);
    r.video.dispatchEvent(new Event('playing'));
    await flush();
    expect(lastStatus()).toBe('watching');
  });

  it('a video of zero size is unusable at the next frame', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    setProps(r.video, { videoWidth: 0, videoHeight: 0 });
    const reads = r.count('recognize');
    await r.tick(2000, 12);
    expect(lastStatus()).toBe('paused');
    expect(r.count('recognize')).toBe(reads);
  });

  function otherVideo() {
    const v2 = document.createElement('video');
    setProps(v2, { readyState: 4, videoWidth: 1280, videoHeight: 720, paused: false, ended: false, seeking: false, currentSrc: 'b.mp4' });
    v2.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, toJSON() {} }) as DOMRect;
    const asked = vi.fn(() => 7);
    (v2 as unknown as Record<string, unknown>).requestVideoFrameCallback = asked;
    (v2 as unknown as Record<string, unknown>).cancelVideoFrameCallback = () => undefined;
    document.body.append(v2);
    return { v2, asked };
  }

  it('a removed video: Live follows another big video on the page', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const { v2, asked } = otherVideo();
    r.video.remove();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(r.views.at(-1)).toMatchObject({ running: true, video: v2, cards: [] });
    expect(asked).toHaveBeenCalled();
    expect(lastStatus()).toBe('watching');
  });

  it('a removed video with none left stops Live with no-video', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.video.remove();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(r.progress().at(-1)).toMatchObject({ status: 'stopped', stopReason: 'no-video' });
    expect(r.views.at(-1)!.running).toBe(false);
    expect(r.toast).toHaveBeenCalled();
  });

  it('a cycle in flight when the player empties drops its results: the fresh first detect still happens', async () => {
    let release!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (release = resolve));
    await r.live.start(OPTS);
    await r.tick(0, 10); // the detect is pending
    setProps(r.video, { videoWidth: 0, videoHeight: 0, readyState: 0 });
    r.video.dispatchEvent(new Event('emptied'));
    setProps(r.video, { videoWidth: 1280, videoHeight: 720, readyState: 4 });
    r.video.dispatchEvent(new Event('loadeddata'));
    r.detect.hold = null;
    release(); // the old cycle ends after the recovery
    await flush();
    await r.tick(1000, 11);
    expect(r.count('live-detect')).toBe(2);
  });

  it('a cycle in flight when the video is replaced drops its results', async () => {
    let release!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (release = resolve));
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const { asked } = otherVideo();
    r.video.remove();
    vi.advanceTimersByTime(1000);
    release();
    await flush();
    r.detect.hold = null;
    const frame = (asked.mock.calls[0] as unknown as [(now: number, m: { mediaTime: number }) => void])[0];
    frame(1000, { mediaTime: 11 });
    await flush();
    expect(r.count('live-detect')).toBe(2);
  });

  it('reports paused once and watching once across a pause, emptied and recovery', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const before = r.progress().length;
    r.state.paused = true;
    r.video.dispatchEvent(new Event('pause'));
    setProps(r.video, { videoWidth: 0, videoHeight: 0, readyState: 0 });
    r.video.dispatchEvent(new Event('emptied'));
    await flush();
    r.state.paused = false;
    setProps(r.video, { videoWidth: 1280, videoHeight: 720, readyState: 4 });
    r.video.dispatchEvent(new Event('playing'));
    await flush();
    expect(r.progress().slice(before).map((p) => p.status)).toEqual(['paused', 'watching']);
  });

  it('a one second stall keeps the tracks, a two second one drops them', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)!.cards).toHaveLength(1);
    setProps(r.video, { readyState: 1 });
    vi.advanceTimersByTime(1000);
    setProps(r.video, { readyState: 4 });
    vi.advanceTimersByTime(1000);
    await flush();
    expect(r.views.at(-1)!.cards).toHaveLength(1);
    expect(lastStatus()).not.toBe('paused');
    setProps(r.video, { readyState: 1 });
    vi.advanceTimersByTime(2000);
    await flush();
    expect(r.views.at(-1)!.cards).toEqual([]);
    expect(lastStatus()).toBe('paused');
  });

  it('does not take a small preview for the lost video', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const { v2 } = otherVideo();
    v2.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, width: 120, height: 68, right: 120, bottom: 68, toJSON() {} }) as DOMRect;
    r.video.remove();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(r.progress().at(-1)).toMatchObject({ status: 'stopped', stopReason: 'no-video' });
  });

  it('a removed video on another page ends the run as left, not as another video', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    otherVideo();
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.com/watch?v=b');
    r.video.remove();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(r.progress().at(-1)).toMatchObject({ status: 'stopped', stopReason: 'left' });
  });

  it('a re-picked video that cannot show frames is reported paused, not watching', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const { v2 } = otherVideo();
    setProps(v2, { videoWidth: 0, videoHeight: 0 });
    r.video.remove();
    vi.advanceTimersByTime(1000);
    await flush();
    expect(r.views.at(-1)).toMatchObject({ video: v2, cards: [] });
    expect(lastStatus()).toBe('paused');
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

  it('keeps one live-detect pending across a stop and a restart', async () => {
    let releaseOld!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (releaseOld = resolve));
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.live.stop('user');
    let releaseNew!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (releaseNew = resolve));
    await r.live.start(OPTS);
    await r.tick(0, 10); // the new run's own first cycle, pending
    releaseOld(); // the old cycle ends: it must not free the new run's slot
    await flush();
    for (let i = 1; i <= 5; i++) {
      wiggle(0, i);
      await r.tick(i * 2000, 10 + i * 2);
    }
    expect(r.count('live-detect')).toBe(2);
    releaseNew();
    await flush();
  });

  it('backs off after a cycle throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.boxes.current = [{ ...IN_ZONE_20, pts: undefined as never }]; // tracker.update throws on it
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(err).toHaveBeenCalled();
    expect(r.count('live-detect')).toBe(1);
    for (const at of [200, 400]) await r.tick(at, 10 + at / 1000);
    expect(r.count('live-detect')).toBe(1);
    err.mockRestore();
  });

  it('backs off after a rejected live-detect', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    r.detect.hold = Promise.reject(new Error('gone'));
    r.detect.hold.catch(() => undefined);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(warn).toHaveBeenCalled();
    for (const at of [200, 400]) await r.tick(at, 10 + at / 1000);
    expect(r.count('live-detect')).toBe(1);
    warn.mockRestore();
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

  it('seek still works after a stop while the page is the same page and the video is on it; not after the page changed', async () => {
    await r.live.start(OPTS);
    r.live.stop('user');
    r.live.seek(60);
    expect(r.video.currentTime).toBe(57);
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.com/watch?v=a&t=5#x');
    r.live.seek(90); // another page key (outside YouTube the key is the URL): the page changed
    expect(r.video.currentTime).toBe(57);
    (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://example.com/watch?v=a');
    r.video.remove();
    r.live.seek(30);
    expect(r.video.currentTime).toBe(57); // the video left the page
  });
});

describe('start while a run exists', () => {
  const setURL = (u: string) => (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(u);

  it('on the same page it takes the settings and reports where things stand, so the panel leaves "starting"', async () => {
    await r.live.start(OPTS);
    const before = r.progress().length;
    expect(await r.live.start({ effort: 'light', showLabel: false })).toEqual({ ok: true, pageKey: 'https://example.com/watch?v=a' });
    expect(r.progress()).toHaveLength(before + 1);
    expect(r.progress().at(-1)).toMatchObject({ status: 'watching' });
    expect(r.views.at(-1)).toMatchObject({ running: true, showLabel: false });
  });

  it('on another page it ends the old run quietly and starts a fresh one with the new page key', async () => {
    await r.live.start(OPTS);
    setURL('https://example.com/watch?v=b');
    expect(await r.live.start(OPTS)).toEqual({ ok: true, pageKey: 'https://example.com/watch?v=b' });
    expect(r.progress().filter((p) => p.status === 'stopped')).toEqual([]); // a stop report would end the new log
    expect(r.live.query()).toMatchObject({ running: true, pageKey: 'https://example.com/watch?v=b' });
  });
});

describe('guards', () => {
  it('stops locally, telling nobody, when the extension was updated under the page (no runtime id)', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    try {
      await r.live.start(OPTS);
      const sentBefore = r.sent.length;
      await r.tick(0, 10);
      expect(r.sent).toHaveLength(sentBefore);
      expect(r.live.query().running).toBe(false);
      expect(r.views.at(-1)).toMatchObject({ running: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps running while the extension is there (runtime id set)', async () => {
    vi.stubGlobal('chrome', { runtime: { id: 'abc' } });
    try {
      await r.live.start(OPTS);
      await r.tick(0, 10);
      expect(r.live.query().running).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a DRM video (mediaKeys set) that draws black stops as blocked on a detect cycle, without sending a frame', async () => {
    Object.defineProperty(r.video, 'mediaKeys', { value: {}, configurable: true });
    r.scene.fill(0);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.toast).toHaveBeenCalled();
    expect(r.progress().at(-1)).toMatchObject({ status: 'stopped', stopReason: 'blocked' });
    expect(r.count('live-detect')).toBe(0);
  });

  it('a black frame without mediaKeys is an ordinary dark scene', async () => {
    r.scene.fill(0);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.count('live-detect')).toBe(1);
  });

  it('samples the gate thumbnail on one canvas, not a new one per sample', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(300, 10.3);
    await r.tick(600, 10.6);
    expect(r.canvases.filter((c) => c === '64x36')).toHaveLength(1);
  });

  it('shows the list count the background answers on the pill, not a count of its own', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)?.count).toBe(1);
  });
});
