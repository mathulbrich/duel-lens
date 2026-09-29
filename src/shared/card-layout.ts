// Geometry of a Yu-Gi-Oh! card, shared by the engine (src/offscreen) and the index tools.
// Owner: recognition engine stream (B).

/** A rectangle as fractions of the full card (0..1, origin at the top-left corner). */
export interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Width / height of a card (59 × 86 mm). */
export const CARD_ASPECT = 59 / 86;

/** The size, in pixels, the engine straightens a found card to (portrait, the card's aspect). */
export const CARD_W = 590;
export const CARD_H = 860;

/**
 * Where YGOPRODeck's artwork crop (images/cards_cropped/<id>.jpg, the image the index is
 * built from) sits inside the full card image (images/cards/<id>.jpg, 813×1185).
 *
 * Measured 2026-09-28 by src/offscreen/__measure__/measure-art-box.ts: grayscale
 * mean-squared-difference search over scale and position (1/8 → 1/4 → full scale).
 * Normal, effect, spell, link, xyz and synchro frames all give x=96 y=215 w=622 h=622 px
 * (624×624 crop); Mirror Force (trap) gives 97, 217, 619 px.
 */
export const ART_BOX: CardBox = { x: 0.118, y: 0.181, w: 0.765, h: 0.525 };

/**
 * Pendulum frames. Their cards_cropped image (712×908) is the whole illustration at the
 * card image's scale: x=50 y=212 px, found by matching its top half (the part not covered
 * by text boxes; Odd-Eyes Pendulum Dragon and Bujin Hiruko, same method and date). On the
 * printed card the illustration is visible only down to the Pendulum text box (about
 * 0.62 of the card height); this box covers the whole illustration so that a crop of it
 * is aligned with the indexed image.
 *
 * The engine does not use it: on 14 straightened pendulum cards, the standard ART_BOX
 * ranked the right card first 13 times, this box 9 times (DINOv2-small, 2026-09-28).
 */
export const ART_BOX_PENDULUM: CardBox = { x: 0.062, y: 0.179, w: 0.876, h: 0.766 };
