// Live's label on the video: a red dot, "Live", how many cards the run has logged, and a ✕ that stops it.
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
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      document.removeEventListener('fullscreenchange', place);
    };
  }, [video]);
  return at;
}

export function LivePill({ view, onStop }: { view: LiveView; onStop(): void }) {
  const at = useCorner(view.running && view.showLabel ? view.video : null);
  if (!view.running || !view.showLabel || !view.video || !at) return null;
  return (
    <div class={`live-pill${view.paused ? ' paused' : ''}`} style={{ left: `${at.left}px`, top: `${at.top}px` }}>
      <span class={`live-dot${view.paused ? ' paused' : ''}`} aria-hidden="true" />
      <span class="live-word">{t('live_label')}</span>
      <span class="live-count">{view.count}</span>
      <button type="button" class="x" aria-label={t('live_stop_label')} title={t('live_stop_label')} onClick={byUser(() => onStop())}>
        ✕
      </button>
    </div>
  );
}
