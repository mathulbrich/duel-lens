// Side panel: the current card plus this session's history. Reads the history straight from its store
// (history.ts: the private IndexedDB store the background writes to) and the current entry from
// chrome.storage.session, loads card text and images through the background's message API, and re-reads on
// any chrome.storage change (history.ts marks each history change there too) so it stays in sync with scans
// made while the panel was already open. The crop build
// (`--no-remote-images`) shows the small picture of the user's own scan that the background
// keeps with each entry (history.ts) instead of YGOPRODeck's card image.
// Under the picture, the card's details are the popover's own card view (card-view.tsx).
// "Read the whole board" (B in scan mode; src/content/board.ts): the background keeps the last board in
// chrome.storage.session, and the panel shows it as its Board view: the cards by player (Near, Far), each
// with its name, a small picture and how sure the read was; a click shows that card's details. The board
// is no scan: it isn't in the history. It opens at the key press, saying "Reading the board…" until the
// cards come. The panel shows what came last: a new board brings the Board view,
// a new current card (a scan, Keep) the card view; the two buttons at the top switch between them.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { clearHistory as clearHistoryStore, getHistory, getThumb } from '../background/history';
import { BOARD_KEY, boardSummary, storedBoard, type StoredBoard } from '../content/board';
import { CardView } from '../content/card-view';
import { displayImageId, isAltArtwork } from '../shared/alt-artwork';
import { t, uiLang } from '../shared/i18n';
import { sendToBackground, type BoardCard } from '../shared/messages';
import { CARD_BACK_ID, type CardRecord, type HistoryEntry } from '../shared/types';
import { isPanelFocus, PANEL_FOCUS_KEY } from '../shared/panel-focus';
import { sidePanelCredit } from '../welcome/copy';
import { SearchBox, searching, SearchView } from './search';
import { Rich } from '../welcome/markdown';

/** A moment of a video as YouTube shows it: m:ss, or h:mm:ss from an hour on. */
export function formatVideoTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The local clock time as the interface's language writes it: "3:04 PM" in English, "15:04" in German. */
export function formatClockTime(at: number): string {
  // ICU puts a narrow no-break space before AM/PM: a plain one reads (and tests) the same.
  return new Intl.DateTimeFormat(uiLang(), { hour: 'numeric', minute: '2-digit' }).format(new Date(at)).replace(/[\u202f\u00a0]/g, ' ');
}

function youTubeVideoId(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1) || null;
    if (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com' || u.hostname === 'm.youtube.com') {
      return u.searchParams.get('v');
    }
  } catch {
    // Not a parseable URL (shouldn't happen for a real HistoryEntry.pageUrl); no link.
  }
  return null;
}

