// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { CardRecord } from '../shared/types';
import { BanFrame, CardView, konamiUrl, priceAsOfLabel, ygoprodeckUrl } from './card-view';
import { setBanlist, setPriceAsOf } from './prefs';
import { trustEvents, untrusted } from './test-events';
import { ASH, DM, MST, NORMAL_PEND, ODD_EYES, POT, SLIFER, TALKER, UTOPIA } from './test-fixtures';

afterEach(() => {
  cleanup();
  setBanlist('tcg');
  setPriceAsOf(undefined);
});

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** The bottom line's labelled numbers, as "Label value" (the price's amounts as shown). */
const meta = (root: ParentNode) =>
  [...root.querySelectorAll('.dv-ids > div')].map((d) => `${d.querySelector('dt')?.textContent} ${(d.querySelector('dd [aria-hidden]') ?? d.querySelector('dd'))?.textContent}`);
/** The fact whose whole text is `label` (the banlist's list, "TCG", is set apart in its own element). */
const fact = (label: string) => screen.getByText((_, el) => !!el && el.matches('.fact') && text(el) === label);

let bundled: CardRecord[] | undefined;
/** A real record from the card data the extension ships (extension/data/cards.json), Genesys points included. */
function bundledCard(name: string): CardRecord {
  bundled ??= (JSON.parse(readFileSync(path.join(process.cwd(), 'extension/data/cards.json'), 'utf8')) as { cards: CardRecord[] }).cards;
  const card = bundled.find((c) => c.name === name);
  if (!card) throw new Error(`no ${name} in cards.json`);
  return card;
}

