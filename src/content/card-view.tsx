// The card itself: image, name, type line, facts, effect text, passcode and archetype.
import type { CardRecord } from '../shared/types';

const ATTR_COLOR: Record<string, string> = {
  FIRE: '#D2432F',
  DARK: '#6A3FA6',
  LIGHT: '#E4C04A',
  EARTH: '#8A6238',
  WIND: '#3E9C55',
  WATER: '#2E78C8',
  DIVINE: '#C9A456',
  SPELL: '#138A77',
  TRAP: '#A83C78',
};

/** Link arrows in reading order, with their glyphs. */
const ARROWS: [string, string][] = [
  ['Top-Left', '↖'],
  ['Top', '↑'],
  ['Top-Right', '↗'],
  ['Left', '←'],
  ['Right', '→'],
  ['Bottom-Left', '↙'],
  ['Bottom', '↓'],
  ['Bottom-Right', '↘'],
];

const isSpellTrap = (c: CardRecord) => c.frameType === 'spell' || c.frameType === 'trap';
const isMonster = (c: CardRecord) => !isSpellTrap(c) && c.frameType !== 'skill';
const isPendulum = (c: CardRecord) => c.frameType.endsWith('_pendulum');
const stat = (n: number | undefined) => (n === undefined || n < 0 ? '?' : String(n));

export function typeLine(c: CardRecord): string {
  if (c.typeline?.length) return `[${c.typeline.join(' / ')}]`;
  return `[${c.humanType ?? [c.race, c.type].filter(Boolean).join(' ')}]`;
}

function attributeLabel(c: CardRecord): string | undefined {
  if (c.frameType === 'spell') return 'SPELL';
  if (c.frameType === 'trap') return 'TRAP';
  return c.attribute;
}

function levelLabel(c: CardRecord): string | undefined {
  if (c.frameType === 'link') return c.linkval !== undefined ? `LINK-${c.linkval}` : undefined;
  if (c.level === undefined) return undefined;
  return c.frameType.startsWith('xyz') ? `Rank ${c.level}` : `Level ${c.level}`;
}

function arrowsOf(c: CardRecord): [string, string][] {
  const set = new Set(c.linkmarkers ?? []);
  return ARROWS.filter(([name]) => set.has(name));
}

function statsLabel(c: CardRecord): string | undefined {
  if (!isMonster(c)) return undefined;
  return c.frameType === 'link' ? `ATK ${stat(c.atk)}` : `ATK ${stat(c.atk)} / DEF ${stat(c.def)}`;
}

/** The TCG banlist status and its chip's tone: Forbidden red, Limited orange, Semi-Limited yellow. */
function banLabel(c: CardRecord): { text: string; tone: 'forbidden' | 'limited' | 'semi' } | undefined {
  const s = c.banlist?.tcg;
  if (!s) return undefined;
  const tone = s === 'Forbidden' || s === 'Banned' ? 'forbidden' : s === 'Limited' ? 'limited' : 'semi';
  return { text: `${s} · TCG`, tone };
}

/**
 * The card's cost in the Genesys format; nothing for the many cards that cost 0 points. Screen readers
 * read it as shown: an aria-label on the chip's role-less <span> may go unread (final review M11).
 */
function genesysLabel(c: CardRecord): string | undefined {
  const p = c.genesysPoints;
  if (!p || p <= 0) return undefined;
  return p === 1 ? 'Genesys 1 pt' : `Genesys ${p} pts`;
}

const paragraphs = (s: string | undefined) =>
  (s ?? '')
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean);

interface TextSection {
  title?: string;
  lines: string[];
  flavor: boolean;
}

/** The card text as sections: Pendulum cards get their two effects apart. */
export function textSections(c: CardRecord): TextSection[] {
  if (isPendulum(c) && (c.pendDesc || c.monsterDesc)) {
    const out: TextSection[] = [];
    if (c.pendDesc) out.push({ title: 'Pendulum Effect', lines: paragraphs(c.pendDesc), flavor: false });
    if (c.monsterDesc) {
      const normal = c.frameType === 'normal_pendulum';
      out.push({ title: normal ? 'Flavor Text' : 'Monster Effect', lines: paragraphs(c.monsterDesc), flavor: normal });
    }
    return out;
  }
  return [{ lines: paragraphs(c.desc), flavor: c.frameType === 'normal' }];
}

export function passcodeLine(c: CardRecord): string {
  const parts = [`Passcode ${String(c.id).padStart(8, '0')}`];
  if (c.archetype) parts.push(`Archetype: ${c.archetype}`);
  return parts.join(' · ');
}

/** Facts in display order, without the banlist status and the Genesys points. */
function factsOf(c: CardRecord): string[] {
  const arrows = arrowsOf(c);
  return [
    attributeLabel(c),
    levelLabel(c),
    arrows.length ? arrows.map(([, g]) => g).join('') : undefined,
    isPendulum(c) && c.scale !== undefined ? `Scale ${c.scale}` : undefined,
    statsLabel(c),
  ].filter((f): f is string => !!f);
}

