// The card database's state, as Duel Lens's pages show it: loading (the first run fills it from
// the bundled card data, which takes a few seconds), ready, or failed with a retry. get-status
// waits for that first fill, and asking again retries a failed one (router.ts, ensureSeededOnce).
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { sendToBackground, type StatusResponse } from '../shared/messages';

export type CardDbState = { kind: 'loading' } | { kind: 'ready'; cardCount: number } | { kind: 'failed' };

/**
 * What a get-status answer says about the card database: `failed` when the background couldn't be
 * asked; an answer without cards is a failed load too (get-status answers 0 when seeding failed).
 */
export function cardDbState(status: StatusResponse | null, failed = false): CardDbState {
  if (failed) return { kind: 'failed' };
  if (!status) return { kind: 'loading' };
  return status.cardCount > 0 ? { kind: 'ready', cardCount: status.cardCount } : { kind: 'failed' };
}

/** Asks the background for the card database's state once, and again on retry(). */
export function useCardDb(): { state: CardDbState; retry(): void } {
  const [state, setState] = useState<CardDbState>({ kind: 'loading' });
  // Only the latest request may set the state (a retry supersedes an earlier answer; unmounting, all).
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    setState({ kind: 'loading' });
    sendToBackground({ type: 'get-status' }).then(
      (status) => request === latest.current && setState(cardDbState(status ?? null, !status)),
      () => request === latest.current && setState({ kind: 'failed' }),
    );
  }, []);
  useEffect(() => {
    load();
    return () => {
      latest.current++;
    };
  }, [load]);
  return { state, retry: load };
}

export function CardDbStatus({ state, onRetry }: { state: CardDbState; onRetry(): void }) {
  return (
    <div class={`status ${state.kind}`} role="status">
      <span class="dot" aria-hidden="true" />
      {state.kind === 'loading' ? (
        <span>Loading the card database… (a few seconds, the first time)</span>
      ) : state.kind === 'ready' ? (
        <span>Ready: {state.cardCount.toLocaleString()} cards loaded.</span>
      ) : (
        <>
          <span>Couldn't load the card database.</span>
          <button type="button" class="btn small" onClick={onRetry}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}