describe('CardView', () => {
  it('shows name, type line, facts, effect text with bullets, and the passcode', () => {
    const { container } = render(<CardView card={ASH} imageDataUrl="data:image/jpeg;base64,AAAA" />);
    expect(screen.getByRole('heading', { name: 'Ash Blossom & Joyous Spring' })).toBeTruthy();
    expect(screen.getByText('[Zombie / Tuner / Effect]')).toBeTruthy();
    expect(screen.getByText('FIRE')).toBeTruthy();
    expect(screen.getByText('Level 3')).toBeTruthy();
    expect(screen.getByText('ATK 0 / DEF 1800')).toBeTruthy();
    // One paragraph per line, bullets kept.
    const paras = [...container.querySelectorAll('.dv-text p')].map((p) => p.textContent);
    expect(paras).toEqual([
      'When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.',
      '● Add a card from the Deck to the hand.',
      '● Special Summon from the Deck.',
      '● Send a card from the Deck to the GY.',
      'You can only use this effect of "Ash Blossom & Joyous Spring" once per turn.',
    ]);
    expect(meta(document)).toContain('Passcode 14558127');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('shows LINK-4 with its arrows, ATK and no DEF for a Link monster', () => {
    const { container } = render(<CardView card={TALKER} imageDataUrl={null} />);
    expect(screen.getByText('LINK-4')).toBeTruthy();
    // The arrows drawn as the card draws them: a 3x3 grid, the four arrows lit.
    const grid = screen.getByRole('img', { name: 'Link arrows: Top, Left, Right, Bottom' });
    expect(grid.querySelectorAll('rect.on')).toHaveLength(4);
    expect(screen.getByText('ATK 2300')).toBeTruthy();
    expect(text(container)).not.toMatch(/DEF/);
  });

  it('shows the Pendulum Scale and the Pendulum and Monster Effects as separate sections', () => {
    render(<CardView card={ODD_EYES} imageDataUrl={null} />);
    expect(screen.getByText('Scale 4')).toBeTruthy();
    const pend = screen.getByRole('heading', { name: 'Pendulum Effect' }).closest('section');
    const mon = screen.getByRole('heading', { name: 'Monster Effect' }).closest('section');
    expect(text(pend)).toContain('You can reduce the battle damage you take');
    expect(text(pend)).not.toContain('battle damage this card inflicts to your opponent is doubled');
    expect(text(mon)).toContain('battle damage this card inflicts to your opponent is doubled');
  });

  it('labels a Normal Pendulum monster’s lore as Flavor Text, set in italics', () => {
    render(<CardView card={NORMAL_PEND} imageDataUrl={null} />);
    expect(screen.getByRole('heading', { name: 'Pendulum Effect' })).toBeTruthy();
    const lore = screen.getByRole('heading', { name: 'Flavor Text' }).closest('section');
    expect(lore?.classList.contains('flavor')).toBe(true);
    expect(screen.queryByRole('heading', { name: 'Monster Effect' })).toBeNull();
  });

  it('shows Rank for an Xyz monster', () => {
    render(<CardView card={UTOPIA} imageDataUrl={null} />);
    expect(screen.getByText('Rank 4')).toBeTruthy();
    expect(screen.queryByText(/^Level/)).toBeNull();
  });

  it('shows a Spell with its property, no stats, and the TCG banlist status', () => {
    const { container } = render(<CardView card={POT} imageDataUrl={null} />);
    expect(screen.getByText('[Normal Spell]')).toBeTruthy();
    expect(screen.getByText('SPELL')).toBeTruthy();
    expect(fact('Forbidden · TCG')).toBeTruthy();
    expect(text(container)).not.toMatch(/ATK/);
  });

  it('prints ? for unknown ATK/DEF', () => {
    render(<CardView card={SLIFER} imageDataUrl={null} />);
    expect(screen.getByText('ATK ? / DEF ?')).toBeTruthy();
  });

  it('pads the passcode to 8 digits and shows the archetype, each under its small label', () => {
    const mst = render(<CardView card={MST} imageDataUrl={null} />);
    expect(meta(mst.container)).toEqual(['Passcode 05318639']);
    cleanup();
    const dm = render(<CardView card={DM} imageDataUrl={null} />);
    expect(meta(dm.container)).toEqual(['Passcode 46986414', 'Archetype Dark Magician']);
  });

  it('keeps its pages apart from its numbers, at the right of the bottom line', () => {
    const { container } = render(<CardView card={bundledCard('Pot of Greed')} imageDataUrl={null} />);
    const links = [...container.querySelectorAll('.dv-meta .dv-links a')].map((a) => a.textContent);
    expect(links).toEqual(['Konami database ↗', 'YGOPRODeck ↗']);
    expect(container.querySelector('.dv-ids a')).toBeNull();
  });

  it('sets Normal monster flavour text apart (italic)', () => {
    const { container } = render(<CardView card={DM} imageDataUrl={null} />);
    expect(container.querySelector('.dv-text')?.classList.contains('flavor')).toBe(true);
  });

  it('falls back to a text-only view when there is no image, and a placeholder while loading', () => {
    const none = render(<CardView card={ASH} imageDataUrl={null} />);
    expect(none.container.querySelector('img')).toBeNull();
    expect(none.container.querySelector('.dv')?.classList.contains('no-img')).toBe(true);
    cleanup();
    const loading = render(<CardView card={ASH} />);
    expect(loading.container.querySelector('img')).toBeNull();
    expect(screen.getByLabelText('Loading card image')).toBeTruthy();
  });
});

describe('CardView: TCG banlist status', () => {
  // With the mark players know (a prohibition circle, a circled 1, a circled 2), each in its own colour (real records).
  it('shows each status with its mark: Forbidden, Limited, Semi-Limited', () => {
    const cases: [string, string, string][] = [
      ['Pot of Greed', 'Forbidden · TCG', 'fact ban forbidden'],
      ['Instant Fusion', 'Limited · TCG', 'fact ban limited'],
      ['Ice Ryzeal', 'Semi-Limited · TCG', 'fact ban semi'],
    ];
    for (const [name, label, className] of cases) {
      render(<CardView card={bundledCard(name)} imageDataUrl={null} />);
      const status = fact(label);
      expect(status.className).toBe(className);
      expect(status.querySelector('svg.mark')).toBeTruthy();
      cleanup();
    }
  });

  it('shows no banlist chip for a card that is not on the TCG list', () => {
    const { container } = render(<CardView card={bundledCard('Dark Magician')} imageDataUrl={null} />);
    expect(container.querySelector('.fact.ban')).toBeNull();
  });
});

describe('konamiUrl', () => {
  it("links to the card's page on Konami's own database", () => {
    expect(konamiUrl(12950)).toBe('https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=12950&request_locale=en');
  });
});

describe('CardView: Konami database link', () => {
  it('shows it next to the passcode when the card has a konamiId', () => {
    render(<CardView card={{ ...ASH, konamiId: 12950 }} imageDataUrl={null} />);
    const link = screen.getByRole('link', { name: 'Konami database ↗' });
    expect(link.getAttribute('href')).toBe(konamiUrl(12950));
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('hides it when there is no konamiId (ASH, from cardinfo.nomisc.json, has none)', () => {
    render(<CardView card={ASH} imageDataUrl={null} />);
    expect(screen.queryByRole('link', { name: 'Konami database ↗' })).toBeNull();
  });
});

describe('CardView: banlist choice (TCG or OCG)', () => {
  it("shows the TCG status by default", () => {
    render(<CardView card={bundledCard('Pot of Greed')} imageDataUrl={null} />);
    expect(fact('Forbidden · TCG')).toBeTruthy();
  });

  it('shows the OCG status instead once the display setting is OCG', () => {
    setBanlist('ocg');
    // ASH (cardinfo.nomisc.json) has only an OCG status: Semi-Limited.
    render(<CardView card={ASH} imageDataUrl={null} />);
    expect(fact('Semi-Limited · OCG')).toBeTruthy();
  });

  it('shows no chip in OCG mode for a card with no OCG status, even if it has a TCG one', () => {
    setBanlist('ocg');
    const { container } = render(<CardView card={bundledCard('Bahamut Shark')} imageDataUrl={null} />);
    expect(container.querySelector('.fact.ban')).toBeNull();
  });

  // The user's ruling: only the selected list shows. Primeval Planet Perlereino is Semi-Limited in the OCG only, so in
  // TCG mode its box says nothing of the OCG (no status, no frame), and in OCG mode it says only the OCG's.
  it("never shows the other list's status: TCG mode says nothing of an OCG-only status", () => {
    setBanlist('tcg');
    const ash = { ...ASH, banlist: { ocg: 'Semi-Limited' } } as CardRecord;
    const { container, unmount } = render(<CardView card={ash} imageDataUrl="data:image/jpeg;base64,AAAA" />);
    expect(container.querySelector('.fact.ban')).toBeNull();
    expect(container.querySelector('.ban-frame')).toBeNull();
    expect(container.textContent).not.toContain('OCG');
    unmount();
    const both = render(<CardView card={{ ...ASH, banlist: { tcg: 'Limited', ocg: 'Forbidden' } } as CardRecord} imageDataUrl={null} />);
    expect([...both.container.querySelectorAll('.fact.ban')].map((e) => e.textContent)).toEqual(['Limited · TCG']);
  });
});

describe('CardView: prices', () => {
  // On the bottom line under "Price", not among the facts: the box stays small. The amounts show ($ is TCGplayer's,
  // € Cardmarket's); where they come from is in the tooltip and said to screen readers.
  it('shows the TCGplayer (USD) and Cardmarket (EUR) amounts under "Price", their sources in words, no buying link', () => {
    const { container } = render(<CardView card={{ ...ASH, prices: { tcgplayer: 1.23, cardmarket: 0.98 } }} imageDataUrl={null} />);
    expect(meta(container)).toContain('Price $1.23 · €0.98');
    const prices = container.querySelector('.dv-meta .dv-prices')!;
    expect(prices.getAttribute('title')).toBe('$1.23 TCGplayer · €0.98 Cardmarket');
    expect(prices.querySelector('.sr-only')?.textContent).toBe('$1.23 TCGplayer · €0.98 Cardmarket');
    expect(prices.querySelector('a')).toBeNull();
    expect(container.querySelector('.dv-facts')?.textContent).not.toContain('TCGplayer');
  });

  it('shows only the quoted side', () => {
    const { container } = render(<CardView card={{ ...ASH, prices: { tcgplayer: 1.23 } }} imageDataUrl={null} />);
    expect(meta(container)).toContain('Price $1.23');
    expect(container.querySelector('.dv-prices')?.getAttribute('title')).toBe('$1.23 TCGplayer');
  });

  it('shows nothing when there are no prices', () => {
    const { container } = render(<CardView card={ASH} imageDataUrl={null} />);
    expect(container.querySelector('.dv-prices')).toBeNull();
  });

  it("adds the data's date once it is known (setPriceAsOf)", () => {
    setPriceAsOf('Sep 28, 2026');
    const { container } = render(<CardView card={{ ...ASH, prices: { tcgplayer: 1.23 } }} imageDataUrl={null} />);
    expect(container.querySelector('.dv-prices')?.getAttribute('title')).toBe('$1.23 TCGplayer (Sep 28, 2026)');
  });

});

describe('priceAsOfLabel', () => {
  it('prefers a readable update date over the database version', () => {
    expect(priceAsOfLabel({ dbVersion: '147.20', updatedAt: '2026-09-28T14:47:44.171Z' })).toBe('Sep 28, 2026');
  });

  it('falls back to the database version when there is no update date', () => {
    expect(priceAsOfLabel({ dbVersion: '147.20' })).toBe('DB 147.20');
  });

  it('is undefined when neither is known', () => {
    expect(priceAsOfLabel({})).toBeUndefined();
  });
});

describe('CardView: Genesys points', () => {
  it('shows what the card costs in Genesys next to its TCG banlist status (real records)', () => {
    const pot = bundledCard('Pot of Greed');
    const { container } = render(<CardView card={pot} imageDataUrl={null} />);
    // Together on their own row: what decides whether the card can be played (the points as the bundled data has them).
    const legal = [...container.querySelectorAll('.facts-row.legal .fact')].map((f) => text(f));
    expect(legal).toEqual(['Forbidden · TCG', `Genesys ${pot.genesysPoints} pts`]);
    cleanup();
    const ash = bundledCard('Ash Blossom & Joyous Spring');
    render(<CardView card={ash} imageDataUrl={null} />);
    const chip = screen.getByText(`Genesys ${ash.genesysPoints} pts`);
    // Its own colour and mark (the user asked for Genesys to stand out): not a banlist tone, not plain.
    expect(chip.className).toBe('fact genesys');
    expect(chip.querySelector('svg.mark')).toBeTruthy();
    // Read as it shows: ARIA gives a role-less <span> no name of its own, so screen readers may skip an
    // aria-label there, while "Genesys 20 pts" is read (final review M11).
    expect(chip.hasAttribute('aria-label')).toBe(false);
  });

  it('says "1 pt" for one point', () => {
    render(<CardView card={{ ...ASH, genesysPoints: 1 }} imageDataUrl={null} />);
    expect(screen.getByText('Genesys 1 pt').hasAttribute('aria-label')).toBe(false);
  });

  it('shows nothing for a card that costs 0 points or has none recorded, like an unrestricted card', () => {
    for (const card of [bundledCard('Dark Magician'), { ...ASH, genesysPoints: 0 }, ASH]) {
      const { container } = render(<CardView card={card} imageDataUrl={null} />);
      expect(text(container)).not.toMatch(/Genesys/);
      cleanup();
    }
  });
});

describe('ygoprodeckUrl', () => {
  // YGOPRODeck redirects ?search=<passcode> to the card's page, alternate-artwork passcodes included
  // (checked 2026-09-29: 46986420 → /card/dark-magician-4003, 16178683 → /card/odd-eyes-pendulum-dragon-1388).
  it("links to the card's YGOPRODeck page by its passcode", () => {
    expect(ygoprodeckUrl(14558127)).toBe('https://ygoprodeck.com/card/?search=14558127');
    expect(ygoprodeckUrl(46986420)).toBe('https://ygoprodeck.com/card/?search=46986420');
  });
});

describe('CardView: card text language (English name as a subtitle)', () => {
  const potFr: CardRecord = { ...POT, name: 'Pot de Cupidité', desc: 'Piochez 2 cartes.', translated: { lang: 'fr', nameEn: POT.name } };

  it('shows the translated name and text, in their language, with the English name under the name', () => {
    const { container } = render(<CardView card={potFr} imageDataUrl={null} />);
    const heading = screen.getByRole('heading', { name: 'Pot de Cupidité' });
    expect(heading.getAttribute('lang')).toBe('fr');
    const sub = container.querySelector('.dv-en');
    expect(text(sub)).toBe(`English name: ${POT.name}`);
    expect(sub?.getAttribute('lang')).toBe('en');
    expect(sub?.querySelector('.sr-only')?.textContent).toBe('English name: ');
    // Right under the name, before the type line.
    expect(heading.nextElementSibling).toBe(sub);
    expect(container.querySelector('.dv-text')?.getAttribute('lang')).toBe('fr');
    expect(text(container.querySelector('.dv-text'))).toBe('Piochez 2 cartes.');
  });

  it('shows no subtitle for an English card, or when the translation keeps the English name', () => {
    const { container, unmount } = render(<CardView card={POT} imageDataUrl={null} />);
    expect(container.querySelector('.dv-en')).toBeNull();
    // English card data says so, whatever the interface's language (src/shared/i18n.ts).
    expect(container.querySelector('.dv-name')?.getAttribute('lang')).toBe('en');
    unmount();
    const same: CardRecord = { ...POT, desc: 'Piochez 2 cartes.', translated: { lang: 'fr', nameEn: POT.name } };
    const again = render(<CardView card={same} imageDataUrl={null} />);
    expect(again.container.querySelector('.dv-en')).toBeNull();
  });
});

describe('card text paragraphs', () => {
  it('puts each numbered effect (②, ③, …) on a paragraph of its own', () => {
    const card: CardRecord = { ...POT, desc: '① Draw 1 card. ② Discard 1 card. ③ Gain 500 LP.' };
    const { container } = render(<CardView card={card} imageDataUrl={null} />);
    expect([...container.querySelectorAll('.dv-text p')].map((p) => p.textContent)).toEqual(['① Draw 1 card.', '② Discard 1 card.', '③ Gain 500 LP.']);
  });

  it('splits numbered effects with no space before them too (Japanese, Chinese)', () => {
    const card: CardRecord = { ...POT, desc: '①カードを1枚引く。②カードを1枚捨てる。' };
    const { container } = render(<CardView card={card} imageDataUrl={null} />);
    expect([...container.querySelectorAll('.dv-text p')].map((p) => p.textContent)).toEqual(['①カードを1枚引く。', '②カードを1枚捨てる。']);
  });
});


describe('CardView: the attribute icon', () => {
  // As on the card: the attribute's character on its colour, drawn by CSS from data-k (no text of its own, so the
  // fact still reads as its word).
  it("draws the attribute's character, and Spell's and Trap's", () => {
    const cases: [CardRecord, string, string][] = [
      [ASH, '炎', 'FIRE'],
      [TALKER, '闇', 'DARK'],
      [POT, '魔', 'SPELL'],
      [bundledCard('Infinite Impermanence'), '罠', 'TRAP'],
    ];
    for (const [card, kanji, word] of cases) {
      const { container } = render(<CardView card={card} imageDataUrl={null} />);
      const icon = container.querySelector('.fact.attr .attr-icon')!;
      expect(icon.getAttribute('data-k')).toBe(kanji);
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(text(icon.closest('.fact'))).toBe(word);
      cleanup();
    }
  });

  it("shows a Level's star with its number, and says it in words", () => {
    const { container } = render(<CardView card={ASH} imageDataUrl={null} />);
    const level = container.querySelector('.fact.level')!;
    expect(level.querySelector('svg.star')).toBeTruthy();
    expect(level.querySelector('.sr-only')?.textContent).toBe('Level 3');
    expect(level.getAttribute('title')).toBe('Level 3');
  });
});

describe('CardView: the bigger picture', () => {
  let distrust: () => void;
  beforeEach(() => {
    distrust = trustEvents();
  });
  afterEach(() => distrust());

  it('shows the picture bigger, over the box, on a click on it, and small again on a click on the big one', () => {
    const { container } = render(<CardView card={ASH} imageDataUrl="data:image/jpeg;base64,AAAA" />);
    const button = screen.getByRole('button', { name: 'Show the picture bigger' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(container.querySelector('.dv')?.classList.contains('big')).toBe(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    // Over the box, not in its flow (the box never scrolls for it), the same picture, focused for the keyboard.
    const big = screen.getByRole('button', { name: 'Show the picture smaller' });
    expect(big.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(document.activeElement).toBe(big);
    fireEvent.click(big);
    expect(container.querySelector('.dv')?.classList.contains('big')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Show the picture smaller' })).toBeNull();
  });

  it("ignores a click a page's script made", () => {
    distrust();
    distrust = () => undefined;
    const { container } = render(<CardView card={ASH} imageDataUrl="data:image/jpeg;base64,AAAA" />);
    fireEvent(screen.getByRole('button', { name: 'Show the picture bigger' }), untrusted(new MouseEvent('click', { bubbles: true })));
    expect(container.querySelector('.dv')?.classList.contains('big')).toBe(false);
  });

  it('has no button without a picture (the side panel shows its own)', () => {
    render(<CardView card={ASH} imageDataUrl={null} />);
    expect(screen.queryByRole('button', { name: 'Show the picture bigger' })).toBeNull();
  });
});

describe('CardView: a made-up sample card (Options)', () => {
  it('links to no page about it', () => {
    render(<CardView card={{ ...ASH, konamiId: 1 }} imageDataUrl={null} sample />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});

// The user's ask: the banlist status as a frame around the card's picture, the way deck sites show it, besides the
// legality row (which stays). One card in the band for Limited, two for Semi-Limited, the prohibition circle for
// Forbidden; the chosen list's status only; a look only (hidden from screen readers, clicks pass to the picture).
describe('BanFrame: the banlist frame around the picture', () => {
  const PIC = 'data:image/jpeg;base64,AAAA';
  const frame = (c: CardRecord) => render(<CardView card={c} imageDataUrl={PIC} />).container.querySelector('.ban-frame');

  it('frames a Limited card in orange with one card in its band', () => {
    setBanlist('tcg');
    const f = frame({ ...ASH, banlist: { tcg: 'Limited' } } as CardRecord);
    expect(f?.classList.contains('limited')).toBe(true);
    expect(f?.querySelectorAll('.ban-band .band-card')).toHaveLength(1);
    expect(f?.querySelector('.band-ban')).toBeNull();
  });

  it('frames a Semi-Limited card with two cards in its band', () => {
    setBanlist('tcg');
    const f = frame({ ...ASH, banlist: { tcg: 'Semi-Limited' } } as CardRecord);
    expect(f?.classList.contains('semi')).toBe(true);
    expect(f?.querySelectorAll('.ban-band .band-card')).toHaveLength(2);
  });

  it('frames a Forbidden card ("Banned" too) in red with the prohibition circle', () => {
    setBanlist('ocg');
    const f = frame({ ...ASH, banlist: { ocg: 'Banned' } } as CardRecord);
    expect(f?.classList.contains('forbidden')).toBe(true);
    expect(f?.querySelector('.ban-band .band-ban')).not.toBeNull();
    expect(f?.querySelector('.band-card')).toBeNull();
  });

  it("follows the chosen list only: no frame for the other list's status, nor for a card on no list", () => {
    setBanlist('tcg');
    expect(frame({ ...ASH, banlist: { ocg: 'Semi-Limited' } } as CardRecord)).toBeNull();
    cleanup();
    expect(frame({ ...ASH, banlist: undefined } as CardRecord)).toBeNull();
    cleanup();
    setBanlist('ocg');
    expect(frame({ ...ASH, banlist: { ocg: 'Semi-Limited' } } as CardRecord)?.classList.contains('semi')).toBe(true);
  });

  it('is hidden from screen readers and keeps the picture its button: a click still shows it bigger', () => {
    setBanlist('tcg');
    const { container } = render(<CardView card={{ ...ASH, banlist: { tcg: 'Limited' } } as CardRecord} imageDataUrl={PIC} />);
    expect(container.querySelector('.ban-band')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.ban-frame .dv-zoom')).not.toBeNull();
    const distrust = trustEvents();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Show the picture bigger' }));
    } finally {
      distrust();
    }
    expect(container.querySelector('.dv.big')).not.toBeNull();
    // The legality row still says it in words.
    expect(container.querySelector('.fact.ban.limited')?.textContent).toBe('Limited · TCG');
  });

  it('frames whatever picture it is given (the side panel), and gives back the picture alone when there is no status', () => {
    setBanlist('tcg');
    const framed = render(
      <BanFrame card={{ ...ASH, banlist: { tcg: 'Forbidden' } } as CardRecord}>
        <img src={PIC} alt="Ash" />
      </BanFrame>,
    );
    expect(framed.container.querySelector('.ban-frame.forbidden > img')).not.toBeNull();
    framed.unmount();
    const bare = render(
      <BanFrame card={{ ...ASH, banlist: undefined } as CardRecord}>
        <img src={PIC} alt="Ash" />
      </BanFrame>,
    );
    expect(bare.container.innerHTML).toBe('<img src="' + PIC + '" alt="Ash">');
  });
});
