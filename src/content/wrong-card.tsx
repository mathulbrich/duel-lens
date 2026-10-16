// "Wrong card?" (src/content/popover.tsx): a free-text search over the whole local card list, for
// when none of the engine's own candidates (the "Not it?"/"Could also be" chips, already in the
// popover) are right. Sends the pick back as a normal `correct` (the entryId the popover already has),
// so history and the local "Wrong card?" record both update the same way the chips already do
// (src/background/router.ts, src/background/corrections.ts) - this component owns only the search UI.
import { useRef, useState } from 'preact/hooks';
import { t } from '../shared/i18n';
import { sendToBackground } from '../shared/messages';
import { byUser } from './trusted';

export interface WrongCardMatch {
  cardId: number;
  name: string;
  imageId: number;
}

export interface WrongCardPanelProps {
  /** The scan's history entry (RecognizeResponse.entry.id): what the correction is recorded against. */
  entryId: string;
}

/** Characters needed before searching, so a stray keystroke doesn't fire a request. */
const MIN_QUERY_LENGTH = 2;
/** Matches router.ts's MAX_SEARCH_QUERY_LENGTH: the background cuts a longer query anyway, so the
 * input simply can't type past this (nothing is lost - no real card name is anywhere near 60 chars). */
const MAX_QUERY_LENGTH = 60;
/** Waits this long after the last keystroke before asking the background (shared/names.ts runs over
 * the whole card list, so this keeps a fast typist from firing a lookup per key). */
const SEARCH_DEBOUNCE_MS = 200;

export function WrongCardPanel({ entryId }: WrongCardPanelProps) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<WrongCardMatch[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const seq = useRef(0);

  const search = (value: string) => {
    window.clearTimeout(timer.current);
    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setMatches([]);
      return;
    }
    const n = ++seq.current;
    timer.current = setTimeout(() => {
      sendToBackground({ type: 'search-cards', query: trimmed })
        .then((res) => {
          if (seq.current === n) setMatches(res.matches);
        })
        .catch(() => {
          if (seq.current === n) setMatches([]);
        });
    }, SEARCH_DEBOUNCE_MS);
  };

  const onInput = (ev: Event) => {
    const value = (ev.target as HTMLInputElement).value;
    setQuery(value);
    setError(null);
    search(value);
  };

  const pick = async (m: WrongCardMatch) => {
    setError(null);
    try {
      const res = await sendToBackground({ type: 'correct', entryId, cardId: m.cardId, imageId: m.imageId });
      if (!res.ok) throw new Error(res.error ?? 'failed');
      setSaved(m.name);
    } catch {
      setError(t('popover_wrong_card_save_failed'));
    }
  };

  if (saved) {
    return (
      <p class="note dv-wrong-saved" role="status">
        {t('popover_wrong_card_saved', saved)}
      </p>
    );
  }

  return (
    <div class="dv-wrong" role="group" aria-label={t('popover_wrong_card_search_label')}>
      <input
        type="text"
        class="dv-wrong-input"
        value={query}
        onInput={onInput}
        placeholder={t('popover_wrong_card_search_placeholder')}
        aria-label={t('popover_wrong_card_search_label')}
        maxLength={MAX_QUERY_LENGTH}
        autoFocus
      />
      {matches.length > 0 ? (
        <ul class="dv-wrong-results">
          {matches.map((m) => (
            <li key={m.cardId}>
              <button type="button" class="alt" onClick={byUser(() => void pick(m))}>
                <em>{m.name}</em>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim().length >= MIN_QUERY_LENGTH ? (
        <p class="note">{t('popover_wrong_card_no_results')}</p>
      ) : null}
      {error ? <p class="note err">{error}</p> : null}
    </div>
  );
}
