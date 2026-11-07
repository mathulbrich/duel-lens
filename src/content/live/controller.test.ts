// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATE } from './gate';
import type { LiveProgress, LiveSighting } from '../../shared/live';
import type { DetectedCardBox, RecognizeResponse } from '../../shared/messages';
import type { CanvasLike } from '../capture';
import { createLiveController, HOVER, type LiveController, type LiveView } from './controller';
import { TRACK } from './tracker';

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

/** A read of `who`; confident ones score 0.82 by default, under VOTE.clear: two agreeing reads promote. */
const recognized = (who: { id: number; imageId: number }, confident = true, score = 0.82): RecognizeResponse =>
  ({
    result: { candidates: [{ cardId: who.id, imageId: who.imageId, score }], confident, faceDown: false, modelId: 'm', timings: {} },
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
  /** Brightness (0-255) of each of 32 regions (8 x 4, row-major) in the next thumbnail; each covers 2x2 of the gate's zones. */
  scene: number[];
  /** Wall clock (ms) the controller sees. */
  clock: { t: number };
  /** How long each detect and each recognize takes on that clock, ms. */
  cost: { ms: number };
  /** How long each gate thumbnail takes on that clock, ms. */
  thumb: { ms: number };
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
  const thumb = { ms: 0 };
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
            clock.t += thumb.ms;
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
    thumb,
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
  it('lists voting and promoted tracks seen in the last detection; a voting one read sure once carries its card (the box shows it)', async () => {
    await r.live.start(OPTS);
    expect(r.views.at(-1)?.cards).toEqual([]);
    await r.tick(0, 10); // one confident read: still voting, but its card is known for the box
    const voting = r.views.at(-1)!.cards;
    expect(voting).toEqual([{ trackId: expect.any(Number), state: 'voting', cardId: ASH.id, imageId: ASH.imageId, box: { x: 670 / 1280, y: 380 / 720, w: 100 / 1280, h: 140 / 720 } }]);
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
    const before = r.views.at(-1)!.cards[0].trackId;
    r.scene.fill(255);
    await r.tick(700, 10.7); // the cut's frame is searched at once: only new tracks
    expect(r.views.at(-1)!.cards.every((c) => c.trackId !== before)).toBe(true);
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
    expect(cards[0].state).toBe('voting'); // dashed until confirmed (its one sure read names it for the box)
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

  it('starts on the video Live check pointed at (a smaller one), and on the largest when none is given', async () => {
    const { v2, asked } = otherVideo(); // 800 x 450, smaller than the rig's 960 x 540
    expect((await r.live.start({ ...OPTS, video: v2 })).ok).toBe(true);
    expect(asked).toHaveBeenCalled();
    expect(r.views.at(-1)?.video).toBe(v2);
  });

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

  it('a cycle in flight across a seek drops its results', async () => {
    let release!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (release = resolve));
    await r.live.start(OPTS);
    await r.tick(0, 10); // the detect is pending
    r.video.dispatchEvent(new Event('seeking'));
    r.detect.hold = null;
    release(); // its boxes are from before the seek
    await flush();
    expect(r.count('recognize')).toBe(0);
    expect(r.views.at(-1)!.cards).toEqual([]);
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

  it('a stall that ended gives the next one its grace again', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    setProps(r.video, { readyState: 1 });
    vi.advanceTimersByTime(2000);
    await flush();
    expect(lastStatus()).toBe('paused');
    setProps(r.video, { readyState: 4 });
    r.video.dispatchEvent(new Event('playing'));
    await flush();
    expect(lastStatus()).toBe('watching');
    setProps(r.video, { readyState: 1 }); // buffering again at once, after a seek
    r.video.dispatchEvent(new Event('seeked'));
    await flush();
    expect(lastStatus()).toBe('watching');
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
  /** Points at the middle of the first outlined card (the rig's video fills 960 x 540 px at the page's corner). */
  const pointAtCard = () => {
    const b = r.views.at(-1)!.cards[0].box;
    r.live.pointer((b.x + b.w / 2) * 960, (b.y + b.h / 2) * 540);
  };

  it('a card the pointer comes to is read at once, HOVER.freshReads times, then sooner than the rate would, even while it moves', async () => {
    r.cost.ms = 300;
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10); // detect + read 1; the first cycle waits the floor
    expect(r.count('recognize')).toBe(1);
    pointAtCard();
    wiggle(20, 1); // the card's zones keep moving
    await r.tick(200, 10.2);
    expect(r.count('recognize')).toBe(1); // HOVER.gapMs after the last cycle's start: not yet
    await r.tick(250, 10.25); // at once, not after the last cycle's 600 ms and a read's 300: read 2
    expect(r.count('recognize')).toBe(2);
    wiggle(20, 2);
    await r.tick(500, 10.5); // the rate's cycle: read 3, the second since the pointer came
    expect(r.count('recognize')).toBe(3);
    wiggle(20, 3);
    await r.tick(1000, 11); // now the last cycle's 300 ms, then a pulled read's 300 ms, from its start
    expect(r.count('recognize')).toBe(3);
    wiggle(20, 4);
    await r.tick(1100, 11.1); // not 1357, the rate's, while its zones move
    expect(r.count('recognize')).toBe(4);
  });

  it('at Speed Light each read goes to the Light model (light), and at the others it does not', async () => {
    r.reads.next = () => recognized(ASH, false);
    await r.live.start({ effort: 'light', showLabel: true });
    await r.tick(0, 10);
    const light = () => r.sent.filter((m) => m.type === 'recognize').map((m) => (m as unknown as { crop: { light?: boolean } }).crop.light);
    expect(light()).toEqual([true]);
    r.live.setSettings({ effort: 'balanced', showLabel: true });
    await r.tick(2100, 12.1);
    expect(light().slice(1)).toEqual([undefined]);
  });

  it("at Speed Best each read asks the engine for every view at once (thorough); at the others it doesn't", async () => {
    r.reads.next = () => recognized(ASH, false); // never sure: the card is read again each cycle
    await r.live.start({ effort: 'best', showLabel: true });
    await r.tick(0, 10);
    const thorough = () => r.sent.filter((m) => m.type === 'recognize').map((m) => (m as unknown as { crop: { thorough?: boolean } }).crop.thorough);
    expect(thorough()).toEqual([true]);
    r.live.setSettings({ effort: 'balanced', showLabel: true });
    await r.tick(600, 10.6);
    expect(thorough()).toEqual([true, undefined]);
  });

  it('the view is not ready (the pill says getting ready) until a detection has answered', async () => {
    await r.live.start(OPTS);
    expect(r.views.at(-1)).toMatchObject({ running: true, ready: false });
    await r.tick(0, 10);
    expect(r.views.at(-1)).toMatchObject({ running: true, ready: true });
    r.live.stop('user');
    await r.live.start(OPTS); // a new run: not ready until its own first detection (the engine may have gone)
    expect(r.views.at(-1)).toMatchObject({ running: true, ready: false });
  });

  it('a card a search finds under the resting pointer counts that first read in its visit', async () => {
    r.cost.ms = 300;
    r.reads.next = () => recognized(ASH, false);
    const c = card(640, 360);
    r.boxes.current = [];
    await r.live.start(OPTS);
    await r.tick(0, 10); // nothing found
    r.boxes.current = [c];
    r.live.pointer((c.cx / 1280) * 960, (c.cy / 720) * 540);
    await r.tick(600, 10.6); // the search finds it, and reads it: read 1 of the visit
    expect(r.count('recognize')).toBe(1);
    await r.tick(850, 10.85); // read 2, at once
    expect(r.count('recognize')).toBe(2);
    await r.tick(1100, 11.1); // no third at once: the visit's two are done
    expect(r.count('recognize')).toBe(2);
  });

  it('a card the pointer comes back to is read at once again', async () => {
    r.cost.ms = 300;
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    pointAtCard();
    await r.tick(250, 10.25);
    await r.tick(500, 10.5);
    expect(r.count('recognize')).toBe(3);
    r.live.pointer(5, 5); // off the card, on the picture
    pointAtCard(); // and back: a new visit
    await r.tick(750, 10.75); // HOVER.gapMs after the last start, not 1100
    expect(r.count('recognize')).toBe(4);
  });

  it('a cycle the pointer pulls reads the pointed card alone and does not bring the next cycle sooner', async () => {
    r.cost.ms = 100;
    r.reads.next = () => recognized(ASH, false);
    const small = card(900, 300);
    r.boxes.current = [card(300, 300, 130, 182), small];
    await r.live.start(OPTS);
    await r.tick(0, 10); // detect + both read; the first cycle waits the floor
    await r.tick(500, 10.5); // both read, 200 ms: the next in 1000 ms
    const crops = () => r.sent.filter((m) => m.type === 'recognize').map((m) => (m as unknown as { crop: { dataUrl: string } }).crop.dataUrl);
    expect(crops()).toHaveLength(4);
    r.live.pointer((small.cx / 1280) * 960, (small.cy / 720) * 540);
    await r.tick(700, 10.7);
    expect(crops()).toHaveLength(4); // the last cycle's 200 ms and a read's 100 ms have not passed since its start
    await r.tick(800, 10.8);
    expect(crops()).toHaveLength(5);
    expect(crops()[4]).toBe(crops()[1]); // the pointed card alone
    r.live.pointerGone();
    await r.tick(1300, 11.3); // the pulled cycle's own wait ended at 1300: the rate's cycle stays at 1500
    expect(crops()).toHaveLength(5);
    await r.tick(1500, 11.5);
    expect(crops()).toHaveLength(7);
  });

  it('the pointer on a spot with no card known searches the picture there', async () => {
    r.boxes.current = [];
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.count('live-detect')).toBe(1);
    r.live.pointer(100, 100);
    await r.tick(600, 10.6);
    expect(r.count('live-detect')).toBe(2);
    await r.tick(800, 10.8); // not again so soon
    expect(r.count('live-detect')).toBe(2);
  });

  it('a pointer off the picture, or idle for HOVER.activeMs, does not pull the loop', async () => {
    r.boxes.current = [];
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.live.pointer(5000, 5000);
    await r.tick(600, 10.6);
    expect(r.count('live-detect')).toBe(1);
    r.live.pointer(100, 100);
    r.clock.t += 10_000;
    await r.tick(700, 10.7);
    expect(r.count('live-detect')).toBe(1);
  });

  it('a pointer resting on a card still being read keeps pulling the loop after HOVER.activeMs; gone, it does not', async () => {
    r.cost.ms = 300;
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5); // the next in 1500 ms
    pointAtCard();
    r.clock.t += HOVER.activeMs; // no move since
    await r.tick(1100, 11.1);
    expect(r.count('recognize')).toBe(3);
    r.live.pointerGone();
    await r.tick(1800, 11.8);
    expect(r.count('recognize')).toBe(3);
  });

  it('a spot searched with nothing found is not searched again until the pointer moves away or HOVER.emptyMs passes', async () => {
    r.boxes.current = [];
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.live.pointer(100, 100);
    await r.tick(600, 10.6); // searched: nothing
    for (const at of [1200, 1800]) await r.tick(at, 10 + at / 1000);
    expect(r.count('live-detect')).toBe(2);
    r.live.pointer(300, 300); // elsewhere
    await r.tick(2400, 12.4);
    expect(r.count('live-detect')).toBe(3);
  });

  it('reads the pointed card first among the cards waiting, at most TRACK.readsPerCycle a cycle', async () => {
    r.reads.next = () => recognized(ASH, false);
    const big = card(130, 180, 160, 224);
    const rest = [150, 140, 130, 120, 115, 110, 105, 100].map((w, i) => card(130 + ((i + 1) % 5) * 240, i < 4 ? 180 : 520, w, w * 1.4));
    r.boxes.current = [big, ...rest];
    await r.live.start(OPTS);
    await r.tick(0, 10); // the 8 largest read once; the smallest not yet, so it would come first next
    const crops = () => r.sent.filter((m) => m.type === 'recognize').map((m) => (m as unknown as { crop: { dataUrl: string } }).crop.dataUrl);
    expect(crops()).toHaveLength(TRACK.readsPerCycle);
    const bigCrop = crops()[0];
    r.live.pointer((big.cx / 1280) * 960, (big.cy / 720) * 540);
    await r.tick(500, 10.5); // the rate's cycle, not a pulled one: every card waiting, the pointed one first
    expect(crops()).toHaveLength(2 * TRACK.readsPerCycle);
    expect(crops()[TRACK.readsPerCycle]).toBe(bigCrop);
  });

  it('a clear read of a card whose zones move does not list it alone', async () => {
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.reads.next = () => recognized(ASH, true, 0.95);
    pointAtCard();
    wiggle(20, 1); // a hand over the card
    await r.tick(250, 10.25);
    expect(r.count('recognize')).toBe(2); // read under the pointer while it moves
    expect(r.sightings()).toEqual([]); // one clear read of a moving card: not listed (a second that agrees lists it)
  });

  it('a card the pointer goes to during a cycle is read next, ahead of the cards still waiting', async () => {
    const small = card(1000, 150, 90, 126);
    r.boxes.current = [card(300, 150, 130, 182), card(650, 150, 110, 154), small];
    let reads = 0;
    r.reads.next = () => {
      if (++reads === 1) r.live.pointer((small.cx / 1280) * 960, (small.cy / 720) * 540); // while the first is read
      return recognized(ASH, false);
    };
    await r.live.start(OPTS);
    await r.tick(0, 10);
    const crops = r.sent.filter((m) => m.type === 'recognize').map((m) => (m as unknown as { crop: { width: number } }).crop.width);
    expect(crops).toHaveLength(3);
    expect(crops[1]).toBeLessThan(crops[2]); // the small card second, then the middle one
  });

  it('a slow computer reads one card a cycle (LIVE.readBudgetMs), a fast one every card waiting', async () => {
    r.reads.next = () => recognized(ASH, false);
    r.boxes.current = [card(200, 150), card(600, 150), card(1000, 150), IN_ZONE_20];
    r.cost.ms = 400; // detection 400 ms, each read 400 ms
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.count('recognize')).toBe(1);
    r.cost.ms = 20;
    await r.tick(500, 10.5);
    expect(r.count('recognize')).toBe(5); // a fast read: all four waiting
  });

  it('a very clear read promotes the card on the first cycle', async () => {
    r.reads.next = () => recognized(ASH, true, 0.93);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    expect(r.sightings()).toEqual([{ cardId: ASH.id, imageId: ASH.imageId, videoTime: 10 }]);
    expect(r.count('recognize')).toBe(1);
  });

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
    await r.tick(600, media); // the cut
    await r.tick(800, media + 0.2);
    await r.tick(1000, media + 0.4); // the first decoded frame after it is searched at once, and its card read
    expect(r.count('live-detect')).toBe(2);
    expect(r.sightings()).toEqual([]); // the old track's read is gone: the new one has a single read
    for (const t of [1600, 2200, 2800]) await r.tick(t, media + (t - 600) / 1000);
    expect(r.sightings().map((x) => x.cardId)).toEqual([ASH.id]); // a second read lists it
  });

  it('drops all tracks on a scene cut', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.scene.fill(255); // the whole picture changes: mean diff 205
    await r.tick(600, 10.6); // the cut's frame is searched at once
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

  it('waits the rate interval between cycles; the first cycle, which waits for the reader to load, does not set it', async () => {
    r.cost.ms = 200;
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10); // detect 200 ms + read 200 ms, but the first cycle waits the floor: 500 ms
    expect(r.progress()[0].intervalMs).toBe(500);
    await r.tick(400, 10.4);
    expect(r.count('recognize')).toBe(1);
    await r.tick(500, 10.5); // a read alone: 200 ms, so 1000 ms
    expect(r.count('recognize')).toBe(2);
    expect(r.progress().at(-1)!.intervalMs).toBe(1000);
  });

  it('a zone settling away from the cards waits while a card waits to be read: the search comes 2 s after the last', async () => {
    r.reads.next = () => recognized(ASH, false);
    await r.live.start(OPTS);
    await r.tick(0, 10);
    r.scene[0] = 200; // a hand far from the card
    for (const at of [200, 400, 600]) await r.tick(at, 10 + at / 1000); // settled at 600
    expect(r.count('live-detect')).toBe(1);
    expect(r.count('recognize')).toBe(2);
    await r.tick(1100, 11.1);
    expect(r.count('live-detect')).toBe(1);
    await r.tick(2100, 12.1);
    expect(r.count('live-detect')).toBe(2);
  });

  it('samples the gate less often when a sample is costly (a slow computer)', async () => {
    r.thumb.ms = 50; // at most a tenth of the time: every 500 ms
    await r.live.start(OPTS);
    for (let at = 0; at <= 2000; at += 100) await r.tick(at, 10 + at / 1000);
    expect(r.live.query().stats.thumbMs).toHaveLength(5);
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
  /** Lets the still-frame timer run `ms` and the cycles it starts settle. */
  const still = async (ms: number) => {
    vi.advanceTimersByTime(ms);
    await flush();
  };

  it("reads a paused video's still frame: one detection, reads until its card is listed, then rests", async () => {
    r.state.paused = true;
    await r.live.start(OPTS);
    await still(0);
    expect(r.count('live-detect')).toBe(1);
    expect(r.progress().at(-1)!.status).toBe('watching');
    await still(500);
    expect(r.sightings().map((x) => x.cardId)).toEqual([ASH.id]);
    expect(r.views.at(-1)!.cards[0].state).toBe('promoted');
    await still(500);
    expect(r.progress().at(-1)!.status).toBe('paused');
    const sent = r.sent.length;
    await still(5000);
    expect(r.sent.length).toBe(sent);
  });

  it('a seek while paused reads the new still frame', async () => {
    r.state.paused = true;
    await r.live.start(OPTS);
    await still(1000);
    r.state.seeking = true;
    r.video.dispatchEvent(new Event('seeking'));
    r.state.seeking = false;
    r.video.dispatchEvent(new Event('seeked'));
    await still(0);
    expect(r.count('live-detect')).toBe(2);
  });

  it('reads the still frame of a hidden page once it shows again', async () => {
    r.state.paused = true;
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    await r.live.start(OPTS);
    await still(2000);
    expect(r.count('live-detect')).toBe(0);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await still(0);
    expect(r.count('live-detect')).toBe(1);
  });

  it('a paused video off screen is tried again until it shows, not marked as read', async () => {
    await r.live.start(OPTS);
    const onScreen = r.video.getBoundingClientRect;
    r.video.getBoundingClientRect = () => ({ x: 0, y: 5000, left: 0, top: 5000, width: 960, height: 540, right: 960, bottom: 5540, toJSON() {} }) as DOMRect;
    r.state.paused = true; // paused after scrolling it away
    r.video.dispatchEvent(new Event('pause'));
    await still(1000);
    expect(r.count('live-detect')).toBe(0);
    r.video.getBoundingClientRect = onScreen;
    await still(250);
    expect(r.count('live-detect')).toBe(1);
  });

  it('a seek that cuts a still read short leaves the status paused, not watching', async () => {
    let release!: () => void;
    r.detect.hold = new Promise<void>((resolve) => (release = resolve));
    r.state.paused = true;
    await r.live.start(OPTS);
    await still(0);
    expect(r.progress().at(-1)!.status).toBe('watching');
    r.state.seeking = true;
    r.video.dispatchEvent(new Event('seeking')); // no 'seeked' follows
    r.detect.hold = null;
    release();
    await still(0); // the cut cycle ends and starts the still read over
    await still(0); // which finds the video seeking: done
    expect(r.progress().at(-1)!.status).toBe('paused');
  });

  it('reads a video left paused under a scan once the scan closes', async () => {
    r.state.paused = true;
    await r.live.start(OPTS);
    r.live.setScanOpen(true);
    await still(1000);
    expect(r.count('live-detect')).toBe(0);
    r.live.setScanOpen(false);
    await still(0);
    expect(r.count('live-detect')).toBe(1);
  });

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
    expect(r.canvases.filter((c) => c === `${GATE.w}x${GATE.h}`)).toHaveLength(1);
  });

  it('shows the list count the background answers on the pill, not a count of its own', async () => {
    await r.live.start(OPTS);
    await r.tick(0, 10);
    await r.tick(500, 10.5);
    expect(r.views.at(-1)?.count).toBe(1);
  });
});
