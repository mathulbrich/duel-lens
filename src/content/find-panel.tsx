// "Find a card by name" in scan mode: the bar's "Find card" (or /) opens this panel under the bar: the name search over
// the local card list (wrong-card.tsx's), whose pick app.tsx shows in the popover as any card ("Found by name"). The
// panel takes its own keys (data-own-keys: arrows, Tab and Enter work in it as anywhere, keys.ts leaves them alone);
// Esc closes it, back to scan mode. Nothing reaches YGOPRODeck while typing: the matches are the local card list's.
import { t } from '../shared/i18n';
import type { Rect } from './geometry';
import { WrongCardPanel, type WrongCardMatch } from './wrong-card';

export interface FindPanelProps {
  /** The bar: the panel opens under its middle. */
  bar: Rect;
  onPick(match: WrongCardMatch): void;
  onClose(): void;
}

export const FIND_PANEL_WIDTH = 340;

export function FindPanel({ bar, onPick, onClose }: FindPanelProps) {
  const left = Math.max(8, Math.min(bar.x + bar.w / 2 - FIND_PANEL_WIDTH / 2, window.innerWidth - FIND_PANEL_WIDTH - 8));
  return (
    <div
      class="ov find-panel"
      data-own-keys=""
      role="dialog"
      aria-label={t('sidepanel_search_placeholder')}
      style={{ left: `${left}px`, top: `${bar.y + bar.h + 8}px`, width: `${FIND_PANEL_WIDTH}px` }}
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
