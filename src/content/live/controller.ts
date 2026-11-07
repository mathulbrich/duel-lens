// Live's loop, in the content script: on each video frame it samples the picture (the gate), runs the card detector
// when something has settled, reads the cards it follows and reports what it is sure of. One request at a time,
// and nothing while the video or page is paused, or a scan session is open.
import { t } from '../../shared/i18n';
import { LIVE, type LiveEffort, type LiveProgress, type LiveSighting, type LiveStats, type LiveStatus, type LiveStopReason } from '../../shared/live';
import type { LiveQueryReply, LiveStartReply, sendToBackground } from '../../shared/messages';
import { encodeFrame, grabVideoFrame, type CanvasFactory, type VideoFrameGrab } from '../capture';
import type { Rect } from '../geometry';
import { liveCrop, toNativeBoxes } from './crop';
import { recordPromotion, type PromotionCrop } from './promotion-crops';
import { GATE, createThumbSampler, createZones, detectReason, type NormBox } from './gate';
import { createRate } from './rate';
import { createTracker, TRACK, type Track } from './tracker';
import { eligible, normPointOf, pageKey, pickLiveVideo, viewportRectOf } from './video';
import { readOf, settle, type Read } from './vote';

export interface LiveDeps {
  doc: Document;
  send: typeof sendToBackground;
  /** Wall clock in ms (performance.now): costs of the steps. */
  now(): number;
  createCanvas?: CanvasFactory;
  onView(v: LiveView): void;
  toast(message: string): void;
  /** The video can't be read (DRM, a tainted canvas): Live stopped itself here (Live check holds off the page). */
  onBlocked?(): void;
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
  /** `video`: the one to read (Live check's pointed video, arm.ts) when it can still be read; else pickLiveVideo's. */
  start(opts: { effort: LiveEffort; showLabel: boolean; video?: HTMLVideoElement | null }): Promise<LiveStartReply>;
  /** Ends the run; `quiet` ends it without telling the background (a restart on another page, an orphaned script). */
  stop(reason: LiveStopReason, quiet?: boolean): void;
  setSettings(opts: { effort: LiveEffort; showLabel: boolean }): void;
  /** Seeks the video to `videoTime` minus LIVE.seekLeadS: the running video, or the last run's after a stop while the page is still that page. */
  seek(videoTime: number): void;
  /** A scan session hides the label and reads no frames. */
  setScanOpen(open: boolean): void;
  /**
   * A trusted pointer move at (`x`, `y`), viewport px. Over the picture it steers the reading (HOVER): the card under
   * it is read first, even while its zones move, and an unknown spot there is searched, at most every HOVER.gapMs.
   */
  pointer(x: number, y: number): void;
  /** The pointer left the page, or the page lost the focus: nothing is pointed at. */
  pointerGone(): void;
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
const VIDEO_EVENTS = ['pause', 'play', 'playing', 'seeking', 'seeked', 'ended', 'emptied', 'error', 'loadeddata'] as const;
/** How often a run checks that its video is still on the page and decoding (a removed element fires no frames). */
const WATCH_MS = 1000;
/** Watchdog ticks of readyState < 2 in a row before a stalled video counts as unusable. */
const STALL_TICKS = 2;
/** The pointer's pull on the loop: while it moved in the last activeMs over a card still being read, or over a spot
 *  last searched staleMs ago or more, a cycle comes sooner than the rate's: gapMs after the last one started at the
 *  soonest, and only once that cycle's cost and then the pull's own (the last pulled cycle's, else the last read's)
 *  have passed, so a slow computer's engine is busy half the time at most. A card the pointer comes to is read at once
 *  instead (gapMs after the last cycle started, so as soon as that one ends), for its first freshReads reads there: a
 *  vote needs two (vote.ts), and the user waits on that card. A pulled cycle reads only the pointed card, so it costs
 *  one read, and the other cards wait for the rate's cycle. A spot searched with nothing found there is not searched
 *  again for emptyMs unless the pointer moves `near` (of the picture) or more away from it. */
export const HOVER = { activeMs: 10_000, gapMs: 250, staleMs: 500, emptyMs: 2000, near: 0.03, freshReads: 2 } as const;

/** How soon a still frame that could not be read (busy, off screen, no frame yet) is tried again (ms). */
const STILL_RETRY_MS = 250;
/** A replacement video must be at least this share of the lost video's area. */
const REPLACE_MIN_AREA = 0.25;

interface Run {
  video: HTMLVideoElement;
  /** pageKey of the page Live started on. */
  key: string;
  stopListening(): void;
  stopWatching(): void;
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
  /** The video is unusable (a player error, emptied, no size or no decoded frame): nothing is read and nothing outlined. */
  let broken = false;
  /** An `emptied` or `error` event fired and no frame has loaded since. */
  let failed = false;
  /** Watchdog ticks in a row that saw readyState < 2: a stall counts as broken only once it holds (STALL_TICKS). */
  let stallTicks = 0;
  /** Bumped when the video's state changes under a cycle (broken, recovered, another video): a cycle started before drops its results. */
  let epoch = 0;
  /** The area of the followed video's box (CSS px), kept to refuse a much smaller replacement. */
  let videoArea = 0;
  /** The status last sent to the background. */
  let reported: LiveStatus | null = null;
  let rate = createRate(effort);
  let zones = createZones();
  let tracker = createTracker();
  /** The list's entry count, as the background last answered (the pill shows it). */
  let count = 0;
  /** Whether the last gate sample was (nearly) black: with a DRM video, a protected picture. */
  let lastBlack = false;
  let stats: LiveStats = { thumbMs: [], encodeMs: [], cropMs: [] };
  /** E2E builds only: the crop of the read that promoted each track (promotion-crops.ts). */
  const promotions: PromotionCrop[] = [];
  /** E2E builds: every detection and read of the run, for test/e2e/live-real.ts's diagnosis (last 400). */
  const trail: NonNullable<LiveQueryReply['trail']> = [];
  const note = (e: NonNullable<LiveQueryReply['trail']>[number]) => {
    if (!__DUEL_LENS_E2E__) return;
    trail.push(e);
    if (trail.length > 400) trail.shift();
  };
  let frames = 0; // frame callbacks seen (E2E trace)
  /** No cycle has finished yet: the first one also waits for the card reader to load, so its cost says nothing of the pace. */
  let cold = true;
  /** A zone settled while cards waited to be read: the detection it asks for comes after GATE.detectGapMs. */
  let settleWaiting = false;
  /** A paused video gives no frame callbacks: its still frame is read on a timer (readStill). */
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  /** The still frame has had its detection; reads follow until no card on it waits. */
  let stillDetected = false;
  /** Reading a paused video's still frame: the status says watching until it is done. */
  let stillReading = false;
  /** Detections answered in this run: tells a still cycle that read nothing (off screen, no frame) from one that did. */
  let detections = 0;
  /** Where the pointer last was on the picture (0-1), and when it moved there (deps.now); null off the picture. */
  let pointedAt: { x: number; y: number } | null = null;
  let pointerMovedAt = -Infinity;
  /** The rVFC time of the last cycle's start; what the last cycle cost, the last one the pointer pulled, and the last
   *  read (ms): a pull waits the last cycle's cost plus its own after that start (pulledCostMs, else one read's). */
  let cycleAt = -Infinity;
  let lastCostMs = 0;
  let pulledCostMs = 0;
  let readCostMs = 0;
  /** The track the pointer is on, and how many reads it had since the pointer came to it (HOVER.freshReads). */
  let reached: { track: Track; reads: number } | null = null;
  /** Where and when (rVFC time) the pointer last asked for a search. */
  let searchedAt: { x: number; y: number; at: number } | null = null;
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
    deps.onView({ running: run !== null, paused, count, showLabel: shown, video: run?.video ?? null, cards: shown && !broken ? cardsOf() : [] });
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
    reported = p.status;
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
  const status = (): LiveStatus => ((paused && !stillReading) || broken ? 'paused' : rate.slow ? 'slow' : 'watching');

