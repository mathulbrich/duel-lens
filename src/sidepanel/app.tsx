// Side panel: the current card plus this session's history. Reads history/current
// straight from chrome.storage (same store the background writes to), loads card text
// and images through the background's message API, and re-reads on any storage change
// so it stays in sync with scans made while the panel was already open. The crop build
// (`--no-remote-images`) shows the small picture of the user's own scan that the background
// keeps with each entry (history.ts) instead of YGOPRODeck's card image.
// Under the picture, the card's details are the popover's own card view (card-view.tsx).
import { useCallback, useEffect, useState } from 'preact/hooks';
import { clearHistory as clearHistoryStore, getThumb } from '../background/history';
import { CardView } from '../content/card-view';
import { sendToBackground } from '../shared/messages';
import { CARD_BACK_ID, type CardRecord, type HistoryEntry } from '../shared/types';
import { sidePanelCredit } from '../welcome/copy';
import { Rich } from '../welcome/markdown';

/** A moment of a video as YouTube shows it: m:ss, or h:mm:ss from an hour on. */
export function formatVideoTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Deterministic 12-hour clock time from the local hour/minute (not locale-formatted). */
export function formatClockTime(at: number): string {
  const d = new Date(at);
  const hours24 = d.getHours();
  const minutes = d.getMinutes();
  const hours12 = ((hours24 + 11) % 12) + 1;
  return `${hours12}:${String(minutes).padStart(2, '0')} ${hours24 < 12 ? 'AM' : 'PM'}`;
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

  const load = useCallback(async () => {
    const [localData, sessionData] = await Promise.all([
      chrome.storage.local.get('history'),
      chrome.storage.session.get('currentEntryId'),
    ]);
    const h = Array.isArray(localData.history) ? (localData.history as HistoryEntry[]) : [];
    setHistory(h);
    setCurrentId(typeof sessionData.currentEntryId === 'string' ? sessionData.currentEntryId : undefined);
  }, []);

  // Initial load, plus staying in sync with scans/clears made elsewhere (e.g. a scan
  // completing while the panel is already open, or the popover's "Keep" button).
  useEffect(() => {
    load();
    const onChanged = () => {
      setChanges((n) => n + 1);
      load();
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
    // Deliberately keyed on `history` only: refetch when the entry list changes, not
    // every time `cards` itself grows (that would just refetch what we already have).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  const currentEntry = history.find((e) => e.id === currentId) ?? history[0];

  useEffect(() => {
    if (!__DUEL_LENS_REMOTE_IMAGES__ || !currentEntry) return;
    const key = imageKey(currentEntry.imageId, 'full');
    if (images[key] !== undefined) return;
    setImageError(false);
    sendToBackground({ type: 'get-image', imageId: currentEntry.imageId, size: 'full' })
      .then((res) => setImages((prev) => ({ ...prev, [key]: res.dataUrl })))
      .catch(() => setImageError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntry?.imageId]);

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
  const shown =
    currentEntry?.cardId === CARD_BACK_ID ? 'Showing a face-down card' : currentCard ? `Showing ${currentCard.name}` : '';
  const status = (
    <p class="sr-only" role="status">
      {shown}
    </p>
  );

  if (history.length === 0) {
    return (
      <div class="panel empty-panel">
        <PanelStyle />
        {status}
        <p class="empty">Nothing scanned yet. Press Alt+Shift+Y, then click a card (or drag a box around one).</p>
        <Credit />
      </div>
    );
  }

  const currentImage = currentEntry ? images[imageKey(currentEntry.imageId, 'full')] : undefined;
  const currentThumb = currentEntry ? thumbs[currentEntry.id] : undefined;

  return (
    <div class="panel">
      <PanelStyle />
      {status}
      <section class="current">
        {/* For the heading outline: this, then the card's name (the card view's h3), then "This session". */}
        <h2 class="sr-only">Current card</h2>
        {currentEntry?.cardId === CARD_BACK_ID ? (
          <p class="face-down">Face-down card</p>
        ) : currentCard ? (
          <>
            {__DUEL_LENS_REMOTE_IMAGES__ ? (
              <>
                {currentImage && <img src={currentImage} alt={currentCard.name} />}
                {imageError && <p class="note">Couldn't load the card image.</p>}
              </>
            ) : (
              currentThumb && <img class="own" src={currentThumb} alt={`What you scanned: ${currentCard.name}`} title="What you scanned" />
            )}
            {/* The popover's details: name, type line, facts (Attribute, Level/Rank/Link, ATK/DEF, TCG
                banlist, Genesys points), the text and the passcode. The picture above is the panel's
                own, so the view draws none (null). */}
            <CardView card={currentCard} imageDataUrl={null} />
          </>
        ) : cardsError ? (
          <p class="loading">Couldn't load this card. Try again.</p>
        ) : (
          <p class="loading">Loading…</p>
        )}
      </section>

      <div class="history-header">
        <h2>This session</h2>
        <button type="button" onClick={onClearHistory}>
          Clear history
        </button>
      </div>
      <ul class="history">
        {history.map((entry) => {
          const c = cards[entry.cardId];
          const name = c?.name ?? (entry.cardId === CARD_BACK_ID ? 'Face-down card' : 'Unknown card');
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
                <span class="name">{name}</span>
                {!link && <span class="time">{time}</span>}
              </button>
              {link && (
                <a class="time" href={link} target="_blank" rel="noreferrer" aria-label={`Open at ${time}`}>
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
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

      /* The card's details: the popover's card view (src/content/card-view.tsx) with its rules from
         src/content/styles.ts ("card view") on the panel's tokens. Only its layout without a picture:
         the panel shows its own picture above it. The text isn't capped here: the panel scrolls. */
      .current .dv { display: grid; gap: 10px; margin-top: 12px; font-family: var(--f-ui); font-size: 13.5px; line-height: 1.45; }
      .dv-head { min-width: 0; }
      .dv-name { margin: 0 0 4px; font-family: var(--f-name); font-weight: 700; font-size: 19px; line-height: 1.15; color: var(--ink); overflow-wrap: anywhere; }
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
      .dv-sec + .dv-sec { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--line); }
      .dv-sec h4 { margin: 0 0 4px; font-family: var(--f-ui); font-stretch: 80%; font-weight: 700; font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-2); }
      .dv-meta { margin: 0; font-family: var(--f-mono); font-size: 11px; color: var(--ink-2); overflow-wrap: anywhere; }
    `}</style>
  );
}
