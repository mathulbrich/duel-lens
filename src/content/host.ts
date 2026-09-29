// The overlay host: one element in the page's top layer holding a closed shadow root.
// - popover="manual" + showPopover() puts it in the top layer, above everything,
//   including fullscreen video once re-shown on fullscreenchange.
// - The closed shadow root and the inline `all: initial` reset keep the page's CSS
//   out and our CSS in.
// - Styles go in through a constructed stylesheet (adoptedStyleSheets), which a strict
//   page CSP (style-src) can't block; a <style> element is the fallback.
import { CSS } from './styles';

export const HOST_ID = 'duel-lens-host';

export interface Host {
  root: ShadowRoot;
  host: HTMLElement;
  destroy(): void;
}

const HOST_STYLE = [
  'all: initial',
  'display: block',
  'position: fixed',
  'inset: 0',
  'width: auto',
  'height: auto',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'background: transparent',
  'overflow: visible',
  'z-index: 2147483647',
  'pointer-events: none',
]
  .map((d) => `${d} !important`)
  .join('; ');

type PopoverElement = HTMLElement & { showPopover?(): void; hidePopover?(): void };

function show(el: PopoverElement) {
  try {
    el.showPopover?.();
  } catch {
    // Already showing, or not connected: nothing to do.
  }
}

function hide(el: PopoverElement) {
  try {
    el.hidePopover?.();
  } catch {
    // Not showing.
  }
}

function adoptStyles(root: ShadowRoot) {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
  }
}

/** UI state mirrored onto the host's light-DOM attributes, for end-to-end tests. */
export interface HostState {
  state: 'selecting' | 'scanning' | 'result' | 'error';
  /** Name of the card shown in the popover (result state only). */
  card?: string;
  /** The engine's confidence (result state only). */
  confident?: boolean;
  /** How many detected cards are outlined on the frozen frame (selecting only, once detection answered). */
  cards?: number;
}

/**
 * The shadow root is closed, so Puppeteer can't look inside. Mirror the state onto
 * data-duel-lens-state / -card / -confident / -cards on the host element instead.
 */
export function mirrorState(host: HTMLElement, s: HostState): void {
  host.setAttribute('data-duel-lens-state', s.state);
  if (s.card !== undefined) host.setAttribute('data-duel-lens-card', s.card);
  else host.removeAttribute('data-duel-lens-card');
  if (s.confident !== undefined) host.setAttribute('data-duel-lens-confident', String(s.confident));
  else host.removeAttribute('data-duel-lens-confident');
  if (s.cards !== undefined) host.setAttribute('data-duel-lens-cards', String(s.cards));
  else host.removeAttribute('data-duel-lens-cards');
}

/**
 * A new custom-element name for every mount: "duel-lens-" and 16 random lowercase hex digits
 * (security review H1). A fixed tag let a page register it first, with a constructor that calls
 * attachInternals(): our host was then the page's custom element, and ElementInternals.shadowRoot
 * handed the page our closed root (the frozen screenshot, cross-origin frames included, and the card).
 */
export function hostTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `duel-lens-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function mountHost(): Host {
  // A reloaded extension leaves its old host behind; there must only ever be one.
  document.querySelectorAll(`#${HOST_ID}`).forEach((el) => el.remove());

  const host = document.createElement(hostTag()) as PopoverElement;
  host.id = HOST_ID;
  host.setAttribute('popover', 'manual');
  host.style.cssText = HOST_STYLE;
  // Attached while the element is undefined and not yet in the page, so the root is never
  // "available to element internals": a page that defines the tag once it sees the element
  // upgrades it, but its ElementInternals.shadowRoot stays null. Keep this before the append.
  const root = host.attachShadow({ mode: 'closed' });
  adoptStyles(root);
  document.documentElement.append(host);
  show(host);

  // The fullscreen element joins the top layer after us; re-showing moves us above it.
  const onFullscreen = () => {
    hide(host);
    show(host);
  };
  document.addEventListener('fullscreenchange', onFullscreen);

  return {
    root,
    host,
    destroy() {
      document.removeEventListener('fullscreenchange', onFullscreen);
      hide(host);
      host.remove();
    },
  };
}
