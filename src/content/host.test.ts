// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountHost, type Host } from './host';

// happy-dom has no Popover API; stand in for Chrome's showPopover/hidePopover.
let calls: string[];
const mounted: Host[] = [];
function mount() {
  const h = mountHost();
  mounted.push(h);
  return h;
}

beforeEach(() => {
  calls = [];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.showPopover = function (this: HTMLElement) {
    calls.push(`show:${this.id}`);
  };
  proto.hidePopover = function (this: HTMLElement) {
    calls.push(`hide:${this.id}`);
  };
});

afterEach(() => {
  mounted.splice(0).forEach((h) => h.destroy());
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  delete proto.showPopover;
  delete proto.hidePopover;
  document.querySelectorAll('#duel-lens-host').forEach((el) => el.remove());
});

describe('mountHost', () => {
  it('adds one top-layer host with a closed shadow root', () => {
    const { host, root } = mount();
    expect(document.querySelectorAll('#duel-lens-host')).toHaveLength(1);
    expect(host.getAttribute('popover')).toBe('manual');
    expect(host.shadowRoot).toBeNull(); // closed: the page can't reach inside
    expect(root.host).toBe(host);
    expect(calls).toEqual(['show:duel-lens-host']);
  });

  it('covers the viewport without taking pointer events itself', () => {
    const { host } = mount();
    expect(host.style.getPropertyValue('position')).toBe('fixed');
    expect(host.style.getPropertyValue('z-index')).toBe('2147483647');
    expect(host.style.getPropertyValue('pointer-events')).toBe('none');
  });

  it('re-shows itself on fullscreenchange so it stays above fullscreen video', () => {
    mount();
    calls = [];
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(calls).toEqual(['hide:duel-lens-host', 'show:duel-lens-host']);
  });

  it('destroy() removes the host and stops listening', () => {
    const h = mount();
    h.destroy();
    expect(document.getElementById('duel-lens-host')).toBeNull();
    calls = [];
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(calls).toEqual([]);
  });

  it('replaces a stale host left behind by an earlier (reloaded) content script', () => {
    const stale = document.createElement('duel-lens');
    stale.id = 'duel-lens-host';
    document.documentElement.append(stale);
    const { host } = mount();
    const all = document.querySelectorAll('#duel-lens-host');
    expect(all).toHaveLength(1);
    expect(all[0]).toBe(host);
  });

  it('still mounts where the Popover API is missing', () => {
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    delete proto.showPopover;
    delete proto.hidePopover;
    const { host } = mount();
    expect(host.isConnected).toBe(true);
  });
});

// Security review H1: with a fixed tag, a page that registered it first (a constructor calling
// attachInternals()) got our closed shadow root from ElementInternals.shadowRoot: the frozen screenshot,
// cross-origin frames included, and the scanned card.
describe('mountHost: a tag the page cannot know (security review H1)', () => {
  it('names the host "duel-lens-" and 16 lowercase hex digits, new for every mount', () => {
    const a = mount().host.localName;
    const b = mount().host.localName;
    expect(a).toMatch(/^duel-lens-[0-9a-f]{16}$/);
    expect(b).toMatch(/^duel-lens-[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });

  it('uses a valid custom element name (the page may define it once it sees it, and still gets no root)', () => {
    const { host } = mount();
    expect(() => customElements.define(host.localName, class extends HTMLElement {})).not.toThrow();
  });

  it('keeps the id the end-to-end harnesses find it by, and still replaces a stale host by that id', () => {
    const first = mount().host;
    const second = mount().host;
    expect(second.id).toBe('duel-lens-host');
    expect(first.isConnected).toBe(false);
    expect(document.querySelectorAll('#duel-lens-host')).toHaveLength(1);
  });

  it('attaches its closed shadow root before the element is in the page (never "available to element internals")', () => {
    const connectedAtAttach: boolean[] = [];
    const attach = Element.prototype.attachShadow;
    vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
      connectedAtAttach.push(this.isConnected);
      return attach.call(this, init);
    });
    mount();
    expect(connectedAtAttach).toEqual([false]);
    vi.restoreAllMocks();
  });

  it('never runs a constructor the page registered for the old fixed tag', () => {
    const constructed = vi.fn();
    customElements.define(
      'duel-lens',
      class extends HTMLElement {
        constructor() {
          super();
          constructed();
        }
      },
    );
    const { host } = mount();
    expect(constructed).not.toHaveBeenCalled();
    expect(host.localName).not.toBe('duel-lens');
  });
});
