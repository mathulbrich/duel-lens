// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { installKeyHandler } from './keys';
import { trustEvents, untrusted } from './test-events';

// Stand-ins for YouTube's own shortcut listeners (K plays/pauses, C toggles captions,
// arrows seek). They are registered like a page would: on document and on window.
type Listener = Mock<(e: Event) => void>;
let pageDoc: Listener;
let pageWin: Listener;
let pageKeyup: Listener;
let uninstall: (() => void) | undefined;
let distrust: () => void;

beforeEach(() => {
  distrust = trustEvents(); // the user's own keys
  pageDoc = vi.fn<(e: Event) => void>();
  pageWin = vi.fn<(e: Event) => void>();
  pageKeyup = vi.fn<(e: Event) => void>();
  document.addEventListener('keydown', pageDoc);
  window.addEventListener('keydown', pageWin);
  document.addEventListener('keyup', pageKeyup);
  // A live, non-invalidated extension context, as real content scripts always have.
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id' } });
});

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  document.removeEventListener('keydown', pageDoc);
  window.removeEventListener('keydown', pageWin);
  document.removeEventListener('keyup', pageKeyup);
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  distrust();
});

function press(key: string, target: EventTarget = document.body, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function handlers() {
  return { onClose: vi.fn(), onPlay: vi.fn(), onCopy: vi.fn(), onPrev: vi.fn(), onNext: vi.fn() };
}

describe('installKeyHandler', () => {
  it('handles K, C, ← and → itself and keeps them away from the page (YouTube safety)', () => {
    const h = handlers();
    uninstall = installKeyHandler(h);
    const later = vi.fn<(e: Event) => void>();
    window.addEventListener('keydown', later, true); // even a later capture listener on window

    const events = ['k', 'c', 'ArrowLeft', 'ArrowRight'].map((k) => press(k));

    expect(h.onPlay.mock.calls).toEqual([['k']]); // K is YouTube's play/pause: scan mode's "leave and play"
    expect(h.onCopy).toHaveBeenCalledTimes(1);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    expect(pageDoc).not.toHaveBeenCalled();
    expect(pageWin).not.toHaveBeenCalled();
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener('keydown', later, true);
  });

  it('closes on Escape', () => {
    const h = handlers();
    uninstall = installKeyHandler(h);
    const e = press('Escape');
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(e.defaultPrevented).toBe(true);
    expect(pageDoc).not.toHaveBeenCalled();
  });

  it('accepts upper-case K, C and S (Shift or Caps Lock)', () => {
    const h = { ...handlers(), onKeep: vi.fn() };
    uninstall = installKeyHandler(h);
    press('K', document.body, { shiftKey: true });
    press('C');
    press('S');
    expect(h.onPlay).toHaveBeenCalledTimes(1);
    expect(h.onCopy).toHaveBeenCalledTimes(1);
    expect(h.onKeep).toHaveBeenCalledTimes(1);
    expect(pageDoc).not.toHaveBeenCalled();
  });

  // UX-1 (the lead's ruling): K and Space leave scan mode and play the video; Keep moved from K to S.
  it('takes S for Keep only when given, and Space for play/pause only when given', () => {
    uninstall = installKeyHandler({ onClose: vi.fn() });
    const passed = [press('s'), press(' ')];
    expect(passed.some((e) => e.defaultPrevented)).toBe(false);
    expect(pageDoc).toHaveBeenCalledTimes(2);
    uninstall();
    const h = { ...handlers(), onKeep: vi.fn() };
    uninstall = installKeyHandler(h);
    const taken = [press('s'), press(' ')];
    expect(h.onKeep).toHaveBeenCalledTimes(1);
    expect(h.onPlay.mock.calls).toEqual([[' ']]);
    expect(taken.every((e) => e.defaultPrevented)).toBe(true);
    expect(pageDoc).toHaveBeenCalledTimes(2); // none more
  });

  it('lets every key reach the page again after uninstall()', () => {
    const h = { ...handlers(), onKeep: vi.fn() };
    installKeyHandler(h)();
    const events = ['k', 'c', 'ArrowLeft', 'ArrowRight', 'Escape', 's', ' '].map((k) => press(k));
    expect(pageDoc).toHaveBeenCalledTimes(7);
    expect(pageWin).toHaveBeenCalledTimes(7);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(Object.values(h).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it('passes other keys through untouched while active', () => {
    const h = handlers();
    uninstall = installKeyHandler(h);
    const events = ['j', 'l', 'f', 'm', 'ArrowUp', 'Enter', 'Tab'].map((k) => press(k));
    expect(pageDoc).toHaveBeenCalledTimes(7);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
  });

  it('does not hijack shortcuts with Ctrl, Meta or Alt (e.g. Ctrl+C copies page text)', () => {
    const h = handlers();
    uninstall = installKeyHandler(h);
    press('c', document.body, { ctrlKey: true });
    press('c', document.body, { metaKey: true });
    press('ArrowLeft', document.body, { altKey: true });
    expect(h.onCopy).not.toHaveBeenCalled();
    expect(h.onPrev).not.toHaveBeenCalled();
    expect(pageDoc).toHaveBeenCalledTimes(3);
  });

  it('ignores keys typed into an input or textarea', () => {
    const h = handlers();
    uninstall = installKeyHandler(h);
    const input = document.createElement('input');
    const area = document.createElement('textarea');
    document.body.append(input, area);
    press('k', input);
    press('c', area);
    press('Escape', input);
    expect(h.onPlay).not.toHaveBeenCalled();
    expect(h.onCopy).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
    expect(pageDoc).toHaveBeenCalledTimes(3);
  });

  it('ignores keys typed into editable content, including inside a shadow root', () => {
    const h = handlers();
    uninstall = installKeyHandler(h);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const shadowHost = document.createElement('div');
    const shadowInput = document.createElement('input');
    shadowHost.attachShadow({ mode: 'open' }).append(shadowInput);
    document.body.append(editable, shadowHost);
    press('k', editable);
    press('c', shadowInput);
    expect(h.onPlay).not.toHaveBeenCalled();
    expect(h.onCopy).not.toHaveBeenCalled();
    expect(pageDoc).toHaveBeenCalledTimes(2);
  });

  it('does not repeat K, S or C while held, but lets the arrows repeat', () => {
    const h = { ...handlers(), onKeep: vi.fn() };
    uninstall = installKeyHandler(h);
    for (const k of ['k', 's', 'c']) {
      press(k);
      press(k, document.body, { repeat: true });
      press(k, document.body, { repeat: true });
    }
    press('ArrowRight');
    press('ArrowRight', document.body, { repeat: true });
    expect(h.onPlay).toHaveBeenCalledTimes(1);
    expect(h.onKeep).toHaveBeenCalledTimes(1);
    expect(h.onCopy).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(2);
    expect(pageDoc).not.toHaveBeenCalled(); // held keys still never reach the page
  });

  // Click to scan: on the frozen frame, Tab / Shift+Tab and ↓ / ↑ step through the outlined cards
  // and Enter reads the one in focus. Only a layer that asks for them takes these keys.
  it('given onStep and onActivate, takes Tab, Shift+Tab, ↓, ↑ and Enter from the page, saying which key stepped', () => {
    const h = { ...handlers(), onStep: vi.fn(), onActivate: vi.fn() };
    uninstall = installKeyHandler(h);
    const events = [press('Tab'), press('Tab', document.body, { shiftKey: true }), press('ArrowDown'), press('ArrowUp'), press('Enter')];
    expect(h.onStep.mock.calls).toEqual([
      [1, 'tab'],
      [-1, 'tab'],
      [1, 'arrow'],
      [-1, 'arrow'],
    ]);
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    expect(pageDoc).not.toHaveBeenCalled();
    expect(pageWin).not.toHaveBeenCalled();
  });

  // Enter or Space on a focused button presses it; Tab in the popover, say, may be left to the browser.
  it('leaves a key untouched when its handler returns false (not handled), its repeats and release too', () => {
    const h = { ...handlers(), onPlay: vi.fn(() => false), onActivate: vi.fn(() => false), onStep: vi.fn(() => false) };
    uninstall = installKeyHandler(h);
    const events = [press(' '), press(' ', document.body, { repeat: true }), press('Enter'), press('Tab')];
    expect(h.onPlay).toHaveBeenCalledTimes(1); // a repeat runs nothing
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(pageDoc).toHaveBeenCalledTimes(4);
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    expect(pageKeyup).toHaveBeenCalledTimes(1);
  });

  // Live check m2: F, T and I (YouTube's fullscreen, theater and miniplayer) change the page's layout,
  // so the frozen frame no longer matches it.
  it('given onLayoutKey, takes F, T and I from the page (either case), without repeating', () => {
    const h = { ...handlers(), onLayoutKey: vi.fn() };
    uninstall = installKeyHandler(h);
    const events = ['f', 'T', 'i', 'F'].map((k) => press(k));
    press('f', document.body, { repeat: true });
    expect(h.onLayoutKey).toHaveBeenCalledTimes(4);
    expect(events.every((e) => e.defaultPrevented)).toBe(true);
    expect(pageDoc).not.toHaveBeenCalled();
  });

  it('without onStep, onActivate and onKeep, leaves Tab, ↓, ↑, Enter, Space and S to the page', () => {
    uninstall = installKeyHandler({ onClose: vi.fn() });
    const events = ['Tab', 'ArrowDown', 'ArrowUp', 'Enter', ' ', 's'].map((k) => press(k));
    expect(pageDoc).toHaveBeenCalledTimes(6);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
  });

  it('does not repeat activation while Enter is held, but lets Tab and the arrows repeat', () => {
    const h = { ...handlers(), onStep: vi.fn(), onActivate: vi.fn() };
    uninstall = installKeyHandler(h);
    press('Enter');
    press('Enter', document.body, { repeat: true });
    press('Tab');
    press('Tab', document.body, { repeat: true });
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    expect(h.onStep).toHaveBeenCalledTimes(2);
    expect(pageDoc).not.toHaveBeenCalled();
  });

  it('also swallows the keyup of a key it handled', () => {
    uninstall = installKeyHandler(handlers());
    press('k');
    const up = new KeyboardEvent('keyup', { key: 'k', bubbles: true, cancelable: true });
    document.body.dispatchEvent(up);
    expect(pageKeyup).not.toHaveBeenCalled();
    // A keyup for a key it never handled goes through.
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', bubbles: true, cancelable: true }));
    expect(pageKeyup).toHaveBeenCalledTimes(1);
  });

  // UX-1: Space or K leaves scan mode, whose unmount uninstalls this handler before the key comes up. A Space
  // keyup on the page's focused button would press it (YouTube's play button: the video would pause again).
  it('keeps the release of the key that closed Duel Lens from the page, once, after uninstalling', () => {
    const h = { ...handlers(), onPlay: vi.fn(() => uninstall?.()) }; // leaving unmounts the handler
    uninstall = installKeyHandler(h);
    const pageButton = document.createElement('button');
    const pressed = vi.fn();
    pageButton.addEventListener('click', pressed);
    document.body.append(pageButton);
    const down = press(' ', pageButton);
    expect(down.defaultPrevented).toBe(true);
    const keypress = new KeyboardEvent('keypress', { key: ' ', bubbles: true, cancelable: true });
    const up = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
    pageButton.dispatchEvent(keypress);
    pageButton.dispatchEvent(up);
    expect(keypress.defaultPrevented && up.defaultPrevented).toBe(true); // no press of the page's button
    expect(pageKeyup).not.toHaveBeenCalled();
    // Only that one release: the next Space is the page's again.
    press(' ', pageButton);
    pageButton.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
    expect(pageDoc).toHaveBeenCalledTimes(1);
    expect(pageKeyup).toHaveBeenCalledTimes(1);
    expect(h.onPlay).toHaveBeenCalledTimes(1);
  });

  // Security review M1: the page's own script can dispatch keys at window, where this listens, and so
  // drive the overlay (close it, cycle the matches, which records a correction, copy, keep).
  it('ignores key events a script made (isTrusted false): nothing happens and the page gets them untouched', () => {
    const h = { ...handlers(), onKeep: vi.fn(), onStep: vi.fn(), onActivate: vi.fn() };
    uninstall = installKeyHandler(h);
    const keys = ['Escape', 'k', 's', 'c', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', ' '];
    const events = keys.map((k) => {
      const e = untrusted(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, composed: true }));
      document.body.dispatchEvent(e);
      return e;
    });
    expect(Object.values(h).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(events.some((e) => e.defaultPrevented)).toBe(false);
    expect(pageDoc).toHaveBeenCalledTimes(keys.length);
    press('Escape'); // the user's own Escape still closes
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not take a script-made keyup for the release of a key the user still holds", () => {
    uninstall = installKeyHandler(handlers());
    press('k');
    document.body.dispatchEvent(untrusted(new KeyboardEvent('keyup', { key: 'k', bubbles: true, cancelable: true })));
    expect(pageKeyup).toHaveBeenCalledTimes(1); // the page's own event, untouched
    document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'k', bubbles: true, cancelable: true }));
    expect(pageKeyup).toHaveBeenCalledTimes(1); // the real keyup is still swallowed
  });

  // Review: after an extension reload with a popover open, the orphaned isolated world's
  // key handler otherwise keeps swallowing K/C/arrows forever (its own Preact tree never
  // unmounts, since nothing tells it the context died).
  describe('self-uninstalls once orphaned', () => {
    it('lets the key through and uninstalls once chrome.runtime.id is gone (extension reloaded)', () => {
      const h = handlers();
      uninstall = installKeyHandler(h);
      vi.stubGlobal('chrome', { runtime: {} }); // reloaded: this world's context is invalidated

      const e = press('k');

      expect(h.onPlay).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
      expect(pageDoc).toHaveBeenCalledTimes(1);

      // Uninstalled for good, even once chrome.runtime.id looks valid again: a real new
      // world would install its own fresh handler; this orphaned one stays retired.
      vi.stubGlobal('chrome', { runtime: { id: 'test-extension-id' } });
      press('c');
      expect(h.onCopy).not.toHaveBeenCalled();
      expect(pageDoc).toHaveBeenCalledTimes(2);
    });

    it('lets the key through and uninstalls once its host element leaves the DOM', () => {
      const h = handlers();
      const hostEl = document.createElement('div');
      document.body.append(hostEl);
      uninstall = installKeyHandler(h, window, hostEl);

      hostEl.remove();
      const e = press('k');

      expect(h.onPlay).not.toHaveBeenCalled();
      expect(e.defaultPrevented).toBe(false);
      expect(pageDoc).toHaveBeenCalledTimes(1);
    });

    it('keeps working normally while a given host element stays connected', () => {
      const h = handlers();
      const hostEl = document.createElement('div');
      document.body.append(hostEl);
      uninstall = installKeyHandler(h, window, hostEl);

      const e = press('k');

      expect(h.onPlay).toHaveBeenCalledTimes(1);
      expect(e.defaultPrevented).toBe(true);
      expect(pageDoc).not.toHaveBeenCalled();
    });
  });
});
