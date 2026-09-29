// Card records for tests, produced by the real trimCard() from the YGOPRODeck snapshot
// (data/raw/cardinfo.nomisc.json). Test-only: nothing in the extension imports this.
import type { Candidate, CardRecord, CropPayload } from '../shared/types';
import type { RecognizeResponse } from '../shared/messages';

export const ASH: CardRecord = {
  "id": 14558127,
  "name": "Ash Blossom & Joyous Spring",
  "type": "Tuner Monster",
  "humanType": "Tuner Effect Monster",
  "frameType": "effect",
  "typeline": [
    "Zombie",
    "Tuner",
    "Effect"
  ],
  "desc": "When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that effect.\n● Add a card from the Deck to the hand.\n● Special Summon from the Deck.\n● Send a card from the Deck to the GY.\nYou can only use this effect of \"Ash Blossom & Joyous Spring\" once per turn.",
  "race": "Zombie",
  "attribute": "FIRE",
  "atk": 0,
  "def": 1800,
  "level": 3,
  "banlist": {
    "ocg": "Semi-Limited"
  },
  "imageIds": [
    14558127,
    14558128
  ]
};

export const BELLE: CardRecord = {
  "id": 73642296,
  "name": "Ghost Belle & Haunted Mansion",
  "type": "Tuner Monster",
  "humanType": "Tuner Effect Monster",
  "frameType": "effect",
  "typeline": [
    "Zombie",
    "Tuner",
    "Effect"
  ],
  "desc": "When a card or effect is activated that includes any of these effects (Quick Effect): You can discard this card; negate that activation.\n● Add a card(s) from the GY to the hand, Deck, and/or Extra Deck.\n● Special Summon a Monster Card(s) from the GY.\n● Banish a card(s) from the GY.\nYou can only use this effect of \"Ghost Belle & Haunted Mansion\" once per turn.",
  "race": "Zombie",
  "attribute": "EARTH",
  "atk": 0,
  "def": 1800,
  "level": 3,
  "imageIds": [
    73642296,
    73642297
  ]
};

export const OGRE: CardRecord = {
  "id": 59438930,
  "name": "Ghost Ogre & Snow Rabbit",
  "type": "Tuner Monster",
  "humanType": "Tuner Effect Monster",
  "frameType": "effect",
  "typeline": [
    "Psychic",
    "Tuner",
    "Effect"
  ],
  "desc": "When a monster on the field activates its effect, or when a Spell/Trap that is already face-up on the field activates its effect (Quick Effect): You can send this card from your hand or field to the GY; destroy that card on the field. You can only use this effect of \"Ghost Ogre & Snow Rabbit\" once per turn.",
  "race": "Psychic",
  "attribute": "LIGHT",
  "atk": 0,
  "def": 1800,
  "level": 3,
  "imageIds": [
    59438930,
    59438931
  ]
};

export const DROLL: CardRecord = {
  "id": 94145021,
  "name": "Droll & Lock Bird",
  "type": "Effect Monster",
  "humanType": "Effect Monster",
  "frameType": "effect",
  "typeline": [
    "Spellcaster",
    "Effect"
  ],
  "desc": "If a card(s) is added from the Main Deck to your opponent's hand, except during the Draw Phase (Quick Effect): You can send this card from your hand to the GY; for the rest of this turn, cards cannot be added from either player's Main Deck to the hand.",
  "race": "Spellcaster",
  "attribute": "WIND",
  "atk": 0,
  "def": 0,
  "level": 1,
  "banlist": {
    "tcg": "Semi-Limited",
    "ocg": "Limited"
  },
  "imageIds": [
    94145021,
    94145022
  ]
};

export const TALKER: CardRecord = {
  "id": 86066372,
  "name": "Accesscode Talker",
  "type": "Link Monster",
  "humanType": "Link Effect Monster",
  "frameType": "link",
  "typeline": [
    "Cyberse",
    "Link",
    "Effect"
  ],
  "desc": "2+ Effect Monsters\nYour opponent cannot activate cards or effects in response to this card's effect activations. If this card is Link Summoned: You can target 1 Link Monster that was used as material for its Link Summon; this card gains ATK equal to that monster's Link Rating x 1000. You can banish 1 Link Monster from your field or GY; destroy 1 card your opponent controls, also for the rest of this turn, you cannot banish monsters with that same Attribute to activate this effect of \"Accesscode Talker\".",
  "race": "Cyberse",
  "attribute": "DARK",
  "atk": 2300,
  "linkval": 4,
  "linkmarkers": [
    "Top",
    "Left",
    "Right",
    "Bottom"
  ],
  "archetype": "Code Talker",
  "imageIds": [
    86066372
  ]
};

