// The card itself: image, name, type line, facts, effect text, passcode and archetype.
import { CARD_TEXT_COPY } from '../shared/card-languages';
import { formatDate, t } from '../shared/i18n';
import type { CardRecord } from '../shared/types';
import { getBanlist, getPriceAsOf } from './prefs';
import { fromUser } from './trusted';

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

/** Link arrows in reading order: the card data's name (CardRecord.linkmarkers), its glyph, and its name for screen readers. */
const ARROWS: [string, string, string][] = [
  ['Top-Left', '↖', t('card_arrow_top_left')],
  ['Top', '↑', t('card_arrow_top')],
  ['Top-Right', '↗', t('card_arrow_top_right')],
  ['Left', '←', t('card_arrow_left')],
  ['Right', '→', t('card_arrow_right')],
  ['Bottom-Left', '↙', t('card_arrow_bottom_left')],
  ['Bottom', '↓', t('card_arrow_bottom')],
  ['Bottom-Right', '↘', t('card_arrow_bottom_right')],
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
  if (c.frameType === 'spell') return t('card_attribute_spell');
  if (c.frameType === 'trap') return t('card_attribute_trap');
  return c.attribute;
}

/** The attribute dot's colour (ATTR_COLOR): by the card data's attribute, or SPELL / TRAP. */
function attributeColor(c: CardRecord): string {
  const attr = c.frameType === 'spell' ? 'SPELL' : c.frameType === 'trap' ? 'TRAP' : c.attribute;
  return (attr && ATTR_COLOR[attr]) ?? '#999';
}

function levelLabel(c: CardRecord): string | undefined {
  if (c.frameType === 'link') return c.linkval !== undefined ? t('card_label_link', c.linkval) : undefined;
  if (c.level === undefined) return undefined;
  return c.frameType.startsWith('xyz') ? t('card_label_rank', c.level) : t('card_label_level', c.level);
}

function arrowsOf(c: CardRecord): [string, string, string][] {
  const set = new Set(c.linkmarkers ?? []);
  return ARROWS.filter(([name]) => set.has(name));
}

function statsLabel(c: CardRecord): string | undefined {
  if (!isMonster(c)) return undefined;
  return c.frameType === 'link' ? t('card_label_atk', stat(c.atk)) : t('card_label_atk_def', stat(c.atk), stat(c.def));
}

/**
 * The banlist status and its chip's tone (Forbidden red, Limited orange, Semi-Limited yellow), for
 * whichever list the display setting picks: the TCG's (default) or the OCG's (Settings.display.banlist,
 * read from `./prefs`, set by begin-selection.banlist in scan mode and by the side panel itself).
 */
