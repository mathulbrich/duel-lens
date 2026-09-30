// Duel Lens keyboard shortcuts while scan mode is open (one handler, installed by the selection layer).
//
// YouTube safety: K (play/pause), C (captions) and ←/→ (seek) are YouTube shortcuts too.
// While installed, a capture-phase listener on window (the first stop of every key event)
// takes those keys, calls preventDefault() and stopImmediatePropagation(), so no page
// listener sees them. Everything else passes through untouched, and nothing is touched
// once uninstall() has run.
//
// K and Space are YouTube's play/pause: in scan mode they leave it and play the video again
// (onPlay), and never reach the page as well (it would toggle playback twice). S keeps the card in
// the side panel (onKeep; K did before scan mode stayed open).
//
// Tab, ↑, ↓, Enter, Space and S are taken only by a handler that handles them (onStep, onActivate,
// onPlay, onKeep). So are F, T and I (onLayoutKey): YouTube's fullscreen, theater and miniplayer keys
// change the page's layout, which the frozen frame must keep matching (live check m2).
// A handler that returns false didn't handle the key after all (Enter on a focused button, which
// presses it): the key goes on untouched.
//
// When the handler itself is uninstalled while handling a key (the key closed Duel Lens), that key's
// release (keypress, keyup) is still kept from the page: a Space keyup on the page's focused button
// would press it (YouTube's play button: the video would pause again).
//
// Only the user's own keys count (security review M1): a key event a script made (isTrusted false,
// e.g. the page's window.dispatchEvent) does nothing here and reaches the page untouched.
import { fromUser } from './trusted';

/** A handler's answer: false when it didn't handle the key after all (it goes on untouched). */
export type KeyResult = boolean | void;

export interface KeyHandlers {
  /** Escape */
  onClose?(): void;
  /** K, or Space when given: YouTube's play/pause keys. K is always taken. */
  onPlay?(key: 'k' | ' '): KeyResult;
  /** S: the side panel. Taken only when given. */
  onKeep?(): KeyResult;
  /** C */
  onCopy?(): void;
  /** ArrowLeft */
  onPrev?(): void;
  /** ArrowRight */
  onNext?(): void;
  /** Tab / ArrowDown (1) and Shift+Tab / ArrowUp (-1), with which it was. Taken only when given. */
  onStep?(dir: 1 | -1, via: 'tab' | 'arrow'): KeyResult;
  /** Enter. Taken only when given. */
  onActivate?(): KeyResult;
  /** F, T or I (YouTube's fullscreen, theater, miniplayer). Taken only when given. */
  onLayoutKey?(): void;
}

type Action =
  | { name: 'onClose' | 'onKeep' | 'onCopy' | 'onPrev' | 'onNext' | 'onActivate' | 'onLayoutKey' }
  | { name: 'onPlay'; key: 'k' | ' ' }
  | { name: 'onStep'; dir: 1 | -1; via: 'tab' | 'arrow' };

/** Actions a held key repeats (to cycle); the others run once per press. */
const REPEATS = new Set<Action['name']>(['onPrev', 'onNext', 'onStep']);

function actionFor(e: KeyboardEvent, handlers: KeyHandlers): Action | null {
  switch (e.key) {
    case 'Escape':
      return { name: 'onClose' };
    case 'k':
    case 'K':
      return { name: 'onPlay', key: 'k' };
    case ' ':
      return handlers.onPlay ? { name: 'onPlay', key: ' ' } : null;
    case 's':
    case 'S':
      return handlers.onKeep ? { name: 'onKeep' } : null;
    case 'c':
    case 'C':
      return { name: 'onCopy' };
    case 'ArrowLeft':
      return { name: 'onPrev' };
    case 'ArrowRight':
      return { name: 'onNext' };
    case 'Tab':
      return handlers.onStep ? { name: 'onStep', dir: e.shiftKey ? -1 : 1, via: 'tab' } : null;
    case 'ArrowDown':
      return handlers.onStep ? { name: 'onStep', dir: 1, via: 'arrow' } : null;
    case 'ArrowUp':
      return handlers.onStep ? { name: 'onStep', dir: -1, via: 'arrow' } : null;
    case 'Enter':
      return handlers.onActivate ? { name: 'onActivate' } : null;
    case 'f':
    case 'F':
    case 't':
    case 'T':
    case 'i':
    case 'I':
      return handlers.onLayoutKey ? { name: 'onLayoutKey' } : null;
    default:
      return null;
  }
}

