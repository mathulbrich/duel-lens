// Mapping from the YGOPRODeck API card shape to our trimmed CardRecord, and the Genesys points
// merged into it. Used by tools/fetch-cards.ts (bundled snapshot) and the background's weekly refresh.
import type { CardRecord } from './types';

/** The subset of a YGOPRODeck `cardinfo.php` card that we read. */
export interface ApiCard {
  id: number;
  name: string;
  type: string;
  humanReadableCardType?: string;
  frameType: string;
  typeline?: string[];
  desc: string;
  pend_desc?: string;
  monster_desc?: string;
  race?: string;
  attribute?: string;
  atk?: number | null;
  def?: number | null;
  level?: number | null;
  linkval?: number | null;
  linkmarkers?: string[];
  scale?: number | null;
  archetype?: string;
  banlist_info?: { ban_tcg?: string; ban_ocg?: string; ban_goat?: string };
  card_images: { id: number }[];
  /** `genesys_points` only with `format=genesys`, and 0 for most cards. */
  misc_info?: { konami_id?: number; genesys_points?: number }[];
}

/** A card of YGOPRODeck's Genesys list (`cardinfo.php?format=genesys&misc=yes`): the part the merge reads. */
export type GenesysApiCard = Pick<ApiCard, 'id' | 'name' | 'misc_info'>;

const text = (s: string) => s.replace(/\r\n?/g, '\n').trim();
const num = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined);

/** The card's Genesys points, or undefined for 0 (or none given). */
function genesysPointsOf(c: Pick<ApiCard, 'misc_info'>): number | undefined {
  const points = num(c.misc_info?.[0]?.genesys_points);
  return points !== undefined && points > 0 ? points : undefined;
}

export function trimCard(c: ApiCard): CardRecord {
  const out: CardRecord = {
    id: c.id,
    konamiId: num(c.misc_info?.[0]?.konami_id),
    name: c.name,
    type: c.type,
    humanType: c.humanReadableCardType,
    frameType: c.frameType,
    typeline: c.typeline,
    desc: text(c.desc ?? ''),
    pendDesc: c.pend_desc ? text(c.pend_desc) : undefined,
    monsterDesc: c.monster_desc ? text(c.monster_desc) : undefined,
    race: c.race,
    attribute: c.attribute,
    atk: num(c.atk),
    def: num(c.def),
    level: num(c.level),
    linkval: num(c.linkval),
    linkmarkers: c.linkmarkers,
    scale: num(c.scale),
    archetype: c.archetype,
    banlist: c.banlist_info
      ? {
          tcg: c.banlist_info.ban_tcg,
          ocg: c.banlist_info.ban_ocg,
          goat: c.banlist_info.ban_goat,
        }
      : undefined,
    imageIds: c.card_images.map((i) => i.id),
    // Last, where mergeGenesysPoints adds it. The plain card list has no Genesys points (2026-09-29).
    genesysPoints: genesysPointsOf(c),
  };
  if (out.banlist) {
    for (const k of Object.keys(out.banlist) as (keyof NonNullable<CardRecord['banlist']>)[]) {
      if (out.banlist[k] === undefined) delete out.banlist[k];
    }
  }
  for (const k of Object.keys(out) as (keyof CardRecord)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export interface GenesysMerge {
  cards: CardRecord[];
  /** How many of `cards` cost points after the merge. */
  withPoints: number;
  /** The Genesys cards with points that match none of `cards`. */
  unmatched: { id: number; name: string; points: number }[];
}

/**
 * `cards` with the points of YGOPRODeck's Genesys list, and nothing else changed (a record whose
 * points don't change is returned as it is). The list covers every card, so a record it gives no
 * points loses any it had.
 *
 * A Genesys card goes to the record with its id; else to the record with an artwork of that id, since
 * YGOPRODeck can name a card by another of its artworks (its name search gives Dark Magician as
 * 46986414, our record is 46986420, and 46986414 is one of that record's artworks); else to the record
 * with its exact name. When two Genesys cards land on one record, the closer match wins.
 */
export function mergeGenesysPoints(cards: CardRecord[], genesys: GenesysApiCard[]): GenesysMerge {
  const byId = new Map<number, number>();
  const byArtwork = new Map<number, number>();
  const byName = new Map<string, number>();
  cards.forEach((c, i) => {
    byId.set(c.id, i);
    for (const imageId of c.imageIds) if (!byArtwork.has(imageId)) byArtwork.set(imageId, i);
    if (!byName.has(c.name)) byName.set(c.name, i);
  });

  // Record index → the points of its closest match; `how` is 0 for the id, 1 for an artwork, 2 for the name.
  const found = new Map<number, { points: number; how: number }>();
  const unmatched: GenesysMerge['unmatched'] = [];
  for (const g of genesys) {
    const points = genesysPointsOf(g) ?? 0;
    const matches = [byId.get(g.id), byArtwork.get(g.id), byName.get(g.name)];
    const how = matches.findIndex((i) => i !== undefined);
    if (how === -1) {
      if (points > 0) unmatched.push({ id: g.id, name: g.name, points });
      continue;
    }
    const i = matches[how]!;
    const prev = found.get(i);
    if (!prev || how < prev.how || (how === prev.how && points > prev.points)) found.set(i, { points, how });
  }

  let withPoints = 0;
  const merged = cards.map((c, i) => {
    const points = found.get(i)?.points ?? 0;
    if (points > 0) withPoints++;
    if (points > 0 ? c.genesysPoints === points : !('genesysPoints' in c)) return c;
    const { genesysPoints: _old, ...rest } = c;
    return points > 0 ? { ...rest, genesysPoints: points } : rest;
  });
  return { cards: merged, withPoints, unmatched };
}
