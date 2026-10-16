// While scan mode is open, the Firefox build pings the background so its event page, which runs the
// engine, isn't suspended under the user (src/shared/keep-alive.ts; content/index.ts starts it with a
// session and stops it when the session closes).
import { KEEP_ALIVE_MS, type KeepAliveMessage } from '../shared/keep-alive';

// The type as a literal (KEEP_ALIVE): src/shared/messages.test.ts reads every type the content script sends.
const ping = (): Promise<unknown> => chrome.runtime.sendMessage({ type: 'keep-alive' } satisfies KeepAliveMessage);

/**
 * Pings at once, then every `everyMs`, until the returned stop() is called. A failed ping is dropped
 * (the extension was reloaded, say): the next one tries again, and scan mode never hears of it.
 */
export function startKeepAlive(send: () => Promise<unknown> = ping, everyMs = KEEP_ALIVE_MS): () => void {
  const beat = () => {
    try {
      void send().catch(() => {});
    } catch {
      // chrome.runtime is gone (the extension was reloaded): nothing to keep alive.
    }
  };
  beat();
  const timer = setInterval(beat, everyMs);
  return () => clearInterval(timer);
}
