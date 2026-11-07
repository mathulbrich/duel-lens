// Live's label on the video: a red dot, "Live", how many cards the run has logged (or "getting ready" with a bar
// while the engine loads), and a ✕ that stops it.
// "Live N" is a button that opens the panel on its Live view, where the cards are listed.
// Rendered in its own host (index.ts, LIVE_HOST_ID), 12 px inside the video's top-left corner. Only the pill takes
// the pointer (.live-pill); every other click goes to the player.
import { useLayoutEffect, useState } from 'preact/hooks';
import { t } from '../../shared/i18n';
import { byUser } from '../trusted';
import type { LiveView } from './controller';

/** How far inside the video's corner the pill sits (CSS px). */
const INSET = 12;

/** The pill's place: the video's top-left corner, kept right as the page moves, resizes or goes fullscreen. */
function useCorner(video: HTMLVideoElement | null): { left: number; top: number } | null {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!video) return setAt(null);
    const place = () => {
      const r = video.getBoundingClientRect();
      setAt((now) => (now && now.left === r.left + INSET && now.top === r.top + INSET ? now : { left: r.left + INSET, top: r.top + INSET }));
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true); // any scrolling ancestor moves the video
    document.addEventListener('fullscreenchange', place);
    // Theater mode and the miniplayer resize or move the video without a window resize.
    const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : null;
    watcher?.observe(video);
    return () => {
      watcher?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('fullscreenchange', place);
    };
  }, [video]);
  return at;
}

/**
 * `warm`: the engine's start steps done, of `total` (WarmState), shown as a bar while Live is getting ready (no
 * detection answered yet): on a slow computer the models take seconds to load and prepare.
 */
export function LivePill({ view, warm, onStop, onOpen }: { view: LiveView; warm?: { done: number; total: number }; onStop(): void; onOpen?(): void }) {
  const at = useCorner(view.running && view.showLabel ? view.video : null);
  if (!view.running || !view.showLabel || !view.video || !at) return null;
  return (
    <div class={`live-pill${view.paused ? ' paused' : ''}`} style={{ left: `${at.left}px`, top: `${at.top}px` }}>
      <button type="button" class="open" title={t('live_open_panel_label')} onClick={byUser(() => onOpen?.())}>
        <span class={`live-dot${view.paused ? ' paused' : ''}`} aria-hidden="true" />
        <span class="live-word">{t('live_label')}</span>
        {view.ready ? (
          <span class="live-count">{view.count}</span>
        ) : (
          <span class="live-ready" role="status">
            {t('live_getting_ready')}
            <span class="live-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((100 * Math.min(warm?.done ?? 0, warm?.total ?? 1)) / Math.max(1, warm?.total ?? 1))}%` }} />
            </span>
          </span>
        )}
      </button>
      <button type="button" class="x" aria-label={t('live_stop_label')} title={t('live_stop_label')} onClick={byUser(() => onStop())}>
        ✕
      </button>
    </div>
  );
}
