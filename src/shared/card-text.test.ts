import { describe, expect, it } from 'vitest';
import { CARD_BOX_PX, CARD_TEXT_PX, cardTextCss } from './card-text';

describe('card text choices', () => {
  it('turns the choices into the overlay\'s custom properties, unknown ones into the defaults', () => {
    expect(cardTextCss({ textSize: 'large', boxWidth: 'compact' })).toBe(`:host { --dl-text: ${CARD_TEXT_PX.large}px; --dl-pop-w: ${CARD_BOX_PX.compact}px; }`);
    expect(cardTextCss({ textSize: 'huge', boxWidth: 3 })).toBe(`:host { --dl-text: ${CARD_TEXT_PX.small}px; --dl-pop-w: ${CARD_BOX_PX.wide}px; }`);
    expect(cardTextCss(undefined)).toBe(cardTextCss({ textSize: 'small', boxWidth: 'wide' }));
  });
});
