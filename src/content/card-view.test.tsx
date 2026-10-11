// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import type { CardRecord } from '../shared/types';
import { CardView, cardText, konamiUrl, priceAsOfLabel, ygoprodeckUrl } from './card-view';
import { setBanlist, setPriceAsOf } from './prefs';
import { ASH, DM, MST, NORMAL_PEND, ODD_EYES, POT, SLIFER, TALKER, UTOPIA } from './test-fixtures';

afterEach(() => {
  cleanup();
  setBanlist('tcg');
  setPriceAsOf(undefined);
});

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

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
    expect(screen.getByText('Passcode 14558127')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
  });

  it('shows LINK-4 with its arrows, ATK and no DEF for a Link monster', () => {
    const { container } = render(<CardView card={TALKER} imageDataUrl={null} />);
    expect(screen.getByText('LINK-4')).toBeTruthy();
    expect(screen.getByLabelText('Link arrows: Top, Left, Right, Bottom').textContent).toBe('↑←→↓');
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
    expect(screen.getByText('Forbidden · TCG')).toBeTruthy();
    expect(text(container)).not.toMatch(/ATK/);
  });

  it('prints ? for unknown ATK/DEF', () => {
    render(<CardView card={SLIFER} imageDataUrl={null} />);
    expect(screen.getByText('ATK ? / DEF ?')).toBeTruthy();
  });

  it('pads the passcode to 8 digits and shows the archetype', () => {
    render(<CardView card={MST} imageDataUrl={null} />);
    expect(screen.getByText('Passcode 05318639')).toBeTruthy();
    render(<CardView card={DM} imageDataUrl={null} />);
    expect(screen.getByText('Passcode 46986414 · Archetype: Dark Magician')).toBeTruthy();
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
  // Highlighted like the Genesys chip (the user's ask), each status in its own colour (real records).
  it('shows each status as its own highlighted chip: Forbidden, Limited, Semi-Limited', () => {
    const cases: [string, string, string][] = [
      ['Pot of Greed', 'Forbidden · TCG', 'fact ban forbidden'],
      ['Instant Fusion', 'Limited · TCG', 'fact ban limited'],
      ['Ice Ryzeal', 'Semi-Limited · TCG', 'fact ban semi'],
    ];
    for (const [name, label, className] of cases) {
      render(<CardView card={bundledCard(name)} imageDataUrl={null} />);
      expect(screen.getByText(label).className).toBe(className);
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
    const { container } = render(<CardView card={ASH} imageDataUrl={null} />);
    expect(container.querySelector('.dv-links')).toBeNull();
  });
});

describe('CardView: banlist choice (TCG or OCG)', () => {
  it("shows the TCG status by default", () => {
    render(<CardView card={bundledCard('Pot of Greed')} imageDataUrl={null} />);
    expect(screen.getByText('Forbidden · TCG')).toBeTruthy();
  });

  it('shows the OCG status instead once the display setting is OCG', () => {
    setBanlist('ocg');
    // ASH (cardinfo.nomisc.json) has only an OCG status: Semi-Limited.
    render(<CardView card={ASH} imageDataUrl={null} />);
    expect(screen.getByText('Semi-Limited · OCG')).toBeTruthy();
  });

  it('shows no chip in OCG mode for a card with no OCG status, even if it has a TCG one', () => {
    setBanlist('ocg');
    const { container } = render(<CardView card={bundledCard('Bahamut Shark')} imageDataUrl={null} />);
    expect(container.querySelector('.fact.ban')).toBeNull();
  });
});

describe('CardView: price chip', () => {
  it('shows TCGplayer (USD) and Cardmarket (EUR) prices, with no buying link', () => {
    const { container } = render(<CardView card={{ ...ASH, prices: { tcgplayer: 1.23, cardmarket: 0.98 } }} imageDataUrl={null} />);
    const chip = screen.getByText('$1.23 TCGplayer · €0.98 Cardmarket');
    expect(chip.className).toBe('fact price');
    expect(container.querySelector('.fact.price a')).toBeNull();
  });

  it('shows only the quoted side', () => {
    render(<CardView card={{ ...ASH, prices: { tcgplayer: 1.23 } }} imageDataUrl={null} />);
    expect(screen.getByText('$1.23 TCGplayer')).toBeTruthy();
  });

  it('shows nothing when there are no prices', () => {
    const { container } = render(<CardView card={ASH} imageDataUrl={null} />);
    expect(container.querySelector('.fact.price')).toBeNull();
  });

  it("adds the data's date, small, once it is known (setPriceAsOf)", () => {
    setPriceAsOf('Sep 28, 2026');
    render(<CardView card={{ ...ASH, prices: { tcgplayer: 1.23 } }} imageDataUrl={null} />);
    expect(screen.getByText('$1.23 TCGplayer (Sep 28, 2026)')).toBeTruthy();
  });

  it('leaves the prices out of "Copy text", like the banlist status and Genesys points', () => {
    expect(cardText({ ...ASH, prices: { tcgplayer: 1.23, cardmarket: 0.98 } })).toBe(cardText(ASH));
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
    const { container } = render(<CardView card={bundledCard('Pot of Greed')} imageDataUrl={null} />);
    const chips = [...container.querySelectorAll('.dv-facts .fact')].map((f) => f.textContent);
    // The real record also has prices now (the price chip, last): just the ban and Genesys chips here.
    expect(chips.slice(-3, -1)).toEqual(['Forbidden · TCG', 'Genesys 30 pts']);
    cleanup();
    render(<CardView card={bundledCard('Ash Blossom & Joyous Spring')} imageDataUrl={null} />);
    const chip = screen.getByText('Genesys 20 pts');
    // Its own highlighted chip (the user asked for Genesys to stand out): not a banlist tone, not plain.
    expect(chip.className).toBe('fact genesys');
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

  it('leaves the points out of "Copy text", like the banlist status', () => {
    expect(cardText({ ...ASH, genesysPoints: 20 })).toBe(cardText(ASH));
  });
});

describe('cardText', () => {
  it('gives plain text to copy: name, type line, stats and the effect', () => {
    expect(cardText(ASH)).toBe(
      [
        'Ash Blossom & Joyous Spring',
        '[Zombie / Tuner / Effect] FIRE · Level 3 · ATK 0 / DEF 1800',
        'When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.',
        '● Add a card from the Deck to the hand.',
        '● Special Summon from the Deck.',
        '● Send a card from the Deck to the GY.',
        'You can only use this effect of "Ash Blossom & Joyous Spring" once per turn.',
      ].join('\n'),
    );
  });

  it('labels the Pendulum sections', () => {
    const t = cardText(ODD_EYES);
    expect(t).toContain('Scale 4');
    expect(t).toMatch(/\[Pendulum Effect\]\nYou can reduce/);
    expect(t).toMatch(/\[Monster Effect\]\nIf this card battles/);
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

  it('copies the English name after the translated one', () => {
    expect(cardText(potFr).split('\n').slice(0, 2)).toEqual(['Pot de Cupidité', `English name: ${POT.name}`]);
    expect(cardText(POT).split('\n')[1]).not.toMatch(/English name/);
  });
});