  function rebase() {
    zones.rebase();
    last = null;
  }

  function cut() {
    epoch++; // a cycle in flight holds boxes from before the cut
    settleWaiting = false;
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
    r.stopWatching();
    r.video.cancelVideoFrameCallback(r.handle);
    if (stillTimer !== null) clearTimeout(stillTimer);
    stillTimer = null;
    stillReading = false;
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
    deps.onBlocked?.();
  }

  const unusable = (v: HTMLVideoElement) => failed || !v.videoWidth || !v.videoHeight || (v.readyState < 2 && stallTicks >= STALL_TICKS);
  const areaOf = (v: HTMLVideoElement) => {
    const b = v.getBoundingClientRect();
    return b.width * b.height;
  };

  /** Tells the background the status if it changed since the last report. */
  function announce() {
    if (status() !== reported) report({ status: status(), intervalMs: waitMs || undefined });
  }

  /** The watchdog's tick: counts a stall, then checks the video. */
  function watch() {
    const v = run?.video;
    if (!v) return;
    stallTicks = v.isConnected && v.readyState < 2 ? stallTicks + 1 : 0;
    checkVideo();
  }

  /** Follows `video` (listeners and frame callback) in place of the run's video. */
  function follow(r: Run, video: HTMLVideoElement) {
    r.stopListening();
    r.video.cancelVideoFrameCallback(r.handle);
    const onEvent = (e: Event) => {
      if (e.type === 'seeking') cut();
      if (e.type === 'pause' || e.type === 'seeked' || e.type === 'loadeddata') readStillSoon(); // a new still frame, if the video stays paused
      if (e.type === 'emptied' || e.type === 'error') failed = true;
      if (e.type === 'loadeddata' || e.type === 'playing') {
        failed = false;
        stallTicks = 0; // recovered: a new stall gets its grace again
      }
      checkVideo();
      onVideoState();
    };
    for (const type of VIDEO_EVENTS) video.addEventListener(type, onEvent);
    r.stopListening = () => {
      for (const type of VIDEO_EVENTS) video.removeEventListener(type, onEvent);
    };
    r.video = video;
    r.handle = video.requestVideoFrameCallback(onFrame);
    epoch++;
    stallTicks = 0;
    videoArea = areaOf(video);
  }

