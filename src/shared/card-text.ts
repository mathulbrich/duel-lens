// How a card's text shows in Duel Lens's card box (Options, "Card text"): its size and the box's width. The overlay's
// stylesheet reads both as custom properties (content/styles.ts --dl-text, --dl-pop-w), set from the settings by
// cardTextCss, so a change in Options reaches every open card box at once (content/host.ts setHostPrefs).

export type CardTextSize = 'small' | 'medium' | 'large' | 'xlarge';
export type CardBoxWidth = 'compact' | 'wide';

/** The text's size in CSS px for each choice; 'small' is the default. */
export const CARD_TEXT_PX: Record<CardTextSize, number> = { small: 13, medium: 14.5, large: 16, xlarge: 18 };
/** The card box's width in CSS px for each choice (never wider than the window): 'wide' is the default. */
export const CARD_BOX_PX: Record<CardBoxWidth, number> = { compact: 372, wide: 420 };
export const CARD_TEXT_SIZES = Object.keys(CARD_TEXT_PX) as CardTextSize[];
export const CARD_BOX_WIDTHS = Object.keys(CARD_BOX_PX) as CardBoxWidth[];

export const isCardTextSize = (v: unknown): v is CardTextSize => typeof v === 'string' && v in CARD_TEXT_PX;
export const isCardBoxWidth = (v: unknown): v is CardBoxWidth => typeof v === 'string' && v in CARD_BOX_PX;

/** The overlay's custom properties for these choices (unknown values: the defaults). */
export function cardTextCss(display: { textSize?: unknown; boxWidth?: unknown } | undefined): string {
  const size = isCardTextSize(display?.textSize) ? display.textSize : 'small';
  const width = isCardBoxWidth(display?.boxWidth) ? display.boxWidth : 'wide';
  return `:host { --dl-text: ${CARD_TEXT_PX[size]}px; --dl-pop-w: ${CARD_BOX_PX[width]}px; }`;
}
