// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/preact';
import type { RecognizeResponse } from '../../shared/messages';
import { trustEvents, untrusted } from '../test-events';
import { ASH } from '../test-fixtures';
import { HOVER_MS } from '../app';
import type { LiveView } from './controller';
import { LiveHoverCard, LiveOutlines } from './outlines';

let distrust: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  distrust = trustEvents();
});
afterEach(() => {
  cleanup();
  distrust();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

type Cards = LiveView['cards'];
const rectOf = (left: number, top: number, width: number, height: number) =>
  ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** A 1280x720 video shown in a box at (left, top); `fit` is its object-fit. */
function videoIn(box: DOMRect, fit = 'fill'): HTMLVideoElement {
  const v = document.createElement('video');
  Object.defineProperty(v, 'videoWidth', { value: 1280, configurable: true });
  Object.defineProperty(v, 'videoHeight', { value: 720, configurable: true });
  v.style.objectFit = fit;
  v.getBoundingClientRect = () => box;
  document.body.append(v);
  return v;
}

const voting: Cards[number] = { trackId: 1, state: 'voting', box: { x: 0.1, y: 0.2, w: 0.1, h: 0.2 } };
const promoted: Cards[number] = { trackId: 2, state: 'promoted', cardId: ASH.id, imageId: ASH.imageIds[0], box: { x: 0.5, y: 0.5, w: 0.1, h: 0.2 } };

function draw(cards: Cards, over: Partial<Parameters<typeof LiveOutlines>[0]> = {}) {
  const handlers = { onHover: vi.fn(), onLeave: vi.fn(), onPick: vi.fn() };
  const video = over.video ?? videoIn(rectOf(100, 50, 960, 540));
  const view = render(<LiveOutlines cards={cards} video={video} names={{ [ASH.id]: ASH.name }} {...handlers} {...over} />);
  return { ...handlers, video, ...view };
}

describe('LiveOutlines', () => {
  it('draws one outline per card at its viewport rect', () => {
    const { container } = draw([voting, promoted]);
    const outlines = container.querySelectorAll<HTMLElement>('.live-outline');
    expect(outlines).toHaveLength(2);
    // 960x540 at (100, 50): scale 0.75.
    expect([outlines[0].style.left, outlines[0].style.top, outlines[0].style.width, outlines[0].style.height]).toEqual(['196px', '158px', '96px', '108px']);
    expect([outlines[1].style.left, outlines[1].style.top, outlines[1].style.width, outlines[1].style.height]).toEqual(['580px', '320px', '96px', '108px']);
  });

  it('keeps to the picture inside the box when the video is letterboxed (object-fit contain)', () => {
    // 960x720 box for a 16:9 picture: the picture is 960x540, centred, 90 px of bars above and below.
    const video = videoIn(rectOf(0, 0, 960, 720), 'contain');
    const { container } = draw([promoted], { video });
    const o = container.querySelector<HTMLElement>('.live-outline')!;
    expect([o.style.left, o.style.top, o.style.width, o.style.height]).toEqual(['480px', '360px', '96px', '108px']);
  });

  it('a voting track gets a dashed outline with no name and no pointer; promotion turns it gold', () => {
    const video = videoIn(rectOf(100, 50, 960, 540));
    const handlers = { onHover: vi.fn(), onLeave: vi.fn(), onPick: vi.fn() };
    const names = { [ASH.id]: ASH.name };
    const { container, rerender } = render(<LiveOutlines cards={[voting]} video={video} names={names} {...handlers} />);
    const dashed = container.querySelector<HTMLElement>('.live-outline')!;
    expect(dashed.classList.contains('reading')).toBe(true);
    expect(dashed.classList.contains('promoted')).toBe(false);
    expect(dashed.getAttribute('aria-hidden')).toBe('true');
    expect(dashed.getAttribute('aria-label')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    fireEvent.pointerEnter(dashed);
    act(() => void vi.advanceTimersByTime(HOVER_MS + 50));
    expect(handlers.onHover).not.toHaveBeenCalled();
    rerender(<LiveOutlines cards={[{ ...voting, state: 'promoted', cardId: ASH.id, imageId: ASH.imageIds[0] }]} video={video} names={names} {...handlers} />);
    const gold = container.querySelector<HTMLElement>('.live-outline')!;
    expect(gold.classList.contains('promoted')).toBe(true);
    expect(gold.classList.contains('reading')).toBe(false);
    expect(gold.tagName).toBe('BUTTON');
    expect(gold.getAttribute('aria-label')).toBe(ASH.name);
    expect(gold.getAttribute('aria-hidden')).toBeNull();
  });

  it('draws nothing for no cards', () => {
    const { container } = draw([]);
    expect(container.querySelector('.live-outline')).toBeNull();
  });

  it('outlines are out of the Tab order and only they take the pointer', () => {
    const { container } = draw([voting, promoted]);
    const button = container.querySelector<HTMLButtonElement>('button.live-outline')!;
    expect(button.getAttribute('tabindex')).toBe('-1');
    expect(container.querySelector('.live-outlines')).not.toBeNull();
  });

  it('follows the video on resize, scroll, fullscreenchange and its own resizing', () => {
    const watchers: { cb: () => void; target?: Element }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(public cb: () => void) {
          watchers.push(this);
        }
        observe(t: Element) {
          (this as unknown as { target: Element }).target = t;
        }
        disconnect() {}
      },
    );
    const video = videoIn(rectOf(100, 50, 960, 540));
    const { container } = draw([promoted], { video });
    const left = () => container.querySelector<HTMLElement>('.live-outline')!.style.left;
    expect(left()).toBe('580px');
    for (const [type, target, at] of [['resize', window, 200], ['scroll', window, 300], ['fullscreenchange', document, 400]] as const) {
      video.getBoundingClientRect = () => rectOf(at, 50, 960, 540);
      act(() => void fireEvent(target, new Event(type)));
      expect(left(), type).toBe(`${at + 480}px`);
    }
    video.getBoundingClientRect = () => rectOf(0, 50, 960, 540);
    act(() => void watchers.find((w) => w.target === video)!.cb());
    expect(left()).toBe('480px');
    vi.unstubAllGlobals();
  });

  it('after a rest on a promoted outline, hover reports the card and its rect; leaving cancels', () => {
    const { container, onHover, onLeave } = draw([promoted]);
    const button = container.querySelector<HTMLElement>('.live-outline')!;
    fireEvent.pointerEnter(button);
    act(() => void vi.advanceTimersByTime(HOVER_MS - 10));
    expect(onHover).not.toHaveBeenCalled();
    fireEvent.pointerLeave(button);
    expect(onLeave).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(HOVER_MS));
    expect(onHover).not.toHaveBeenCalled(); // left before the rest
    fireEvent.pointerEnter(button);
    act(() => void vi.advanceTimersByTime(HOVER_MS + 1));
    expect(onHover).toHaveBeenCalledWith(ASH.id, ASH.imageIds[0], { x: 580, y: 320, w: 96, h: 108 });
  });

  it('a trusted click picks the card at the outline; an untrusted one does nothing', () => {
    const { container, onPick } = draw([promoted]);
    const button = container.querySelector<HTMLElement>('.live-outline')!;
    fireEvent(button, untrusted(createEvent.click(button, { bubbles: true })));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onPick).toHaveBeenCalledWith(ASH.id, ASH.imageIds[0], { x: 580, y: 320, w: 96, h: 108 });
  });

  it('an untrusted pointer does not start a hover', () => {
    const { container, onHover } = draw([promoted]);
    const button = container.querySelector<HTMLElement>('.live-outline')!;
    fireEvent(button, untrusted(createEvent.pointerEnter(button)));
    act(() => void vi.advanceTimersByTime(HOVER_MS + 50));
    expect(onHover).not.toHaveBeenCalled();
  });
});

