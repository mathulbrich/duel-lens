// The card box over a Live video: a Live row's click shows today's popover (a card found by name: Copy and YGOPRODeck,
// no history entry, so no Keep, no other matches, no Ask AI, no "Wrong card?", no Report) beside the card, while the
// video plays and Live keeps reading. It never takes the focus, so Space and K still reach the player; Esc or the ✕
// closes it. Rendered in Live's host next to the pill (index.ts).
import { useEffect } from 'preact/hooks';
import type { RecognizeResponse } from '../../shared/messages';
import type { Rect } from '../geometry';
import { Popover } from '../popover';
import { fromUser } from '../trusted';

const OFF_ROW = ['above', 'below', 'right', 'left'] as const;

export function LiveCardBox(props: {
  response: RecognizeResponse;
  anchor: Rect;
  images: Record<number, string | null>;
  onClose(): void;
  onEnter?(): void;
  onLeave?(): void;
  /** Shown by hovering: above or below the card first, so the cards beside it in a row (a hand) stay free to point at. */
  hover?: boolean;
}) {
  const { response, anchor, images, onClose, onEnter, onLeave, hover } = props;
  // The box's one key: Esc, before the page sees it. Every other key goes on to the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !fromUser(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <Popover
      anchor={anchor}
      state={{ kind: 'result', response, selected: 0 }}
      images={images}
      passive
      onEnter={onEnter}
      onLeave={onLeave}
      sides={hover ? OFF_ROW : undefined}
      onClose={() => onClose()}
      onKeep={() => undefined}
      onCorrect={() => undefined}
      onAskAi={() => undefined}
    />
  );
}
