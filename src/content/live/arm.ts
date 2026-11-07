// Live check's arming (spec D-L14): with the switch on, a page's script only watches the pointer. Once it is over a
// playing, readable video, the background is asked to start Live here (its usual start: consent, log, badge, pill).
// Nothing is read and the engine is not loaded before that, so a page with Live check on costs nothing until then.
import { eligible, normPointOf, pageKey } from './video';

/** How often the pointer is checked against the videos, and how long a refused start waits before another (ms). */
export const ARM = { checkMs: 250, retryMs: 5000 } as const;

export interface LiveArmDeps {
  doc: Document;
  now: () => number;
  /** Whether Live runs on this page already. */
  running: () => boolean;
  /** Asks the background to start Live here; whether it started. */
  start: () => Promise<boolean>;
}

export interface LiveArm {
  setOn(on: boolean): void;
  readonly on: boolean;
  /** A trusted pointer move, viewport px. */
  pointer(x: number, y: number): void;
  /** Live was stopped on this page by the user (or the video can't be read): not again until the page changes. */
  stoppedHere(): void;
}

export function createLiveArm(deps: LiveArmDeps): LiveArm {
  let on = false;
  let checkedAt = -Infinity;
  let retryAt = -Infinity;
  let pending = false;
  let stoppedKey: string | null = null;
  const here = () => pageKey(deps.doc.location.href);
  return {
    get on() {
      return on;
    },
    setOn(next) {
      on = next;
      if (next) stoppedKey = null; // switched on again: every page may start afresh
    },
    stoppedHere() {
      stoppedKey = here();
    },
    pointer(x, y) {
      if (!on || pending) return;
      const now = deps.now();
      if (now - checkedAt < ARM.checkMs || now < retryAt) return;
      checkedAt = now;
      if (deps.running() || stoppedKey === here()) return;
      const view = deps.doc.defaultView ?? window;
      const over = Array.from(deps.doc.querySelectorAll('video')).some(
        (v) => !v.paused && !v.ended && eligible(v, view) && normPointOf(v, x, y, view) !== null,
      );
      if (!over) return;
      pending = true;
      const refused = () => (retryAt = deps.now() + ARM.retryMs);
      void deps
        .start()
        .then((ok) => void (ok || refused()), refused)
        .finally(() => (pending = false));
    },
  };
}
