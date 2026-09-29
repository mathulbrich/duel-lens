// Duel Lens keyboard shortcuts while its overlay is open.
//
// YouTube safety: K (play/pause), C (captions) and ←/→ (seek) are YouTube shortcuts too.
// While installed, a capture-phase listener on window (the first stop of every key event)
// takes those keys, calls preventDefault() and stopImmediatePropagation(), so no page
// listener sees them. Everything else passes through untouched, and nothing is touched
// once uninstall() has run.
//
// Tab, ↑, ↓, Enter and Space are taken only by a layer that handles them (onStep, onActivate: the
// frozen frame's outlined cards); elsewhere (the popover) they keep their native behaviour. So are
// F, T and I (onLayoutKey): YouTube's fullscreen, theater and miniplayer keys change the page's
// layout, which the frozen frame must keep matching (live check m2).
//
// Only the user's own keys count (security review M1): a key event a script made (isTrusted false,
// e.g. the page's window.dispatchEvent) does nothing here and reaches the page untouched.
import { fromUser } from './trusted';

export interface KeyHandlers {
  /** Escape */
  onClose?(): void;
  /** K */
  onKeep?(): void;
  /** C */
  onCopy?(): void;
  /** ArrowLeft */
  onPrev?(): void;
  /** ArrowRight */
  onNext?(): void;
  /** Tab / ArrowDown (1) and Shift+Tab / ArrowUp (-1). Taken only when given. */
  onStep?(dir: 1 | -1): void;
  /** Enter or Space. Taken only when given. */
  onActivate?(): void;
  /** F, T or I (YouTube's fullscreen, theater, miniplayer). Taken only when given. */
  onLayoutKey?(): void;
}

type Action =
  | { name: 'onClose' | 'onKeep' | 'onCopy' | 'onPrev' | 'onNext' | 'onActivate' | 'onLayoutKey' }
  | { name: 'onStep'; dir: 1 | -1 };

function actionFor(e: KeyboardEvent, handlers: KeyHandlers): Action | null {
  switch (e.key) {
    case 'Escape':
      return { name: 'onClose' };
    case 'k':
    case 'K':
      return { name: 'onKeep' };
    case 'c':
    case 'C':
      return { name: 'onCopy' };
    case 'ArrowLeft':
      return { name: 'onPrev' };
    case 'ArrowRight':
      return { name: 'onNext' };
    case 'Tab':
      return handlers.onStep ? { name: 'onStep', dir: e.shiftKey ? -1 : 1 } : null;
    case 'ArrowDown':
      return handlers.onStep ? { name: 'onStep', dir: 1 } : null;
    case 'ArrowUp':
      return handlers.onStep ? { name: 'onStep', dir: -1 } : null;
    case 'Enter':
    case ' ':
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

/**
 * @param host When given, watched on every keydown: once it leaves the document (a fresh
 * world's mountHost()/prepareCapture removed it directly, without ever running this
 * handler's own effect cleanup), the handler uninstalls itself instead of intercepting
 * forever.
 */
export function installKeyHandler(handlers: KeyHandlers, target: Window = window, host?: Node): () => void {
  // Keys whose keydown we took; their keypress/keyup are swallowed too.
  const taken = new Set<string>();

  const uninstall = () => {
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
    e.preventDefault();
    e.stopImmediatePropagation();
    taken.add(e.key.toLowerCase());
    // Holding K/C/Esc/Enter should not repeat the action; arrows and Tab may repeat to cycle.
    if (e.repeat && action.name !== 'onPrev' && action.name !== 'onNext' && action.name !== 'onStep') return;
    if (action.name === 'onStep') handlers.onStep?.(action.dir);
    else handlers[action.name]?.();
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
