// The Firefox keep-alive (decision D-FF3). Firefox suspends an idle MV3 event page after 30 s
// (extensions.background.idle.timeout) and the engine that runs in it goes too, so the next read pays a
// cold reload (about 0.35 s more, firefox-spike.md §3). While scan mode is open, the content script
// pings the background (src/content/keep-alive.ts): each message is an event that restarts Firefox's
// idle timer. Only then: once scan mode closes, the event page may be suspended as before. The Chrome
// build sends none (its service worker and offscreen document have their own lifetimes).
//
// Not part of the ToBackground protocol (src/shared/messages.ts): the background answers it before
// the router (src/background/index.ts), from Duel Lens's own content script or pages only.

/** The ping's type. */
export const KEEP_ALIVE = 'keep-alive';

/** How often the content script pings while scan mode is open: well inside Firefox's 30 s. */
export const KEEP_ALIVE_MS = 20_000;

export interface KeepAliveMessage {
  type: typeof KEEP_ALIVE;
}

export function isKeepAlive(msg: unknown): msg is KeepAliveMessage {
  return typeof msg === 'object' && msg !== null && !('target' in msg) && (msg as { type?: unknown }).type === KEEP_ALIVE;
}
