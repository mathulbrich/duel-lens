// Outlines on the playing video (D-L13): a solid gold one around every card Live has listed and still tracks, a dashed
// grey one around a card it is still reading. Rendered in Live's host (index.ts) beside the pill. Only the gold ones
// take the pointer: a rest on one shows today's quick preview or the card box (Options → Show card details), a click
// opens the card box; the rest of the video stays the player's. They are buttons out of the Tab order (the side
// panel's Live list is the keyboard path), named by their card, so a screen reader finds them with the pointer.
import { useEffect, useLayoutEffect, useReducer, useRef } from 'preact/hooks';
import type { RecognizeResponse } from '../../shared/messages';
import { HOVER_MS } from '../app';
import type { Rect } from '../geometry';
import { Preview, previewText } from '../preview';
import { fromUser } from '../trusted';
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
  /** Card names by id, for the outlines' accessible names. */
  names: Record<number, string>;
  /** The pointer rested on a listed card's outline. */
  onHover(cardId: number, imageId: number, anchor: Rect): void;
  onLeave(): void;
  /** A trusted click on a listed card's outline. */
  onPick(cardId: number, imageId: number, anchor: Rect): void;
}

export function LiveOutlines({ cards, video, names, onHover, onLeave, onPick }: LiveOutlinesProps) {
  useVideoMoves(video);
  const rest = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(rest.current), []);
  if (!cards.length) return null;
  return (
    <div class="live-outlines">
      {cards.map((c) => {
        const at = viewportRectOf(video, c.box);
        if (!at) return null;
        const style = { left: `${at.x}px`, top: `${at.y}px`, width: `${at.w}px`, height: `${at.h}px` };
        if (c.state !== 'promoted' || c.cardId === undefined || c.imageId === undefined) {
          return <div key={c.trackId} class="live-outline reading" style={style} aria-hidden="true" />;
        }
        const { cardId, imageId } = c;
        return (
          <button
            key={c.trackId}
            type="button"
            class="live-outline promoted"
            style={style}
            tabIndex={-1}
            aria-label={names[cardId]}
            onPointerEnter={(e) => {
              if (!fromUser(e)) return;
              clearTimeout(rest.current);
              rest.current = setTimeout(() => onHover(cardId, imageId, at), HOVER_MS);
            }}
            onPointerLeave={(e) => {
              if (!fromUser(e)) return;
              clearTimeout(rest.current);
              onLeave();
            }}
            // Keeps focus where it is (on the player), as the scan's frozen frame does.
            onPointerDown={(e) => fromUser(e) && e.preventDefault()}
            onClick={(e) => fromUser(e) && onPick(cardId, imageId, at)}
          />
        );
      })}
    </div>
  );
}

export interface LiveHoverCardProps {
  reveal: 'preview' | 'full' | 'click';
  /** The hovered card's read (a card found by name), where it sits, and its artwork when loaded. */
  shown: { response: RecognizeResponse; anchor: Rect; images: Record<number, string | null> } | null;
  /** The pointer is on the preview, or left it (it stays while the pointer is over it, WCAG 1.4.13). */
  onEnter(): void;
  onLeave(): void;
  /** A click on the preview opens the card box. */
  onPick(): void;
  onClose(): void;
}

/** What a rest on an outline shows: the quick preview, the card box (passive) or, for "Click", nothing. */
export function LiveHoverCard({ reveal, shown, onEnter, onLeave, onPick, onClose }: LiveHoverCardProps) {
  if (!shown || reveal === 'click') return null;
  if (reveal === 'full') return <LiveCardBox response={shown.response} anchor={shown.anchor} images={shown.images} onClose={onClose} />;
  return <Preview anchor={shown.anchor} text={previewText(shown.response)} avoid={() => []} onEnter={onEnter} onLeave={onLeave} onPick={onPick} />;
}