/** A link back to the moment in the video, or null when the entry isn't from YouTube. */
export function openAtHref(entry: HistoryEntry): string | null {
  if (entry.videoTime === undefined) return null;
  const videoId = youTubeVideoId(entry.pageUrl);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(entry.videoTime)}s`;
}

function imageKey(imageId: number, size: 'full' | 'small'): string {
  return `${imageId}:${size}`;
}

/** How sure the board's read of a card was, in the popover's words. */
export const BOARD_STATE_WORDS: Record<BoardCard['state'], string> = {
  sure: t('board_state_sure'),
  'not-sure': t('popover_label_not_sure'),
  low: t('popover_label_low_match'),
};

export function App() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>(undefined);
  const [cards, setCards] = useState<Record<number, CardRecord>>({});
  const [images, setImages] = useState<Record<string, string | null>>({});
  const [cardsError, setCardsError] = useState(false);
  const [imageError, setImageError] = useState(false);
  /** The crop build (`--no-remote-images`): the picture of each scan, by entry id (null: none was kept). */
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  /** Counts storage changes: a scan's picture is kept a moment after its entry. */
  const [changes, setChanges] = useState(0);
  /** The last board read (B in scan mode), if any. */
  const [board, setBoard] = useState<StoredBoard | null>(null);
  /** What the panel shows: the current card and the history, or the board. */
  const [view, setView] = useState<'card' | 'board'>('card');
  /** The board's card whose details show (its index in board.cards); null: the board's lists. */
  const [boardPick, setBoardPick] = useState<number | null>(null);
  /** The board and current card the last load saw (null before the first): what changed picks the view. */
  const seen = useRef<{ boardAt?: number; currentId?: string } | null>(null);
  /** Board card ids get-cards answered without (not in the card data): "Unknown card", not "Loading…" for good. */
  const [unknown, setUnknown] = useState<ReadonlySet<number>>(new Set());
  /** Images asked for already (`imageKey`), so a re-render doesn't ask twice. */
  const asked = useRef(new Set<string>());
  /** "Back to the board" (focused when a board card's details open), and the row they were opened from. */
  const backRef = useRef<HTMLButtonElement>(null);
  const lastPick = useRef<number | null>(null);

  /** Bumped when the card text language changes, so the cards are read again (get-cards answers in it). */
  const [cardLanguageEpoch, setCardLanguageEpoch] = useState(0);
  // "Find a card by name" (search.tsx): what the box holds, and the match opened from it.
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<CardRecord | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const matchesRef = useRef<HTMLUListElement>(null);
  const focusSearch = useCallback(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const load = useCallback(async () => {
    const [h, sessionData, boardData, focusData] = await Promise.all([
      getHistory(),
      chrome.storage.session.get('currentEntryId'),
      chrome.storage.session.get(BOARD_KEY),
      chrome.storage.session.get(PANEL_FOCUS_KEY),
    ]);
    // Opened by the shortcut or the toolbar menu's "Find a card by name": the box takes the focus.
    if (isPanelFocus(focusData?.[PANEL_FOCUS_KEY])) {
      void chrome.storage.session.remove(PANEL_FOCUS_KEY);
      requestAnimationFrame(focusSearch);
    }
    const current = typeof sessionData.currentEntryId === 'string' ? sessionData.currentEntryId : undefined;
    const b = storedBoard(boardData?.[BOARD_KEY]);
    setHistory(h);
    setCurrentId(current);
    setBoard(b);
    // What came last shows: on opening, the board if it is newer than the card shown; then a new board
    // brings the Board view, and a new current card (a scan, Keep) the card view.
    const before = seen.current;
    if (!before) {
      const entry = h.find((e) => e.id === current) ?? h[0];
      setView(b && (!entry || b.at >= entry.at) ? 'board' : 'card');
    } else if (b && b.at !== before.boardAt) {
      setView('board');
      setBoardPick(null);
      lastPick.current = null; // a new board: no row of the old one to go back to
      setQuery(''); // what was just read shows, not a search
      setOpened(null);
    } else if (current !== before.currentId) {
      setView('card');
      setQuery('');
      setOpened(null);
    }
    if (!b) setView('card');
    seen.current = { boardAt: b?.at, currentId: current };
  }, [focusSearch]);

  // "/" anywhere in the panel (but in a box) goes to the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      focusSearch();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusSearch]);

  // Initial load, plus staying in sync with scans/clears made elsewhere (e.g. a scan
  // completing while the panel is already open, or the popover's "Keep" button).
  useEffect(() => {
    load();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      setChanges((n) => n + 1);
      load();
      // A new card text language (Options): read the cards again, in it.
      const lang = (v: unknown) => (v as { display?: { cardLanguage?: unknown } } | undefined)?.display?.cardLanguage;
      if (area === 'local' && changes.settings && lang(changes.settings.oldValue) !== lang(changes.settings.newValue)) {
        setCards({});
        setCardLanguageEpoch((n) => n + 1);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [load]);

  useEffect(() => {
    const ids = [...new Set(history.map((e) => e.cardId).filter((id) => id !== CARD_BACK_ID))];
    const missing = ids.filter((id) => cards[id] === undefined);
    if (missing.length === 0) return;
    setCardsError(false);
    sendToBackground({ type: 'get-cards', ids: missing })
      .then((res) => setCards((prev) => ({ ...prev, ...res.cards })))
      .catch(() => setCardsError(true));
    // Deliberately keyed on `history` (and the card text language) only: refetch when the entry list changes,
    // not every time `cards` itself grows (that would just refetch what we already have).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, cardLanguageEpoch]);

  // The board's cards' records (names, details), as for the history above.
  useEffect(() => {
    if (!board) return;
    const missing = [...new Set(board.cards.map((c) => c.cardId))].filter((id) => cards[id] === undefined);
    if (missing.length === 0) return;
    setCardsError(false);
    sendToBackground({ type: 'get-cards', ids: missing })
      .then((res) => {
        setCards((prev) => ({ ...prev, ...res.cards }));
        const absent = missing.filter((id) => !res.cards?.[id]);
        if (absent.length) setUnknown((prev) => new Set([...prev, ...absent]));
      })
      .catch(() => setCardsError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, cardLanguageEpoch]);

  /** Asks the background for a card image once (the crop build asks for none). */
  const loadImage = (imageId: number, size: 'full' | 'small') => {
    const key = imageKey(imageId, size);
    if (!__DUEL_LENS_REMOTE_IMAGES__ || isAltArtwork(imageId) || asked.current.has(key)) return;
    asked.current.add(key);
    sendToBackground({ type: 'get-image', imageId, size }).then(
      (res) => setImages((prev) => ({ ...prev, [key]: res?.dataUrl ?? null })),
      () => setImages((prev) => ({ ...prev, [key]: null })),
    );
  };

  const picked = view === 'board' && board && boardPick !== null ? board.cards[boardPick] : undefined;
  const pickedImageId = picked ? displayImageId(picked.imageId, cards[picked.cardId]) : undefined;

  // The board's small pictures while it shows; the picked card's in full.
  useEffect(() => {
    if (view !== 'board' || !board) return;
    for (const c of board.cards) loadImage(displayImageId(c.imageId, cards[c.cardId]), 'small');
    if (pickedImageId !== undefined) loadImage(pickedImageId, 'full');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, board, cards, pickedImageId]);

  // Focus follows the board's details: to "Back to the board" when a card's open, and back to that card's row after.
  useLayoutEffect(() => {
    if (picked) backRef.current?.focus();
    else if (lastPick.current !== null) document.querySelector<HTMLElement>(`[data-board-index="${lastPick.current}"]`)?.focus();
  }, [boardPick]);

  const currentEntry = history.find((e) => e.id === currentId) ?? history[0];
  // The entry's picture is a YGOPRODeck image. An entry naming an artwork YGOPRODeck lacks (a synthetic id,
  // src/shared/alt-artwork.ts; the background records its card's image instead) shows its card's own first image,
  // once the card's record is here.
  const currentImageId = currentEntry ? displayImageId(currentEntry.imageId, cards[currentEntry.cardId]) : undefined;

  useEffect(() => {
    if (!__DUEL_LENS_REMOTE_IMAGES__ || currentImageId === undefined || isAltArtwork(currentImageId)) return;
    const key = imageKey(currentImageId, 'full');
    if (images[key] !== undefined) return;
    setImageError(false);
    sendToBackground({ type: 'get-image', imageId: currentImageId, size: 'full' })
      .then((res) => setImages((prev) => ({ ...prev, [key]: res.dataUrl })))
      .catch(() => setImageError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId]);

  // The crop build (`--no-remote-images`): the picture kept with the entry (read again after storage
  // changes until it's there).
  useEffect(() => {
    if (__DUEL_LENS_REMOTE_IMAGES__ || !currentEntry) return;
    const id = currentEntry.id;
    if (thumbs[id]) return;
    getThumb(id).then(
      (thumb) => setThumbs((prev) => ({ ...prev, [id]: thumb ?? null })),
      () => setThumbs((prev) => ({ ...prev, [id]: null })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry?.id, changes]);

  const selectEntry = (id: string) => {
    setCurrentId(id);
    void chrome.storage.session.set({ currentEntryId: id });
  };

  const onClearHistory = () => {
    void clearHistoryStore().then(load);
  };

  const currentCard = currentEntry ? cards[currentEntry.cardId] : undefined;
  // What a screen reader hears when the shown card changes (a11y review m3): its name only. A live
  // region on the card's section would read out its whole text. The region stays mounted, at the same
  // place in both layouts below, so the first scan after an empty panel is announced too.
  const shown = searching(query)
    ? ''
    : view === 'board' && board
      ? picked
        ? cards[picked.cardId]
          ? t('sidepanel_announce_showing', cards[picked.cardId].name)
          : ''
        : board.reading
          ? t('sidepanel_reading_board')
          : t('sidepanel_announce_showing_board', boardSummary(board.cards))
      : currentEntry?.cardId === CARD_BACK_ID
        ? t('sidepanel_announce_face_down')
        : currentCard
          ? t('sidepanel_announce_showing', currentCard.name)
          : '';
  const status = (
    <p class="sr-only" role="status">
      {shown}
    </p>
  );
  // The two views, once there is a board.
  const views = board ? (
    <div class="views" role="group" aria-label={t('sidepanel_views_group_label')}>
      <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>
        {t('sidepanel_board_tab')}
      </button>
      <button type="button" aria-pressed={view === 'card'} onClick={() => setView('card')}>
        {t('sidepanel_scans_tab')}
      </button>
    </div>
  ) : null;

  const onQuery = (q: string) => {
    setQuery(q);
    setOpened(null);
  };
  const searchBox = (
    <SearchBox
      query={query}
      onQuery={onQuery}
      inputRef={searchRef}
      onDown={() => matchesRef.current?.querySelector<HTMLButtonElement>('button.match')?.focus()}
      onEscape={() => (opened ? setOpened(null) : onQuery(''))}
    />
  );
  if (searching(query)) {
    return (
      <div class="panel">
        <PanelStyle />
        {/* The search view speaks for itself (search.tsx: how many matches, the card opened). */}
        {searchBox}
        <SearchView query={query} opened={opened} onOpen={setOpened} onBackToBox={focusSearch} listRef={matchesRef} />
        <Credit />
      </div>
    );
  }

  if (view === 'board' && board) {
    const pick = (i: number) => {
      lastPick.current = i;
      setBoardPick(i);
    };
    const pickedCard = picked ? cards[picked.cardId] : undefined;
    const pickedImage = pickedImageId !== undefined ? (images[imageKey(pickedImageId, 'full')] ?? images[imageKey(pickedImageId, 'small')]) : undefined;
    return (
      <div class="panel">
        <PanelStyle />
        {status}
        {searchBox}
        {views}
        {picked ? (
          <section class="current">
            <h2 class="sr-only">{t('sidepanel_board_card_heading')}</h2>
            <button type="button" class="back" ref={backRef} onClick={() => setBoardPick(null)}>
              {t('sidepanel_back_to_board')}
            </button>
            <p class={`state ${picked.state}`}>{BOARD_STATE_WORDS[picked.state]}</p>
            {pickedCard ? (
              <>
                {__DUEL_LENS_REMOTE_IMAGES__ && pickedImage ? <img src={pickedImage} alt={pickedCard.name} /> : null}
                <CardView card={pickedCard} imageDataUrl={null} />
              </>
            ) : cardsError || unknown.has(picked.cardId) ? (
              <p class="loading">{t('sidepanel_card_loading_failed')}</p>
            ) : (
              <p class="loading">{t('sidepanel_loading')}</p>
            )}
          </section>
        ) : (
          <section class="board" aria-labelledby="board-heading">
            <div class="history-header">
              <h2 id="board-heading">{t('sidepanel_board_heading')}</h2>
              {board.reading ? null : <span class="time">{formatClockTime(board.at)}</span>}
            </div>
            {board.reading ? (
              <p class="empty">{t('sidepanel_reading_board')}</p>
            ) : board.cards.length === 0 ? (
              <p class="empty">{t('sidepanel_board_empty')}</p>
            ) : (
              <ul class="board-list">
                {board.cards.map((c, i) => {
                  const card = cards[c.cardId];
                  const thumb = images[imageKey(displayImageId(c.imageId, card), 'small')];
                  return (
                    <li key={i}>
                      <button type="button" class="board-item" data-board-index={i} onClick={() => pick(i)}>
                        {thumb ? <img src={thumb} alt="" /> : <span class="ph" aria-hidden="true" />}
                        <span class="name" lang={card ? (card.translated?.lang ?? 'en') : undefined}>
                          {card?.name ?? (cardsError || unknown.has(c.cardId) ? t('sidepanel_unknown_card') : t('sidepanel_loading'))}
                        </span>
                        <span class={`state ${c.state}`}>{BOARD_STATE_WORDS[c.state]}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        <Credit />
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div class="panel empty-panel">
        <PanelStyle />
        {status}
        {searchBox}
        {views}
        <p class="empty">{t('sidepanel_empty_history')}</p>
        <p class="empty tip">{t('sidepanel_empty_search_hint')}</p>
        <Credit />
      </div>
    );
  }

  const currentImage = currentImageId !== undefined ? images[imageKey(currentImageId, 'full')] : undefined;
  const currentThumb = currentEntry ? thumbs[currentEntry.id] : undefined;

  return (
    <div class="panel">
      <PanelStyle />
      {status}
      {searchBox}
      {views}
      <section class="current">
        {/* For the heading outline: this, then the card's name (the card view's h3), then "This session". */}
        <h2 class="sr-only">{t('sidepanel_current_card_heading')}</h2>
        {currentEntry?.cardId === CARD_BACK_ID ? (
          <p class="face-down">{t('preview_face_down')}</p>
        ) : currentCard ? (
          <>
            {__DUEL_LENS_REMOTE_IMAGES__ ? (
              <>
                {currentImage && <img src={currentImage} alt={currentCard.name} />}
                {imageError && <p class="note">{t('sidepanel_card_image_load_failed')}</p>}
              </>
            ) : (
              currentThumb && (
                <img class="own" src={currentThumb} alt={t('sidepanel_own_crop_alt', currentCard.name)} title={t('sidepanel_own_crop_title')} />
              )
            )}
            {/* The popover's details: name, type line, facts (Attribute, Level/Rank/Link, ATK/DEF, TCG
                banlist, Genesys points), the text and the passcode. The picture above is the panel's
                own, so the view draws none (null). */}
            <CardView card={currentCard} imageDataUrl={null} />
          </>
        ) : cardsError ? (
          <p class="loading">{t('sidepanel_card_loading_failed')}</p>
        ) : (
          <p class="loading">{t('sidepanel_loading')}</p>
        )}
      </section>

      <div class="history-header">
        <h2>{t('sidepanel_this_session_heading')}</h2>
        <button type="button" onClick={onClearHistory}>
          {t('sidepanel_clear_history_button')}
        </button>
      </div>
      <ul class="history">
        {history.map((entry) => {
          const c = cards[entry.cardId];
          const name = c?.name ?? (entry.cardId === CARD_BACK_ID ? t('preview_face_down') : t('sidepanel_unknown_card'));
          const time = entry.videoTime !== undefined ? formatVideoTime(entry.videoTime) : formatClockTime(entry.at);
          const link = openAtHref(entry);
          // The entry whose card is shown above (the newest, until one is picked): gold, and
          // aria-current for screen readers (a11y review m2).
          const isCurrent = entry.id === currentEntry?.id;
          // A YouTube entry's time is itself the link back to that moment (live-check p3: the row
          // showed it twice, "436:32 · Open at 436:32"); its name says what it does.
          return (
            <li key={entry.id} class={isCurrent ? 'active' : undefined}>
              <button type="button" class="entry" aria-current={isCurrent ? 'true' : undefined} onClick={() => selectEntry(entry.id)}>
                <span class="name" lang={c ? (c.translated?.lang ?? 'en') : undefined}>
                  {name}
                </span>
                {!link && <span class="time">{time}</span>}
              </button>
              {link && (
                <a class="time" href={link} target="_blank" rel="noreferrer" aria-label={t('sidepanel_open_at_label', time)}>
                  {time}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <Credit />
    </div>
  );
}

/** Where the card data comes from, and the short disclaimer (docs/release/disclaimers.md §8). */
function Credit() {
  return (
    <p class="credit">
      <Rich text={sidePanelCredit(__DUEL_LENS_REMOTE_IMAGES__)} />
    </p>
  );
}

// Inline styles keep the side panel a single-file component, matching the design
// study's dark theme (#17151E / gold #E7B955). The popover (stream C) owns the polished
// version of this visual language; this is a plain, functional echo of it. The panel is
// dark whatever the system theme (color-scheme: dark), like the popover; its colours are the
// tokens on .panel. The card's details use the popover's rules and type (index.tsx loads the fonts).
function PanelStyle() {
  return (
    <style>{`
      :root { color-scheme: dark; }
      body { margin: 0; }
      .panel {
        --bg: #17151E; --ink: #EDE8DC; --ink-2: #B8B2C4; --line: #3A3648; --gold: #E7B955;
        --f-ui: "Duel Lens Archivo", "Archivo", "Helvetica Neue", Arial, sans-serif;
        --f-name: "Duel Lens Spectral SC", "Spectral SC", "Spectral", Georgia, serif;
        --f-text: "Duel Lens Source Serif 4", "Source Serif 4", "Source Serif Pro", Georgia, serif;
        --f-mono: "Duel Lens JetBrains Mono", "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
        font-family: system-ui, sans-serif; background: var(--bg); color: var(--ink); min-height: 100vh; padding: 16px; box-sizing: border-box;
      }
      .history-header h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2); margin: 0; }
      .current img { width: 100%; border-radius: 6px; display: block; }
      .current img.own { width: auto; max-width: 100%; max-height: 180px; background: rgba(0,0,0,.35); }
      .credit { margin: 24px 0 0; font-size: 11.5px; line-height: 1.5; color: var(--ink-2); }
      .credit a { color: var(--gold); }
      .history-header { display: flex; align-items: center; justify-content: space-between; margin: 20px 0 8px; }
      .history-header button { background: none; border: 1px solid var(--line); color: var(--ink-2); border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer; }
      .history { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
      .history li { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .history li.active .entry { color: var(--gold); }
      .history .entry { flex: 1; display: flex; justify-content: space-between; gap: 8px; background: none; border: none; color: inherit; text-align: left; padding: 6px 4px; border-radius: 4px; cursor: pointer; font: inherit; }
      .history .entry:hover { background: rgba(231, 185, 85, 0.08); }
      .history .time { color: var(--ink-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .history a.time { color: var(--gold); padding: 6px 4px; border-radius: 4px; text-underline-offset: 0.18em; }
      .history a.time:hover { text-decoration-thickness: 2px; }
      .empty { color: var(--ink-2); text-align: center; margin-top: 40px; }

      /* "Find a card by name" (search.tsx): the box at the top, then its matches or the card picked. */
      .search { position: relative; display: flex; align-items: center; margin: 0 0 14px; }
      .search .glass { position: absolute; left: 10px; width: 15px; height: 15px; fill: none; stroke: var(--ink-2); stroke-width: 1.8; stroke-linecap: round; pointer-events: none; }
      .search input { flex: 1; min-width: 0; box-sizing: border-box; padding: 8px 32px 8px 32px; border-radius: 8px; border: 1px solid var(--line); background: rgba(255,255,255,.04); color: var(--ink); font: inherit; font-size: 13.5px; }
      .search input::placeholder { color: var(--ink-2); }
      .search input:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; border-color: transparent; }
      .search .clear { position: absolute; right: 6px; width: 24px; height: 24px; border: 0; border-radius: 5px; background: none; color: var(--ink-2); font-size: 16px; cursor: pointer; }
      .search .clear:hover { color: var(--ink); background: rgba(255,255,255,.08); }
      .search .slash { position: absolute; right: 9px; font-family: var(--f-mono); font-size: 11px; color: var(--ink-2); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; pointer-events: none; }
      .search-results h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--ink-2); margin: 0 0 8px; font-weight: 600; overflow-wrap: anywhere; }
      .matches { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .match { width: 100%; display: grid; gap: 1px; text-align: left; background: none; border: 1px solid transparent; border-radius: 6px; color: inherit; font: inherit; padding: 7px 8px; cursor: pointer; }
      .match:hover, .match:focus-visible { background: rgba(231, 185, 85, 0.08); border-color: rgba(231, 185, 85, 0.35); outline: none; }
      .match .name { font-family: var(--f-name); font-size: 15px; }
      .match .name b { color: var(--gold); font-weight: inherit; }
      .match .kind, .match .english { font-size: 11.5px; color: var(--ink-2); }
      .search-results .tip, .empty .tip { color: var(--ink-2); font-size: 12px; margin: 10px 0 0; }
      .search-results .empty { margin-top: 24px; }

      /* The two views (once there is a board), and the board: one list of its cards. */
      .views { display: flex; gap: 4px; margin: 0 0 14px; padding: 3px; border: 1px solid var(--line); border-radius: 8px; }
      .views button { flex: 1; background: none; border: 0; border-radius: 5px; color: var(--ink-2); font: inherit; font-size: 12.5px; font-weight: 600; padding: 5px 8px; cursor: pointer; }
      .views button[aria-pressed="true"] { background: rgba(231, 185, 85, 0.16); color: var(--gold); }
      .views button:hover { color: var(--ink); }
      .board .history-header { margin-top: 0; }
      .board .time { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
      .board-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .board-item { width: 100%; display: flex; align-items: center; gap: 10px; background: none; border: none; color: inherit; text-align: left; padding: 4px; border-radius: 6px; cursor: pointer; font: inherit; }
      .board-item:hover { background: rgba(231, 185, 85, 0.08); }
      .board-item img, .board-item .ph { width: 34px; height: 50px; flex: none; border-radius: 3px; object-fit: cover; background: rgba(255,255,255,.06); }
      .board-item .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .state { flex: none; font-size: 11px; font-weight: 650; white-space: nowrap; color: var(--ink-2); }
      .state.not-sure { color: #FFD84D; }
      .state.low { color: #FF9D3C; }
      .current p.state { margin: 0 0 10px; font-size: 12px; }
      .back { background: none; border: 1px solid var(--line); color: var(--ink-2); border-radius: 4px; padding: 4px 8px; font: inherit; font-size: 12px; cursor: pointer; margin-bottom: 10px; }
      .back:hover { color: var(--ink); }
      .views button:focus-visible, .board-item:focus-visible, .back:focus-visible { outline: 2px solid var(--gold); outline-offset: 1px; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

      /* The card's details: the popover's card view (src/content/card-view.tsx) with its rules from
         src/content/styles.ts ("card view") on the panel's tokens. Only its layout without a picture:
         the panel shows its own picture above it. The text isn't capped here: the panel scrolls. */
      .current .dv { display: grid; gap: 10px; margin-top: 12px; font-family: var(--f-ui); font-size: 13.5px; line-height: 1.45; }
      .dv-head { min-width: 0; }
      .dv-name { margin: 0 0 4px; font-family: var(--f-name); font-weight: 700; font-size: 19px; line-height: 1.15; color: var(--ink); overflow-wrap: anywhere; }
      .dv-en { margin: -2px 0 6px; font-size: 12.5px; line-height: 1.25; color: var(--ink-2); overflow-wrap: anywhere; }
      .dv-type { margin: 0 0 8px; font-stretch: 80%; font-weight: 650; font-size: 11.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-2); }
      .dv-facts { display: flex; flex-wrap: wrap; gap: 5px; }
      .fact { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,.08); font-size: 11.5px; font-weight: 620; white-space: nowrap; color: var(--ink); }
      .fact.mono { font-family: var(--f-mono); font-size: 11px; }
      .fact.ban { gap: 6px; font-weight: 750; }
      .fact.ban::before { content: ''; width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--ban); box-shadow: 0 0 6px var(--ban); }
      .fact.forbidden { --ban: #FF5A5A; background: linear-gradient(135deg, rgba(255,80,80,.30), rgba(190,30,60,.28)); color: #FFD6D2; box-shadow: inset 0 0 0 1px rgba(255,120,110,.65), 0 0 10px rgba(255,80,80,.25); }
      .fact.limited { --ban: #FF9D3C; background: linear-gradient(135deg, rgba(255,150,50,.30), rgba(215,95,20,.26)); color: #FFE2C4; box-shadow: inset 0 0 0 1px rgba(255,170,90,.65), 0 0 10px rgba(255,150,60,.22); }
      .fact.semi { --ban: #FFD84D; background: linear-gradient(135deg, rgba(255,215,70,.26), rgba(200,160,30,.24)); color: #FFF2C6; box-shadow: inset 0 0 0 1px rgba(255,222,110,.6), 0 0 10px rgba(255,215,80,.2); }
      .fact.genesys { gap: 6px; background: linear-gradient(135deg, rgba(56,200,230,.30), rgba(132,96,255,.30)); color: #D9F6FF; font-weight: 750; box-shadow: inset 0 0 0 1px rgba(110,215,255,.6), 0 0 10px rgba(80,190,255,.25); }
      .fact.genesys::before { content: ''; width: 6px; height: 6px; flex: none; border-radius: 1px; transform: rotate(45deg); background: #6FE3F7; box-shadow: 0 0 6px rgba(111,227,247,.9); }
      .adot { width: 9px; height: 9px; border-radius: 50%; background: var(--attr, #999); box-shadow: 0 0 0 1.5px rgba(255,255,255,.35); }
      .dv-text { font-family: var(--f-text); font-size: 14px; line-height: 1.5; background: rgba(255,255,255,.045); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; color: var(--ink); }
      .dv-text p { margin: 0 0 6px; }
      .dv-text p:last-child { margin: 0; }
      .dv-text.flavor p, .dv-text .flavor p { font-style: italic; }
      /* Japanese and Korean have no italics: a translated flavor text stays upright (card text language). */
      .dv-text:is([lang="ja"], [lang="ko"]) p { font-style: normal; }
      .dv-sec + .dv-sec { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--line); }
      .dv-sec h4 { margin: 0 0 4px; font-family: var(--f-ui); font-stretch: 80%; font-weight: 700; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
      .dv-meta { margin: 0; font-family: var(--f-mono); font-size: 11px; color: var(--ink-2); overflow-wrap: anywhere; }
      .dv-meta a { color: var(--gold); text-underline-offset: 0.18em; }
    `}</style>
  );
}
