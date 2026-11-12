// The card itself: image, name, type line, facts, effect text, passcode and archetype.
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CARD_TEXT_COPY } from '../shared/card-languages';
import { formatDate, t, type MessageKey } from '../shared/i18n';
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

/** The attribute icon's character, as on the card (and 魔 / 罠 for Spells and Traps): drawn in the bundled Noto Sans JP
 *  subset (extension/fonts/noto-sans-jp-700-attributes.woff2), so it shows on a computer without a Japanese font. */
const ATTR_KANJI: Record<string, string> = { DARK: '闇', LIGHT: '光', FIRE: '炎', WATER: '水', EARTH: '地', WIND: '風', DIVINE: '神', SPELL: '魔', TRAP: '罠' };

/** Link arrows in reading order: the card data's name (CardRecord.linkmarkers), its glyph, and its name for screen readers. */
const ARROWS: [string, string, MessageKey][] = [
  ['Top-Left', '↖', 'card_arrow_top_left'],
  ['Top', '↑', 'card_arrow_top'],
  ['Top-Right', '↗', 'card_arrow_top_right'],
  ['Left', '←', 'card_arrow_left'],
  ['Right', '→', 'card_arrow_right'],
  ['Bottom-Left', '↙', 'card_arrow_bottom_left'],
  ['Bottom', '↓', 'card_arrow_bottom'],
  ['Bottom-Right', '↘', 'card_arrow_bottom_right'],
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

/** The card data's attribute, or SPELL / TRAP. */
const attributeKey = (c: CardRecord) => (c.frameType === 'spell' ? 'SPELL' : c.frameType === 'trap' ? 'TRAP' : c.attribute);

/** The attribute icon's colour (ATTR_COLOR). */
function attributeColor(c: CardRecord): string {
  const attr = attributeKey(c);
  return (attr && ATTR_COLOR[attr]) ?? '#999';
}

function levelLabel(c: CardRecord): string | undefined {
  if (c.frameType === 'link') return c.linkval !== undefined ? t('card_label_link', c.linkval) : undefined;
  if (c.level === undefined) return undefined;
  return c.frameType.startsWith('xyz') ? t('card_label_rank', c.level) : t('card_label_level', c.level);
}

function arrowsOf(c: CardRecord): [string, string, string][] {
  const set = new Set(c.linkmarkers ?? []);
  return ARROWS.filter(([name]) => set.has(name)).map(([name, glyph, label]) => [name, glyph, t(label)]);
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
function banLabel(c: CardRecord): { text: string; status: string; list: string; tone: 'forbidden' | 'limited' | 'semi' } | undefined {
  const mode = getBanlist();
  const s = mode === 'ocg' ? c.banlist?.ocg : c.banlist?.tcg;
  if (!s) return undefined;
  const tone = s === 'Forbidden' || s === 'Banned' ? 'forbidden' : s === 'Limited' ? 'limited' : 'semi';
  return { text: `${s} · ${mode.toUpperCase()}`, status: s, list: mode.toUpperCase(), tone };
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

/** A card text's paragraphs: its own lines, and each numbered effect (②, ③, …) on a line of its own. */
const paragraphs = (s: string | undefined) =>
  (s ?? '')
    .replace(/(?<=\S)[ \t]*(?=[\u2461-\u2473])/g, '\n') // with or without a space before it (Japanese, Chinese)
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

/**
 * The English name under a translated one ("Card text language" in Options; CardRecord.translated): players search
 * by English names. Undefined for an English card, and when the translation keeps the English name.
 */
export function englishSubtitle(c: CardRecord): string | undefined {
  const en = c.translated?.nameEn;
  return en && en !== c.name ? en : undefined;
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
  /** A made-up card (Options' preview of the text size): no links to pages about it. */
  sample?: boolean;
  /** An unpinned box (a hovered card, Live's box over the video): no passcode, archetype, price or links, so it fits
   *  without a scroll; pinning the card shows them. */
  compact?: boolean;
  /** The bigger picture, when the box owns it (the popover: Esc and × shrink it first); else the view keeps its own. */
  big?: boolean;
  onBig?(big: boolean): void;
  /** Leave the focus where it is when the picture grows or shrinks: Live's box never takes it (Space and K stay the
   *  player's). */
  keepFocus?: boolean;
}

/** The marks players know from the banlists: a prohibition circle for Forbidden, a circled 1 for Limited, a circled 2
 *  for Semi-Limited. Drawn here; the status is said in words beside it. */
function BanMark({ tone }: { tone: 'forbidden' | 'limited' | 'semi' }) {
  return (
    <svg class="mark" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" class="mark-disc" />
      {tone === 'forbidden' ? (
        <>
          <circle cx="10" cy="10" r="5.6" fill="none" stroke="#fff" stroke-width="2.2" />
          <path d="M6.1 13.9 13.9 6.1" stroke="#fff" stroke-width="2.2" stroke-linecap="round" />
        </>
      ) : (
        // The digit drawn as a path: no text of its own, so the status reads (and copies) as its words alone.
        <path
          class="mark-num"
          d={tone === 'limited' ? 'M8.4 6.6 10.7 5.2V14.8' : 'M7.3 7.7C7.5 6 8.6 5.2 10 5.2c1.6 0 2.8 1 2.8 2.5 0 1.3-.8 2.1-2.2 3.3L7.2 14.6H13'}
          fill="none"
          stroke-width="2.2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      )}
    </svg>
  );
}

/** The Genesys points' mark: a hexagon, a cost token. */
function GenesysMark() {
  return (
    <svg class="mark" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 1.3 17.5 5.6v8.8L10 18.7 2.5 14.4V5.6z" class="gen-hex" />
      <path d="M10 4.4 14.8 7.2v5.6L10 15.6 5.2 12.8V7.2z" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1" />
    </svg>
  );
}

/** The band's card: a card's outline with its art box, as deck sites count copies. */
function BandCard() {
  return (
    <svg class="band-card" viewBox="0 0 10 14" aria-hidden="true">
      <rect x=".5" y=".5" width="9" height="13" rx="1.4" class="band-card-body" />
      <rect x="2" y="2.6" width="6" height="5.4" rx=".5" class="band-card-art" />
    </svg>
  );
}

/**
 * A coloured frame around the card's picture, with a band of marks along its bottom, by the chosen list's status, the
 * way deck sites show a banlist: one card for Limited, two for Semi-Limited, the prohibition circle for Forbidden. The
 * colours are the legality row's marks. It only adds a look: the row beside says the status in words, so the frame is
 * hidden from screen readers and lets clicks through to the picture.
 */
export function BanFrame({ card, children }: { card: CardRecord; children: ComponentChildren }) {
  const tone = banLabel(card)?.tone;
  if (!tone) return <>{children}</>;
  return (
    <div class={`ban-frame ${tone}`}>
      {children}
      <span class="ban-band" aria-hidden="true">
        {tone === 'forbidden' ? (
          <svg class="band-ban" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="6.6" fill="none" stroke="#fff" stroke-width="2.6" />
            <path d="M5.4 14.6 14.6 5.4" stroke="#fff" stroke-width="2.6" stroke-linecap="round" />
          </svg>
        ) : (
          <>
            <BandCard />
            {tone === 'semi' ? <BandCard /> : null}
          </>
        )}
      </span>
    </div>
  );
}

/** A Link monster's arrows as the card draws them: a 3x3 grid, its arrows lit (the middle is the card). */
function LinkGrid({ arrows }: { arrows: Set<string> }) {
  const cells = ['Top-Left', 'Top', 'Top-Right', 'Left', '', 'Right', 'Bottom-Left', 'Bottom', 'Bottom-Right'];
  return (
    <svg class="link-grid" viewBox="0 0 15 15" aria-hidden="true">
      {cells.map((name, i) => (
        <rect key={i} x={0.5 + (i % 3) * 5} y={0.5 + Math.floor(i / 3) * 5} width="4" height="4" rx="1" class={name === '' ? 'mid' : arrows.has(name) ? 'on' : 'off'} />
      ))}
    </svg>
  );
}

const STAR = 'M10 1.6l2.6 5.5 6 .7-4.4 4.1 1.2 5.9L10 14.8 4.6 17.8l1.2-5.9L1.4 7.8l6-.7z';

/**
 * The card's facts, drawn as the card draws them: the attribute icon, the Level's (or Rank's) star, the Link arrows'
 * grid, the Pendulum Scale and ATK/DEF, then a row of what decides whether it can be played: the banlist status (TCG or
 * OCG, per the display setting) with its mark, and the Genesys points. Colour is for that row only. The popover's card
 * view, the side panel and the hover preview (preview.tsx) all show them. The prices are on the card view's meta line.
 */
export function CardFacts({ card }: { card: CardRecord }) {
  const attr = attributeLabel(card);
  const kanji = ATTR_KANJI[attributeKey(card) ?? ''];
  const level = levelLabel(card);
  const arrows = arrowsOf(card);
  const stats = statsLabel(card);
  const ban = banLabel(card);
  const genesys = genesysLabel(card);
  const rank = card.frameType.startsWith('xyz');
  const link = card.frameType === 'link';
  return (
    <div class="dv-facts">
      <div class="facts-row">
        {attr ? (
          <span class="fact attr">
            <i class="attr-icon" style={{ '--attr': attributeColor(card) }} data-k={kanji ?? ''} aria-hidden="true" />
            {attr}
          </span>
        ) : null}
        {level && link ? (
          <span class="fact link">
            {arrows.length ? (
              <span role="img" class="link-icon" aria-label={t('card_link_arrows_label', arrows.map(([, , label]) => label).join(', '))}>
                <LinkGrid arrows={new Set(arrows.map(([n]) => n))} />
              </span>
            ) : null}
            {level}
          </span>
        ) : level ? (
          <span class={`fact level${rank ? ' rank' : ''}`} title={level}>
            <svg class="star" viewBox="0 0 20 20" aria-hidden="true">
              <path d={STAR} />
            </svg>
            <span aria-hidden="true">{card.level}</span>
            <span class="sr-only">{level}</span>
          </span>
        ) : null}
        {isPendulum(card) && card.scale !== undefined ? <span class="fact">{t('card_label_scale', card.scale)}</span> : null}
        {stats ? <span class="fact mono">{stats}</span> : null}
      </div>
      {ban || genesys ? (
        <div class="facts-row legal">
          {ban ? (
            <span class={`fact ban ${ban.tone}`}>
              <BanMark tone={ban.tone} />
              {ban.status}
              <small> · {ban.list}</small>
            </span>
          ) : null}
          {genesys ? (
            <span class="fact genesys">
              <GenesysMark />
              {genesys}
            </span>
          ) : null}
        </div>
      ) : null}
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
    arrows.length ? t('card_link_arrows_label', arrows.map(([, , label]) => label).join(', ')) : undefined,
    isPendulum(c) && c.scale !== undefined ? t('card_label_scale', c.scale) : undefined,
    statsLabel(c),
    banLabel(c)?.text,
    genesysLabel(c),
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

/** The card's prices for its meta line, with their date ("as of"); undefined when it has none. */
function pricesLine(c: CardRecord): { short: string; full: string } | undefined {
  const price = priceLabel(c);
  const p = c.prices;
  if (!price || !p) return undefined;
  const asOf = getPriceAsOf();
  // The amounts alone on the line ($ is TCGplayer's, € Cardmarket's); where they come from, and when, in words.
  const short = [p.tcgplayer !== undefined ? usd(p.tcgplayer) : undefined, p.cardmarket !== undefined ? eur(p.cardmarket) : undefined]
    .filter(Boolean)
    .join(' · ');
  return { short, full: asOf ? `${price} (${asOf})` : price };
}

export function CardView({ card, imageDataUrl, ownCrop = false, sample = false, compact = false, big: bigProp, onBig, keepFocus = false }: CardViewProps) {
  const sections = textSections(card);
  const withImage = imageDataUrl !== null;
  // The picture, bigger, over the whole box (a click on it; a click on it again, or on the small one, shrinks it). It
  // adds nothing to the box's content, so the box never scrolls for it: the box grows to fit it, at most to the
  // window's height (styles.ts .pop-content:has(.dv.big)).
  const [bigOwn, setBigOwn] = useState(false);
  const big = (bigProp ?? bigOwn) && !!imageDataUrl;
  const setBig = (v: boolean) => (onBig ? onBig(v) : setBigOwn(v));
  const bigRef = useRef<HTMLButtonElement>(null);
  const smallRef = useRef<HTMLButtonElement>(null);
  // The focus goes with the picture: to the big one when it opens, back to the small one when it shrinks.
  const wasBig = useRef(false);
  // Live's box never takes the focus: a press on its picture doesn't focus the button either (the browser would on
  // mousedown), so Space and K stay the player's.
  const noFocus = keepFocus ? (e: MouseEvent) => e.preventDefault() : undefined;
  useEffect(() => {
    if (!keepFocus) {
      if (big) bigRef.current?.focus({ preventScroll: true });
      else if (wasBig.current) smallRef.current?.focus({ preventScroll: true });
    }
    wasBig.current = big;
  }, [big]);
  const prices = pricesLine(card);
  // The card's name, type line and text carry their language (screen reader voices, CJK glyph forms): the
  // translation's, else English, whatever the interface's language.
  const lang = card.translated?.lang ?? 'en';
  return (
    <div class={`dv${withImage ? '' : ' no-img'}${big ? ' big' : ''}`}>
      {withImage ? (
        // Under the bigger picture, what it covers is out of reach (inert): no Tab, no screen reader, no click.
        <div class={ownCrop ? 'dv-card crop' : 'dv-card'} inert={big}>
          <BanFrame card={card}>
            {imageDataUrl ? (
              <button
                ref={smallRef}
                type="button"
                class="dv-zoom"
                onMouseDown={noFocus}
                aria-pressed={big}
                // The user's own crop says so (its picture's alt would be hidden by the button's name).
                aria-label={ownCrop ? `${t('card_view_own_crop_label')}. ${t('card_view_picture_bigger')}` : t('card_view_picture_bigger')}
                title={ownCrop ? `${t('card_view_own_crop_label')}. ${t('card_view_picture_bigger')}` : t('card_view_picture_bigger')}
                onClick={(e) => {
                  if (fromUser(e)) setBig(!big);
                }}
              >
                <img src={imageDataUrl} alt={ownCrop ? t('card_view_own_crop_label') : ''} draggable={false} />
              </button>
            ) : (
              <div class="skel-card" role="img" aria-label={t('card_view_loading_image_label')} />
            )}
          </BanFrame>
        </div>
      ) : null}
      {big ? (
        <button
          ref={bigRef}
          type="button"
          class="dv-big"
          onMouseDown={noFocus}
          aria-label={t('card_view_picture_smaller')}
          title={t('card_view_picture_smaller')}
          onClick={(e) => {
            if (fromUser(e)) setBig(false);
          }}
        >
          <img src={imageDataUrl} alt="" draggable={false} />
        </button>
      ) : null}
      <div class="dv-head" inert={big}>
        <h3 class="dv-name" lang={lang}>
          {card.name}
        </h3>
        <EnglishName card={card} class="dv-en" />
        <p class="dv-type" lang="en">
          {typeLine(card)}
        </p>
        <CardFacts card={card} />
      </div>
      <div class={`dv-text${sections.length === 1 && sections[0].flavor ? ' flavor' : ''}`} lang={lang} inert={big}>
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
      {/* The card's numbers under their small labels, and its pages apart, at the right. */}
      {compact ? null : (
        <div class="dv-meta" inert={big}>
          <dl class="dv-ids">
            <div>
              <dt>{t('card_meta_passcode')}</dt>
              <dd>{String(card.id).padStart(8, '0')}</dd>
            </div>
            {card.archetype ? (
              <div>
                <dt>{t('card_meta_archetype')}</dt>
                <dd>{card.archetype}</dd>
              </div>
            ) : null}
            {prices ? (
              <div class="dv-prices" title={prices.full}>
                <dt>{t('card_meta_price')}</dt>
                <dd>
                  <span aria-hidden="true">{prices.short}</span>
                  <span class="sr-only">{prices.full}</span>
                </dd>
              </div>
            ) : null}
          </dl>
          {sample ? null : (
            <p class="dv-links">
              {card.konamiId !== undefined ? (
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
              ) : null}
              {/* Credit where the data comes from: the card's YGOPRODeck page (the user's ask). */}
              <a
                href={ygoprodeckUrl(card.id)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (!fromUser(e)) e.preventDefault();
                }}
              >
                {t('popover_ygoprodeck_link')}
              </a>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