function run(action: Action, handlers: KeyHandlers): KeyResult {
  switch (action.name) {
    case 'onPlay':
      return handlers.onPlay?.(action.key);
    case 'onStep':
      return handlers.onStep?.(action.dir, action.via);
    default:
      return handlers[action.name]?.();
  }
}

/** True when the key event is aimed at something the user types into. */
function isTyping(e: KeyboardEvent): boolean {
  // composedPath()[0] is the real target, even inside an open shadow root.
  const t = (e.composedPath?.()[0] ?? e.target) as Element | null;
  if (!t || typeof (t as Element).tagName !== 'string') return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  const el = t as HTMLElement;
  if (el.isContentEditable) return true;
  // Fallback for DOMs that don't compute isContentEditable.
  return !!el.closest?.('[contenteditable]:not([contenteditable="false"])');
}

/** How long a key's release is waited for once the key closed Duel Lens. */
const RELEASE_MS = 2000;

/** Keeps the release (keypress, keyup) of a key the user holds from the page, until its keyup or RELEASE_MS. */
function swallowRelease(target: Window, key: string): void {
  const k = key.toLowerCase();
  const swallow = (e: KeyboardEvent) => {
    if (!fromUser(e) || e.key.toLowerCase() !== k) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keyup') done();
  };
  const done = () => {
    clearTimeout(timer);
    target.removeEventListener('keypress', swallow, true);
    target.removeEventListener('keyup', swallow, true);
  };
  target.addEventListener('keypress', swallow, true);
  target.addEventListener('keyup', swallow, true);
  const timer = setTimeout(done, RELEASE_MS);
}

/**
 * @param host When given, watched on every keydown: once it leaves the document (a fresh
 * world's mountHost()/prepareCapture removed it directly, without ever running this
 * handler's own effect cleanup), the handler uninstalls itself instead of intercepting
 * forever.
 */
export function installKeyHandler(handlers: KeyHandlers, target: Window = window, host?: Node): () => void {
  // Keys whose keydown we took; their keypress/keyup are swallowed too.
  const taken = new Set<string>();
  let installed = true;

  const uninstall = () => {
    installed = false;
    target.removeEventListener('keydown', onKeyDown, true);
    target.removeEventListener('keypress', onKeyUpOrPress, true);
    target.removeEventListener('keyup', onKeyUpOrPress, true);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Orphaned: either this world's extension context was invalidated (reloaded/updated -
    // chrome.runtime.id goes away), or our own host element was torn down without ever
    // running our effect cleanup. Either way, stop intercepting and let this and every
    // later key event reach the page (review: orphaned key handler after a reload).
    if (!chrome.runtime?.id || (host && !host.isConnected)) {
      uninstall();
      return;
    }
    if (!fromUser(e) || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const action = actionFor(e, handlers);
    if (!action || isTyping(e)) return;
    const k = e.key.toLowerCase();
    // Holding K/C/Esc/Enter should not repeat the action; arrows and Tab may repeat to cycle. A held
    // key whose first press went on untouched goes on untouched.
    if (e.repeat && !REPEATS.has(action.name)) {
      if (taken.has(k)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (run(action, handlers) === false) {
      taken.delete(k);
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (installed) taken.add(k);
    else swallowRelease(target, e.key); // the key closed Duel Lens: its release is ours too
  };

  const onKeyUpOrPress = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    if (!taken.has(k) || !fromUser(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keyup') taken.delete(k);
  };

  target.addEventListener('keydown', onKeyDown, true);
  target.addEventListener('keypress', onKeyUpOrPress, true);
  target.addEventListener('keyup', onKeyUpOrPress, true);
  return uninstall;
}
