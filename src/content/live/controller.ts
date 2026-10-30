// Live's loop, in the content script: on each video frame it samples the picture (the gate), runs the card detector
// when something has settled, reads the cards it follows and reports what it is sure of. One request at a time,
// and nothing while the video or page is paused, or a scan session is open.
import { t } from '../../shared/i18n';
import { LIVE, type LiveEffort, type LiveProgress, type LiveSighting, type LiveStats, type LiveStatus, type LiveStopReason } from '../../shared/live';
import type { LiveQueryReply, LiveStartReply, sendToBackground } from '../../shared/messages';
import { encodeFrame, grabVideoFrame, type CanvasFactory, type VideoFrameGrab } from '../capture';
import type { Rect } from '../geometry';
import { liveCrop, toNativeBoxes } from './crop';
import { GATE, createThumbSampler, createZones, detectReason, type NormBox } from './gate';
import { createRate } from './rate';
import { createTracker, type Track } from './tracker';
import { pageKey, pickLiveVideo, viewportRectOf } from './video';
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
  /**
   * The cards to outline on the video: tracks seen in the last detection that are still voting or promoted (cardId and
   * imageId only once promoted). Empty when Live is not running, a scan is open or the label is off.
   */
  cards: { trackId: number; state: 'voting' | 'promoted'; cardId?: number; imageId?: number; box: NormBox }[];
}

export interface LiveController {
  start(opts: { effort: LiveEffort; showLabel: boolean }): Promise<LiveStartReply>;
  /** Ends the run; `quiet` ends it without telling the background (a restart on another page, an orphaned script). */
  stop(reason: LiveStopReason, quiet?: boolean): void;
  setSettings(opts: { effort: LiveEffort; showLabel: boolean }): void;
  /** Seeks the video to `videoTime` minus LIVE.seekLeadS: the running video, or the last run's after a stop while the page is still that page. */
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
  /** The last run's video and page key, kept after a stop: the panel's times still seek it. */
  let lastRun: { video: HTMLVideoElement; key: string } | null = null;
  const sampleThumb = createThumbSampler(deps.createCanvas);
  let effort: LiveEffort = 'balanced';
  let showLabel = true;
  let scanOpen = false;
  let paused = false;
  let rate = createRate(effort);
  let zones = createZones();
  let tracker = createTracker();
  /** The list's entry count, as the background last answered (the pill shows it). */
  let count = 0;
  /** Whether the last gate sample was (nearly) black: with a DRM video, a protected picture. */
  let lastBlack = false;
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
    const shown = run !== null && showLabel && !scanOpen;
    deps.onView({ running: run !== null, paused, count, showLabel: shown, video: run?.video ?? null, cards: shown ? cardsOf() : [] });
  }

  function cardsOf(): LiveView['cards'] {
    const cards: LiveView['cards'] = [];
    for (const tr of tracker.tracks()) {
      if (tr.misses > 0) continue;
      if (tr.state === 'voting') cards.push({ trackId: tr.id, state: 'voting', box: { ...tr.box } });
      else if (tr.state === 'promoted') {
        const v = settle(tr.reads);
        if (v.cardId !== undefined && v.imageId !== undefined) cards.push({ trackId: tr.id, state: 'promoted', cardId: v.cardId, imageId: v.imageId, box: { ...tr.box } });
      }
    }
    return cards;
  }

  function report(p: Partial<LiveProgress> & { status: LiveStatus }) {
    deps
      .send({ type: 'live-progress', progress: { voting: tracker.voting(), sightings: [], ...p } })
      .then((reply) => {
        if (run && typeof reply?.count === 'number' && reply.count !== count) {
          count = reply.count;
          view();
        }
      })
      .catch(() => undefined); // the page outlived the extension: nothing to tell
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
    view();
  }

  function stop(reason: LiveStopReason, quiet = false) {
    const r = run;
    if (!r) return;
    run = null;
    lastRun = { video: r.video, key: r.key };
    r.stopListening();
    r.video.cancelVideoFrameCallback(r.handle);
    if (!quiet) report({ status: 'stopped', stopReason: reason, voting: 0 });
    view();
  }

  /** After an extension update the old script lives on without its extension: chrome.runtime has lost its id. */
  function orphaned(): boolean {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && !chrome.runtime.id;
    } catch {
      return true;
    }
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
      const taken = sampleThumb(video);
      thumb = taken.grey;
      lastBlack = taken.black;
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
    if (zones.sample(thumb) === 'cut') {
      tracker.reset();
      view();
    }
    last = { now, media };
    return true;
  }

  function onFrame(now: number, metadata: VideoFrameCallbackMetadata) {
    const r = run;
    if (!r) return;
    if (orphaned()) return stop('left', true); // nobody to tell, and the pill must go
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
        // A protected (DRM) video draws black on a canvas without throwing: nothing here can be read.
        if (r.video.mediaKeys && lastBlack) return block();
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
          view(); // the outlines move to the new boxes before the reads
        }
      }
      for (const track of tracker.toRead(may)) {
        const sighting = await readTrack(grab, track, media);
        if (run !== r) return;
        if (sighting) sightings.push(sighting);
      }
      view(); // a promotion happens on a read cycle
      waitMs = rate.next(deps.now() - t0);
      dueAt = now + waitMs;
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
        if (run.key === pageKey(deps.doc.location.href)) {
          // Already running here: take the settings, and say where things stand so the panel leaves "starting".
          setSettings(opts);
          report({ status: status(), intervalMs: waitMs || undefined });
          return { ok: true, pageKey: run.key };
        }
        stop('left', true); // the page changed under the run: a fresh start on this one (the background starts its log afresh)
      }
      const video = pickLiveVideo(deps.doc);
      if (!video || typeof video.requestVideoFrameCallback !== 'function') return { ok: false, reason: 'no-video' };
      effort = opts.effort;
      showLabel = opts.showLabel;
      rate = createRate(effort);
      zones = createZones();
      tracker = createTracker();
      count = 0;
      lastBlack = false;
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
      return { ok: true, pageKey: run.key };
    },
    stop,
    setSettings,
    seek(videoTime) {
      const target = run ?? lastRun;
      if (!target || !target.video.isConnected || pageKey(deps.doc.location.href) !== target.key) return;
      target.video.currentTime = Math.max(0, videoTime - LIVE.seekLeadS);
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
      const at = held && viewportRectOf(video, held.box, win);
      if (at) return at;
      const r = video.getBoundingClientRect();
      return { x: r.right - CORNER_INSET, y: r.top + CORNER_INSET, w: 1, h: 1 };
    },
    query: () => ({ running: run !== null, pageKey: pageKey(deps.doc.location.href), stats: { thumbMs: [...stats.thumbMs], encodeMs: [...stats.encodeMs], cropMs: [...stats.cropMs] } }),
  };
}