export const ODD_EYES: CardRecord = {
  "id": 16178681,
  "name": "Odd-Eyes Pendulum Dragon",
  "type": "Pendulum Effect Monster",
  "humanType": "Pendulum Effect Monster",
  "frameType": "effect_pendulum",
  "typeline": [
    "Dragon",
    "Pendulum",
    "Effect"
  ],
  "desc": "[ Pendulum Effect ] \nYou can reduce the battle damage you take from an attack involving a Pendulum Monster you control to 0. During your End Phase: You can destroy this card, and if you do, add 1 Pendulum Monster with 1500 or less ATK from your Deck to your hand. You can only use each Pendulum Effect of \"Odd-Eyes Pendulum Dragon\" once per turn.\n\n[ Monster Effect ] \nIf this card battles an opponent's monster, any battle damage this card inflicts to your opponent is doubled.",
  "pendDesc": "You can reduce the battle damage you take from an attack involving a Pendulum Monster you control to 0. During your End Phase: You can destroy this card, and if you do, add 1 Pendulum Monster with 1500 or less ATK from your Deck to your hand. You can only use each Pendulum Effect of \"Odd-Eyes Pendulum Dragon\" once per turn.",
  "monsterDesc": "If this card battles an opponent's monster, any battle damage this card inflicts to your opponent is doubled.",
  "race": "Dragon",
  "attribute": "DARK",
  "atk": 2500,
  "def": 2000,
  "level": 7,
  "scale": 4,
  "archetype": "-Eyes Dragon",
  "imageIds": [
    16178681,
    16178682,
    16178683
  ]
};

/** A long, unbreakable name: used to check that an alternative-match chip truncates instead of overflowing the popover. */
export const ODD_EYES_HEAVENLY: CardRecord = {
  "id": 75787708,
  "name": "Odd-Eyes Pendulum Dragon of the Four Heavenly Dragons",
  "type": "Pendulum Effect Monster",
  "humanType": "Pendulum Effect Monster",
  "frameType": "effect_pendulum",
  "typeline": [
    "Dragon",
    "Pendulum",
    "Effect"
  ],
  "desc": "[ Pendulum Effect ] \nDuring your Main Phase: You can destroy this card, and if you do, add 1 Pendulum Monster with 1500 or less ATK from your Deck to your hand, also for the rest of this turn, unless you Pendulum Summon after this effect resolves, you cannot activate monster effects on the field. You can only use this effect of \"Odd-Eyes Pendulum Dragon of the Four Heavenly Dragons\" once per turn.\n\n[ Monster Effect ] \nThis Pendulum Summoned card gains these effects.\n● Gains ATK equal to the difference between the Pendulum Scales of the 2 cards in your Pendulum Zones x 300.\n● Any battle damage your opponent takes from battles involving this card is doubled.\nIf this card in the Monster Zone is destroyed by battle or card effect: You can add this card to your hand, then if it was destroyed by your opponent, you can Special Summon it. You can only use this effect of \"Odd-Eyes Pendulum Dragon of the Four Heavenly Dragons\" once per turn.",
  "pendDesc": "During your Main Phase: You can destroy this card, and if you do, add 1 Pendulum Monster with 1500 or less ATK from your Deck to your hand, also for the rest of this turn, unless you Pendulum Summon after this effect resolves, you cannot activate monster effects on the field. You can only use this effect of \"Odd-Eyes Pendulum Dragon of the Four Heavenly Dragons\" once per turn.",
  "monsterDesc": "This Pendulum Summoned card gains these effects.\n● Gains ATK equal to the difference between the Pendulum Scales of the 2 cards in your Pendulum Zones x 300.\n● Any battle damage your opponent takes from battles involving this card is doubled.\nIf this card in the Monster Zone is destroyed by battle or card effect: You can add this card to your hand, then if it was destroyed by your opponent, you can Special Summon it. You can only use this effect of \"Odd-Eyes Pendulum Dragon of the Four Heavenly Dragons\" once per turn.",
  "race": "Dragon",
  "attribute": "DARK",
  "atk": 2500,
  "def": 2000,
  "level": 7,
  "scale": 4,
  "archetype": "Odd-Eyes",
  "imageIds": [
    75787708
  ]
};