const found = (): RecognizeResponse => ({
  result: { candidates: [{ cardId: ASH.id, imageId: ASH.imageIds[0], score: 0, source: 'name' }], confident: true, faceDown: false, modelId: '', timings: {} },
  cards: { [ASH.id]: ASH },
  aiEnabled: false,
});
const ANCHOR = { x: 580, y: 320, w: 96, h: 108 };

describe('LiveHoverCard', () => {
  const show = (reveal: 'preview' | 'full' | 'click') => {
    const h = { onEnter: vi.fn(), onLeave: vi.fn(), onPick: vi.fn(), onClose: vi.fn() };
    const view = render(<LiveHoverCard reveal={reveal} shown={{ response: found(), anchor: ANCHOR, images: {} }} {...h} />);
    return { ...h, ...view };
  };

  it('hover shows the quick preview for preview, the card box for full, nothing for click', () => {
    const preview = show('preview');
    expect(preview.container.querySelector('.pv')).not.toBeNull();
    expect(preview.container.querySelector('.pv-head')!.textContent).toBe(ASH.name);
    expect(preview.container.querySelector('.ov')).toBeNull();
    cleanup();
    const full = show('full');
    expect(full.container.querySelector('.ov')).not.toBeNull();
    expect(full.container.querySelector('.pv')).toBeNull();
    cleanup();
    const click = show('click');
    expect(click.container.querySelector('.pv, .ov')).toBeNull();
  });

  it('shows nothing when nothing is hovered', () => {
    const { container } = render(<LiveHoverCard reveal="preview" shown={null} onEnter={() => undefined} onLeave={() => undefined} onPick={() => undefined} onClose={() => undefined} />);
    expect(container.querySelector('.pv, .ov')).toBeNull();
  });

  it('a trusted click on the preview picks the card; the pointer on it holds it open', () => {
    const { container, onPick, onEnter, onLeave } = show('preview');
    const pv = container.querySelector<HTMLElement>('.pv')!;
    fireEvent.pointerEnter(pv);
    expect(onEnter).toHaveBeenCalled();
    fireEvent.pointerLeave(pv);
    expect(onLeave).toHaveBeenCalled();
    fireEvent(pv, untrusted(createEvent.click(pv, { bubbles: true })));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(pv);
    expect(onPick).toHaveBeenCalledTimes(1);
  });
});