  /** The run's video left the page (another is picked, else Live stops) or stopped or resumed decoding. */
  function checkVideo() {
    const r = run;
    if (!r) return;
    if (!r.video.isConnected) {
      if (pageKey(deps.doc.location.href) !== r.key) return stop('left');
      const next = pickLiveVideo(deps.doc);
      if (!next || typeof next.requestVideoFrameCallback !== 'function' || areaOf(next) < videoArea * REPLACE_MIN_AREA) {
        deps.toast(t('content_live_no_video'));
        return stop('no-video');
      }
      follow(r, next);
      failed = false;
      broken = unusable(next);
      src = next.currentSrc;
      paused = idle(next);
      cut();
      first = true;
      last = null;
      announce();
      return;
    }
    videoArea = areaOf(r.video) || videoArea;
    const bad = unusable(r.video);
    if (bad === broken) return;
    broken = bad;
    paused = idle(r.video);
    epoch++;
    if (bad) {
      tracker.reset();
      zones.cut();
      rebase();
    } else {
      rebase();
      first = true;
    }
    view();
    announce();
  }

  /** The page was hidden or shown again: a paused video's frame is read once it shows. */
  function onVisibility() {
    onVideoState();
    if (!deps.doc.hidden) readStillSoon();
  }

  /** The video or page paused, resumed or sought. */
  function onVideoState() {
    if (!run) return;
    const now = idle(run.video);
    if (now === paused) return;
    paused = now;
    if (!paused) rebase();
    view();
    announce();
  }

  /** How often the gate samples: GATE.sampleMs, or slower when a sample costs more than 1/GATE.thumbShare of that. */
  function sampleEvery(): number {
    const recent = stats.thumbMs.slice(-10);
    const mean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
    return Math.min(GATE.maxSampleMs, Math.max(GATE.sampleMs, mean * GATE.thumbShare));
  }