export const UTOPIA: CardRecord = {
  "id": 84013237,
  "name": "Number 39: Utopia",
  "type": "XYZ Monster",
  "humanType": "Xyz Effect Monster",
  "frameType": "xyz",
  "typeline": [
    "Warrior",
    "Xyz",
    "Effect"
  ],
  "desc": "2 Level 4 monsters\nWhen a monster declares an attack: You can detach 1 material from this card; negate the attack. If this card is targeted for an attack, while it has no material: Destroy this card.",
  "race": "Warrior",
  "attribute": "LIGHT",
  "atk": 2500,
  "def": 2000,
  "level": 4,
  "archetype": "Utopia",
  "imageIds": [
    84013237,
    84013238
  ]
};

export const POT: CardRecord = {
  "id": 55144522,
  "name": "Pot of Greed",
  "type": "Spell Card",
  "humanType": "Normal Spell",
  "frameType": "spell",
  "desc": "Draw 2 cards.",
  "race": "Normal",
  "archetype": "Greed",
  "banlist": {
    "tcg": "Forbidden",
    "ocg": "Forbidden",
    "goat": "Limited"
  },
  "imageIds": [
    55144522
  ]
};

export const DM: CardRecord = {
  "id": 46986414,
  "name": "Dark Magician",
  "type": "Normal Monster",
  "humanType": "Normal Monster",
  "frameType": "normal",
  "typeline": [
    "Spellcaster",
    "Normal"
  ],
  "desc": "''The ultimate wizard in terms of attack and defense.''",
  "race": "Spellcaster",
  "attribute": "DARK",
  "atk": 2500,
  "def": 2100,
  "level": 7,
  "archetype": "Dark Magician",
  "imageIds": [
    46986414,
    46986415,
    46986416,
    46986417,
    46986418,
    46986419,
    36996508,
    46986420,
    46986421
  ]
};

export const BEWD: CardRecord = {
  "id": 89631139,
  "name": "Blue-Eyes White Dragon",
  "type": "Normal Monster",
  "humanType": "Normal Monster",
  "frameType": "normal",
  "typeline": [
    "Dragon",
    "Normal"
  ],
  "desc": "This legendary dragon is a powerful engine of destruction. Virtually invincible, very few have faced this awesome creature and lived to tell the tale.",
  "race": "Dragon",
  "attribute": "LIGHT",
  "atk": 3000,
  "def": 2500,
  "level": 8,
  "archetype": "Blue-Eyes",
  "imageIds": [
    89631139,
    89631140,
    89631141,
    89631142,
    89631143,
    89631144,
    89631145,
    89631146
  ]
};

export const IMPERM: CardRecord = {
  "id": 10045474,
  "name": "Infinite Impermanence",
  "type": "Trap Card",
  "humanType": "Normal Trap",
  "frameType": "trap",
  "desc": "Target 1 face-up monster your opponent controls; negate its effects (until the end of this turn), then, if this card was Set before activation and is on the field at resolution, for the rest of this turn all other Spell/Trap effects in this column are negated. If you control no cards, you can activate this card from your hand.",
  "race": "Normal",
  "imageIds": [
    10045474
  ]
};

export const MST: CardRecord = {
  "id": 5318639,
  "name": "Mystical Space Typhoon",
  "type": "Spell Card",
  "humanType": "Quick-Play Spell",
  "frameType": "spell",
  "desc": "Target 1 Spell/Trap on the field; destroy that target.",
  "race": "Quick-Play",
  "banlist": {
    "goat": "Limited"
  },
  "imageIds": [
    5318639
  ]
};

export const SLIFER: CardRecord = {
  "id": 10000020,
  "name": "Slifer the Sky Dragon",
  "type": "Effect Monster",
  "humanType": "Effect Monster",
  "frameType": "effect",
  "typeline": [
    "Divine-Beast",
    "Effect"
  ],
  "desc": "Requires 3 Tributes to Normal Summon (cannot be Normal Set). This card's Normal Summon cannot be negated. When Normal Summoned, cards and effects cannot be activated. Once per turn, during the End Phase, if this card was Special Summoned: Send it to the GY. Gains 1000 ATK/DEF for each card in your hand. If a monster(s) is Normal or Special Summoned to your opponent's field in Attack Position: That monster(s) loses 2000 ATK, then if its ATK has been reduced to 0 as a result, destroy it.",
  "race": "Divine-Beast",
  "attribute": "DIVINE",
  "atk": -1,
  "def": -1,
  "level": 10,
  "archetype": "Egyptian God",
  "imageIds": [
    10000020,
    10000021,
    10000022
  ]
};

