// Live's loop, in the content script: on each video frame it samples the picture (the gate), runs the card detector
// when something has settled, reads the cards it follows and reports what it is sure of. One request at a time,
// and nothing while the video or page is paused, or a scan session is open.
import { t } from '../../shared/i18n';
import { LIVE, type LiveEffort, type LiveProgress, type LiveSighting, type LiveStats, type LiveStatus, type LiveStopReason } from '../../shared/live';
import type { LiveQueryReply, LiveStartReply, sendToBackground } from '../../shared/messages';
import { contentRect, encodeFrame, grabVideoFrame, type CanvasFactory, type VideoFrameGrab } from '../capture';
import { videoContentBox, type Rect } from '../geometry';
import { liveCrop, toNativeBoxes } from './crop';
import { GATE, createZones, detectReason, thumbOf } from './gate';
import { createRate } from './rate';
import { createTracker, type Track } from './tracker';
import { pageKey, pickLiveVideo } from './video';
import { readOf, settle, type Read } from './vote';

export interface LiveDeps {
  doc: Document;
  send: typeof sendToBackground;
  /** Wall clock in ms (performance.now): costs of the steps. */
  now(): number;
  createCanvas?: CanvasFactory;
  onView(v: LiveView): void;
  toast(message: string): void;
}

/** What the page shows of Live: the label on the video (Task 7). */
export interface LiveView {
  running: boolean;
  paused: boolean;
  count: number;
  showLabel: boolean;
  video: HTMLVideoElement | null;
}

export interface LiveController {
  start(opts: { effort: LiveEffort; showLabel: boolean }): Promise<LiveStartReply>;
  stop(reason: LiveStopReason): void;
  setSettings(opts: { effort: LiveEffort; showLabel: boolean }): void;
  /** Seeks the video to `videoTime` minus LIVE.seekLeadS. */
  seek(videoTime: number): void;
  /** A scan session hides the label and reads no frames. */
  setScanOpen(open: boolean): void;
  query(): LiveQueryReply;
  /**
   * Where the card box opens for `cardId`: the viewport rect of a live track settled on it (its video-normalised box
   * through the video's content box), else a 1x1 rect at the video's top-right corner, 12 px in.
   */
  anchorFor(cardId: number): Rect;
}

/** How far inside the video's corner the box opens when no track holds its card (CSS px). */
const CORNER_INSET = 12;

const STATS_KEEP = 200;
const VIDEO_EVENTS = ['pause', 'play', 'seeking', 'seeked', 'ended'] as const;

interface Run {
  video: HTMLVideoElement;
  /** pageKey of the page Live started on. */
  key: string;
  stopListening(): void;
  handle: number;
  /** A cycle of this run is waiting on the background: one request at a time, per run. */
  busy: boolean;
}