  /** The gate's sample of the picture, at most every sampleEvery() ms. Returns false when the frame can't be read. */
  function sample(video: HTMLVideoElement, now: number, media: number): boolean {
    if (last && now - last.now < sampleEvery()) return true;
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
    frames++;
    if (orphaned()) return stop('left', true); // nobody to tell, and the pill must go
    r.handle = r.video.requestVideoFrameCallback(onFrame);
    if (pageKey(deps.doc.location.href) !== r.key) return stop('left');
    if (broken !== unusable(r.video)) checkVideo();
    if (broken || scanOpen || idle(r.video)) return;
    if (!sample(r.video, now, metadata.mediaTime)) return;
    if (r.busy) return;
    // The pointer on a card still being read, or on a spot not searched lately: come sooner than the rate's wait.
    const pointed = pointedTrack();
    const hover = pointerActive() && (pointed ? pointed.state === 'voting' : now - lastDetectAt >= HOVER.staleMs && !searchedHere(now));
    reach();
    const fresh = !!reached && reached.reads < HOVER.freshReads;
    const pullAt = cycleAt + (fresh ? HOVER.gapMs : Math.max(HOVER.gapMs, lastCostMs + (pulledCostMs || readCostMs)));
    if (now < (hover ? Math.min(dueAt, pullAt) : dueAt)) return;
    const pulled = now < dueAt; // before the rate's time: the pointer's cycle, for its card alone

    const settled = zones.takeSettled() || settleWaiting;
    settleWaiting = false;
    let reason = detectReason({ first, settled, sinceDetectMs: now - lastDetectAt });
    if (hover && !pointed && pointedAt) {
      reason ??= 'refresh'; // an unknown spot under the pointer: search the picture now
      searchedAt = { ...pointedAt, at: now };
    }
    const quiet = (tr: Track) => tr === pointed || zones.quiet(tr.box); // the pointed card is read even while it moves
    // Cards are waiting to be read and no known card's spot changed: read them now, find the cards again a little later.
    if (reason === 'settled' && now - lastDetectAt < GATE.detectGapMs && tracker.toRead(quiet).length > 0 && !tracker.tracks().some(movedHere)) {
      reason = null;
      settleWaiting = true;
    }
    const may = reason === 'refresh' ? () => true : quiet;
    if (!reason && (pulled ? readList(may, true) : tracker.toRead(may)).length === 0) return;
    r.busy = true;
    cycleAt = now;
    const t0 = deps.now();
    cycle(r, now, metadata.mediaTime, reason, may, pulled)
      .catch((e) => {
        console.error('Duel Lens: Live cycle failed', e);
        if (run !== r) return;
        paced(now, deps.now() - t0, pulled); // a failing cycle waits like any other
      })
      .finally(() => (r.busy = false));
  }

  /** What a cycle started at `now` cost: when the next comes. A pulled one never brings the rate's cycle sooner. */
  function paced(now: number, costMs: number, pulled: boolean) {
    lastCostMs = costMs;
    if (pulled) pulledCostMs = costMs;
    waitMs = rate.next(cold ? 0 : costMs, pointerActive());
    cold = false;
    dueAt = pulled ? Math.max(dueAt, now + waitMs) : now + waitMs;
  }