/** Plain text for "Copy text". */
export function cardText(c: CardRecord): string {
  const facts = isSpellTrap(c) ? [] : factsOf(c);
  const lines = [c.name, [typeLine(c), facts.join(' · ')].filter(Boolean).join(' ')];
  for (const s of textSections(c)) {
    if (s.title) lines.push(`[${s.title}]`);
    lines.push(...s.lines);
  }
  return lines.join('\n');
}

/**
 * The card's page on YGOPRODeck, where its data and pictures come from: `?search=<passcode>` redirects
 * to the card's page, alternate-artwork passcodes included.
 */
export function ygoprodeckUrl(passcode: number): string {
  return `https://ygoprodeck.com/card/?search=${passcode}`;
}

export interface CardViewProps {
  card: CardRecord;
  /** Data URL of the card image; null shows a text-only view; undefined means still loading. */
  imageDataUrl?: string | null;
  /**
   * The image is the user's own crop, not the card's official image (builds without remote
   * images): shown whole, and labelled as what the user selected.
   */
  ownCrop?: boolean;
}

/**
 * The card's facts as chips: Attribute, Level/Rank/Link, Link arrows, Pendulum Scale, ATK/DEF, then the TCG
 * banlist status and the Genesys points. The popover's card view and the hover preview (preview.tsx) both show them.
 */
export function CardFacts({ card }: { card: CardRecord }) {
  const attr = attributeLabel(card);
  const level = levelLabel(card);
  const arrows = arrowsOf(card);
  const stats = statsLabel(card);
  const ban = banLabel(card);
  const genesys = genesysLabel(card);
  return (
    <div class="dv-facts">
      {attr ? (
        <span class="fact">
          <i class="adot" style={{ '--attr': ATTR_COLOR[attr] ?? '#999' }} />
          {attr}
        </span>
      ) : null}
      {level ? <span class="fact">{level}</span> : null}
      {arrows.length ? (
        <span class="fact mono" aria-label={`Link arrows: ${arrows.map(([n]) => n).join(', ')}`}>
          {arrows.map(([n, g]) => (
            <span key={n}>{g}</span>
          ))}
        </span>
      ) : null}
      {isPendulum(card) && card.scale !== undefined ? <span class="fact">Scale {card.scale}</span> : null}
      {stats ? <span class="fact mono">{stats}</span> : null}
      {ban ? <span class={`fact ban ${ban.tone}`}>{ban.text}</span> : null}
      {genesys ? <span class="fact genesys">{genesys}</span> : null}
    </div>
  );
}

/** The facts in words, for screen readers: "FIRE, Level 3, Zombie / Tuner / Effect, ATK 0 / DEF 1800, Genesys 20 pts". */
export function factsInWords(c: CardRecord): string {
  const arrows = arrowsOf(c);
  return [
    attributeLabel(c),
    levelLabel(c),
    typeLine(c).slice(1, -1),
    arrows.length ? `Link arrows: ${arrows.map(([n]) => n).join(', ')}` : undefined,
    isPendulum(c) && c.scale !== undefined ? `Scale ${c.scale}` : undefined,
    statsLabel(c),
    banLabel(c)?.text,
    genesysLabel(c),
  ]
    .filter(Boolean)
    .join(', ');
}

export function CardView({ card, imageDataUrl, ownCrop = false }: CardViewProps) {
  const sections = textSections(card);
  const withImage = imageDataUrl !== null;
  return (
    <div class={`dv${withImage ? '' : ' no-img'}`}>
      {withImage ? (
        <div class={ownCrop ? 'dv-card crop' : 'dv-card'}>
          {imageDataUrl ? (
            <img src={imageDataUrl} alt={ownCrop ? 'What you selected' : ''} title={ownCrop ? 'What you selected' : undefined} draggable={false} />
          ) : (
            <div class="skel-card" role="img" aria-label="Loading card image" />
          )}
        </div>
      ) : null}
      <div class="dv-head">
        <h3 class="dv-name">{card.name}</h3>
        <p class="dv-type">{typeLine(card)}</p>
        <CardFacts card={card} />
      </div>
      <div class={`dv-text${sections.length === 1 && sections[0].flavor ? ' flavor' : ''}`}>
        {sections.length === 1 && !sections[0].title
          ? sections[0].lines.map((p, i) => <p key={i}>{p}</p>)
          : sections.map((s) => (
              <section class={`dv-sec${s.flavor ? ' flavor' : ''}`} key={s.title}>
                <h4>{s.title}</h4>
                {s.lines.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </section>
            ))}
      </div>
      <p class="dv-meta">{passcodeLine(card)}</p>
    </div>
  );
}
