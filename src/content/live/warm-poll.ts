// Live's "getting ready" (pill.tsx): while a run waits for its first detection, how many of the engine's start steps
// are done (WarmState), asked of the background every WARM_POLL.everyMs. Asking stops once every step is done, while
// the page is hidden (no frame is read then, and Firefox's event page would be kept awake for nothing), and when the
// run is ready or ends.
import { WARM_STEPS, type WarmState } from '../../shared/messages';

export const WARM_POLL = { everyMs: 500 } as const;

export interface WarmPollDeps {
  doc: Document;
  ask: () => Promise<WarmState | undefined>;
  /** The number of steps done changed. */
  onChange: (done: number) => void;
}

export interface WarmPoll {
  /** The start steps done, as last answered (0 until then). */
  readonly done: number;
  /** Whether a run waits for its first detection: asking follows it. */
  follow(waiting: boolean): void;
}

export function createWarmPoll(deps: WarmPollDeps): WarmPoll {
  let timer: ReturnType<typeof setInterval> | undefined;
  let done = 0;
  let waiting = false;
  let finished = false;
  /** Which wait a reply belongs to: one asked for an earlier run is dropped. */
  let gen = 0;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  const ask = () => {
    const mine = gen;
    void deps.ask().then(
      (s) => {
        if (!waiting || mine !== gen) return;
        const n = WARM_STEPS.filter((step) => s?.done?.[step] !== undefined).length;
        if (n !== done) {
          done = n;
          deps.onChange(n);
        }
        if (n >= WARM_STEPS.length) {
          finished = true;
          stop();
        }
      },
      () => undefined,
    );
  };
  const resume = () => {
    if (!waiting || finished || timer !== undefined || deps.doc.hidden) return;
    ask();
    timer = setInterval(ask, WARM_POLL.everyMs);
  };
  deps.doc.addEventListener('visibilitychange', () => (deps.doc.hidden ? stop() : resume()));
  return {
    get done() {
      return done;
    },
    follow(next) {
      if (!next) {
        if (waiting) gen++;
        waiting = finished = false;
        done = 0;
        stop();
        return;
      }
      waiting = true;
      resume();
    },
  };
}