  /** One detect cycle (`reason`) or read cycle (null): grab the frame, find the cards, read some (`pulled`: only the
   *  pointed one), report. */
  async function cycle(r: Run, now: number, media: number, reason: ReturnType<typeof detectReason>, may: (t: Track) => boolean, pulled = false) {
    const t0 = deps.now();
    const ep = epoch;
    const grab = grabVideoFrame(r.video, { createCanvas: deps.createCanvas, view: win });
    if (!grab) return; // off screen: the next frame tries again
    try {
      if (!grab.canvas) {
        if (r.video.readyState >= 2) block(); // a decoded frame that can't be read
        return;
      }
      const sightings: LiveSighting[] = [];
      const grabbedAt = zones.sampleIndex();
      if (reason) {
        // A protected (DRM) video draws black on a canvas without throwing: nothing here can be read.
        if (r.video.mediaKeys && lastBlack) return block();
        const e0 = deps.now();
        const frame = encodeFrame(grab, { w: win.innerWidth, h: win.innerHeight }, deps.createCanvas, {
          maxSide: LIVE.frameMaxSide,
          quality: LIVE.frameQuality,
        });
        lap(stats.encodeMs, deps.now() - e0);
        const d0 = deps.now();
        const res = await deps.send({ type: 'live-detect', dataUrl: frame.dataUrl }).catch((e) => {
          console.warn('Duel Lens: Live detection failed', e);
          return null;
        });
        if (run !== r || ep !== epoch) return;
        first = false;
        lastDetectAt = now;
        detections++;
        // A failed detection says nothing about the cards: keep the tracks as they are.
        if (__DUEL_LENS_E2E__ && res) {
          const b = res.detection.boxes;
          note({ at: Math.round(media * 100) / 100, kind: 'detect', ms: Math.round(deps.now() - d0), engineMs: res.detection.ms, faceUp: b.filter((x) => x.kind === 'face-up').length, other: b.filter((x) => x.kind !== 'face-up').length, frame: `${frame.width}x${frame.height}`, error: res.detection.error });
        }
        if (res && !res.detection.error) {
          tracker.update(toNativeBoxes(grab, frame, res.detection.boxes), { width: grab.videoWidth, height: grab.videoHeight });
          readAgainWhereMoved();
          view(); // the outlines move to the new boxes before the reads
        }
      }
      const queue = readList(may, pulled);
      const done = new Set<Track>();
      for (let track = nextRead(queue, done, pulled); track; track = nextRead(queue, done, pulled)) {
        done.add(track);
        const r0 = deps.now();
        const sighting = await readTrack(grab, track, media, grabbedAt);
        if (run !== r || ep !== epoch) return;
        readCostMs = deps.now() - r0;
        if (reached?.track === track) reached.reads++;
        if (sighting) sightings.push(sighting);
        if (deps.now() - t0 >= LIVE.readBudgetMs) break; // a slow computer: the rest wait for the next cycle
      }
      view(); // a promotion happens on a read cycle
      paced(now, deps.now() - t0, pulled);
      report({ status: status(), intervalMs: waitMs, sightings });
    } finally {
      if (grab.canvas) grab.canvas.width = grab.canvas.height = 0;
    }
  }

  /**
   * A promoted or rejected track whose zones moved after its last read and are quiet again may hold another card (one
   * put on the same spot is matched to it by overlap): it votes afresh, outline dashed and unnamed until confirmed.
   */
  function readAgainWhereMoved() {
    for (const tr of tracker.tracks()) {
      if (!movedHere(tr)) continue;
      if (tr.state !== 'voting') tr.prevCardId = tr.state === 'promoted' ? settle(tr.reads).cardId : undefined;
      tr.state = 'voting'; // a voting track's old votes go too: they may be of the card that was replaced
      tr.reads = [];
    }
  }

  /** Whether `r`'s video shows a still frame Live may read: paused (not seeking or ended), decoded, on a shown page. */
  function stillFrame(r: Run): boolean {
    const v = r.video;
    return !broken && !scanOpen && v.paused && !v.seeking && !v.ended && !deps.doc.hidden && v.readyState >= 2;
  }

  /** The video paused, sought while paused, or Live started on a paused one: read the still frame from scratch. */
  function readStillSoon() {
    stillDetected = false;
    if (stillTimer !== null) clearTimeout(stillTimer);
    stillTimer = setTimeout(readStill, 0);
  }

  /**
   * One cycle on a paused video's still frame (no frame callbacks come while it is paused): a detection first, then
   * reads of every card on it, at the rate's pace, until none waits; then nothing until a seek or play.
   */
  function readStill() {
    stillTimer = null;
    const r = run;
    const all = () => true;
    if (!r || !stillFrame(r) || (stillDetected && tracker.toRead(all).length === 0)) {
      if (stillReading) {
        stillReading = false;
        announce();
      }
      return;
    }
    if (r.busy) {
      stillTimer = setTimeout(readStill, STILL_RETRY_MS); // a cycle from before the pause is finishing
      return;
    }
    if (!stillReading) {
      stillReading = true;
      announce();
    }
    const ep = epoch;
    const t0 = deps.now();
    const seen = detections;
    r.busy = true;
    cycle(r, t0, r.video.currentTime, stillDetected ? null : 'refresh', all)
      .catch((e) => {
        console.error('Duel Lens: Live cycle failed', e);
        if (run === r) waitMs = rate.next(deps.now() - t0);
      })
      .finally(() => {
        r.busy = false;
        if (run !== r) return;
        if (ep !== epoch) return readStillSoon(); // a seek, a new video or a break: start over (or end, if no longer still)
        // No detection (the video off screen, no frame yet): try again a little later, not at once.
        if (!stillDetected && detections === seen) return void (stillTimer = setTimeout(readStill, Math.max(waitMs, STILL_RETRY_MS)));
        stillDetected = true;
        stillTimer = setTimeout(readStill, waitMs);
      });
  }