export const VEILER: CardRecord = {
  "id": 97268402,
  "name": "Effect Veiler",
  "type": "Tuner Monster",
  "humanType": "Tuner Effect Monster",
  "frameType": "effect",
  "typeline": [
    "Spellcaster",
    "Tuner",
    "Effect"
  ],
  "desc": "During your opponent's Main Phase (Quick Effect): You can send this card from your hand to the GY, then target 1 Effect Monster your opponent controls; negate the effects of that face-up monster your opponent controls, until the end of this turn.",
  "race": "Spellcaster",
  "attribute": "LIGHT",
  "atk": 0,
  "def": 0,
  "level": 1,
  "imageIds": [
    97268402
  ]
};

export const NORMAL_PEND: CardRecord = {
  "id": 70026064,
  "name": "Bujin Hiruko",
  "type": "Pendulum Normal Monster",
  "humanType": "Pendulum Normal Monster",
  "frameType": "normal_pendulum",
  "typeline": [
    "Beast-Warrior",
    "Pendulum",
    "Normal"
  ],
  "desc": "[ Pendulum Effect ] \nYou can banish this card in your Pendulum Zone, then target 1 \"Bujin\" Xyz Monster you control; Special Summon from your Extra Deck, 1 \"Bujin\" Xyz Monster with a different name, by using that target as the Xyz Material. (This Special Summon is treated as an Xyz Summon. Xyz Materials attached to it also become Xyz Materials on the Summoned monster.)\n\n[ Monster Effect ] \n''Imprisoned after a showdown with \"Bujin Hirume\" over the Sky Throne, this master schemer eventually escaped by manipulating Hirume and creating the sinister \"Bujinki Amaterasu\", then went on to almost engulf the world in darkness, but was finally defeated by Yamato and his allies.''",
  "pendDesc": "You can banish this card in your Pendulum Zone, then target 1 \"Bujin\" Xyz Monster you control; Special Summon from your Extra Deck, 1 \"Bujin\" Xyz Monster with a different name, by using that target as the Xyz Material. (This Special Summon is treated as an Xyz Summon. Xyz Materials attached to it also become Xyz Materials on the Summoned monster.)",
  "monsterDesc": "''Imprisoned after a showdown with \"Bujin Hirume\" over the Sky Throne, this master schemer eventually escaped by manipulating Hirume and creating the sinister \"Bujinki Amaterasu\", then went on to almost engulf the world in darkness, but was finally defeated by Yamato and his allies.''",
  "race": "Beast-Warrior",
  "attribute": "LIGHT",
  "atk": 1000,
  "def": 2000,
  "level": 4,
  "scale": 3,
  "archetype": "Bujin",
  "imageIds": [
    70026064
  ]
};

export const ALL: CardRecord[] = [ASH, BELLE, OGRE, DROLL, TALKER, ODD_EYES, UTOPIA, POT, DM, BEWD, IMPERM, MST, SLIFER, VEILER];

export const VIDEO_CROP: CropPayload = {
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  width: 180,
  height: 262,
  source: 'video',
  videoHeight: 720,
};

/** A recognize response over `cards` with the given scores (best first). */
export function response(
  cards: CardRecord[],
  scores: number[],
  extra: { confident?: boolean; faceDown?: boolean; candidates?: Candidate[]; aiEnabled?: boolean; truncated?: boolean; suggested?: boolean } = {},
): RecognizeResponse {
  const candidates = extra.candidates ?? cards.map((c, i) => ({ cardId: c.id, imageId: c.imageIds[0], score: scores[i] }));
  return {
    result: {
      candidates,
      confident: extra.confident ?? true,
      faceDown: extra.faceDown ?? false,
      modelId: 'dinov2-small',
      best: { hypothesis: 'quad', rotation: 180 },
      timings: { total: 120 },
      ...(extra.truncated ? { truncated: true } : {}),
      ...(extra.suggested ? { suggested: true } : {}),
    },
    cards: Object.fromEntries(cards.map((c) => [c.id, c])),
    aiEnabled: extra.aiEnabled ?? true,
    entry:
      candidates.length > 0
        ? {
            id: 'entry-1',
            cardId: candidates[0].cardId,
            imageId: candidates[0].imageId,
            score: candidates[0].score,
            confident: extra.confident ?? true,
            at: 1_790_000_000_000,
            pageUrl: 'https://www.youtube.com/watch?v=abc',
            pageTitle: 'Feature match',
            videoTime: 1458,
            source: 'video',
          }
        : undefined,
  };
}
