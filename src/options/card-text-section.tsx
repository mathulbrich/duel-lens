// Options, "Card text": the card text's size and the card box's width (shared/card-text.ts), with a preview: the
// real card box (content/card-view.tsx CardView, with the overlay's own stylesheet) showing a made-up card whose
// text runs as long as a modern effect, so a choice is seen before the next card is read.
import { render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { CardView } from '../content/card-view';
import { CSS } from '../content/styles';
import { CARD_BOX_WIDTHS, CARD_TEXT_SIZES, cardTextCss, type CardBoxWidth, type CardTextSize } from '../shared/card-text';
import { t, type MessageKey } from '../shared/i18n';
import type { CardRecord, Settings } from '../shared/types';

const SIZE_LABEL: Record<CardTextSize, MessageKey> = {
  small: 'options_card_text_small',
  medium: 'options_card_text_medium',
  large: 'options_card_text_large',
  xlarge: 'options_card_text_xlarge',
};
const WIDTH_LABEL: Record<CardBoxWidth, MessageKey> = { compact: 'options_card_box_compact', wide: 'options_card_box_wide' };

/** A made-up card (not a real one), its text as long as a modern effect's. */
const SAMPLE: CardRecord = {
  id: 1,
  name: 'Sample Dragon of the Tide',
  type: 'Effect Monster',
  humanType: 'Effect Monster',
  frameType: 'effect',
  typeline: ['Dragon', 'Effect'],
  race: 'Dragon',
  attribute: 'WATER',
  level: 8,
  atk: 3000,
  def: 2500,
  imageIds: [],
  desc:
    '① If a WATER monster you control is targeted by a card effect: you can Special Summon this card from your hand, then you can return 1 card your opponent controls to the hand. ② When this card is Special Summoned: you can add 1 "Tide" Spell or Trap from your Deck to your hand; for the rest of this turn, you cannot Special Summon from the Extra Deck, except WATER monsters. ③ If this card in your possession is destroyed by your opponent\'s card and sent to your GY: you can target 1 card on the field; destroy it. You can only use each effect of "Sample Dragon of the Tide" once per turn.',
};

/** The preview's box sits in the page, not over it as the overlay's does. */
const PREVIEW_CSS = '.dl.dl-preview-root { position: static; inset: auto; pointer-events: auto; } .pop.dl-preview { position: static; max-height: none; box-shadow: none; } .pop.dl-preview::after { display: none; }';

export function CardTextSection({ display, onChange }: { display: Settings['display']; onChange(patch: Partial<Settings['display']>): void }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    root.replaceChildren();
    const style = document.createElement('style');
    style.textContent = CSS + cardTextCss(display) + PREVIEW_CSS;
    const mount = document.createElement('div');
    root.append(style, mount);
    render(
      <div class="dl dl-preview-root">
        <div class="ov pop dl-preview">
          <div class="pop-scroll">
            <CardView card={SAMPLE} imageDataUrl={null} />
          </div>
        </div>
      </div>,
      mount,
    );
    return () => render(null, mount);
  }, [display.textSize, display.boxWidth]);

  return (
    <section id="card-text" class="op-section" aria-labelledby="card-text-title">
      <h2 id="card-text-title">{t('options_section_card_text')}</h2>
      <p class="hint">{t('options_card_text_hint')}</p>
      <div class="choices" role="radiogroup" aria-label={t('options_card_text_size')}>
        <b>{t('options_card_text_size')}</b>
        {CARD_TEXT_SIZES.map((s) => (
          <label class="check" key={s}>
            <input type="radio" name="card-text-size" value={s} checked={display.textSize === s} onChange={() => onChange({ textSize: s })} />
            {t(SIZE_LABEL[s])}
          </label>
        ))}
      </div>
      <div class="choices" role="radiogroup" aria-label={t('options_card_box_width')}>
        <b>{t('options_card_box_width')}</b>
        {CARD_BOX_WIDTHS.map((w) => (
          <label class="check" key={w}>
            <input type="radio" name="card-box-width" value={w} checked={display.boxWidth === w} onChange={() => onChange({ boxWidth: w })} />
            {t(WIDTH_LABEL[w])}
          </label>
        ))}
      </div>
      <div ref={host} class="card-text-preview" aria-label={t('options_card_text_preview')} role="img" />
    </section>
  );
}