  /** The pointer is near where it last asked for a search, which found no card there, less than HOVER.emptyMs ago. */
  function searchedHere(now: number): boolean {
    const s = searchedAt;
    const p = pointedAt;
    return !!s && !!p && now - s.at < HOVER.emptyMs && Math.abs(p.x - s.x) < HOVER.near && Math.abs(p.y - s.y) < HOVER.near;
  }

  /** The pointer moved over the picture within HOVER.activeMs, or rests on a card still being read (until it settles). */
  function pointerActive(): boolean {
    if (pointedAt === null) return false;
    return deps.now() - pointerMovedAt < HOVER.activeMs || pointedTrack()?.state === 'voting';
  }

  /** The track seen in the last detection whose box holds the pointer (the smallest, where boxes overlap). */
  function pointedTrack(): Track | null {
    const p = pointedAt;
    if (!p) return null;
    let best: Track | null = null;
    for (const tr of tracker.tracks()) {
      const b = tr.box;
      if (tr.misses > 0 || p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h) continue;
      if (!best || b.w * b.h < best.box.w * best.box.h) best = tr;
    }
    return best;
  }

  /** A new visit when the pointer is on another track than `reached`'s (or on none): no reads there yet. */
  function reach() {
    const p = pointedTrack();
    if (reached?.track !== p) reached = p ? { track: p, reads: 0 } : null;
  }

  /** The tracks to read this cycle: the pointed card first, when it is still being read and `may` allows it; a cycle
   *  the pointer pulled reads it alone. */
  function readList(may: (t: Track) => boolean, pulled: boolean): Track[] {
    const p = pointedTrack();
    const mine = !!p && p.state === 'voting' && p.misses === 0 && may(p);
    if (pulled) return mine ? [p] : [];
    const list = tracker.toRead(may);
    if (!mine) return list;
    return [p, ...list.filter((t) => t !== p)].slice(0, TRACK.readsPerCycle);
  }

  /**
   * The next card a cycle reads: the one the pointer went to meanwhile, when it is still being read and this cycle has
   * not read it (read even while its zones move, as the pointed card always is), else the next of `queue`. A pulled
   * cycle reads its own card only. At most TRACK.readsPerCycle, plus the pointed card.
   */
  function nextRead(queue: readonly Track[], done: ReadonlySet<Track>, pulled: boolean): Track | undefined {
    if (pulled) return queue.find((t) => !done.has(t));
    const p = pointedTrack();
    if (p && p.state === 'voting' && p.misses === 0 && !done.has(p)) return p;
    if (done.size >= TRACK.readsPerCycle) return undefined;
    return queue.find((t) => !done.has(t) && t.state === 'voting');
  }

  /** Whether a read track's zones moved after its last read and are quiet again: the card there may be another one. */
  function movedHere(tr: Track): boolean {
    if (tr.misses > 0 || (tr.state === 'voting' && tr.reads.length === 0)) return false;
    return zones.movedSince(tr.box, tr.verifiedAt) && zones.quiet(tr.box);
  }

