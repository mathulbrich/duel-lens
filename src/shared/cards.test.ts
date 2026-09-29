import { describe, expect, it } from 'vitest';
import { mergeGenesysPoints, trimCard, type ApiCard, type GenesysApiCard } from './cards';
import type { CardRecord } from './types';

const ash: ApiCard = {
  id: 14558127,
  name: 'Ash Blossom & Joyous Spring',
  typeline: ['Zombie', 'Tuner', 'Effect'],
  type: 'Tuner Monster',
  humanReadableCardType: 'Tuner Effect Monster',
  frameType: 'effect',
  desc: 'When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.\r\n● Add a card from the Deck to the hand.\r\nYou can only use this effect of "Ash Blossom & Joyous Spring" once per turn.',
  race: 'Zombie',
  atk: 0,
  def: 1800,
  level: 3,
  attribute: 'FIRE',
  banlist_info: { ban_ocg: 'Semi-Limited' },
  card_images: [{ id: 14558127 }, { id: 14558128 }],
  misc_info: [{ konami_id: 12950 }],
};

describe('trimCard', () => {
  it('keeps the fields the overlay needs and normalises line breaks', () => {
    expect(trimCard(ash)).toEqual({
      id: 14558127,
      konamiId: 12950,
      name: 'Ash Blossom & Joyous Spring',
      type: 'Tuner Monster',
      humanType: 'Tuner Effect Monster',
      frameType: 'effect',
      typeline: ['Zombie', 'Tuner', 'Effect'],
      desc: 'When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.\n● Add a card from the Deck to the hand.\nYou can only use this effect of "Ash Blossom & Joyous Spring" once per turn.',
      race: 'Zombie',
      attribute: 'FIRE',
      atk: 0,
      def: 1800,
      level: 3,
      banlist: { ocg: 'Semi-Limited' },
      imageIds: [14558127, 14558128],
    });
  });

  it('drops null stats (Link monsters have no DEF or Level)', () => {
    const link = trimCard({
      id: 4731783, name: 'A Bao A Qu, the Lightless Shadow', type: 'Link Monster', frameType: 'link',
      desc: '2+ monsters', race: 'Fiend', atk: 2800, def: null, level: null, attribute: 'DARK',
      linkval: 4, linkmarkers: ['Left', 'Right', 'Bottom-Left', 'Bottom-Right'], card_images: [{ id: 4731783 }],
    });
    expect(link).not.toHaveProperty('def');
    expect(link).not.toHaveProperty('level');
    expect(link.linkval).toBe(4);
    expect(link.linkmarkers).toEqual(['Left', 'Right', 'Bottom-Left', 'Bottom-Right']);
  });

  it('keeps Pendulum sections, scale, archetype and TCG banlist status', () => {
    const p = trimCard({
      id: 15308295, name: 'Abyss Actor - Comic Relief', type: 'Pendulum Effect Monster', frameType: 'effect_pendulum',
      desc: '[ Pendulum Effect ] \nA\n\n[ Monster Effect ] \nB', pend_desc: 'A', monster_desc: 'B', race: 'Fiend',
      atk: 1000, def: 2000, level: 3, attribute: 'DARK', archetype: 'Abyss Actor', scale: 8,
      banlist_info: { ban_tcg: 'Limited', ban_goat: 'Forbidden' }, card_images: [{ id: 15308295 }],
    });
    expect(p).toMatchObject({ pendDesc: 'A', monsterDesc: 'B', scale: 8, archetype: 'Abyss Actor', banlist: { tcg: 'Limited', goat: 'Forbidden' } });
  });

  it('handles Spells with no monster fields', () => {
    const s = trimCard({ id: 55144522, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.', race: 'Normal', card_images: [{ id: 55144522 }] });
    expect(s).toEqual({ id: 55144522, name: 'Pot of Greed', type: 'Spell Card', frameType: 'spell', desc: 'Draw 2 cards.', race: 'Normal', imageIds: [55144522] });
  });
});

describe('trimCard: Genesys points', () => {
  it('keeps genesys_points above 0 (only format=genesys answers carry them), and leaves 0 out', () => {
    expect(trimCard({ ...ash, misc_info: [{ konami_id: 12950, genesys_points: 20 }] }).genesysPoints).toBe(20);
    expect(trimCard({ ...ash, misc_info: [{ konami_id: 12950, genesys_points: 0 }] })).not.toHaveProperty('genesysPoints');
    expect(trimCard(ash)).not.toHaveProperty('genesysPoints');
  });
});

describe('mergeGenesysPoints', () => {
  const record = (id: number, name: string, imageIds = [id]): CardRecord => ({ id, name, type: 'Effect Monster', frameType: 'effect', desc: '', imageIds });
  const genesys = (id: number, name: string, points: number): GenesysApiCard => ({ id, name, misc_info: [{ konami_id: 1, genesys_points: points }] });
  const ashBlossom = record(14558127, 'Ash Blossom & Joyous Spring', [14558127, 14558128]);
  // Our record is 46986420; YGOPRODeck's name search gives 46986414, one of its artworks.
  const darkMagician = record(46986420, 'Dark Magician', [46986420, 46986421, 46986414, 46986415]);
  const maxxC = record(23434538, 'Maxx "C"');
  const potOfGreed = record(55144522, 'Pot of Greed');
  const cards = [ashBlossom, darkMagician, maxxC, potOfGreed];
  const pointsOf = (merged: CardRecord[]) => Object.fromEntries(merged.map((c) => [c.name, c.genesysPoints]));

  it('matches a Genesys card to the record with its id', () => {
    const { cards: merged, withPoints, unmatched } = mergeGenesysPoints(cards, [genesys(14558127, 'Ash Blossom & Joyous Spring', 20)]);
    expect(merged[0]).toEqual({ ...ashBlossom, genesysPoints: 20 });
    expect(withPoints).toBe(1);
    expect(unmatched).toEqual([]);
  });

  it("matches it by an artwork id when its id is another of our card's artworks", () => {
    const { cards: merged } = mergeGenesysPoints(cards, [genesys(46986414, 'Dark Magician (another artwork)', 7)]);
    expect(merged[1]).toEqual({ ...darkMagician, genesysPoints: 7 });
  });

  it('matches it by its exact name when neither its id nor an artwork is ours', () => {
    const { cards: merged, unmatched } = mergeGenesysPoints(cards, [genesys(99999999, 'Maxx "C"', 50), genesys(99999998, 'maxx "c"', 40)]);
    expect(merged[2]).toEqual({ ...maxxC, genesysPoints: 50 });
    expect(unmatched).toEqual([{ id: 99999998, name: 'maxx "c"', points: 40 }]); // exact: case matters
  });

  it('lets the closest match win when two Genesys cards land on one record', () => {
    const { cards: merged } = mergeGenesysPoints(cards, [
      genesys(99999999, 'Dark Magician', 30), // by name
      genesys(46986414, 'Dark Magician', 5), // by an artwork: closer
    ]);
    expect(merged[1].genesysPoints).toBe(5);
  });

  it('leaves 0 points out, and takes away points the list no longer gives', () => {
    const before = [{ ...ashBlossom, genesysPoints: 20 }, { ...potOfGreed, genesysPoints: 30 }, maxxC];
    const { cards: merged, withPoints } = mergeGenesysPoints(before, [
      genesys(14558127, 'Ash Blossom & Joyous Spring', 0),
      genesys(23434538, 'Maxx "C"', 0),
    ]);
    expect(merged.map((c) => 'genesysPoints' in c)).toEqual([false, false, false]);
    expect(merged).toEqual([ashBlossom, potOfGreed, maxxC]);
    expect(withPoints).toBe(0);
  });

  it('changes nothing else: same order, and a record whose points are unchanged is the same object', () => {
    const before = [{ ...ashBlossom, genesysPoints: 20 }, darkMagician, maxxC, potOfGreed];
    const { cards: merged } = mergeGenesysPoints(before, [genesys(14558127, 'Ash Blossom & Joyous Spring', 20), genesys(23434538, 'Maxx "C"', 50)]);
    expect(merged[0]).toBe(before[0]);
    expect(merged[1]).toBe(darkMagician);
    expect(merged[3]).toBe(potOfGreed);
    expect(pointsOf(merged)).toEqual({ 'Ash Blossom & Joyous Spring': 20, 'Dark Magician': undefined, 'Maxx "C"': 50, 'Pot of Greed': undefined });
    expect(maxxC).not.toHaveProperty('genesysPoints'); // the input is left alone
  });

  it('lists the Genesys cards with points that match no record, and ignores unmatched ones at 0', () => {
    const { unmatched, withPoints } = mergeGenesysPoints(cards, [genesys(1, 'Not In Our Snapshot', 3), genesys(2, 'Also Not Ours', 0)]);
    expect(unmatched).toEqual([{ id: 1, name: 'Not In Our Snapshot', points: 3 }]);
    expect(withPoints).toBe(0);
  });
});
