// Live's pace: wait long enough after each read that reading costs at most the effort's share of time.
import { LIVE, LIVE_EFFORTS, type LiveEffort } from '../../shared/live';

export interface Rate {
  /** Milliseconds to wait before the next read, given what this one cost; `active`: the pointer moves over the picture. */
  next(costMs: number, active?: boolean): number;
  /** The last LIVE.slowFrames waits were all longer than the effort's slowAboveMs. */
  readonly slow: boolean;
  setEffort(e: LiveEffort): void;
}

export function createRate(effort: LiveEffort): Rate {
  let cfg = LIVE_EFFORTS[effort];
  let slowCycles = 0;
  return {
    next(costMs, active = false) {
      const wait = Math.round(Math.min(LIVE.maxIntervalMs, Math.max(cfg.minIntervalMs, costMs / (active ? cfg.activeLoad : cfg.load))));
      slowCycles = wait > cfg.slowAboveMs ? slowCycles + 1 : 0;
      return wait;
    },
    get slow() {
      return slowCycles >= LIVE.slowFrames;
    },
    setEffort(e) {
      cfg = LIVE_EFFORTS[e];
      slowCycles = 0; // the threshold changed, so earlier cycles no longer say anything
    },
  };
}
