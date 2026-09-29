// A one-line notice at the top of the viewport (e.g. why the side panel didn't open).
import { useLayoutEffect, useState } from 'preact/hooks';

export interface ToastStore {
  show(message: string): void;
  subscribe(fn: (message: string | null) => void): () => void;
  dispose(): void;
}

/** A single-slot toast: each show() replaces the message; it clears after `ms`, then calls `onIdle`. */
export function createToastStore(ms = 4000, onIdle?: () => void): ToastStore {
  let current: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = new Set<(m: string | null) => void>();
  const emit = () => subs.forEach((fn) => fn(current));
  return {
    show(message) {
      current = message;
      emit();
      clearTimeout(timer);
      timer = setTimeout(() => {
        current = null;
        emit();
        onIdle?.();
      }, ms);
    },
    subscribe(fn) {
      subs.add(fn);
      fn(current);
      return () => {
        subs.delete(fn);
      };
    },
    dispose() {
      clearTimeout(timer);
      subs.clear();
    },
  };
}

export function Toast({ store }: { store: ToastStore }) {
  const [message, setMessage] = useState<string | null>(null);
  // Subscribe during commit so a message shown right after mounting is never missed.
  useLayoutEffect(() => store.subscribe(setMessage), [store]);
  return message ? (
    <div class="toast" role="status">
      {message}
    </div>
  ) : null;
}
