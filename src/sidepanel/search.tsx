// "Find a card by name": the side panel's search box, at its top in every view, and what it shows while it holds a
// name (2 characters or more): the matches from the local card list, best first, each with its type line; then the
// card picked, in full, with a way back to the matches. Opened by its box, by the shortcut (Alt+Shift+F) or the
// toolbar icon's menu (background/find-card.ts), which focus the box.
// - Nothing reaches YGOPRODeck while typing: the matches are the local card list's (search-cards, get-cards), with no
//   pictures. Only the card picked asks for its picture, once (get-image, cached: background/image-cache.ts).
// - Keys: ↓ from the box to the matches, ↑ ↓ through them, Enter opens one; Esc goes back from a card to the
//   matches, then empties the box; / anywhere in the panel goes to the box.
// - A looked-up card isn't a scan: it stays out of the history ("This session").
import type { Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { CardView, englishSubtitle, typeLine } from '../content/card-view';
import { t } from '../shared/i18n';
import { sendToBackground } from '../shared/messages';
import type { CardRecord } from '../shared/types';

/** Characters needed before searching (as "Wrong card?": a stray keystroke fires nothing). */
export const MIN_QUERY = 2;
/** Waits this long after the last keystroke. */
const DEBOUNCE_MS = 150;
/** The background answers at most this many matches (router.ts SEARCH_RESULT_LIMIT). */
const RESULT_LIMIT = 8;

export const searching = (query: string) => query.trim().length >= MIN_QUERY;

export interface SearchBoxProps {
  query: string;
  onQuery(query: string): void;
  inputRef: Ref<HTMLInputElement>;
  /** ↓ from the box: the first match takes the focus. */
  onDown(): void;
  /** Esc in the box: back from a card, else the box empties. */
  onEscape(): void;
}

export function SearchBox({ query, onQuery, inputRef, onDown, onEscape }: SearchBoxProps) {
  return (
    <div class="search" role="search">
      <svg class="glass" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" />
        <path d="M12.6 12.6 17 17" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        maxLength={60}
        autoComplete="off"
        spellcheck={false}
        placeholder={t('sidepanel_search_placeholder')}
        aria-label={t('sidepanel_search_placeholder')}
        onInput={(e) => onQuery((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            onDown();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onEscape();
          }
        }}
      />
      {query ? (
        <button type="button" class="clear" aria-label={t('sidepanel_search_clear')} onClick={() => onQuery('')}>
          ×
        </button>
      ) : (
        <kbd class="slash" aria-hidden="true">
          /
        </kbd>
      )}
    </div>
  );
}

type Results = { state: 'loading' } | { state: 'done'; cards: CardRecord[] } | { state: 'failed' };

/** The matches for `query` from the local card list, as cards (their type lines, in the card text language). */
function useMatches(query: string): Results {
  const [results, setResults] = useState<Results>({ state: 'loading' });
  useEffect(() => {
    const q = query.trim();
    let live = true;
    setResults((r) => (r.state === 'done' ? r : { state: 'loading' }));
    const timer = setTimeout(async () => {
      try {
        const { matches } = await sendToBackground({ type: 'search-cards', query: q });
        const { cards } = matches.length ? await sendToBackground({ type: 'get-cards', ids: matches.map((m) => m.cardId) }) : { cards: {} };
        if (live) setResults({ state: 'done', cards: matches.flatMap((m) => (cards[m.cardId] ? [cards[m.cardId]] : [])) });
      } catch {
        if (live) setResults({ state: 'failed' });
      }
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);
  return results;
}

export interface SearchViewProps {
  query: string;
  /** The card picked from the matches, shown in full; null: the matches. */
  opened: CardRecord | null;
  onOpen(card: CardRecord | null): void;
  /** Back to the box (↑ from the first match, Esc). */
  onBackToBox(): void;
  listRef: Ref<HTMLUListElement>;
}

export function SearchView({ query, opened, onOpen, onBackToBox, listRef }: SearchViewProps) {
  const results = useMatches(query);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (opened) backRef.current?.focus();
  }, [opened]);

  if (opened) return <FoundCard card={opened} backRef={backRef} onBack={() => onOpen(null)} />;

  const q = query.trim();
  const cards = results.state === 'done' ? results.cards : [];
  const onListKey = (e: KeyboardEvent) => {
    const items = [...((e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button.match'))];
    const at = items.indexOf(e.target as HTMLButtonElement);
    if (e.key === 'ArrowDown' && at < items.length - 1) {
      e.preventDefault();
      items[at + 1].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (at > 0) items[at - 1].focus();
      else onBackToBox();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onBackToBox();
    }
  };
  return (
    <section class="search-results" aria-labelledby="search-heading">
      <h2 id="search-heading">{t('sidepanel_search_heading', q)}</h2>
      <p class="sr-only" role="status">
        {results.state === 'done' ? (cards.length === 1 ? t('sidepanel_search_found_one') : t('sidepanel_search_found_other', cards.length)) : ''}
      </p>
      {results.state === 'failed' ? (
        <p class="empty">{t('sidepanel_search_failed')}</p>
      ) : results.state === 'loading' && !cards.length ? (
        <p class="empty">{t('sidepanel_loading')}</p>
      ) : cards.length === 0 ? (
        <div class="empty">
          <p>{t('sidepanel_search_none', q)}</p>
          <p class="tip">{t('sidepanel_search_none_tip')}</p>
        </div>
      ) : (
        <>
          <ul class="matches" ref={listRef} onKeyDown={onListKey}>
            {cards.map((c) => (
              <li key={c.id}>
                <button type="button" class="match" onClick={() => onOpen(c)}>
                  <span class="name" lang={c.translated?.lang ?? 'en'}>
                    <Highlight text={c.name} query={q} />
                  </span>
                  <span class="kind">{typeLine(c)}</span>
                  {englishSubtitle(c) ? (
                    <span class="english" lang="en">
                      {englishSubtitle(c)}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
          {cards.length >= RESULT_LIMIT ? <p class="tip">{t('sidepanel_search_more')}</p> : null}
        </>
      )}
    </section>
  );
}

/** The card picked: its picture (asked for once, cached in the background) and its full details. */
function FoundCard({ card, backRef, onBack }: { card: CardRecord; backRef: Ref<HTMLButtonElement>; onBack(): void }) {
  const [image, setImage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!__DUEL_LENS_REMOTE_IMAGES__) return;
    let live = true;
    setImage(undefined);
    sendToBackground({ type: 'get-image', imageId: card.imageIds[0], size: 'full' })
      .then((r) => live && setImage(r.dataUrl))
      .catch(() => live && setImage(null));
    return () => {
      live = false;
    };
  }, [card.id]);
  return (
    <section class="current" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), onBack())}>
      <button type="button" class="back" ref={backRef} onClick={onBack}>
        {t('sidepanel_search_back')}
      </button>
      <p class="sr-only" role="status">
        {t('sidepanel_announce_showing', card.name)}
      </p>
      {image ? <img src={image} alt={card.name} /> : null}
      <CardView card={card} imageDataUrl={null} />
    </section>
  );
}

/** The name with the part the query matched in bold (the first place it appears, ignoring case). */
function Highlight({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <b>{text.slice(at, at + query.length)}</b>
      {text.slice(at + query.length)}
    </>
  );
}