export function createLiveController(deps: LiveDeps): LiveController {
  const win = deps.doc.defaultView ?? window;
  let run: Run | null = null;
  let effort: LiveEffort = 'balanced';
  let showLabel = true;
  let scanOpen = false;
  let paused = false;
  let rate = createRate(effort);
  let zones = createZones();
  let tracker = createTracker();
  let found = new Set<number>();
  let stats: LiveStats = { thumbMs: [], encodeMs: [], cropMs: [] };
  let dueAt = 0;
  let waitMs = 0;
  let first = true;
  let lastDetectAt = 0;
  let src = '';
  /** The last gate sample, for the media-time jump check; null after a pause (the next sample compares nothing). */
  let last: { now: number; media: number } | null = null;

  const lap = (list: number[], ms: number) => {
    list.push(ms);
    if (list.length > STATS_KEEP) list.shift();
  };
  const idle = (v: HTMLVideoElement) => v.paused || v.ended || v.seeking || deps.doc.hidden;

  function view() {
    deps.onView({ running: run !== null, paused, count: found.size, showLabel: run !== null && showLabel && !scanOpen, video: run?.video ?? null });
  }

  function report(p: Partial<LiveProgress> & { status: LiveStatus }) {
    deps.send({ type: 'live-progress', progress: { voting: tracker.voting(), sightings: [], ...p } }).catch(() => undefined); // the page outlived the extension: nothing to tell
  }

  /** The status the loop reports now. */
  const status = (): LiveStatus => (paused ? 'paused' : rate.slow ? 'slow' : 'watching');

  function rebase() {
    zones.rebase();
    last = null;
  }

  function cut() {
    zones.cut();
    tracker.reset();
  }

  function stop(reason: LiveStopReason) {
    const r = run;
    if (!r) return;
    run = null;
    r.stopListening();
    r.video.cancelVideoFrameCallback(r.handle);
    report({ status: 'stopped', stopReason: reason, voting: 0 });
    view();
  }

  function block() {
    deps.toast(t('content_video_blocked'));
    stop('blocked');
  }

  /** The video or page paused, resumed or sought. */
  function onVideoState() {
    if (!run) return;
    const now = idle(run.video);
    if (now === paused) return;
    paused = now;
    if (!paused) rebase();
    view();
    report({ status: status(), intervalMs: waitMs || undefined });
  }

  /** The gate's sample of the picture, at most every GATE.sampleMs. Returns false when the frame can't be read. */
  function sample(video: HTMLVideoElement, now: number, media: number): boolean {
    if (last && now - last.now < GATE.sampleMs) return true;
    const t0 = deps.now();
    let thumb: Uint8Array;
    try {
      thumb = thumbOf(video, deps.createCanvas);
    } catch {
      block();
      return false;
    }
    lap(stats.thumbMs, deps.now() - t0);
    const jumped = last !== null && Math.abs(media - last.media - ((now - last.now) / 1000) * (video.playbackRate || 1)) > LIVE.jumpS;
    if (video.currentSrc !== src || jumped) {
      src = video.currentSrc;
      cut();
    }
    if (zones.sample(thumb) === 'cut') tracker.reset();
    last = { now, media };
    return true;
  }

  function onFrame(now: number, metadata: VideoFrameCallbackMetadata) {
    const r = run;
    if (!r) return;
    r.handle = r.video.requestVideoFrameCallback(onFrame);
    if (pageKey(deps.doc.location.href) !== r.key) return stop('left');
    if (scanOpen || idle(r.video)) return;
    if (!sample(r.video, now, metadata.mediaTime)) return;
    if (r.busy || now < dueAt) return;

    const reason = detectReason({ first, settled: zones.takeSettled(), sinceDetectMs: now - lastDetectAt });
    const may = reason === 'refresh' ? () => true : (tr: Track) => zones.quiet(tr.box);
    if (!reason && tracker.toRead(may).length === 0) return;
    r.busy = true;
    const t0 = deps.now();
    cycle(r, now, metadata.mediaTime, reason, may)
      .catch((e) => {
        console.error('Duel Lens: Live cycle failed', e);
        if (run !== r) return;
        waitMs = rate.next(deps.now() - t0); // a failing cycle waits like any other
        dueAt = now + waitMs;
      })
      .finally(() => (r.busy = false));
  }

  /** One detect cycle (`reason`) or read cycle (null): grab the frame, find the cards, read some, report. */
  async function cycle(r: Run, now: number, media: number, reason: ReturnType<typeof detectReason>, may: (t: Track) => boolean) {
    const t0 = deps.now();
    const grab = grabVideoFrame(r.video, { createCanvas: deps.createCanvas, view: win });
    if (!grab) return; // off screen: the next frame tries again
    try {
      if (!grab.canvas) {
        if (r.video.readyState >= 2) block(); // a decoded frame that can't be read
        return;
      }
      const sightings: LiveSighting[] = [];
      if (reason) {
        const e0 = deps.now();
        const frame = encodeFrame(grab, { w: win.innerWidth, h: win.innerHeight }, deps.createCanvas, {
          maxSide: LIVE.frameMaxSide,
          quality: LIVE.frameQuality,
        });
        lap(stats.encodeMs, deps.now() - e0);
        const res = await deps.send({ type: 'live-detect', dataUrl: frame.dataUrl }).catch((e) => {
          console.warn('Duel Lens: Live detection failed', e);
          return null;
        });
        if (run !== r) return;
        first = false;
        lastDetectAt = now;
        // A failed detection says nothing about the cards: keep the tracks as they are.
        if (res && !res.detection.error) {
          tracker.update(toNativeBoxes(grab, frame, res.detection.boxes), { width: grab.videoWidth, height: grab.videoHeight });
        }
      }
      for (const track of tracker.toRead(may)) {
        const sighting = await readTrack(grab, track, media);
        if (run !== r) return;
        if (sighting) sightings.push(sighting);
      }
      waitMs = rate.next(deps.now() - t0);
      dueAt = now + waitMs;
      for (const s of sightings) found.add(s.cardId);
      if (sightings.length) view();
      report({ status: status(), intervalMs: waitMs, sightings });
    } finally {
      if (grab.canvas) grab.canvas.width = grab.canvas.height = 0;
    }
  }

  /** One recognize of a tracked card from its last box; the sighting when this read promotes it. */
  async function readTrack(grab: VideoFrameGrab, track: Track, media: number): Promise<LiveSighting | null> {
    let read: Read;
    try {
      const c0 = deps.now();
      const crop = liveCrop(grab, track.card, deps.createCanvas);
      lap(stats.cropMs, deps.now() - c0);
      const context = { pageUrl: deps.doc.location.href, pageTitle: deps.doc.title, videoTime: media };
      read = readOf(await deps.send({ type: 'recognize', crop, context, record: false }));
    } catch (e) {
      read = readOf({ error: e instanceof Error ? e.message : String(e) });
    }
    track.reads.push(read);
    const verdict = settle(track.reads);
    track.state = verdict.state;
    if (verdict.state !== 'promoted') return null;
    return { cardId: verdict.cardId as number, imageId: verdict.imageId as number, videoTime: media };
  }

  function setSettings(opts: { effort: LiveEffort; showLabel: boolean }) {
    effort = opts.effort;
    showLabel = opts.showLabel;
    rate.setEffort(effort);
    view();
  }

  return {
    async start(opts) {
      if (run) {
        setSettings(opts);
        return { ok: true };
      }
      const video = pickLiveVideo(deps.doc);
      if (!video || typeof video.requestVideoFrameCallback !== 'function') return { ok: false, reason: 'no-video' };
      effort = opts.effort;
      showLabel = opts.showLabel;
      rate = createRate(effort);
      zones = createZones();
      tracker = createTracker();
      found = new Set();
      stats = { thumbMs: [], encodeMs: [], cropMs: [] };
      dueAt = waitMs = lastDetectAt = 0;
      first = true;
      last = null;
      src = video.currentSrc;
      const onEvent = (e: Event) => {
        if (e.type === 'seeking') cut();
        onVideoState();
      };
      for (const type of VIDEO_EVENTS) video.addEventListener(type, onEvent);
      deps.doc.addEventListener('visibilitychange', onVideoState);
      const stopListening = () => {
        for (const type of VIDEO_EVENTS) video.removeEventListener(type, onEvent);
        deps.doc.removeEventListener('visibilitychange', onVideoState);
      };
      run = { video, key: pageKey(deps.doc.location.href), stopListening, handle: video.requestVideoFrameCallback(onFrame), busy: false };
      paused = idle(video);
      view();
      if (paused) report({ status: 'paused' });
      return { ok: true };
    },
    stop,
    setSettings,
    seek(videoTime) {
      if (run) run.video.currentTime = Math.max(0, videoTime - LIVE.seekLeadS);
    },
    setScanOpen(open) {
      if (scanOpen === open) return;
      scanOpen = open;
      if (!open) rebase();
      view();
    },
    anchorFor(cardId) {
      const video = run?.video;
      if (!video) return { x: CORNER_INSET, y: CORNER_INSET, w: 1, h: 1 };
      const held = tracker.tracks().find((tr) => tr.state === 'promoted' && settle(tr.reads).cardId === cardId);
      if (held && video.videoWidth && video.videoHeight) {
        const box = videoContentBox(contentRect(video, win), video.videoWidth, video.videoHeight, win.getComputedStyle(video).objectFit);
        return { x: box.x + held.box.x * box.w, y: box.y + held.box.y * box.h, w: held.box.w * box.w, h: held.box.h * box.h };
      }
      const r = video.getBoundingClientRect();
      return { x: r.right - CORNER_INSET, y: r.top + CORNER_INSET, w: 1, h: 1 };
    },
    query: () => ({ running: run !== null, pageKey: pageKey(deps.doc.location.href), stats: { thumbMs: [...stats.thumbMs], encodeMs: [...stats.encodeMs], cropMs: [...stats.cropMs] } }),
  };
}
