// The outline on the playing video (D-L13): only around the card under the pointer (index.ts follows the pointer with
// cardAt), solid gold when Live has listed it, dashed grey while it is still reading it. Rendered in Live's host beside
// the pill; it never takes the pointer, so clicks and hovers stay the player's. A rest on a listed card shows its quick
// preview or card box (LiveHoverCard); the side panel's Live list is the keyboard path.
import { useLayoutEffect, useReducer } from 'preact/hooks';
import { t } from '../../shared/i18n';
import type { RecognizeResponse } from '../../shared/messages';
import type { Rect } from '../geometry';
import { Preview, previewText } from '../preview';
import { LiveCardBox } from './card-box';
import type { LiveView } from './controller';
import { viewportRectOf } from './video';

/** Re-renders when the video moves or resizes: the same events as the pill. */
function useVideoMoves(video: HTMLVideoElement): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    window.addEventListener('resize', bump);
    window.addEventListener('scroll', bump, true); // any scrolling ancestor moves the video
    document.addEventListener('fullscreenchange', bump);
    const watcher = typeof ResizeObserver === 'function' ? new ResizeObserver(bump) : null;
    watcher?.observe(video);
    return () => {
      watcher?.disconnect();
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
      document.removeEventListener('fullscreenchange', bump);
    };
  }, [video]);
}

export interface LiveOutlinesProps {
  cards: LiveView['cards'];
  video: HTMLVideoElement;
  /** The track under the pointer (cardAt), the only one outlined; null draws nothing. */
  pointed: number | null;
}

/** The card whose outline holds the viewport point (x, y): the smallest, where outlines overlap; null when none does. */
export function cardAt(cards: LiveView['cards'], video: HTMLVideoElement, x: number, y: number): LiveView['cards'][number] | null {
  let best: LiveView['cards'][number] | null = null;
  let bestArea = Infinity;
  for (const c of cards) {
    const at = viewportRectOf(video, c.box);
    if (!at || x < at.x || x > at.x + at.w || y < at.y || y > at.y + at.h) continue;
    if (at.w * at.h < bestArea) [best, bestArea] = [c, at.w * at.h];
  }
  return best;
}

export function LiveOutlines({ cards, video, pointed }: LiveOutlinesProps) {
  useVideoMoves(video);
  const c = pointed === null ? undefined : cards.find((x) => x.trackId === pointed);
  const at = c && viewportRectOf(video, c.box);
  if (!c || !at) return null;
  const style = { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px` };
  return (
    <div class="live-outlines">
      <div class={`live-outline ${c.state === 'promoted' ? 'promoted' : 'reading'}`} style={style} aria-hidden="true" />
    </div>
  );
}

export interface LiveHoverCardProps {
  reveal: 'preview' | 'full' | 'click';
  /** The hovered card's read (a card found by name; none while it is still being read), where it sits, and its artwork when loaded. */
  shown: { response: RecognizeResponse | null; anchor: Rect; images: Record<number, string | null> } | null;
  /** The pointer is on the preview, or left it (it stays while the pointer is over it, WCAG 1.4.13). */
  onEnter(): void;
  onLeave(e: PointerEvent): void;
  /** A click on the preview opens the card box. */
  onPick(): void;
  onClose(): void;
}

/**
 * What a rest on a listed card shows: the card box (passive) for "Full", else the quick preview. Live's outline takes
 * no click, so "Click" shows the preview too: a click on it opens the card box.
 */
export function LiveHoverCard({ reveal, shown, onEnter, onLeave, onPick, onClose }: LiveHoverCardProps) {
  if (!shown) return null;
  // The pointer on the box keeps it, as on the preview: its effect text can be scrolled.
  if (reveal === 'full') return <LiveCardBox response={shown.response} anchor={shown.anchor} images={shown.images} onClose={onClose} onEnter={onEnter} onLeave={onLeave} hover />;
  const text = shown.response ? previewText(shown.response) : { kind: 'none' as const, head: t('content_matching_artwork') };
  return <Preview anchor={shown.anchor} text={text} avoid={() => []} onEnter={onEnter} onLeave={onLeave} onPick={shown.response ? onPick : () => undefined} />;
}
