// Live check's arming (spec D-L14): with the switch on, a page's script only watches the pointer. Once the pointer has
// rested ARM.dwellMs on a readable video of a real size, playing or paused on a frame, the background is asked to start Live here (its usual
// start: consent, log, badge, pill) on that video. Nothing is read before that, and a pointer passing over a feed's
// preview clips starts nothing. A page with a video of that size asks the background once to load the engine (`warm`),
// so that the first rest finds it ready: on a slow computer the models take seconds to load and prepare.
import { eligible, normPointOf, pageKey } from './video';

/** How often the pointer is checked against the videos; how long it must rest on one; the smallest video that counts
 *  (CSS px: a feed's hover previews and ads are smaller); how long a refused start waits before another (ms). */
export const ARM = { checkMs: 250, dwellMs: 600, restPx: 16, minW: 400, minH: 225, retryMs: 5000 } as const;

/**
 * Whether Live's video loop takes `v`: a video of ARM's size, visible, playing or paused on a decoded frame. Any other
 * video (a small one, an ended one, one with no frame yet) is read as a picture instead (pictures.ts): Live check
 * reads what is on the screen, whatever a video is doing.
 */
export function liveTakes(v: HTMLVideoElement, view: Window): boolean {
  if (v.ended || (v.paused && v.readyState < 2) || !eligible(v, view)) return false;
  const r = v.getBoundingClientRect();
  return r.width >= ARM.minW && r.height >= ARM.minH;
}

export interface LiveArmDeps {
  doc: Document;
  now: () => number;
  /** Whether Live runs on this page already. */
  running: () => boolean;
  /** Asks the background to start Live here; whether it started. */
  start: () => Promise<boolean>;
  /** Asks the background to load the engine now (best effort): once a page, when it has a video of ARM's size. */
  warm?: () => void;
}

export interface LiveArm {
  setOn(on: boolean): void;
  readonly on: boolean;
  /** The video the pointer rested on when the last start was asked for: the one Live reads. */
  readonly video: HTMLVideoElement | null;
  /** Where the pointer last was (viewport px), null before any move: Live's start takes it as its first point. */
  readonly lastPointer: { x: number; y: number } | null;
  /** A trusted pointer move, viewport px. */
  pointer(x: number, y: number): void;
  /** Live was stopped on this page by the user (or the video can't be read): not again until the page changes. */
  stoppedHere(): void;
  /** The pointer left the page, or the page lost the focus: a rest under way ends without starting Live. */
  gone(): void;
}

export function createLiveArm(deps: LiveArmDeps): LiveArm {
  let on = false;
  let checkedAt = -Infinity;
  let retryAt = -Infinity;
  let pending = false;
  let stoppedKey: string | null = null;
  let last = { x: 0, y: 0 };
  let moved = false;
  let candidate: HTMLVideoElement | null = null;
  /** Where the rest under way began: a pointer that moves ARM.restPx or more from it is passing by, and its rest starts again. */
  let restAt: { x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chosen: HTMLVideoElement | null = null;
  let warmedKey: string | null = null;
  const here = () => pageKey(deps.doc.location.href);
  const view = () => deps.doc.defaultView ?? window;
  const blocked = () => !on || pending || deps.running() || stoppedKey === here();

  function videoAt(x: number, y: number): HTMLVideoElement | null {
    for (const v of Array.from(deps.doc.querySelectorAll('video'))) {
      // Playing, or paused on a decoded frame (a viewer pauses to look at a card: Live then reads that still frame).
      if (!liveTakes(v, view())) continue;
      if (normPointOf(v, x, y, view()) !== null) return v;
    }
    return null;
  }

  /** The page has a video of ARM's size, playing or not: the engine is asked to load (once for this page). */
  function warmIfVideo() {
    if (!on || !deps.warm || warmedKey === here()) return;
    const big = Array.from(deps.doc.querySelectorAll('video')).some((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= ARM.minW && r.height >= ARM.minH;
    });
    if (!big) return;
    warmedKey = here();
    deps.warm();
  }

  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    candidate = null;
    restAt = null;
  }

  /** The rest on `v` (re)starts at (x, y): ARM.dwellMs from now. */
  function restOn(v: HTMLVideoElement, x: number, y: number) {
    clearTimeout(timer);
    candidate = v;
    restAt = { x, y };
    timer = setTimeout(() => rested(v), ARM.dwellMs);
  }

  function rested(v: HTMLVideoElement) {
    timer = undefined;
    candidate = null;
    restAt = null;
    if (blocked() || deps.doc.hidden || deps.now() < retryAt || videoAt(last.x, last.y) !== v) return;
    chosen = v;
    pending = true;
    const refused = () => (retryAt = deps.now() + ARM.retryMs);
    void deps
      .start()
      .then((ok) => void (ok || refused()), refused)
      .finally(() => (pending = false));
  }

  return {
    get on() {
      return on;
    },
    get video() {
      return chosen;
    },
    get lastPointer() {
      return moved ? { ...last } : null;
    },
    setOn(next) {
      on = next;
      if (next) {
        stoppedKey = null; // switched on again: every page may start afresh
        warmIfVideo();
      } else cancel();
    },
    stoppedHere() {
      stoppedKey = here();
      cancel();
    },
    gone() {
      cancel();
    },
    pointer(x, y) {
      last = { x, y };
      moved = true;
      if (blocked()) return;
      // Moving across the video, not resting on it: the rest starts again from here (Live reads only where it rests).
      if (candidate && restAt && Math.hypot(x - restAt.x, y - restAt.y) >= ARM.restPx) restOn(candidate, x, y);
      const now = deps.now();
      if (now - checkedAt < ARM.checkMs || now < retryAt) return;
      checkedAt = now;
      warmIfVideo(); // a video the page added later (a feed, a player loaded on click)
      const v = videoAt(x, y);
      if (v === candidate) return; // still resting on it: its timer runs
      cancel();
      if (!v) return;
      restOn(v, x, y);
    },
  };
}
