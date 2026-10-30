// "Find a card by name" in scan mode: the bar's "Find card" (or /) opens this panel under the bar (above it, when the bar
// sits low in the frame): the name search over the local card list (wrong-card.tsx's), whose pick app.tsx shows in the
// popover as any card ("Found by name"). The panel takes its own keys (data-own-keys: arrows and Enter work in it as
// anywhere, keys.ts leaves them alone, and the page never gets them, host.ts); Tab goes round its box and matches, and
// Esc closes it, back to scan mode (selection.tsx, app.tsx). Nothing reaches YGOPRODeck while typing: the matches are
// the local card list's.
import { t } from '../shared/i18n';
import type { Rect } from './geometry';
import { WrongCardPanel, type WrongCardMatch } from './wrong-card';

export interface FindPanelProps {
  /** The bar: the panel opens under its middle, or above it when the bar is in the lower half of the frame. */
  bar: Rect;
  onPick(match: WrongCardMatch): void;
  onClose(): void;
}

export const FIND_PANEL_WIDTH = 340;
/** Between the bar and the panel, and between the panel and the frame's edge (CSS px). */
const GAP = 8;

export function FindPanel({ bar, onPick, onClose }: FindPanelProps) {
  const left = Math.max(GAP, Math.min(bar.x + bar.w / 2 - FIND_PANEL_WIDTH / 2, window.innerWidth - FIND_PANEL_WIDTH - GAP));
  // The bar sits at the top of the frame, or at its bottom when cards are under the top: the panel goes where the room is.
  const below = bar.y + bar.h / 2 < window.innerHeight / 2;
  const place = below
    ? { top: `${bar.y + bar.h + GAP}px`, maxHeight: `${window.innerHeight - (bar.y + bar.h) - 2 * GAP}px` }
    : { bottom: `${window.innerHeight - bar.y + GAP}px`, maxHeight: `${bar.y - 2 * GAP}px` };
  return (
    <div
      class="ov find-panel"
      data-own-keys=""
      role="dialog"
      aria-label={t('sidepanel_search_placeholder')}
      data-side={below ? 'below' : 'above'}
      style={{ left: `${left}px`, width: `${FIND_PANEL_WIDTH}px`, ...place }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <p class="find-title">{t('sidepanel_search_placeholder')}</p>
      <WrongCardPanel onPick={onPick} label={t('sidepanel_search_placeholder')} />
    </div>
  );
}