function banLabel(c: CardRecord): { text: string; tone: 'forbidden' | 'limited' | 'semi' } | undefined {
  const mode = getBanlist();
  const s = mode === 'ocg' ? c.banlist?.ocg : c.banlist?.tcg;
  if (!s) return undefined;
  const tone = s === 'Forbidden' || s === 'Banned' ? 'forbidden' : s === 'Limited' ? 'limited' : 'semi';
  return { text: `${s} · ${mode.toUpperCase()}`, tone };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const eur = (n: number) => `€${n.toFixed(2)}`;

/**
 * The card's market prices, informational only (no buying links): "$1.23 TCGplayer · €0.98 Cardmarket".
 * Either side alone when only it is quoted; undefined when neither is (most cards: `card_prices` isn't
 * card-specific pricing Duel Lens controls, so it can be stale or missing).
 */
function priceLabel(c: CardRecord): string | undefined {
  const p = c.prices;
  if (!p) return undefined;
  const parts = [
    p.tcgplayer !== undefined ? `${usd(p.tcgplayer)} TCGplayer` : undefined,
    p.cardmarket !== undefined ? `${eur(p.cardmarket)} Cardmarket` : undefined,
  ].filter((s): s is string => !!s);
  return parts.length ? parts.join(' · ') : undefined;
}

/**
 * A short "as of" label for the price chip, from the stored card snapshot's metadata (`./prefs`,
 * `getPriceAsOf`): the database's update date if known, else its version. Undefined where neither is
 * known, or where it isn't available at all (the content script can't read the card store's metadata).
 */
export function priceAsOfLabel(meta: { dbVersion?: string; updatedAt?: string }): string | undefined {
  if (meta.updatedAt) {
    const d = new Date(meta.updatedAt);
    if (!Number.isNaN(d.getTime())) return formatDate(d, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return meta.dbVersion ? t('card_db_version_label', meta.dbVersion) : undefined;
}

/**
 * The card's cost in the Genesys format; nothing for the many cards that cost 0 points. Screen readers
 * read it as shown: an aria-label on the chip's role-less <span> may go unread (final review M11).
 */
function genesysLabel(c: CardRecord): string | undefined {
  const p = c.genesysPoints;
  if (!p || p <= 0) return undefined;
  return p === 1 ? t('card_genesys_points_one', p) : t('card_genesys_points_other', p);
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
    if (c.pendDesc) out.push({ title: t('card_section_pendulum_effect'), lines: paragraphs(c.pendDesc), flavor: false });
    if (c.monsterDesc) {
      const normal = c.frameType === 'normal_pendulum';
      out.push({ title: normal ? t('card_section_flavor_text') : t('card_section_monster_effect'), lines: paragraphs(c.monsterDesc), flavor: normal });
    }
    return out;
  }
  return [{ lines: paragraphs(c.desc), flavor: c.frameType === 'normal' }];
}

export function passcodeLine(c: CardRecord): string {
  const parts = [t('card_label_passcode', String(c.id).padStart(8, '0'))];
  if (c.archetype) parts.push(t('card_label_archetype', c.archetype));
  return parts.join(' · ');
}

/** Facts in display order, without the banlist status and the Genesys points. */
function factsOf(c: CardRecord): string[] {
  const arrows = arrowsOf(c);
  return [
    attributeLabel(c),
    levelLabel(c),
    arrows.length ? arrows.map(([, g]) => g).join('') : undefined,
    isPendulum(c) && c.scale !== undefined ? t('card_label_scale', c.scale) : undefined,
    statsLabel(c),
  ].filter((f): f is string => !!f);
}

/**
 * The English name under a translated one ("Card text language" in Options; CardRecord.translated): players search
 * by English names. Undefined for an English card, and when the translation keeps the English name.
 */
export function englishSubtitle(c: CardRecord): string | undefined {
  const en = c.translated?.nameEn;
  return en && en !== c.name ? en : undefined;
}

/** Plain text for "Copy text". A translated card's English name follows its name. */
export function cardText(c: CardRecord): string {
  const facts = isSpellTrap(c) ? [] : factsOf(c);
  const en = englishSubtitle(c);
  const lines = [c.name, ...(en ? [`${CARD_TEXT_COPY.englishName}: ${en}`] : []), [typeLine(c), facts.join(' · ')].filter(Boolean).join(' ')];
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

/**
 * The card's page on Konami's own database, shared by the official DB, Yugipedia and YGOResources
 * (CardRecord.konamiId). Not every card has one (imported/anime-only cards, mainly): callers hide the
 * link when it's absent.
 */
export function konamiUrl(konamiId: number): string {
  return `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=${konamiId}&request_locale=en`;
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
 * The card's facts as chips: Attribute, Level/Rank/Link, Link arrows, Pendulum Scale, ATK/DEF, then the
 * banlist status (TCG or OCG, per the display setting), the Genesys points and the market prices. The
 * popover's card view and the hover preview (preview.tsx) both show them.
 */
export function CardFacts({ card }: { card: CardRecord }) {
  const attr = attributeLabel(card);
  const level = levelLabel(card);
  const arrows = arrowsOf(card);
  const stats = statsLabel(card);
  const ban = banLabel(card);
  const genesys = genesysLabel(card);
  const price = priceLabel(card);
  const priceAsOf = price ? getPriceAsOf() : undefined;
  return (
    <div class="dv-facts">
      {attr ? (
        <span class="fact">
          <i class="adot" style={{ '--attr': attributeColor(card) }} />
          {attr}
        </span>
      ) : null}
      {level ? <span class="fact">{level}</span> : null}
      {arrows.length ? (
        <span class="fact mono" aria-label={t('card_link_arrows_label', arrows.map(([, , label]) => label).join(', '))}>
          {arrows.map(([n, g]) => (
            <span key={n}>{g}</span>
          ))}
        </span>
      ) : null}
      {isPendulum(card) && card.scale !== undefined ? <span class="fact">{t('card_label_scale', card.scale)}</span> : null}
      {stats ? <span class="fact mono">{stats}</span> : null}
      {ban ? <span class={`fact ban ${ban.tone}`}>{ban.text}</span> : null}
      {genesys ? <span class="fact genesys">{genesys}</span> : null}
      {price ? (
        <span class="fact price">
          {price}
          {priceAsOf ? ` (${priceAsOf})` : ''}
        </span>
      ) : null}
    </div>
  );
}

/** The facts in words, for screen readers: "FIRE, Level 3, Zombie / Tuner / Effect, ATK 0 / DEF 1800, Genesys 20 pts". */
export function factsInWords(c: CardRecord): string {
  const arrows = arrowsOf(c);
  const price = priceLabel(c);
  const priceAsOf = price ? getPriceAsOf() : undefined;
  return [
    attributeLabel(c),
    levelLabel(c),
    typeLine(c).slice(1, -1),
    arrows.length ? t('card_link_arrows_label', arrows.map(([, , label]) => label).join(', ')) : undefined,
    isPendulum(c) && c.scale !== undefined ? t('card_label_scale', c.scale) : undefined,
    statsLabel(c),
    banLabel(c)?.text,
    genesysLabel(c),
    price ? `${price}${priceAsOf ? ` (${priceAsOf})` : ''}` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * The English name as a small line under a translated name, labelled for screen readers ("English name: …").
 * Shared by the card view (popover, side panel) and the hover preview.
 */
export function EnglishName({ card, class: cls }: { card: CardRecord; class: string }) {
  const en = englishSubtitle(card);
  if (!en) return null;
  return (
    <p class={cls} lang="en">
      <span class="sr-only">{CARD_TEXT_COPY.englishName}: </span>
      {en}
    </p>
  );
}

export function CardView({ card, imageDataUrl, ownCrop = false }: CardViewProps) {
  const sections = textSections(card);
  const withImage = imageDataUrl !== null;
  // The card's name, type line and text carry their language (screen reader voices, CJK glyph forms): the
  // translation's, else English, whatever the interface's language.
  const lang = card.translated?.lang ?? 'en';
  return (
    <div class={`dv${withImage ? '' : ' no-img'}`}>
      {withImage ? (
        <div class={ownCrop ? 'dv-card crop' : 'dv-card'}>
          {imageDataUrl ? (
            <img
              src={imageDataUrl}
              alt={ownCrop ? t('card_view_own_crop_label') : ''}
              title={ownCrop ? t('card_view_own_crop_label') : undefined}
              draggable={false}
            />
          ) : (
            <div class="skel-card" role="img" aria-label={t('card_view_loading_image_label')} />
          )}
        </div>
      ) : null}
      <div class="dv-head">
        <h3 class="dv-name" lang={lang}>
          {card.name}
        </h3>
        <EnglishName card={card} class="dv-en" />
        <p class="dv-type" lang="en">
          {typeLine(card)}
        </p>
        <CardFacts card={card} />
      </div>
      <div class={`dv-text${sections.length === 1 && sections[0].flavor ? ' flavor' : ''}`} lang={lang}>
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
      {card.konamiId !== undefined ? (
        <p class="dv-meta dv-links">
          <a
            href={konamiUrl(card.konamiId)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!fromUser(e)) e.preventDefault();
            }}
          >
            {t('card_view_konami_link')}
          </a>
        </p>
      ) : null}
    </div>
  );
}