  /** One recognize of a tracked card from its last box; the sighting when this read promotes it. */
  async function readTrack(grab: VideoFrameGrab, track: Track, media: number, grabbedAt: number): Promise<LiveSighting | null> {
    let read: Read;
    let sent: { dataUrl: string; width: number; height: number } | null = null;
    try {
      const c0 = deps.now();
      const crop = liveCrop(grab, track.card, deps.createCanvas);
      lap(stats.cropMs, deps.now() - c0);
      if (__DUEL_LENS_E2E__) sent = { dataUrl: crop.dataUrl, width: crop.width, height: crop.height };
      const context = { pageUrl: deps.doc.location.href, pageTitle: deps.doc.title, videoTime: media };
      const r0 = deps.now();
      const answer = await deps.send({ type: 'recognize', crop, context, record: false });
      read = readOf(answer);
      if (__DUEL_LENS_E2E__) {
        const res = 'result' in answer ? answer.result : null;
        note({ at: Math.round(media * 100) / 100, kind: 'read', track: track.id, ms: Math.round(deps.now() - r0), cardId: read.cardId, score: read.score, second: res?.candidates[1]?.score, confident: read.confident, quiet: zones.quiet(track.box), box: track.box, crop: `${crop.width}x${crop.height}`, error: res?.error, path: `${res?.best?.hypothesis ?? '-'}|${Object.entries(res?.timings ?? {}).map(([k, v]) => `${k}:${Math.round(v as number)}`).join(',')}|${res?.countBadge ? 'badge' : ''}${res?.truncated ? 'cut' : ''}` });
      }
      // A card whose zones move (a hand, a card being swapped) is read when the pointer is on it: such a read never
      // promotes alone, however clear; it needs a second one that agrees.
      if (read.score !== undefined && !zones.quiet(track.box)) read = { cardId: read.cardId, imageId: read.imageId, confident: read.confident };
    } catch (e) {
      read = readOf({ error: e instanceof Error ? e.message : String(e) });
    }
    track.reads.push(read);
    track.verifiedAt = grabbedAt;
    const verdict = settle(track.reads);
    track.state = verdict.state;
    if (verdict.state !== 'promoted') return null;
    if (verdict.cardId === track.prevCardId) return null; // the same card again after a re-read: the list entry stays as it is
    track.prevCardId = undefined;
    if (sent) recordPromotion(promotions, { cardId: verdict.cardId as number, trackId: track.id, videoTime: media, ...sent });
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
      const asked = opts.video;
      const video = asked && asked.isConnected && eligible(asked, win) ? asked : pickLiveVideo(deps.doc);
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
      broken = failed = false;
      stallTicks = 0;
      reported = null;
      cold = true;
      settleWaiting = false;
      pointedAt = searchedAt = null;
      pointerMovedAt = cycleAt = -Infinity;
      reached = null;
      lastCostMs = pulledCostMs = readCostMs = 0;
      deps.doc.addEventListener('visibilitychange', onVisibility);
      const timer = setInterval(watch, WATCH_MS);
      run = {
        video,
        key: pageKey(deps.doc.location.href),
        stopListening: () => undefined,
        stopWatching: () => {
          clearInterval(timer);
          deps.doc.removeEventListener('visibilitychange', onVisibility);
        },
        handle: 0,
        busy: false,
      };
      follow(run, video);
      paused = idle(video);
      stillDetected = stillReading = false;
      view();
      if (paused) report({ status: 'paused' });
      readStillSoon();
      return { ok: true, pageKey: run.key };
    },
    stop,
    setSettings,
    seek(videoTime) {
      const target = run ?? lastRun;
      if (!target || !target.video.isConnected || pageKey(deps.doc.location.href) !== target.key) return;
      target.video.currentTime = Math.max(0, videoTime - LIVE.seekLeadS);
    },
    pointerGone() {
      pointedAt = null;
      reach();
    },
    pointer(x, y) {
      const video = run?.video;
      pointedAt = video ? normPointOf(video, x, y, win) : null;
      if (pointedAt) pointerMovedAt = deps.now();
      reach();
    },
    setScanOpen(open) {
      if (scanOpen === open) return;
      scanOpen = open;
      if (!open) {
        rebase();
        readStillSoon(); // a video left paused under the scan is read now
      }
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
    query: () => ({ running: run !== null, pageKey: pageKey(deps.doc.location.href), stats: { thumbMs: [...stats.thumbMs], encodeMs: [...stats.encodeMs], cropMs: [...stats.cropMs] }, ...(__DUEL_LENS_E2E__ ? { promotions: [...promotions], flags: { paused, broken, failed, stallTicks, busy: !!run?.busy, hidden: deps.doc.hidden, frames }, trail: [...trail] } : {}) }),
  };
}
